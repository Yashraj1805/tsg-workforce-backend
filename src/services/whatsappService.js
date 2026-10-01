// R21: "WhatsApp copy of the manager's daily email." Real delivery needs a WhatsApp
// Business API provider (Gupshup, Twilio, Meta Cloud API, or the WATI account this repo
// mentions elsewhere) — not sourced yet, same category of gap as OTP SMS delivery. Dev
// mode logs what would have been sent so the calling code (scheduler.js) is already
// correct and just needs real credentials dropped in later.
const isDev = process.env.NODE_ENV !== 'production';

function isConfigured() {
  return !!(process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_KEY);
}

async function sendWhatsApp({ to, text }) {
  if (!to) return { sent: false, reason: 'no recipient' };
  if (!isConfigured()) {
    if (isDev) console.log(`[WHATSAPP] (not actually sent — no provider configured) To: ${to} | ${text.slice(0, 120)}...`);
    return { sent: false, reason: 'WhatsApp provider not configured (dev mode)' };
  }
  try {
    const res = await fetch(process.env.WHATSAPP_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}` },
      body: JSON.stringify({ to, text }),
    });
    if (!res.ok) return { sent: false, reason: `Provider returned ${res.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = { isConfigured, sendWhatsApp };
