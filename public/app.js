const state = {
  messages: [],
  selectedId: null,
  csvRows: [],
};

const configStatus = document.querySelector('#configStatus');
const inboxStatus = document.querySelector('#inboxStatus');
const messageList = document.querySelector('#messageList');
const messageDetail = document.querySelector('#messageDetail');
const searchInput = document.querySelector('#searchInput');
const recipientFilter = document.querySelector('#recipientFilter');
const sendStatus = document.querySelector('#sendStatus');
const bulkStatus = document.querySelector('#bulkStatus');
const csvPreview = document.querySelector('#csvPreview');
const history = document.querySelector('#history');

document.querySelector('#syncInbox').addEventListener('click', syncInbox);
document.querySelector('#refreshInbox').addEventListener('click', loadInbox);
document.querySelector('#sendForm').addEventListener('submit', sendEmail);
document.querySelector('#bulkForm').addEventListener('submit', sendBulk);
document.querySelector('#csvFile').addEventListener('change', loadCsvFile);
searchInput.addEventListener('input', debounce(loadInbox, 250));
recipientFilter.addEventListener('input', debounce(loadInbox, 250));

loadConfig();
loadInbox();
loadHistory();

async function loadConfig() {
  const result = await api('/api/config');

  if (!result.resendConfigured) {
    configStatus.textContent = 'Missing RESEND_API_KEY in .env';
    configStatus.className = 'status error';
    return;
  }

  if (result.domainError) {
    const staleKey = /invalid/i.test(result.domainError)
      ? ' Restart the local server after changing .env.'
      : '';
    configStatus.textContent = `Resend rejected the request: ${result.domainError}.${staleKey}`;
    configStatus.className = 'status error';
    return;
  }

  if (!result.smtp?.configured) {
    configStatus.textContent = 'SMTP is not configured. Set SMTP_HOST, SMTP_PORT, and SMTP_USERNAME in .env.';
    configStatus.className = 'status error';
    return;
  }

  const domains = result.domains.length ? result.domains.join(', ') : 'no verified domains found';
  configStatus.textContent = `Sending through SMTP ${result.smtp.host}:${result.smtp.port}. Domains: ${domains}`;
  configStatus.className = 'status ok';
}

async function loadInbox() {
  const params = new URLSearchParams();
  const filter = recipientFilter.value.trim();

  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  if (filter.includes('@')) params.set('recipient', filter);
  if (filter && !filter.includes('@')) params.set('domain', filter.replace(/^@/, ''));

  const result = await api(`/api/messages?${params}`);
  state.messages = result.messages || [];
  renderMessages();
}

async function syncInbox() {
  const button = document.querySelector('#syncInbox');
  button.disabled = true;
  inboxStatus.textContent = 'Syncing...';

  try {
    const result = await api('/api/inbox/sync', {
      method: 'POST',
      body: JSON.stringify({ maxPages: 3, limit: 50 }),
    });
    inboxStatus.textContent = `Synced ${result.synced} new message(s).`;
    if (result.errors?.length) inboxStatus.textContent += ` ${result.errors.length} item(s) failed.`;
    await loadInbox();
  } catch (error) {
    inboxStatus.textContent = error.message;
    inboxStatus.className = 'error';
  } finally {
    button.disabled = false;
  }
}

function renderMessages() {
  messageList.replaceChildren();

  if (state.messages.length === 0) {
    messageList.append(element('p', { className: 'muted' }, 'No messages saved locally yet. Click Sync inbox.'));
    renderSelectedMessage();
    return;
  }

  for (const message of state.messages) {
    const item = element('article', { className: 'message-item', tabIndex: 0 });
    item.append(
      element('strong', {}, message.subject || '(no subject)'),
      element('div', { className: 'message-meta' }, `From: ${message.from || 'unknown'}`),
      element('div', { className: 'message-meta' }, `To: ${(message.to || []).join(', ')}`),
      element('div', { className: 'message-meta' }, formatDate(message.createdAt)),
    );
    item.addEventListener('click', () => {
      state.selectedId = message.id;
      renderSelectedMessage();
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') item.click();
    });
    messageList.append(item);
  }

  if (!state.selectedId || !state.messages.some((message) => message.id === state.selectedId)) {
    state.selectedId = state.messages[0]?.id || null;
  }
  renderSelectedMessage();
}

function renderSelectedMessage() {
  const message = state.messages.find((entry) => entry.id === state.selectedId);
  messageDetail.replaceChildren();

  if (!message) {
    messageDetail.className = 'empty-state';
    messageDetail.textContent = 'Select a message from the inbox.';
    return;
  }

  messageDetail.className = '';
  messageDetail.append(
    element('h2', {}, message.subject || '(no subject)'),
    element('p', { className: 'message-meta' }, `From: ${message.from || 'unknown'}`),
    element('p', { className: 'message-meta' }, `To: ${(message.to || []).join(', ')}`),
    element('p', { className: 'message-meta' }, formatDate(message.createdAt)),
  );

  if (message.attachments?.length) {
    messageDetail.append(element('p', { className: 'message-meta' }, `Attachments: ${message.attachments.map((item) => item.filename || item.id).join(', ')}`));
  }

  const textBody = message.text || stripHtml(message.html || '');
  messageDetail.append(element('pre', { className: 'message-body' }, textBody || '(empty body)'));

  if (message.html) {
    const frameTitle = element('h3', {}, 'Sandboxed HTML preview');
    const frame = element('iframe', { className: 'html-frame', title: 'Sandboxed email HTML preview' });
    frame.setAttribute('sandbox', '');
    frame.srcdoc = message.html;
    messageDetail.append(frameTitle, frame);
  }
}

async function sendEmail(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  sendStatus.textContent = 'Sending...';

  try {
    const result = await api('/api/send', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(data.entries())),
    });
    sendStatus.textContent = `Sent through SMTP. Local ID: ${result.send.id}`;
    form.reset();
    await loadHistory();
  } catch (error) {
    sendStatus.textContent = error.message;
    sendStatus.className = 'error';
  }
}

async function loadCsvFile(event) {
  const file = event.target.files?.[0];
  state.csvRows = [];
  csvPreview.replaceChildren();

  if (!file) return;

  const text = await file.text();
  state.csvRows = parseCsv(text);

  csvPreview.append(element('p', { className: 'muted' }, `${state.csvRows.length} row(s) ready.`));
  for (const row of state.csvRows.slice(0, 5)) {
    csvPreview.append(element('div', { className: 'preview-row' }, row.email || row.to || '(missing email)'));
  }
  if (state.csvRows.length > 5) {
    csvPreview.append(element('p', { className: 'muted' }, `Showing first 5 rows only.`));
  }
}

async function sendBulk(event) {
  event.preventDefault();

  if (state.csvRows.length === 0) {
    bulkStatus.textContent = 'Choose a CSV file first.';
    bulkStatus.className = 'error';
    return;
  }

  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  delete payload.csvFile;
  payload.rows = state.csvRows;
  bulkStatus.textContent = 'Sending bulk job...';

  try {
    const result = await api('/api/bulk', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    bulkStatus.textContent = `Done. Sent ${result.job.succeeded}/${result.job.total}. Failed ${result.job.failed}.`;
    await loadHistory();
  } catch (error) {
    bulkStatus.textContent = error.message;
    bulkStatus.className = 'error';
  }
}

async function loadHistory() {
  const result = await api('/api/sends');
  history.replaceChildren();

  for (const send of result.sends || []) {
    const row = element('article', { className: 'history-row' });
    row.append(
      element('strong', {}, send.subject || '(no subject)'),
      element('div', { className: 'history-meta' }, `${send.status}: ${send.from} -> ${(send.to || []).join(', ')}`),
      element('div', { className: 'history-meta' }, formatDate(send.createdAt)),
    );
    if (send.error) row.append(element('div', { className: 'error' }, send.error));
    history.append(row);
  }

  for (const job of result.bulkJobs || []) {
    const row = element('article', { className: 'history-row' });
    row.append(
      element('strong', {}, `Bulk job ${job.id}`),
      element('div', { className: 'history-meta' }, `${job.status}: ${job.succeeded}/${job.total} sent, ${job.failed} failed`),
      element('div', { className: 'history-meta' }, formatDate(job.createdAt)),
    );
    history.append(row);
  }

  if (!history.children.length) {
    history.append(element('p', { className: 'muted' }, 'No send history yet.'));
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Request failed.');
  }

  return data;
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length === 0) return [];

  const headers = rows.shift().map((header) => header.trim().toLowerCase());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() || ''])));
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function debounce(fn, ms) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}
