// One KYC interface for the routes, whichever provider is configured:
//   Meon (meon.co.in) — the provider TSG is live with (DigiLocker Aadhaar + PAN fetch).
//   Setu — the earlier integration, kept as a fallback if its credentials are ever set.
// Routes call these and never care which one answered.
const meon = require('./meonClient');
const setu = require('./setuClient');

const provider = () => (meon.digilockerConfigured() ? 'meon' : setu.isConfigured() ? 'setu' : null);
const isConfigured = () => provider() !== null;

// → { id, url, clientToken?, provider }. The app opens `url`; `id` is used to complete.
async function createDigilockerRequest(redirectUrl, documents) {
  const p = provider();
  if (p === 'meon') { const r = await meon.createDigilockerLink(redirectUrl, documents); return { ...r, provider: 'meon' }; }
  if (p === 'setu') { const r = await setu.createDigilockerRequest(redirectUrl); return { id: r.id, url: r.url, provider: 'setu' }; }
  throw new Error('No KYC provider configured (MEON_COMPANY_NAME/MEON_SECRET_TOKEN or SETU_*)');
}

// → { status: 'pending' | 'complete', aadhaar: { maskedNumber, last4, name, dateOfBirth, gender, fatherName, address, photoUrl }, pan: { number, name, masked } | null }
async function fetchDigilocker(reqRow) {
  if (reqRow.provider === 'meon' || (!reqRow.provider && meon.digilockerConfigured())) {
    const r = await meon.fetchDigilockerData(reqRow.client_token, reqRow.id);
    if (r.status !== 'complete') return r;
    // The entire-data call masks the PAN number; ask for the full one when PAN was requested.
    if (r.pan && r.pan.masked) {
      try { const p = await meon.fetchPanDetail(reqRow.client_token, reqRow.id); if (p.status === 'complete' && p.number && !/\*/.test(p.number)) r.pan = { number: p.number, name: p.name || r.pan.name, masked: false }; } catch (e) { /* keep masked PAN */ }
    }
    return r;
  }
  const r = await setu.fetchDigilockerAadhaar(reqRow.id);
  if (r.status !== 'complete') return { status: 'pending' };
  const a = r.aadhaar || {};
  const last4 = String(a.maskedNumber || '').replace(/\D/g, '').slice(-4);
  return { status: 'complete', aadhaar: { maskedNumber: a.maskedNumber, last4, name: a.name, dateOfBirth: a.dateOfBirth, gender: a.gender, fatherName: a.careOf || null, address: a.address ? JSON.stringify(a.address) : null, photoUrl: null }, pan: null };
}

// Standalone PAN verification (vendor contact / manual PAN). Meon's PAN API spec is not
// published in the portal yet, so only Setu can answer this today.
async function verifyPan(pan, reason) {
  if (setu.isConfigured()) return setu.verifyPan(pan, reason);
  const e = new Error('Standalone PAN verification is not available yet — PAN is verified through DigiLocker during registration'); e.code = 'PAN_API_UNAVAILABLE'; throw e;
}
const panApiConfigured = () => setu.isConfigured();

module.exports = { provider, isConfigured, createDigilockerRequest, fetchDigilocker, verifyPan, panApiConfigured };
