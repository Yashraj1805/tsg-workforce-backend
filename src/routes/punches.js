const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { workerIdScopeSql, PUNCH_RESULT_RESTRICTION } = require('../rbac');
const { haversineMeters } = require('../services/geo');
const gemini = require('../services/geminiClient');
const { sqlDay } = require('../services/time');
const { alertBlockedPunch } = require('../services/alerts');

const router = express.Router();

// Fake-GPS heuristics (BRD R10 "Block punch ... with fake GPS"; §8 "Fake GPS apps
// blocked"). The phone's own mock-location flag is the main signal; the server adds a
// physical-plausibility check it can do without trusting the phone at all.
const TELEPORT_MIN_M = 2000;      // only judge speed over a real distance
const TELEPORT_MAX_KMH = 250;     // faster than any road travel between two punches
const TELEPORT_WINDOW_MS = 6 * 3600000;

// ---- Every punch check, in one place. Runs server-side against server-held data (BRD:
// "A punch is saved only if location, face and phone pass the server checks" / "Server
// time is saved, not phone time"). Used by the live punch below and by offline sync
// (R19), which passes the reconstructed original time as `ts`.
// Returns { ok: true, punch } or { ok: false, status, body }.
async function evaluatePunch(w, input, ts, opts = {}) {
  const { type, lat, lng, accuracy, selfieDataUrl, deviceId, integrity } = input;
  const block = (reason, status, error, note, distanceM) => {
    logBlocked(w, type, lat, lng, accuracy, distanceM == null ? null : distanceM, selfieDataUrl, deviceId, reason, note, ts, opts.offline);
    return { ok: false, status, body: { error, blocked: true, reason, distanceM, accuracy } };
  };

  // Device binding (R03: one phone per worker; change needs HR approval).
  if (w.device_id && deviceId && w.device_id !== deviceId) {
    return block('device_mismatch', 403, 'This device is not the one registered for this worker — ask HR to approve a device change');
  }

  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(w.location_id);
  if (!loc) return { ok: false, status: 400, body: { error: 'Worker has no assigned location — ask HR to fix this in the worker record' } };
  const distanceM = Math.round(haversineMeters(lat, lng, loc.lat, loc.lng));

  // Fake GPS: the phone reports a mock-location fix → block.
  if (integrity && (integrity.mock || integrity.legacyMockSetting)) {
    return block('fake_gps', 422, 'A fake-location app is active on this phone — turn it off and punch again', `phone reported mock location (fixes checked: ${integrity.fixesChecked ?? '?'})`, distanceM);
  }
  // Fake GPS: impossible travel since this worker's previous punch attempt.
  const prev = db.prepare('SELECT ts, lat, lng FROM punches WHERE worker_id = ? AND lat IS NOT NULL AND ts < ? ORDER BY ts DESC LIMIT 1').get(w.id, ts);
  if (prev && ts - prev.ts < TELEPORT_WINDOW_MS) {
    const moved = haversineMeters(lat, lng, prev.lat, prev.lng);
    const kmh = (moved / 1000) / Math.max((ts - prev.ts) / 3600000, 1 / 3600);
    if (moved > TELEPORT_MIN_M && kmh > TELEPORT_MAX_KMH) {
      return block('fake_gps', 422, 'Location jumped impossibly far since your last punch — fake GPS suspected', `moved ${Math.round(moved / 1000)} km in ${Math.round((ts - prev.ts) / 60000)} min (${Math.round(kmh)} km/h)`, distanceM);
    }
  }
  // Real GPS never returns exactly the same coordinates on different days; a spoofing
  // app often does. Not blocked on its own (could be a cached fix) — noted and alerted.
  const sameSpot = db.prepare(`SELECT 1 FROM punches WHERE worker_id = ? AND lat = ? AND lng = ? AND ${sqlDay('ts')} != ${sqlDay('?')} LIMIT 1`).get(w.id, lat, lng, ts);
  const integrityNote = sameSpot ? 'exact same coordinates as a punch on another day (possible fake GPS)' : null;

  if (accuracy != null && accuracy > loc.accuracy_limit) {
    return block('low_accuracy', 422, `GPS accuracy too low (${Math.round(accuracy)}m, limit ${loc.accuracy_limit}m) — move to an open area and try again`, null, distanceM);
  }
  if (distanceM > loc.radius) {
    return block('outside_geofence', 422, `Outside the geofenced work location (${distanceM}m away, radius ${loc.radius}m)`, null, distanceM);
  }

  const dayPunches = db.prepare(`SELECT * FROM punches WHERE worker_id = ? AND result = 'ok' AND ${sqlDay('ts')} = ${sqlDay('?')} ORDER BY ts`).all(w.id, ts);
  const hasIn = dayPunches.some(p => p.type === 'in');
  const hasOut = dayPunches.some(p => p.type === 'out');
  if (type === 'in' && hasIn) return { ok: false, status: 409, body: { error: 'Already punched in today (R09: one punch-in per day)' } };
  if (type === 'out' && !hasIn) return { ok: false, status: 409, body: { error: 'Cannot punch out before punching in' } };
  if (type === 'out' && hasOut) return { ok: false, status: 409, body: { error: 'Already punched out today' } };
  if (type === 'out' && ts <= Math.max(...dayPunches.filter(p => p.type === 'in').map(p => p.ts))) {
    return { ok: false, status: 409, body: { error: 'Punch-out time is before the punch-in time' } };
  }

  // Automated face-match (Gemini vision judgement — not a certified biometric API; see
  // geminiClient.js). Only runs if a key is configured and the worker has a registration
  // photo to compare against. An error in the check itself (timeout, bad key, API
  // outage) does NOT block a legitimate worker — it's logged on the punch record for
  // HR to see, not treated as a fraud signal.
  //
  // A single vision-model call is noisy enough on its own (confirmed live: the same
  // real worker got a clean match on punch-in and a false mismatch on punch-out a few
  // minutes later, same face, same device) that blocking on one borderline read is too
  // fragile for something that locks a legitimate worker out of clocking out. So a
  // mismatch — or a "photo of a screen/photo" spoof verdict (BRD §8: "Face match with
  // live check") — only blocks if a second, independent call agrees.
  let faceMatchNote = null;
  if (gemini.isConfigured() && w.photo_data_url) {
    const first = await gemini.compareFaces(w.photo_data_url, selfieDataUrl);
    if (first.ok) {
      const firstNote = `samePerson=${first.samePerson} confidence=${first.confidence} spoofSuspected=${first.spoofSuspected}: ${first.reason}`;
      const mismatch = !first.samePerson && first.confidence >= 0.75;
      if (mismatch || first.spoofSuspected) {
        const second = await gemini.compareFaces(w.photo_data_url, selfieDataUrl);
        const secondNote = second.ok ? `samePerson=${second.samePerson} confidence=${second.confidence} spoofSuspected=${second.spoofSuspected}: ${second.reason}` : `failed: ${second.error}`;
        if (second.ok && mismatch && !second.samePerson && second.confidence >= 0.75) {
          return block('face_mismatch', 422, `Selfie doesn't appear to match the registered photo (${second.reason})`, `[check 1] ${firstNote} | [check 2 confirmed] ${secondNote}`, distanceM);
        }
        if (second.ok && first.spoofSuspected && second.spoofSuspected) {
          return block('spoof_suspected', 422, 'This looks like a photo of a photo or a screen — take a live selfie', `[check 1] ${firstNote} | [check 2 confirmed spoof] ${secondNote}`, distanceM);
        }
        faceMatchNote = `[check 1] ${firstNote} | [check 2 did not confirm] ${secondNote} — allowed`;
      } else {
        faceMatchNote = firstNote;
      }
    } else {
      faceMatchNote = `face check unavailable: ${first.error}`;
    }
  }
  if (integrityNote) {
    faceMatchNote = [faceMatchNote, integrityNote].filter(Boolean).join(' | ');
    alertBlockedPunch(w, 'gps_suspicious', integrityNote);
  }

  // Bind the phone on first successful punch (R03).
  if (!w.device_id && deviceId) db.prepare('UPDATE workers SET device_id = ? WHERE id = ?').run(deviceId, w.id);

  const id = crypto.randomUUID();
  // vendor_id/location_id stamped at punch time so the vendor bill check (R16) bills the
  // vendor the worker belonged to that day, even after a later transfer.
  db.prepare(`INSERT INTO punches (id, worker_id, type, ts, lat, lng, accuracy, distance_m, selfie_data_url, result, reason, device_id, face_match_note, vendor_id, location_id, offline, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, w.id, type, ts, lat, lng, accuracy || null, distanceM, selfieDataUrl, 'ok', null, deviceId || null, faceMatchNote, w.vendor_id, w.location_id, opts.offline ? 1 : 0, Date.now());
  addAudit(w.mobile, 'punch_' + type, `${type.toUpperCase()} at ${new Date(ts).toISOString()}${opts.offline ? ' (offline, synced later)' : ''}, ${distanceM}m from ${loc.name}`);
  return { ok: true, punch: { id, type, ts, distanceM, accuracy, location: loc.name } };
}

router.post('/', requireAuth('worker'), async (req, res) => {
  const { type, lat, lng, selfieDataUrl } = req.body || {};
  if (type !== 'in' && type !== 'out') return res.status(400).json({ error: 'type must be "in" or "out"' });
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng are required' });
  if (!selfieDataUrl) return res.status(400).json({ error: 'selfieDataUrl is required — live camera capture only (FR-K05/R09)' });
  // BRD §7.8: "Punching is always done by the worker" — a Site HR assisted-registration
  // token (routes/assisted.js) must never punch, or bind HR's phone as the worker's.
  if (req.auth.assistedBy) return res.status(403).json({ error: 'Punching is always done by the worker on their own phone' });

  const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status !== 'approved') return res.status(403).json({ error: `Cannot punch — registration status is "${w.status}", not approved (R07)` });

  const r = await evaluatePunch(w, req.body, Date.now()); // server time, never a client-supplied timestamp
  if (!r.ok) return res.status(r.status).json(r.body);
  res.json({ ok: true, ...r.punch });
});

function logBlocked(w, type, lat, lng, accuracy, distanceM, selfieDataUrl, deviceId, reason, faceMatchNote, ts, offline) {
  const id = crypto.randomUUID();
  const when = ts || Date.now();
  db.prepare(`INSERT INTO punches (id, worker_id, type, ts, lat, lng, accuracy, distance_m, selfie_data_url, result, reason, device_id, face_match_note, offline, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, w.id, type, when, lat, lng, accuracy || null, distanceM, selfieDataUrl, 'blocked', reason, deviceId || null, faceMatchNote || null, offline ? 1 : 0, Date.now());
  addAudit(w.id, 'punch_blocked', `${type} blocked: ${reason}`);
  // BRD §11 screen 6: "Save the attempt and alert Security."
  alertBlockedPunch(w, reason, faceMatchNote);
}

router.get('/me', requireAuth('worker'), (req, res) => {
  const rows = db.prepare('SELECT * FROM punches WHERE worker_id = ? ORDER BY ts DESC LIMIT 200').all(req.auth.sub);
  res.json(rows);
});

// ---- HR: attendance register / exceptions ----
// Scoped to the caller's workers (rbac.js); Security only ever gets blocked attempts.
// worker_name is joined in so roles without workers.read (Security) can still tell
// whose attempt it was.
router.get('/', requirePermission('punches.read'), (req, res) => {
  const { workerId, date } = req.query;
  const result = PUNCH_RESULT_RESTRICTION[req.user.role] || req.query.result;
  const scope = workerIdScopeSql(req.user, 'punches.worker_id');
  let sql = `SELECT punches.*, workers.name AS worker_name FROM punches LEFT JOIN workers ON workers.id = punches.worker_id WHERE ${scope.sql}`;
  const args = [...scope.args];
  if (workerId) { sql += ' AND punches.worker_id = ?'; args.push(workerId); }
  if (date) { sql += ` AND ${sqlDay('punches.ts')} = ?`; args.push(date); }
  if (result) { sql += ' AND punches.result = ?'; args.push(result); }
  sql += ' ORDER BY punches.ts DESC LIMIT 500';
  res.json(db.prepare(sql).all(...args));
});

module.exports = router;
