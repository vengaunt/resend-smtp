const RESEND_API_BASE = 'https://api.resend.com';
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function isResendConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

export function parseAddressEmail(value) {
  const input = String(value || '').trim();
  const match = input.match(/<([^<>]+)>$/);
  return (match ? match[1] : input).trim().toLowerCase();
}

export function isValidEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

export function normalizeEmailList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  return String(value || '')
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function apiRequest(path, options = {}) {
  if (!process.env.RESEND_API_KEY) {
    return {
      data: null,
      error: { status: 401, name: 'missing_api_key', message: 'Set RESEND_API_KEY in .env before using Resend.' },
    };
  }

  const headers = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  try {
    const response = await fetch(`${RESEND_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      return {
        data: null,
        error: {
          status: response.status,
          name: payload?.name || payload?.error || 'resend_error',
          message: payload?.message || response.statusText,
          details: payload,
        },
      };
    }

    return { data: payload, error: null };
  } catch (error) {
    return {
      data: null,
      error: { status: 0, name: 'network_error', message: error.message },
    };
  }
}

export async function listVerifiedDomains() {
  const { data, error } = await apiRequest('/domains');
  if (error) return { data: [], error };

  const domains = Array.isArray(data?.data) ? data.data : [];
  return {
    data: domains
      .filter((domain) => ['verified', 'success'].includes(String(domain.status || '').toLowerCase()))
      .map((domain) => String(domain.name || domain.domain || '').toLowerCase())
      .filter(Boolean),
    error: null,
  };
}

export async function validateSender(from) {
  const email = parseAddressEmail(from);

  if (!isValidEmail(email)) {
    return { valid: false, message: 'Enter a valid from email address.' };
  }

  const domain = email.split('@')[1];
  const { data: domains, error } = await listVerifiedDomains();
  if (error) {
    return { valid: false, message: `Could not verify sender domain: ${error.message}` };
  }

  if (!domains.includes(domain)) {
    return { valid: false, message: `${domain} is not a verified Resend domain for this API key.` };
  }

  return { valid: true, email, domain };
}

export async function listReceivedEmails({ limit = 50, after } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (after) params.set('after', after);

  return apiRequest(`/emails/receiving?${params}`);
}

export async function getReceivedEmail(id) {
  return apiRequest(`/emails/receiving/${encodeURIComponent(id)}`);
}

export function toStoredMessage(email) {
  const id = email.id || email.email_id;

  return {
    id,
    from: email.from || '',
    to: Array.isArray(email.to) ? email.to : [],
    cc: Array.isArray(email.cc) ? email.cc : [],
    bcc: Array.isArray(email.bcc) ? email.bcc : [],
    subject: email.subject || '(no subject)',
    createdAt: email.created_at || email.createdAt || new Date().toISOString(),
    html: email.html || '',
    text: email.text || '',
    headers: email.headers || {},
    attachments: Array.isArray(email.attachments) ? email.attachments : [],
    raw: email,
    syncedAt: new Date().toISOString(),
  };
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
