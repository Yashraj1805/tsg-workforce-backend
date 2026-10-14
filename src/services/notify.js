// Outgoing messages: OTPs, approval SMS, security alerts, scheduled report emails.
// Providers aren't sourced yet, so each channel is a small adapter that is switched on by
// .env and otherwise logs to the console (dev). Nothing here decides *whether* to send —
// callers do; this only delivers.
//
//   SMS       SMS_WEBHOOK_URL (+ SMS_WEBHOOK_TOKEN): POST {to, message} — fits most Indian
//             SMS gateways' HTTP APIs behind a small proxy
//   Email     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (nodemailer)
//   WhatsApp  Meta WhatsApp Cloud API, direct (no BSP in between) — WHATSAPP_ACCESS_TOKEN +
//             WHATSAPP_PHONE_NUMBER_ID, docs: developers.facebook.com/docs/whatsapp/cloud-api.
//             OTPs need an approved *Authentication*-category template (WHATSAPP_OTP_TEMPLATE);
//             a plain free-text message (sendWhatsApp, R21 report copies) only delivers inside
//             the 24h customer-service window Meta opens after the customer last messaged in.
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
  // The message text can carry an OTP — never log it outside an explicit dev bypass.
  if (!process.env.SMS_WEBHOOK_URL) {
    const devEcho = process.env.NODE_ENV !== 'production' && process.env.DEV_BYPASS === '1';
    console.log(`[SMS not sent — no SMS_WEBHOOK_URL] to ${String(to).replace(/.(?=.{4})/g, 'x')}${devEcho ? `: ${message}` : ''}`);
    return { ok: false, skipped: true };
  }
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

const WA_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
function waConfigured() { return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID); }
async function waSend(body) {
  const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `WhatsApp Cloud API HTTP ${r.status}`);
  return data;
}

// R21: WhatsApp copy of a report. A plain text message — only deliverable inside the 24h
// window Meta opens after the customer last messaged the business number.
async function sendWhatsApp(toMobile, message) {
  if (!waConfigured()) { console.log(`[WhatsApp not sent — Cloud API not configured] to ${toMobile}`); return { ok: false, skipped: true }; }
  try {
    await waSend({ to: '91' + toMobile, type: 'text', text: { body: message } });
    return { ok: true };
  } catch (e) { console.error('[WhatsApp failed]', toMobile, e.message); return { ok: false, error: e.message }; }
}

// WhatsApp OTP uses a Meta-approved *authentication*-category template (WHATSAPP_OTP_TEMPLATE,
// the template's name as approved in Meta Business Manager) — a free-text message can't open
// a conversation, so sendWhatsApp() above is not usable for this. The template's one body
// variable is the code. If the approved template also has a "Copy Code" button (Meta's newer
// authentication templates default to this), uncomment the `components` button entry below —
// without knowing your exact template shape yet, this ships with the plain body-only form.
async function sendWhatsAppOtp(toMobile, code) {
  if (!waConfigured() || !process.env.WHATSAPP_OTP_TEMPLATE) return { ok: false, skipped: true };
  try {
    await waSend({
      to: '91' + toMobile,
      type: 'template',
      template: {
        name: process.env.WHATSAPP_OTP_TEMPLATE,
        language: { code: process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          // { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: code }] },
        ],
      },
    });
    return { ok: true };
  } catch (e) { console.error('[WhatsApp OTP failed]', toMobile, e.message); return { ok: false, error: e.message }; }
}

// Returns { channel: 'whatsapp' | 'sms' | 'email' | 'none' } — which channel actually
// accepted the message, so the login screen can tell the worker where to look.
// Mobile numbers: WhatsApp first (cheaper, lands faster, no DLT), SMS if WhatsApp isn't
// configured / isn't on that number / fails. `preferred: 'sms'` skips WhatsApp — the
// "didn't get it on WhatsApp? send on SMS" button.
async function sendOtp(identifier, purpose, code, preferred) {
  const msg = `${code} is your TSG Workforce OTP. Valid 5 minutes. Do not share it.`;
  let channel = 'none';
  if (/^\d{10}$/.test(identifier)) {
    if (preferred !== 'sms') { const w = await sendWhatsAppOtp(identifier, code); if (w.ok) channel = 'whatsapp'; }
    if (channel === 'none') { const s = await sendSms(identifier, msg); if (s.ok) channel = 'sms'; }
  } else {
    const e = await sendEmail(identifier, 'TSG Workforce login OTP', msg);
    if (e.ok) channel = 'email';
  }
  if (channel === 'none') {
    const devEcho = process.env.NODE_ENV !== 'production' && process.env.DEV_BYPASS === '1';
    console.log(`[OTP] no delivery channel configured for ${purpose} to ${String(identifier).replace(/.(?=.{4})/g, 'x')}${devEcho ? ` (dev code ${code})` : ''}`);
  }
  return { channel };
}

// Worker-facing status SMS (BRD §10 screen 12: "SMS when approved or sent back").
function notifyWorker(worker, message) {
  if (!worker || !worker.mobile) return;
  sendSms(worker.mobile, message).then(r => { if (r.ok) addAudit('system', 'sms_sent', `${worker.mobile}: ${message.slice(0, 80)}`); });
}

module.exports = { sendSms, sendEmail, sendWhatsApp, sendWhatsAppOtp, sendOtp, notifyWorker };
