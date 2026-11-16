import nodemailer from 'nodemailer';

let transport;

export function smtpSettings() {
  const port = Number(process.env.SMTP_PORT || 587);
  const password = process.env.SMTP_PASSWORD || process.env.RESEND_API_KEY || '';

  return {
    host: process.env.SMTP_HOST || '',
    port,
    username: process.env.SMTP_USERNAME || 'resend',
    password,
  };
}

export function isSmtpConfigured() {
  const settings = smtpSettings();
  return Boolean(settings.host && settings.port && settings.username && settings.password);
}

function getTransport() {
  if (transport) return transport;

  const settings = smtpSettings();
  transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    auth: {
      user: settings.username,
      pass: settings.password,
    },
    requireTLS: settings.port !== 465,
  });

  return transport;
}

export async function sendSmtp(payload) {
  if (!isSmtpConfigured()) {
    return {
      data: null,
      error: { status: 400, message: 'Set SMTP_HOST, SMTP_PORT, SMTP_USERNAME, and RESEND_API_KEY or SMTP_PASSWORD in .env.' },
    };
  }

  try {
    const info = await getTransport().sendMail({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });

    return {
      data: {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
      error: null,
    };
  } catch (error) {
    return { data: null, error: { status: 502, message: error.message } };
  }
}
