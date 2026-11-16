import dotenv from 'dotenv';
import express from 'express';

dotenv.config({ override: true, quiet: true });
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { readStore, updateStore, upsertById } from './lib/store.js';
import {
  getReceivedEmail,
  isResendConfigured,
  isValidEmail,
  listReceivedEmails,
  listVerifiedDomains,
  normalizeEmailList,
  toStoredMessage,
  validateSender,
  wait,
} from './lib/resend.js';
import { isSmtpConfigured, sendSmtp, smtpSettings } from './lib/smtp.js';

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", 'about:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public', { extensions: ['html'] }));

app.get('/api/config', async (_req, res) => {
  const settings = smtpSettings();
  const domains = isResendConfigured() ? await listVerifiedDomains() : { data: [], error: null };

  res.json({
    resendConfigured: isResendConfigured(),
    smtp: {
      host: settings.host,
      port: settings.port,
      username: settings.username,
      configured: isSmtpConfigured(),
    },
    domains: domains.data,
    domainError: domains.error?.message || null,
  });
});

app.get('/api/messages', async (req, res) => {
  const store = await readStore();
  const recipient = String(req.query.recipient || '').trim().toLowerCase();
  const domain = String(req.query.domain || '').trim().toLowerCase();
  const search = String(req.query.search || '').trim().toLowerCase();

  const messages = store.messages
    .filter((message) => {
      const recipients = [...message.to, ...message.cc, ...message.bcc].map((entry) => String(entry).toLowerCase());
      const haystack = `${message.from} ${message.subject} ${message.text}`.toLowerCase();

      if (recipient && !recipients.some((entry) => entry.includes(recipient))) return false;
      if (domain && !recipients.some((entry) => entry.endsWith(`@${domain}`))) return false;
      if (search && !haystack.includes(search)) return false;
      return true;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ messages });
});

app.post('/api/inbox/sync', async (req, res) => {
  const maxPages = Math.min(Number(req.body?.maxPages || 3), 10);
  const limit = Math.min(Number(req.body?.limit || 50), 100);
  const store = await readStore();
  const knownIds = new Set(store.messages.map((message) => message.id));
  const synced = [];
  const errors = [];

  let after = req.body?.after || undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const listed = await listReceivedEmails({ limit, after });

    if (listed.error) {
      return res.status(listed.error.status || 500).json({ error: listed.error.message });
    }

    const pageMessages = Array.isArray(listed.data?.data) ? listed.data.data : [];
    if (pageMessages.length === 0) break;

    for (const summary of pageMessages) {
      const id = summary.id || summary.email_id;
      if (!id || knownIds.has(id)) continue;

      const full = await getReceivedEmail(id);
      if (full.error) {
        errors.push({ id, error: full.error.message });
        continue;
      }

      const message = toStoredMessage({ ...summary, ...full.data, id });
      synced.push(message);
      knownIds.add(id);
    }

    if (!listed.data?.has_more) break;
    after = listed.data?.next_cursor || listed.data?.next || pageMessages.at(-1)?.id;
    if (!after) break;
  }

  if (synced.length > 0) {
    await updateStore((data) => {
      for (const message of synced) upsertById(data.messages, message);
      return data;
    });
  }

  res.json({ synced: synced.length, errors });
});

app.get('/api/sends', async (_req, res) => {
  const store = await readStore();
  res.json({
    sends: store.sends.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    bulkJobs: store.bulkJobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  });
});

app.post('/api/send', async (req, res) => {
  const validation = await validateSendPayload(req.body);
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  const id = randomUUID();
  const payload = validation.payload;
  const result = await sendSmtp(payload);
  const record = {
    id,
    ...payload,
    status: result.error ? 'failed' : 'sent',
    error: result.error?.message || null,
    smtpResult: result.data,
    createdAt: new Date().toISOString(),
  };

  await updateStore((data) => {
    data.sends.unshift(record);
    return data;
  });

  if (result.error) return res.status(result.error.status || 500).json({ error: result.error.message, send: record });
  res.json({ send: record });
});

app.post('/api/bulk', async (req, res) => {
  const fromValidation = await validateSender(req.body?.from);
  if (!fromValidation.valid) return res.status(400).json({ error: fromValidation.message });

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const subject = String(req.body?.subject || '').trim();
  const text = String(req.body?.text || '').trim();
  const html = String(req.body?.html || '').trim();

  if (rows.length === 0) return res.status(400).json({ error: 'CSV has no recipient rows.' });
  if (rows.length > 1000) return res.status(400).json({ error: 'Limit CSV sends to 1000 rows per job.' });
  if (!subject) return res.status(400).json({ error: 'Subject is required.' });
  if (!text && !html) return res.status(400).json({ error: 'Text or HTML body is required.' });

  const recipients = rows.map((row, index) => ({
    index,
    to: String(row.email || row.to || '').trim().toLowerCase(),
    subject: String(row.subject || subject).trim(),
    text: String(row.text || text).trim(),
    html: String(row.html || html).trim(),
  }));
  const invalid = recipients.filter((row) => !isValidEmail(row.to));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid email in row ${invalid[0].index + 1}: ${invalid[0].to || '(empty)'}` });
  }

  const job = {
    id: randomUUID(),
    from: req.body.from,
    total: recipients.length,
    succeeded: 0,
    failed: 0,
    status: 'running',
    rows: recipients.map((row) => ({ ...row, status: 'pending', error: null, smtpResult: null })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  for (let index = 0; index < job.rows.length; index += 1) {
    const row = job.rows[index];
    const result = await sendSmtp({
      from: req.body.from,
      to: [row.to],
      subject: row.subject,
      ...(row.html ? { html: row.html } : {}),
      ...(row.text ? { text: row.text } : {}),
    });

    if (result.error) {
      row.status = 'failed';
      row.error = result.error.message;
      job.failed += 1;
    } else {
      row.status = 'sent';
      row.smtpResult = result.data;
      job.succeeded += 1;
    }

    if (index < job.rows.length - 1) await wait(600);
  }

  job.status = job.failed > 0 ? 'completed_with_errors' : 'completed';
  job.updatedAt = new Date().toISOString();

  await updateStore((data) => {
    data.bulkJobs.unshift(job);
    return data;
  });

  res.json({ job });
});

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message || 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`Local Resend Mailbox running at http://localhost:${port}`);
});

async function validateSendPayload(body) {
  const sender = await validateSender(body?.from);
  if (!sender.valid) return { ok: false, error: sender.message };

  const to = normalizeEmailList(body?.to).map((entry) => entry.toLowerCase());
  const invalid = to.find((entry) => !isValidEmail(entry));
  const subject = String(body?.subject || '').trim();
  const text = String(body?.text || '').trim();
  const html = String(body?.html || '').trim();

  if (to.length === 0) return { ok: false, error: 'At least one recipient is required.' };
  if (to.length > 50) return { ok: false, error: 'A single send can have at most 50 recipients.' };
  if (invalid) return { ok: false, error: `Invalid recipient: ${invalid}` };
  if (!subject) return { ok: false, error: 'Subject is required.' };
  if (!text && !html) return { ok: false, error: 'Text or HTML body is required.' };

  return {
    ok: true,
    payload: {
      from: body.from,
      to,
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
    },
  };
}

