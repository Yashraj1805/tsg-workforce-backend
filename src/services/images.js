// Every image the app uploads arrives as a base64 data URL in JSON. Before anything is
// stored or sent to Gemini it must (a) be a real JPEG/PNG — a value like
// `x" onerror="…` must never reach an <img src> in the HR portal, and (b) be within a
// size budget, so one phone with a broken shrink step can't fill the database.
const LIMITS = {
  frame: 600 * 1024,        // low-res preview frames for face-detect / liveness
  selfie: 2500 * 1024,      // punch selfie (phones should send ~150 KB; tightened once verified)
  photo: 3000 * 1024,       // registration photo
  document: 4000 * 1024,    // PAN card / Aadhaar QR / passbook photos
};
const MAGIC = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47] };
const RE = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/]+={0,2})$/;

function imageBytes(value) {
  const m = RE.exec(value || '');
  return m ? Math.floor(m[2].length * 3 / 4) : 0;
}

// Returns null when the value is acceptable (or absent), else a message for a 400/413.
// `kind` picks the size budget from LIMITS.
function checkImage(value, kind, label) {
  if (value == null || value === '') return null;
  const name = label || 'Image';
  if (typeof value !== 'string') return { status: 400, error: `${name} must be an image` };
  const m = RE.exec(value);
  if (!m) return { status: 400, error: `${name} must be a JPEG or PNG photo` };
  const bytes = Math.floor(m[2].length * 3 / 4);
  const max = LIMITS[kind] || LIMITS.document;
  if (bytes > max) return { status: 413, error: `${name} is too large (${Math.round(bytes / 1024)} KB, limit ${Math.round(max / 1024)} KB) — update the app or retake the photo` };
  const head = Buffer.from(m[2].slice(0, 12), 'base64');
  const magic = MAGIC[m[1] === 'png' ? 'png' : 'jpeg'];
  if (magic.some((b, i) => head[i] !== b)) return { status: 400, error: `${name} is not a valid ${m[1].toUpperCase()} photo` };
  return null;
}

// Checks several body fields at once: spec = { selfieDataUrl: 'selfie', livenessFrameDataUrl: 'frame' }.
// Returns the first problem as { status, error } or null.
function checkImages(body, spec) {
  for (const [field, kind] of Object.entries(spec)) {
    const bad = checkImage((body || {})[field], kind, field.replace(/DataUrl$/, '').replace(/([A-Z])/g, ' $1').trim());
    if (bad) return bad;
  }
  return null;
}

module.exports = { checkImage, checkImages, imageBytes, LIMITS };
