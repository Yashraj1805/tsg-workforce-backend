// Real Setu (Pinelabs) KYC API client — endpoint shapes confirmed against Setu's
// current docs (docs.setu.co/data/digilocker/quickstart, docs.setu.co/data/pan/quickstart)
// on 2026-09-30. Requires real credentials from Setu's sandbox sign-up
// (https://bridge.setu.co/v2/) in SETU_CLIENT_ID / SETU_CLIENT_SECRET /
// SETU_PRODUCT_INSTANCE_ID — calls will fail with a clear error until those are set.

const BASE_URL = process.env.SETU_BASE_URL || 'https://dg-sandbox.setu.co';

function headers() {
  const { SETU_CLIENT_ID, SETU_CLIENT_SECRET, SETU_PRODUCT_INSTANCE_ID } = process.env;
  if (!SETU_CLIENT_ID || !SETU_CLIENT_SECRET || !SETU_PRODUCT_INSTANCE_ID) {
    throw new Error('Setu credentials not configured — set SETU_CLIENT_ID, SETU_CLIENT_SECRET, SETU_PRODUCT_INSTANCE_ID in .env (get these from Setu after sandbox sign-up)');
  }
  return {
    'Content-Type': 'application/json',
    'x-client-id': SETU_CLIENT_ID,
    'x-client-secret': SETU_CLIENT_SECRET,
    'x-product-instance-id': SETU_PRODUCT_INSTANCE_ID,
  };
}

async function createDigilockerRequest(redirectUrl) {
  const res = await fetch(`${BASE_URL}/api/digilocker/`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ redirectUrl }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Setu DigiLocker init failed (${res.status}): ${JSON.stringify(body)}`);
  return body; // { id, status, url, validUpto }
}

async function fetchDigilockerAadhaar(requestId) {
  const res = await fetch(`${BASE_URL}/api/digilocker/${requestId}/aadhaar`, { headers: headers() });
  const body = await res.json();
  if (!res.ok) throw new Error(`Setu DigiLocker fetch failed (${res.status}): ${JSON.stringify(body)}`);
  return body; // { aadhaar: {...}, id, status }
}

async function revokeDigilocker(requestId) {
  const res = await fetch(`${BASE_URL}/api/digilocker/${requestId}/revoke`, { headers: headers() });
  return res.json();
}

async function verifyPan(pan, reason) {
  const res = await fetch(`${BASE_URL}/api/verify/pan`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ pan, consent: 'Y', reason: reason || 'TSG Workforce contract worker onboarding' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Setu PAN verify failed (${res.status}): ${JSON.stringify(body)}`);
  return body; // { data, message, verification, traceId }
}

module.exports = { createDigilockerRequest, fetchDigilockerAadhaar, revokeDigilocker, verifyPan };
