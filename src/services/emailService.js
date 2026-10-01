// Real email sending via SMTP (nodemailer) once configured — same dev-mode fallback
// pattern as otp.js: no credentials yet, so log what would have been sent instead of
// failing the whole report pipeline. Swap in real SMTP_* env vars (Gmail workspace,
// SES, SendGrid SMTP, etc.) when sourced.
const nodemailer = require('nodemailer');

let transporter = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, html, attachments }) {
  const recipients = [].concat(to).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'no recipients' };
  if (!isConfigured()) {
    console.log(`[EMAIL] (not actually sent — no SMTP configured) To: ${recipients.join(', ')} | Subject: ${subject}`);
    return { sent: false, reason: 'SMTP not configured (dev mode)' };
  }
  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients.join(', '),
      subject,
      html,
      attachments,
    });
    return { sent: true };
  } catch (e) {
    console.error(`[EMAIL] send failed: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

module.exports = { isConfigured, sendEmail };
