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

module.exports = { vahanVerify, vahanConfigured, normaliseRegNo, REG_NO_RE };
