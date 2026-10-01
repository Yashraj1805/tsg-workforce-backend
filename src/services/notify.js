// Outgoing messages: OTPs, approval SMS, security alerts, scheduled report emails.
// Providers aren't sourced yet, so each channel is a small adapter that is switched on by
// .env and otherwise logs to the console (dev). Nothing here decides *whether* to send —
// callers do; this only delivers.
//
//   SMS       SMS_WEBHOOK_URL (+ SMS_WEBHOOK_TOKEN): POST {to, message} — fits most Indian
//             SMS gateways' HTTP APIs behind a small proxy, or a WATI/MSG91 webhook
//   Email     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (nodemailer)
//   WhatsApp  WATI_API_URL + WATI_API_TOKEN (R21)
const { addAudit } = require('../db');

let mailer = null;
function smtp() {
  if (mailer !== null) return mailer;
  if (!process.env.SMTP_HOST) { mailer = false; return mailer; }
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return mailer;
}

async function sendSms(to, message) {
  if (!process.env.SMS_WEBHOOK_URL) { console.log(`[SMS not sent — no SMS_WEBHOOK_URL] to ${to}: ${message}`); return { ok: false, skipped: true }; }
  try {
    const r = await fetch(process.env.SMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: 'Bearer ' + process.env.SMS_WEBHOOK_TOKEN } : {}) },
      body: JSON.stringify({ to, message }),
    });
    if (!r.ok) throw new Error(`SMS gateway HTTP ${r.status}`);
    return { ok: true };
  } catch (e) { console.error('[SMS failed]', to, e.message); return { ok: false, error: e.message }; }
}

// attachments: [{ filename, content (Buffer) }]
async function sendEmail(to, subject, text, attachments) {
  const recipients = [].concat(to).filter(Boolean);
  if (!recipients.length) return { ok: false, skipped: true };
  const t = smtp();
  if (!t) {
    console.log(`[Email not sent — no SMTP_HOST] to ${recipients.join(', ')}: ${subject}`);
    // Dev servers keep a copy in data/outbox/*.eml (opens in Outlook) so the reports can be
    // checked before an SMTP account exists.
    if (process.env.NODE_ENV !== 'production') saveToOutbox(recipients, subject, text, attachments);
    return { ok: false, skipped: true };
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: recipients.join(', '), subject, text, attachments });
    return { ok: true };
  } catch (e) { console.error('[Email failed]', subject, e.message); return { ok: false, error: e.message }; }
}

function saveToOutbox(to, subject, text, attachments) {
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'outbox');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const t = require('nodemailer').createTransport({ streamTransport: true, buffer: true });
    t.sendMail({ from: 'tsg-workforce@localhost', to: to.join(', '), subject, text, attachments }, (err, info) => {
      if (!err) fs.writeFileSync(path.join(dir, `${Date.now()}-${subject.replace(/[^\w-]+/g, '_').slice(0, 60)}.eml`), info.message);
    });
  } catch (e) { /* preview only */ }
}

// R21: WhatsApp copy of a report. WATI's "send session message" endpoint; works only once
// a WATI account + approved template exist.
async function sendWhatsApp(toMobile, message) {
  if (!process.env.WATI_API_URL || !process.env.WATI_API_TOKEN) { console.log(`[WhatsApp not sent — WATI not configured] to ${toMobile}`); return { ok: false, skipped: true }; }
  try {
    const r = await fetch(`${process.env.WATI_API_URL.replace(/\/$/, '')}/api/v1/sendSessionMessage/91${toMobile}?messageText=${encodeURIComponent(message)}`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.WATI_API_TOKEN },
    });
    if (!r.ok) throw new Error(`WATI HTTP ${r.status}`);
    return { ok: true };
  } catch (e) { console.error('[WhatsApp failed]', toMobile, e.message); return { ok: false, error: e.message }; }
}

function sendOtp(identifier, purpose, code) {
  const msg = `${code} is your TSG Workforce OTP. Valid 5 minutes. Do not share it.`;
  if (/^\d{10}$/.test(identifier)) sendSms(identifier, msg);
  else sendEmail(identifier, 'TSG Workforce login OTP', msg);
  if (!process.env.SMS_WEBHOOK_URL || !process.env.SMTP_HOST) console.log(`[OTP] ${purpose} OTP for ${identifier}: ${code}`);
}

// Worker-facing status SMS (BRD §10 screen 12: "SMS when approved or sent back").
function notifyWorker(worker, message) {
  if (!worker || !worker.mobile) return;
  sendSms(worker.mobile, message).then(r => { if (r.ok) addAudit('system', 'sms_sent', `${worker.mobile}: ${message.slice(0, 80)}`); });
}

module.exports = { sendSms, sendEmail, sendWhatsApp, sendOtp, notifyWorker };
