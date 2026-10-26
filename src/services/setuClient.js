// Real Setu (Pinelabs) KYC API client — endpoint shapes confirmed against Setu's
// current docs (docs.setu.co/data/digilocker/quickstart, docs.setu.co/data/pan/quickstart)
// and live-tested against the sandbox on 2026-10-26. Each KYC product set up in Setu's
// dashboard gets its own x-product-instance-id (confirmed live - the DigiLocker product's
// ID fails on the PAN endpoint and vice versa), so this needs two separate IDs:
// SETU_CLIENT_ID / SETU_CLIENT_SECRET (shared) plus SETU_DIGILOCKER_PRODUCT_INSTANCE_ID
// and SETU_PAN_PRODUCT_INSTANCE_ID (from each product's "Resume configuration" page).

const BASE_URL = process.env.SETU_BASE_URL || 'https://dg-sandbox.setu.co';

function headers(productInstanceId) {
  const { SETU_CLIENT_ID, SETU_CLIENT_SECRET } = process.env;
  if (!SETU_CLIENT_ID || !SETU_CLIENT_SECRET || !productInstanceId) {
    throw new Error('Setu credentials not configured — set SETU_CLIENT_ID, SETU_CLIENT_SECRET, and SETU_DIGILOCKER_PRODUCT_INSTANCE_ID/SETU_PAN_PRODUCT_INSTANCE_ID in .env (get these from Setu\'s KYC dashboard)');
  }
  return {
    'Content-Type': 'application/json',
    'x-client-id': SETU_CLIENT_ID,
    'x-client-secret': SETU_CLIENT_SECRET,
    'x-product-instance-id': productInstanceId,
  };
}

async function createDigilockerRequest(redirectUrl) {
  const res = await fetch(`${BASE_URL}/api/digilocker/`, {
    method: 'POST', headers: headers(process.env.SETU_DIGILOCKER_PRODUCT_INSTANCE_ID), body: JSON.stringify({ redirectUrl }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Setu DigiLocker init failed (${res.status}): ${JSON.stringify(body)}`);
  return body; // { id, status, url, validUpto }
}

async function fetchDigilockerAadhaar(requestId) {
  const res = await fetch(`${BASE_URL}/api/digilocker/${requestId}/aadhaar`, { headers: headers(process.env.SETU_DIGILOCKER_PRODUCT_INSTANCE_ID) });
  const body = await res.json();
  if (!res.ok) throw new Error(`Setu DigiLocker fetch failed (${res.status}): ${JSON.stringify(body)}`);
  return body; // { aadhaar: {...}, id, status }
}

async function revokeDigilocker(requestId) {
  const res = await fetch(`${BASE_URL}/api/digilocker/${requestId}/revoke`, { headers: headers(process.env.SETU_DIGILOCKER_PRODUCT_INSTANCE_ID) });
  return res.json();
}

async function verifyPan(pan, reason) {
  const res = await fetch(`${BASE_URL}/api/verify/pan`, {
    method: 'POST', headers: headers(process.env.SETU_PAN_PRODUCT_INSTANCE_ID),
    body: JSON.stringify({ pan, consent: 'Y', reason: reason || 'TSG Workforce contract worker onboarding' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Setu PAN verify failed (${res.status}): ${JSON.stringify(body)}`);
  return body; // { data, message, verification, traceId }
}

function isConfigured() {
  return !!(process.env.SETU_CLIENT_ID && process.env.SETU_CLIENT_SECRET && process.env.SETU_DIGILOCKER_PRODUCT_INSTANCE_ID);
}
function panApiConfiguredDirect() {
  return !!(process.env.SETU_CLIENT_ID && process.env.SETU_CLIENT_SECRET && process.env.SETU_PAN_PRODUCT_INSTANCE_ID);
}

module.exports = { createDigilockerRequest, fetchDigilockerAadhaar, revokeDigilocker, verifyPan, isConfigured, panApiConfiguredDirect };
