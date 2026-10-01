// Aadhaar QR decoding (BRD R04: "Aadhaar QR" captured by camera). Two formats exist on
// printed Aadhaar / e-Aadhaar cards:
//
//  - Secure QR (all cards since 2019): the QR holds one huge decimal number. As bytes it
//    is gzip-compressed; decompressed, text fields are separated by byte 255, followed
//    by a JPEG2000 photo, optional email/mobile hashes, and a 256-byte RSA-SHA256
//    signature by UIDAI over everything before it. Newer cards prefix the fields with a
//    version marker ("V2", "V3", ...), which shifts every field by one.
//  - Old XML QR (pre-2019 cards): <PrintLetterBarcodeData uid=".." name=".." .../>,
//    unsigned and carrying the full 12-digit number.
//
// Only the last 4 digits, name, DOB/year and gender are kept — never the full number
// (BRD §9). The signature can only be checked against UIDAI's offline-verification
// public certificate (set AADHAAR_QR_CERT_PATH); without it the QR is still useful for
// pre-filling and cross-checking, but the identity itself still has to be verified
// through the API (DigiLocker) before the worker counts as Aadhaar-verified.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs');

const SIGNATURE_BYTES = 256;
const FIELD_SEP = 255;

function bigDecimalToBytes(decimal) {
  let hex = BigInt(decimal).toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

function decompress(bytes) {
  try { return zlib.gunzipSync(bytes); } catch (e) { /* some encoders emit raw zlib */ }
  try { return zlib.inflateSync(bytes); } catch (e) { /* fall through */ }
  return zlib.inflateRawSync(bytes);
}

let cachedCert;
function uidaiCert() {
  if (cachedCert !== undefined) return cachedCert;
  const p = process.env.AADHAAR_QR_CERT_PATH;
  cachedCert = null;
  if (p) {
    cachedCert = new crypto.X509Certificate(fs.readFileSync(p)); // DER or PEM .cer
  }
  return cachedCert;
}

function verifySignature(data) {
  const cert = uidaiCert();
  if (!cert) return 'unchecked';
  const signed = data.subarray(0, data.length - SIGNATURE_BYTES);
  const signature = data.subarray(data.length - SIGNATURE_BYTES);
  return crypto.verify('sha256', signed, cert.publicKey, signature) ? 'valid' : 'invalid';
}

function parseSecureQr(decimal) {
  const data = decompress(bigDecimalToBytes(decimal));
  // Text fields are latin1/utf8 up to the photo; collect the first 17 separators' worth.
  const fields = [];
  let start = 0;
  for (let i = 0; i < data.length && fields.length < 18; i++) {
    if (data[i] === FIELD_SEP) { fields.push(data.subarray(start, i).toString('utf8')); start = i + 1; }
  }
  const offset = /^V\d+$/.test(fields[0] || '') ? 1 : 0;
  const f = (n) => (fields[n + offset] || '').trim();
  const referenceId = f(1); // last 4 digits of Aadhaar + generation timestamp
  const last4 = referenceId.slice(0, 4);
  if (!/^\d{4}$/.test(last4)) throw new Error('Not an Aadhaar Secure QR (no reference id)');
  return {
    format: 'secure',
    version: offset ? fields[0] : 'V1',
    last4,
    name: f(2),
    dob: normaliseDob(f(3)),
    gender: normaliseGender(f(4)),
    pincode: f(10),
    state: f(12),
    careOf: f(5),
    // house, street, landmark, locality, VTC, post office, sub-district, district, state, PIN
    address: joinAddress([f(8), f(13), f(7), f(9), f(15), f(11), f(14), f(6), f(12), f(10)]),
    signature: verifySignature(data),
  };
}

function parseXmlQr(xml) {
  const attr = (k) => { const m = new RegExp(`\\b${k}="([^"]*)"`).exec(xml); return m ? m[1].trim() : ''; };
  const uid = attr('uid').replace(/\D/g, '');
  if (uid.length !== 12) throw new Error('Not an Aadhaar QR (no 12-digit uid)');
  return {
    format: 'xml',
    version: 'xml',
    last4: uid.slice(-4),
    name: attr('name'),
    dob: normaliseDob(attr('dob')) || attr('yob'),
    gender: normaliseGender(attr('gender')),
    pincode: attr('pc'),
    state: attr('state'),
    careOf: attr('co'),
    address: joinAddress([attr('house'), attr('street'), attr('lm'), attr('loc'), attr('vtc'), attr('po'), attr('subdist'), attr('dist'), attr('state'), attr('pc')]),
    signature: 'unsigned', // the old format has no signature at all
  };
}

// Address lines as printed on the card, blanks and repeats dropped.
function joinAddress(parts) {
  const seen = new Set();
  return parts.map(p => (p || '').trim()).filter(p => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).join(', ');
}
// "S/O Ram Kumar" -> "Ram Kumar" (care-of on Aadhaar is the father's / husband's name).
function careOfName(co) { return (co || '').replace(/^\s*(S\/O|D\/O|W\/O|C\/O|H\/O)[:\s]*/i, '').trim(); }

function normaliseDob(s) {
  if (!s) return '';
  let m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s); // DD-MM-YYYY (UIDAI format)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}
function normaliseGender(g) {
  const c = (g || '').trim().toUpperCase()[0];
  return c === 'M' ? 'male' : c === 'F' ? 'female' : c ? 'other' : '';
}

function parseAadhaarQr(text) {
  const t = (text || '').trim();
  if (/^\d{50,}$/.test(t)) return parseSecureQr(t);
  if (t.includes('PrintLetterBarcodeData') || /<\?xml/.test(t)) return parseXmlQr(t);
  throw new Error('This QR code is not an Aadhaar QR — scan the QR printed on the Aadhaar card');
}

// Duplicate/blacklist key for an Aadhaar we never see in full: last 4 digits + DOB.
// Two different people sharing both is ~1 in 10^8, unlike last-4 alone (1 in 10^4).
function aadhaarKey(last4, dob) {
  const d = normaliseDob(dob);
  return /^\d{4}$/.test(last4 || '') && d ? `${last4}|${d}` : null;
}

module.exports = { parseAadhaarQr, aadhaarKey, normaliseDob, careOfName };
