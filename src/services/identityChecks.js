// Registration identity checks (BRD R06 "Block duplicate Aadhaar, PAN, mobile or face",
// R14 "Blacklisted Aadhaar cannot register again", §8 "Removed worker joins through
// another vendor → Blacklist on Aadhaar, PAN and face").
//
// Two different questions, answered separately so each gets its own message and audit:
//  - blacklist: does this Aadhaar / PAN / face belong to a worker HR exited with
//    blacklisting? → can never register again, through any vendor.
//  - duplicate: is it already on another live registration (draft, pending, sent back,
//    approved)? Rejected and plain-exited (not blacklisted) records don't count — a
//    worker who left normally may rejoin later.
const { db } = require('../db');
const gemini = require('./geminiClient');

const LIVE = "status NOT IN ('rejected', 'exited')";

function blacklistHit(field, value, excludeId) {
  if (!value) return null;
  return db.prepare(`SELECT id, name FROM workers WHERE ${field} = ? AND id != ? AND blacklisted = 1`).get(value, excludeId);
}
function duplicateHit(field, value, excludeId) {
  if (!value) return null;
  return db.prepare(`SELECT id, name FROM workers WHERE ${field} = ? AND id != ? AND blacklisted = 0 AND ${LIVE}`).get(value, excludeId);
}

const LABEL = { aadhaar_key: 'Aadhaar', pan_number: 'PAN' };

// Returns null if fine, else { status, error, audit } for the route to send back.
function checkDocument(field, value, workerId) {
  const bl = blacklistHit(field, value, workerId);
  if (bl) return { status: 403, kind: 'blacklisted', error: `This ${LABEL[field]} is blacklisted and cannot register again`, audit: `${LABEL[field]} matches blacklisted worker ${bl.name} (${bl.id})` };
  const dup = duplicateHit(field, value, workerId);
  if (dup) return { status: 409, kind: 'duplicate', error: `This ${LABEL[field]} is already registered to worker ${dup.name} (R06 duplicate block)`, audit: `${LABEL[field]} duplicates worker ${dup.name} (${dup.id})` };
  return null;
}

// ---- Face (R06 + blacklist on face) ----
// Compares the registrant's live photo with every live and blacklisted worker's photo,
// a few candidates per Gemini call. Same caution as the punch face check (punches.js):
// a vision-model "match" is noisy, so it only blocks if a second, independent pairwise
// comparison agrees. If Gemini is unavailable the check is skipped, not failed — the
// note tells HR it didn't run, and HR still sees both photos at approval.
const BATCH = 6;
const CONCURRENCY = 3;
const MATCH_CONFIDENCE = 0.8;

async function checkFace(worker) {
  if (!worker.photo_data_url) return { ok: true, note: 'face check: no registration photo' };
  if (!gemini.isConfigured()) return { ok: true, note: 'face check skipped: GEMINI_API_KEY not set' };

  const candidates = db.prepare(`SELECT id, name, photo_data_url, blacklisted FROM workers
      WHERE id != ? AND photo_data_url IS NOT NULL AND (blacklisted = 1 OR ${LIVE})
        AND (gender IS NULL OR ? IS NULL OR gender = ?)`)
    .all(worker.id, worker.gender || null, worker.gender || null);
  if (!candidates.length) return { ok: true, note: 'face check: no other workers to compare' };

  const batches = [];
  for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));
  const errors = [];
  let suspect = null;
  for (let i = 0; i < batches.length && !suspect; i += CONCURRENCY) {
    const results = await Promise.all(batches.slice(i, i + CONCURRENCY).map(b =>
      gemini.findMatchingFace(worker.photo_data_url, b.map(c => c.photo_data_url)).then(r => ({ r, b }))));
    for (const { r, b } of results) {
      if (!r.ok) { errors.push(r.error); continue; }
      if (r.matchIndex >= 1 && r.matchIndex <= b.length && r.confidence >= MATCH_CONFIDENCE) { suspect = { cand: b[r.matchIndex - 1], first: r }; break; }
    }
  }
  if (!suspect) {
    return { ok: true, note: errors.length ? `face check incomplete (${errors.length} of ${batches.length} batches failed: ${errors[0]}) — no match in the rest` : `face check: no match among ${candidates.length} workers` };
  }
  const confirm = await gemini.compareFaces(suspect.cand.photo_data_url, worker.photo_data_url);
  const desc = `${suspect.cand.name} (${suspect.cand.id})${suspect.cand.blacklisted ? ' [BLACKLISTED]' : ''}`;
  if (confirm.ok && confirm.samePerson && confirm.confidence >= MATCH_CONFIDENCE) {
    return {
      ok: false,
      kind: suspect.cand.blacklisted ? 'blacklisted' : 'duplicate',
      status: suspect.cand.blacklisted ? 403 : 409,
      error: suspect.cand.blacklisted
        ? 'This person matches a blacklisted worker and cannot register again'
        : `This person appears to be already registered as ${suspect.cand.name} (R06 duplicate face)`,
      note: `face matches ${desc}: ${suspect.first.reason} | confirmed: ${confirm.reason}`,
    };
  }
  return { ok: true, note: `face check: possible match with ${desc} not confirmed by second check (${confirm.ok ? confirm.reason : confirm.error}) — HR please compare` };
}

module.exports = { checkDocument, checkFace };
