const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { workerIdScopeSql, PUNCH_RESULT_RESTRICTION } = require('../rbac');
const { haversineMeters } = require('../services/geo');
const gemini = require('../services/geminiClient');

const router = express.Router();

function todayStr(ts) { return new Date(ts).toISOString().slice(0, 10); }

// ---- Worker: punch in/out — every check here runs server-side against server-held
// data (BRD: "A punch is saved only if location, face and phone pass the server
// checks" / "Server time is saved, not phone time"). The client cannot spoof the
// worker's assigned location, the geofence radius, or the timestamp. ----
router.post('/', requireAuth('worker'), async (req, res) => {
  const { type, lat, lng, accuracy, selfieDataUrl, deviceId } = req.body || {};
  if (type !== 'in' && type !== 'out') return res.status(400).json({ error: 'type must be "in" or "out"' });
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng are required' });
  if (!selfieDataUrl) return res.status(400).json({ error: 'selfieDataUrl is required — live camera capture only (FR-K05/R09)' });
  // BRD §7.8: "Punching is always done by the worker" — a Site HR assisted-registration
  // token (routes/assisted.js) must never punch, or bind HR's phone as the worker's.
  if (req.auth.assistedBy) return res.status(403).json({ error: 'Punching is always done by the worker on their own phone' });

  const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status !== 'approved') return res.status(403).json({ error: `Cannot punch — registration status is "${w.status}", not approved (R07)` });

  // Device binding (R03: one phone per worker; change needs HR approval).
  if (!w.device_id && deviceId) {
    db.prepare('UPDATE workers SET device_id = ? WHERE id = ?').run(deviceId, w.id);
  } else if (w.device_id && deviceId && w.device_id !== deviceId) {
    logBlocked(w.id, type, lat, lng, accuracy, null, selfieDataUrl, deviceId, 'device_mismatch');
    return res.status(403).json({ error: 'This device is not the one registered for this worker — ask HR to approve a device change' });
  }

  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(w.location_id);
  if (!loc) return res.status(400).json({ error: 'Worker has no assigned location — ask HR to fix this in the worker record' });

  const distanceM = Math.round(haversineMeters(lat, lng, loc.lat, loc.lng));

  if (accuracy != null && accuracy > loc.accuracy_limit) {
    logBlocked(w.id, type, lat, lng, accuracy, distanceM, selfieDataUrl, deviceId, 'low_accuracy');
    return res.status(422).json({ error: `GPS accuracy too low (${Math.round(accuracy)}m, limit ${loc.accuracy_limit}m) — move to an open area and try again`, blocked: true, reason: 'low_accuracy', distanceM, accuracy });
  }
  if (distanceM > loc.radius) {
    logBlocked(w.id, type, lat, lng, accuracy, distanceM, selfieDataUrl, deviceId, 'outside_geofence');
    return res.status(422).json({ error: `Outside the geofenced work location (${distanceM}m away, radius ${loc.radius}m)`, blocked: true, reason: 'outside_geofence', distanceM, accuracy });
  }

  const now = Date.now(); // server time, never trust a client-supplied timestamp
  const today = todayStr(now);
  const todaysPunches = db.prepare("SELECT * FROM punches WHERE worker_id = ? AND result = 'ok' AND date(ts / 1000, 'unixepoch') = date(? / 1000, 'unixepoch') ORDER BY ts")
    .all(w.id, now);
  const hasIn = todaysPunches.some(p => p.type === 'in');
  const hasOut = todaysPunches.some(p => p.type === 'out');
  if (type === 'in' && hasIn) return res.status(409).json({ error: 'Already punched in today (R09: one punch-in per day)' });
  if (type === 'out' && !hasIn) return res.status(409).json({ error: 'Cannot punch out before punching in' });
  if (type === 'out' && hasOut) return res.status(409).json({ error: 'Already punched out today' });

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
  // mismatch only actually blocks if a second, independent call agrees — one noisy
  // "no" no longer blocks on its own, both calls have to say "no".
  let faceMatchNote = null;
  if (gemini.isConfigured() && w.photo_data_url) {
    const first = await gemini.compareFaces(w.photo_data_url, selfieDataUrl);
    if (first.ok) {
      const firstNote = `samePerson=${first.samePerson} confidence=${first.confidence} spoofSuspected=${first.spoofSuspected}: ${first.reason}`;
      if (!first.samePerson && first.confidence >= 0.75) {
        const second = await gemini.compareFaces(w.photo_data_url, selfieDataUrl);
        if (second.ok && !second.samePerson && second.confidence >= 0.75) {
          faceMatchNote = `[check 1] ${firstNote} | [check 2 confirmed] samePerson=${second.samePerson} confidence=${second.confidence}: ${second.reason}`;
          logBlocked(w.id, type, lat, lng, accuracy, distanceM, selfieDataUrl, deviceId, 'face_mismatch', faceMatchNote);
          return res.status(422).json({ error: `Selfie doesn't appear to match the registered photo (${second.reason})`, blocked: true, reason: 'face_mismatch', distanceM, accuracy });
        }
        faceMatchNote = second.ok
          ? `[check 1] ${firstNote} | [check 2 overturned it] samePerson=${second.samePerson} confidence=${second.confidence}: ${second.reason} — allowed`
          : `[check 1] ${firstNote} | [check 2 failed: ${second.error}] — allowed, not treating one noisy read as fraud`;
      } else {
        faceMatchNote = firstNote;
      }
    } else {
      faceMatchNote = `face check unavailable: ${first.error}`;
    }
  }

  const id = crypto.randomUUID();
  // vendor_id/location_id stamped at punch time so the vendor bill check (R16) bills the
  // vendor the worker belonged to that day, even after a later transfer.
  db.prepare(`INSERT INTO punches (id, worker_id, type, ts, lat, lng, accuracy, distance_m, selfie_data_url, result, reason, device_id, face_match_note, vendor_id, location_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, w.id, type, now, lat, lng, accuracy || null, distanceM, selfieDataUrl, 'ok', null, deviceId || null, faceMatchNote, w.vendor_id, w.location_id, now);
  addAudit(w.mobile, 'punch_' + type, `${type.toUpperCase()} at ${new Date(now).toISOString()}, ${distanceM}m from ${loc.name}`);

  res.json({ ok: true, id, type, ts: now, distanceM, accuracy });
});

function logBlocked(workerId, type, lat, lng, accuracy, distanceM, selfieDataUrl, deviceId, reason, faceMatchNote) {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO punches (id, worker_id, type, ts, lat, lng, accuracy, distance_m, selfie_data_url, result, reason, device_id, face_match_note, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, workerId, type, now, lat, lng, accuracy || null, distanceM, selfieDataUrl, 'blocked', reason, deviceId || null, faceMatchNote || null, now);
  addAudit(workerId, 'punch_blocked', `${type} blocked: ${reason}`);
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
  if (date) { sql += " AND date(punches.ts / 1000, 'unixepoch') = ?"; args.push(date); }
  if (result) { sql += ' AND punches.result = ?'; args.push(result); }
  sql += ' ORDER BY punches.ts DESC LIMIT 500';
  res.json(db.prepare(sql).all(...args));
});

module.exports = router;
