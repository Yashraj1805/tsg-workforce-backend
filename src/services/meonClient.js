// Meon (meon.co.in) KYC APIs — the provider TSG signed up with on 2026-10-10.
//
//   Vehicle (Vahan) RC lookup — used by the TSG website's "car details" feature via
//   routes/vehicle.js. Confirmed live on 2026-10-10: only X-API-Key is checked (the
//   X-Signature header in the sample request is accepted but not required, and the
//   same Idempotency-Key returns the cached result).
//
//   DigiLocker Aadhaar / PAN fetch — credentials (company id/name + secret token) are in
//   MEON_COMPANY_ID / MEON_COMPANY_NAME / MEON_SECRET_TOKEN; the endpoint shapes are filled
//   in from Meon's developer portal docs (developer.meon.co.in, login required).
const crypto = require('node:crypto');

const VAHAN_URL = process.env.MEON_VAHAN_URL || 'https://api.meon.co.in/api/v1/public/vahan-verify/v1/vahan-verify/';
const REG_NO_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$/; // e.g. MH12AB1234, DL3CAM0001, UP16BC0001 (normalised: no spaces)

function vahanConfigured() { return !!process.env.MEON_VAHAN_API_KEY; }

function normaliseRegNo(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Returns { ok:true, vehicle:{...clean fields}, raw } or { ok:false, error, notFound? }.
async function vahanVerify(regNoInput) {
  const regNo = normaliseRegNo(regNoInput);
  if (!REG_NO_RE.test(regNo)) return { ok: false, error: 'Enter a valid registration number, e.g. MH12AB1234' };
  if (!vahanConfigured()) return { ok: false, error: 'Vehicle lookup not configured (MEON_VAHAN_API_KEY)' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(VAHAN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.MEON_VAHAN_API_KEY,
        // Same number → same key within the day, so a retry never bills twice.
        'Idempotency-Key': 'tsg-' + crypto.createHash('sha256').update(regNo + ':' + new Date().toISOString().slice(0, 10)).digest('hex').slice(0, 24),
      },
      body: JSON.stringify({ vehiclenumber: regNo }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `Vehicle service error (${res.status})`, raw: json };
    const d = json?.data?.result?.response?.[0]?.response_json?.VehicleDetails;
    if (!d) return { ok: false, error: json?.data?.result?.message || json?.message || 'No vehicle data in response', raw: json };
    // Vahan returns an empty shell for numbers it does not know.
    if (!d.rc_regn_dt && !d.rc_maker_desc && !d.rc_owner_name) return { ok: false, notFound: true, error: 'No record found for this registration number', raw: json };
    return { ok: true, regNo, vehicle: cleanVehicle(d), raw: json };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Vehicle service timed out' : e.message };
  } finally { clearTimeout(timer); }
}

// The fields a website visitor actually wants, in plain names. Owner name comes back
// masked from Vahan already; address fields are dropped (not needed, personal data).
function cleanVehicle(d) {
  const v = (k) => (d[k] == null || d[k] === '' ? null : String(d[k]).trim());
  return {
    registrationNumber: v('rc_regn_no'),
    registrationDate: v('rc_regn_dt'),
    registeredAt: v('rc_registered_at'),
    state: v('state_cd'),
    status: v('rc_status'),
    statusAsOn: v('rc_status_as_on'),
    maker: v('rc_maker_desc'),
    model: v('rc_maker_model') || v('rc_model_cd'),
    variantClass: v('rc_vh_class_desc'),
    category: v('rc_vch_catg_desc'),
    bodyType: v('rc_body_type_desc'),
    fuel: v('rc_fuel_desc'),
    colour: v('rc_color'),
    engineCc: v('rc_cubic_cap'),
    cylinders: v('rc_no_cyl'),
    seats: v('rc_seat_cap'),
    unladenWeightKg: v('rc_unld_wt'),
    grossWeightKg: v('rc_gvw'),
    manufactured: v('rc_manu_month_yr'),
    emissionNorms: v('rc_norms_desc'),
    ownerNameMasked: v('rc_owner_name'),
    ownerSerial: v('rc_owner_sr'),
    ownerCategory: v('rc_own_catg_desc'),
    financer: v('rc_financer'),
    engineNumberMasked: v('rc_eng_no'),
    chassisNumberMasked: v('rc_chasi_no'),
    fitnessUpto: v('rc_fit_upto'),
    taxUpto: v('rc_tax_upto'),
    insuranceCompany: v('rc_insurance_comp'),
    insuranceUpto: v('rc_insurance_upto'),
    insurancePolicyNo: v('rc_insurance_policy_no'),
    puccNo: v('rc_pucc_no'),
    puccUpto: v('rc_pucc_upto'),
    blacklistStatus: v('rc_blacklist_status'),
    nocDetails: v('rc_noc_details'),
  };
}

// ---------------- DigiLocker Aadhaar + PAN fetch ----------------
// Confirmed live on 2026-10-10 against Meon's developer-portal reference:
//   POST /get_access_token   {company_name, secret_token}                        → {client_token, state}
//   POST /digi_url           {client_token, redirect_url, company_name, documents} → {url}  (worker opens it)
//   POST /v2/send_entire_data{client_token, state, status:true}                   → 204 until the worker has
//        consented; then {data:{aadhar_no:"xxxxxxxx7845", name, dob:"14-1-2002", gender, fathername,
//        house/locality/dist/state/pincode, adharimg, pan_number (masked), name_on_pan, …}}
//   POST /export_pan_detail  {client_token, state, status:true}                   → PAN details
const DIGI_URL = process.env.MEON_DIGILOCKER_URL || 'https://digilocker.meon.co.in';

function digilockerConfigured() { return !!(process.env.MEON_COMPANY_NAME && process.env.MEON_SECRET_TOKEN); }

async function meonPost(path, body, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(DIGI_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
    return { status: res.status, json, text };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Meon DigiLocker timed out' : `Meon DigiLocker unreachable: ${e.message}`);
  } finally { clearTimeout(timer); }
}

async function getAccessToken() {
  if (!digilockerConfigured()) throw new Error('Meon DigiLocker not configured (MEON_COMPANY_NAME / MEON_SECRET_TOKEN)');
  const r = await meonPost('/get_access_token', { company_name: process.env.MEON_COMPANY_NAME, secret_token: process.env.MEON_SECRET_TOKEN });
  if (!r.json || !r.json.client_token || !r.json.state) throw new Error(`Meon token failed (${r.status}): ${r.text.slice(0, 200)}`);
  return { clientToken: r.json.client_token, state: r.json.state };
}

// Returns { id: state, clientToken, url } — `id` is what the app polls with later.
async function createDigilockerLink(redirectUrl, documents = 'aadhaar,pan') {
  const { clientToken, state } = await getAccessToken();
  const r = await meonPost('/digi_url', { client_token: clientToken, redirect_url: redirectUrl, company_name: process.env.MEON_COMPANY_NAME, documents });
  if (!r.json || !r.json.url) throw new Error(`Meon link failed (${r.status}): ${(r.json && r.json.msg) || r.text.slice(0, 200)}`);
  return { id: state, clientToken, url: r.json.url };
}

const pick = (o, k) => (o && o[k] != null && String(o[k]).trim() !== '' ? String(o[k]).trim() : null);

// Normalises Meon's "14-1-2002" / "14/01/2002" / "2002-01-14" to YYYY-MM-DD.
function isoDob(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// { status: 'pending' } until the worker finishes at DigiLocker; then
// { status: 'complete', aadhaar: {...}, pan: {...}|null, raw }.
async function fetchDigilockerData(clientToken, state) {
  const r = await meonPost('/v2/send_entire_data', { client_token: clientToken, state, status: true });
  if (r.status === 204 || !r.json) return { status: 'pending' };
  if (r.json.success === false || !r.json.data) {
    if (/invalid client token/i.test(r.json.msg || '')) return { status: 'pending' };
    throw new Error(`Meon data fetch failed (${r.status}): ${r.json.msg || r.text.slice(0, 200)}`);
  }
  const d = r.json.data;
  const digits = String(pick(d, 'aadhar_no') || '').replace(/\D/g, '');
  const last4 = digits.slice(-4);
  const address = [pick(d, 'house'), pick(d, 'locality'), pick(d, 'dist'), pick(d, 'state'), pick(d, 'pincode')].filter(Boolean).join(', ') || null;
  const aadhaar = {
    maskedNumber: last4 ? `XXXX-XXXX-${last4}` : null,
    last4: last4 || null,
    name: pick(d, 'name'),
    dateOfBirth: isoDob(pick(d, 'dob')),
    gender: pick(d, 'gender'),
    fatherName: pick(d, 'fathername'),
    address,
    photoUrl: pick(d, 'adharimg') || pick(d, 'aadhar_img_filename'),
    xmlUrl: pick(d, 'aadhar_xml'),
    fetchedAt: pick(d, 'date_time'),
  };
  const panNo = pick(d, 'pan_number');
  const pan = panNo || pick(d, 'name_on_pan') ? { number: panNo, name: pick(d, 'name_on_pan'), masked: !!panNo && /\*/.test(panNo), imageUrl: pick(d, 'pan_image_path') } : null;
  return { status: 'complete', aadhaar, pan, raw: d };
}

// Full PAN details (the entire-data call masks the number). Shape not published in the
// portal reference; the common keys are tried and the raw payload is returned too.
async function fetchPanDetail(clientToken, state) {
  const r = await meonPost('/export_pan_detail', { client_token: clientToken, state, status: true });
  if (r.status === 204 || !r.json) return { status: 'pending' };
  if (r.json.success === false) return { status: 'error', error: r.json.msg || `HTTP ${r.status}`, raw: r.json };
  const d = r.json.data || r.json;
  const number = pick(d, 'pan_number') || pick(d, 'pan') || pick(d, 'panNumber') || pick(d, 'pan_no');
  const name = pick(d, 'name_on_pan') || pick(d, 'name') || pick(d, 'full_name') || pick(d, 'pan_name');
  return { status: 'complete', number: number ? number.toUpperCase() : null, name, dateOfBirth: isoDob(pick(d, 'dob')), raw: d };
}

module.exports = { vahanVerify, vahanConfigured, normaliseRegNo, REG_NO_RE, digilockerConfigured, getAccessToken, createDigilockerLink, fetchDigilockerData, fetchPanDetail, isoDob };
