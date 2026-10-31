const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { workerIdScopeSql, PUNCH_RESULT_RESTRICTION } = require('../rbac');
const { haversineMeters } = require('../services/geo');
const gemini = require('../services/geminiClient');
const { sqlDay } = require('../services/time');
const { alertBlockedPunch } = require('../services/alerts');
const { checkImages } = require('../services/images');
const { makeThumb } = require('../services/thumbs');

// Thumbnail for list screens, written after the response so a punch never waits on it.
function attachThumb(punchId, selfieDataUrl) {
  makeThumb(selfieDataUrl).then(t => { if (t) db.prepare('UPDATE punches SET selfie_thumb = ? WHERE id = ?').run(t, punchId); }).catch(() => {});
}
// What a list row carries instead of the full selfie.
const PUNCH_LIST_COLS = 'id, worker_id, type, ts, lat, lng, accuracy, distance_m, result, reason, device_id, face_match_note, vendor_id, location_id, offline, risk_score, risk_reasons, client_id, created_at';
const IMAGE_SPEC = { selfieDataUrl: 'selfie', livenessFrameDataUrl: 'frame' };

const router = express.Router();

// Fake-GPS heuristics (BRD R10 "Block punch ... with fake GPS"; §8 "Fake GPS apps
// blocked"). The phone's own mock-location flag is the main signal; the server adds a
// physical-plausibility check it can do without trusting the phone at all.
const TELEPORT_MIN_M = 2000;      // only judge speed over a real distance
const TELEPORT_MAX_KMH = 250;     // faster than any road travel between two punches
const TELEPORT_WINDOW_MS = 6 * 3600000;
const TELEPORT_MAX_ACCURACY_M = 100; // fixes vaguer than this aren't used for the jump check

// Deterministic risk-triage score (0-100) for an ALLOWED punch — every individual check
// already passed (evaluatePunch's own thresholds decide block/allow), this just flags
// "borderline on several signals at once" for HR to glance at on the Exceptions screen,
// without needing to read every face-match note by hand. No extra Gemini call — built
// entirely from signals evaluatePunch already gathered deciding whether to allow it.
function computeRiskScore({ accuracy, accuracyLimit, distanceM, radius, faceBorderline, integritySuspicious, offline, offlineDelayMin, livenessBorderline }) {
  let score = 0;
  const reasons = [];
  if (accuracy != null && accuracy > accuracyLimit * 0.7) { score += 15; reasons.push('GPS accuracy close to the limit'); }
  if (radius && distanceM > radius * 0.8) { score += 10; reasons.push('near the geofence edge'); }
  if (faceBorderline) { score += 35; reasons.push('face-match was borderline'); }
  if (integritySuspicious) { score += 30; reasons.push('same coordinates as another day'); }
  if (offline) { score += 10; reasons.push('offline punch'); }
  // The claimed capture time of an offline punch comes from the phone. A punch uploaded
  // long after it was supposedly taken is exactly the back-dating case, so it is
  // surfaced to HR rather than silently billed.
  if (offlineDelayMin > 15) { score += 25; reasons.push(`offline punch uploaded ${Math.round(offlineDelayMin)} min after its claimed time`); }
  if (livenessBorderline) { score += 25; reasons.push('liveness check was borderline'); }
  return { score: Math.min(100, score), reasons };
}

// ---- Every punch check, in one place. Runs server-side against server-held data (BRD:
// "A punch is saved only if location, face and phone pass the server checks" / "Server
// time is saved, not phone time"). Used by the live punch below and by offline sync
// (R19), which passes the reconstructed original time as `ts`.
// Returns { ok: true, punch } or { ok: false, status, body }.
async function evaluatePunch(w, input, ts, opts = {}) {
  const { type, selfieDataUrl, deviceId, integrity, livenessFrameDataUrl } = input;
  const block = (reason, status, error, note, distanceM) => {
    const punchId = logBlocked(w, type, lat, lng, accuracy, distanceM == null ? null : distanceM, selfieDataUrl, deviceId, reason, note, ts, opts.offline);
    return { ok: false, status, body: { error, blocked: true, reason, distanceM, accuracy }, punchId };
  };

  // Device binding (R03: one phone per worker; change needs HR approval).
  if (!opts.kiosk && w.device_id && deviceId && w.device_id !== deviceId) {
    return block('device_mismatch', 403, 'This device is not the one registered for this worker — ask HR to approve a device change');
  }

  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(w.location_id);
  if (!loc) return { ok: false, status: 400, body: { error: 'Worker has no assigned location — ask HR to fix this in the worker record' } };
  // A paired gate tablet is bound to its site and never moves, so its position is the
  // site's; it sends no GPS, and the phone-only checks below (fake GPS, teleport, same
  // spot, accuracy, geofence) don't apply to it. Running them on a fixed tablet flagged
  // every gate punch as "same coordinates as another day" and e-mailed Security each time.
  const atGate = !!opts.kiosk;
  const { lat, lng } = atGate ? { lat: loc.lat, lng: loc.lng } : input;
  const accuracy = atGate ? null : input.accuracy;
  const distanceM = atGate ? 0 : Math.round(haversineMeters(lat, lng, loc.lat, loc.lng));

  // Fake GPS: the phone reports a mock-location fix → block.
  if (!atGate && integrity && (integrity.mock || integrity.legacyMockSetting)) {
    return block('fake_gps', 422, 'A fake-location app is active on this phone — turn it off and punch again', `phone reported mock location (fixes checked: ${integrity.fixesChecked ?? '?'})`, distanceM);
  }
  // Fake GPS: impossible travel since this worker's previous punch attempt.
  // Only fixes that claim good accuracy are compared, and both accuracy radii are given
  // the benefit of the doubt — one wildly wrong network fix must not look like a teleport.
  const prev = atGate ? null : db.prepare('SELECT ts, lat, lng, accuracy FROM punches WHERE worker_id = ? AND lat IS NOT NULL AND ts < ? AND (accuracy IS NULL OR accuracy <= ?) ORDER BY ts DESC LIMIT 1').get(w.id, ts, TELEPORT_MAX_ACCURACY_M);
  if (prev && ts - prev.ts < TELEPORT_WINDOW_MS && (accuracy == null || accuracy <= TELEPORT_MAX_ACCURACY_M)) {
    const moved = Math.max(0, haversineMeters(lat, lng, prev.lat, prev.lng) - (accuracy || 0) - (prev.accuracy || 0));
    const kmh = (moved / 1000) / Math.max((ts - prev.ts) / 3600000, 1 / 3600);
    if (moved > TELEPORT_MIN_M && kmh > TELEPORT_MAX_KMH) {
      return block('fake_gps', 422, 'Location jumped impossibly far since your last punch — fake GPS suspected', `moved ${Math.round(moved / 1000)} km in ${Math.round((ts - prev.ts) / 60000)} min (${Math.round(kmh)} km/h)`, distanceM);
    }
  }
  // Real GPS never returns exactly the same coordinates on different days; a spoofing
  // app often does. Not blocked on its own (could be a cached fix) — noted and alerted.
  const sameSpot = atGate ? null : db.prepare(`SELECT 1 FROM punches WHERE worker_id = ? AND lat = ? AND lng = ? AND ${sqlDay('ts')} != ${sqlDay('?')} LIMIT 1`).get(w.id, lat, lng, ts);
  const integrityNote = sameSpot ? 'exact same coordinates as a punch on another day (possible fake GPS)' : null;

  if (accuracy != null && accuracy > loc.accuracy_limit) {
    return block('low_accuracy', 422, `GPS accuracy too low (${Math.round(accuracy)}m, limit ${loc.accuracy_limit}m) — move to an open area and try again`, null, distanceM);
  }
  if (!atGate && distanceM > loc.radius) {
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
  // geminiClient.js). Compares against the Aadhaar photo (DigiLocker), not the
  // registration selfie — the Aadhaar photo is government-sourced, so this is a
  // stronger identity check than trusting the worker's own uploaded photo (2026-10-15,
  // Harpreet). Overridden by reference_photo_url once HR confirms one (see refPhoto
  // above) — an Aadhaar photo can be years old and genuinely stop matching a worker's
  // current face, which is not something a photo check can tell apart from fraud on its
  // own. A worker with neither photo has the check skipped for them the same way a
  // missing registration photo used to skip it — not blocked, just unchecked. Only runs
  // if a key is configured and there's a photo to compare against. An error in the check
  // itself (timeout, bad key, API outage) does NOT block a legitimate worker — it's
  // logged on the punch record for HR to see, not treated as a fraud signal.
  //
  // A single vision-model call is noisy enough on its own (confirmed live: the same
  // real worker got a clean match on punch-in and a false mismatch on punch-out a few
  // minutes later, same face, same device) that blocking on one borderline read is too
  // fragile for something that locks a legitimate worker out of clocking out. So a
  // mismatch — or a "photo of a screen/photo" spoof verdict (BRD §8: "Face match with
  // live check") — only blocks if a second, independent call agrees.
  // A confirmed reference photo (HR-reviewed, see reference_photo_url) wins over the
  // Aadhaar photo — set when the Aadhaar photo is too old to match the worker's current
  // face, which a straight DigiLocker photo has no way to detect on its own.
  const refPhoto = w.reference_photo_url || w.aadhaar_photo_url;
  let faceMatchNote = null;
  let faceBorderline = false;
  if (opts.kiosk) {
    // R20 gate tablet: no personal phone to bind, so the face is the only proof of who is
    // punching — it must positively match, and if it can't be checked the punch is refused.
    if (!gemini.isConfigured() || !refPhoto) return { ok: false, status: 503, body: { error: 'Face check is not available on the gate tablet right now — punch on your phone or ask Team Lead' } };
    const r = await gemini.compareFaces(refPhoto, selfieDataUrl);
    if (!r.ok) return { ok: false, status: 503, body: { error: 'Face check failed — try again' } };
    const kNote = `[gate tablet ${opts.kiosk.name}] samePerson=${r.samePerson} confidence=${r.confidence} spoofSuspected=${r.spoofSuspected}: ${r.reason}`;
    if (r.spoofSuspected) return block('spoof_suspected', 422, 'This looks like a photo of a photo or a screen — look at the camera', kNote, distanceM);
    if (!r.samePerson || r.confidence < 0.75) return block('face_mismatch', 422, 'Face did not match the selected worker', kNote, distanceM);
    faceMatchNote = kNote;
    faceBorderline = r.confidence < 0.9;
  } else if (gemini.isConfigured() && refPhoto) {
    const first = await gemini.compareFaces(refPhoto, selfieDataUrl);
    if (first.ok) {
      const firstNote = `samePerson=${first.samePerson} confidence=${first.confidence} spoofSuspected=${first.spoofSuspected}: ${first.reason}`;
      const mismatch = !first.samePerson && first.confidence >= 0.75;
      if (mismatch || first.spoofSuspected) {
        const second = await gemini.compareFaces(refPhoto, selfieDataUrl);
        const secondNote = second.ok ? `samePerson=${second.samePerson} confidence=${second.confidence} spoofSuspected=${second.spoofSuspected}: ${second.reason}` : `failed: ${second.error}`;
        if (second.ok && mismatch && !second.samePerson && second.confidence >= 0.75) {
          return block('face_mismatch', 422, `Selfie doesn't appear to match your ${w.reference_photo_url ? 'confirmed reference' : 'Aadhaar'} photo (${second.reason})`, `[check 1] ${firstNote} | [check 2 confirmed] ${secondNote}`, distanceM);
        }
        if (second.ok && first.spoofSuspected && second.spoofSuspected) {
          return block('spoof_suspected', 422, 'This looks like a photo of a photo or a screen — take a live selfie', `[check 1] ${firstNote} | [check 2 confirmed spoof] ${secondNote}`, distanceM);
        }
        // A first-check flag that the second call didn't confirm — allowed, but that's
        // exactly the "passed, but only just" case the risk score exists for.
        faceBorderline = true;
        faceMatchNote = `[check 1] ${firstNote} | [check 2 did not confirm] ${secondNote} — allowed`;
      } else {
        faceMatchNote = firstNote;
        faceBorderline = first.confidence < 0.85;
      }
    } else {
      faceMatchNote = `face check unavailable: ${first.error}`;
    }
  }
  if (integrityNote) {
    faceMatchNote = [faceMatchNote, integrityNote].filter(Boolean).join(' | ');
    alertBlockedPunch(w, 'gps_suspicious', integrityNote);
  }

  // Passive liveness (phase 1, anti-spoofing): livenessFrameDataUrl is an earlier,
  // low-res preview frame the app already captured while locking onto the face (see
  // scanFaceForPunch in app.js) — a fraction of a second before selfieDataUrl, at no
  // extra cost to the worker. Same double-check-before-blocking pattern as face-match
  // above, since a single vision-model call is too noisy to lock a legitimate worker
  // out on. Optional: older app builds or a lock on the very first preview frame won't
  // have one, and that's not treated as suspicious on its own.
  let livenessNote = null;
  let livenessBorderline = false;
  if (gemini.isConfigured() && livenessFrameDataUrl) {
    const first = await gemini.checkLiveness(livenessFrameDataUrl, selfieDataUrl);
    if (first.ok) {
      const firstNote = `live=${first.live} confidence=${first.confidence} spoofType=${first.spoofType}: ${first.reason}`;
      if (!first.live && first.confidence >= 0.75) {
        const second = await gemini.checkLiveness(livenessFrameDataUrl, selfieDataUrl);
        const secondNote = second.ok ? `live=${second.live} confidence=${second.confidence} spoofType=${second.spoofType}: ${second.reason}` : `failed: ${second.error}`;
        if (second.ok && !second.live && second.confidence >= 0.75) {
          return block('spoof_suspected', 422, 'This looks like a photo or a screen, not a live camera — look straight at the camera and try again', `[liveness check 1] ${firstNote} | [liveness check 2 confirmed] ${secondNote}`, distanceM);
        }
        livenessBorderline = true;
        livenessNote = `[liveness check 1] ${firstNote} | [liveness check 2 did not confirm] ${secondNote} — allowed`;
      } else {
        livenessNote = firstNote;
        livenessBorderline = !first.live || first.confidence < 0.85;
      }
    } else {
      livenessNote = `liveness check unavailable: ${first.error}`;
    }
  }
  faceMatchNote = [faceMatchNote, livenessNote].filter(Boolean).join(' | ') || null;

  const risk = computeRiskScore({
    accuracy, accuracyLimit: loc.accuracy_limit, distanceM, radius: loc.radius,
    faceBorderline, integritySuspicious: !!integrityNote, offline: !!opts.offline, offlineDelayMin: opts.offlineDelayMin, livenessBorderline,
  });

  // Bind the phone on first successful punch (R03).
  if (!opts.kiosk && !w.device_id && deviceId) db.prepare('UPDATE workers SET device_id = ? WHERE id = ?').run(deviceId, w.id);

  const id = crypto.randomUUID();
  // vendor_id/location_id stamped at punch time so the vendor bill check (R16) bills the
  // vendor the worker belonged to that day, even after a later transfer.
  db.prepare(`INSERT INTO punches (id, worker_id, type, ts, lat, lng, accuracy, distance_m, selfie_data_url, result, reason, device_id, face_match_note, vendor_id, location_id, offline, risk_score, risk_reasons, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, w.id, type, ts, lat, lng, accuracy || null, distanceM, selfieDataUrl, 'ok', null, deviceId || null, faceMatchNote, w.vendor_id, w.location_id, opts.offline ? 1 : 0, risk.score, risk.reasons.join(', ') || null, Date.now());
  addAudit(w.mobile, 'punch_' + type, `${type.toUpperCase()} at ${new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST${opts.offline ? ' (offline, synced later)' : ''}${atGate ? ` at gate tablet ${opts.kiosk.name}` : `, ${distanceM}m from ${loc.name}`}`);
  attachThumb(id, selfieDataUrl);
  return { ok: true, punch: { id, type, ts, distanceM, accuracy, location: loc.name } };
}

router.post('/', requireAuth('worker'), async (req, res) => {
  const { type, lat, lng, selfieDataUrl, deviceId } = req.body || {};
  if (type !== 'in' && type !== 'out') return res.status(400).json({ error: 'type must be "in" or "out"' });
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng are required' });
  if (!selfieDataUrl) return res.status(400).json({ error: 'selfieDataUrl is required — live camera capture only (FR-K05/R09)' });
  // R03 one phone per worker: a punch without a device id would skip the binding check.
  if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId is required — update the app' });
  const bad = checkImages(req.body, IMAGE_SPEC); if (bad) return res.status(bad.status).json({ error: bad.error });
  // BRD §7.8: "Punching is always done by the worker" — a Team Lead assisted-registration
  // token (routes/assisted.js) must never punch, or bind the Team Lead's phone as the worker's.
  if (req.auth.assistedBy) return res.status(403).json({ error: 'Punching is always done by the worker on their own phone' });

  const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status !== 'approved') return res.status(403).json({ error: `Cannot punch — registration status is "${w.status}", not approved (R07)` });

  const r = await evaluatePunch(w, req.body, Date.now()); // server time, never a client-supplied timestamp
  if (!r.ok) return res.status(r.status).json(r.body);
  res.json({ ok: true, ...r.punch });
});

// ---- Offline punch (BRD R19, §11 screen 7: "Allowed only inside the site. Send within
// 12 hours with the original time."). The phone's wall clock can't be trusted, so the
// original time comes from Android's elapsedRealtime (can't be changed by the user):
//   original time = server receive time − (elapsed now − elapsed at capture)
// That only holds on the same boot, so a punch from before a phone restart is refused
// (Team Lead raises a missed-punch request instead). Every other check — site fence, face,
// device, fake GPS, one-in-one-out — runs exactly as for a live punch, via evaluatePunch.
const OFFLINE_MAX_MS = 12 * 3600000;

router.post('/offline', requireAuth('worker'), async (req, res) => {
  const b = req.body || {};
  const { clientId, capturedElapsedMs, nowElapsedMs, capturedBootCount, nowBootCount } = b;
  if (!clientId || typeof clientId !== 'string') return res.status(400).json({ error: 'clientId is required' });
  if (b.type !== 'in' && b.type !== 'out') return res.status(400).json({ error: 'type must be "in" or "out"' });
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number' || !b.selfieDataUrl) return res.status(400).json({ error: 'lat, lng and selfieDataUrl are required' });
  if (!b.deviceId || typeof b.deviceId !== 'string') return res.status(400).json({ error: 'deviceId is required — update the app' });
  if (req.auth.assistedBy) return res.status(403).json({ error: 'Punching is always done by the worker on their own phone' });
  const bad = checkImages(b, IMAGE_SPEC); if (bad) return res.status(bad.status).json({ error: bad.error });

  // Same upload again (retry after a dropped response): return what happened the first time.
  const seen = db.prepare('SELECT id, type, ts, result, reason FROM punches WHERE client_id = ? AND worker_id = ?').get(clientId, req.auth.sub);
  if (seen) return res.status(seen.result === 'ok' ? 200 : 422).json({ duplicate: true, ok: seen.result === 'ok', id: seen.id, type: seen.type, ts: seen.ts, reason: seen.reason });

  if (typeof capturedElapsedMs !== 'number' || typeof nowElapsedMs !== 'number') {
    return res.status(400).json({ error: 'This phone cannot prove the punch time (no device clock) — ask Team Lead to raise a missed-punch request', reason: 'offline_no_clock' });
  }
  if (capturedBootCount != null && nowBootCount != null && capturedBootCount !== nowBootCount) {
    return res.status(422).json({ error: 'The phone restarted after this punch, so its time cannot be proven — ask Team Lead to raise a missed-punch request', reason: 'offline_rebooted' });
  }
  const sinceCapture = nowElapsedMs - capturedElapsedMs;
  if (sinceCapture < 0) return res.status(422).json({ error: 'The phone restarted after this punch — ask Team Lead to raise a missed-punch request', reason: 'offline_rebooted' });
  if (sinceCapture > OFFLINE_MAX_MS) return res.status(422).json({ error: 'Offline punches must be sent within 12 hours — ask Team Lead to raise a missed-punch request', reason: 'offline_expired' });

  const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.auth.sub);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status !== 'approved') return res.status(403).json({ error: `Cannot punch — registration status is "${w.status}", not approved (R07)` });

  const ts = Date.now() - sinceCapture;
  const r = await evaluatePunch(w, b, ts, { offline: true, offlineDelayMin: sinceCapture / 60000 });
  const id = r.ok ? r.punch.id : r.punchId;
  if (id) db.prepare('UPDATE punches SET client_id = ? WHERE id = ?').run(clientId, id);
  if (!r.ok) return res.status(r.status).json(r.body);
  res.json({ ok: true, offline: true, ...r.punch });
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
  attachThumb(id, selfieDataUrl);
  return id;
}

// The worker's own history never needs the selfies back (the phone took them); without
// them 200 rows fit in the offline home cache instead of blowing the localStorage quota.
router.get('/me', requireAuth('worker'), (req, res) => {
  const rows = db.prepare(`SELECT ${PUNCH_LIST_COLS} FROM punches WHERE worker_id = ? ORDER BY ts DESC LIMIT 200`).all(req.auth.sub);
  res.json(rows);
});

// One punch with its full selfie, for HR compare views (scoped like the list).
router.get('/:id/selfie', requirePermission('punches.read'), (req, res) => {
  const scope = workerIdScopeSql(req.user, 'punches.worker_id');
  const p = db.prepare(`SELECT punches.id, punches.selfie_data_url FROM punches WHERE punches.id = ? AND ${scope.sql}`).get(req.params.id, ...scope.args);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json({ id: p.id, selfie_data_url: p.selfie_data_url });
});

// ---- HR: attendance register / exceptions ----
// Scoped to the caller's workers (rbac.js); Security only ever gets blocked attempts.
// worker_name is joined in so roles without workers.read (Security) can still tell
// whose attempt it was.
router.get('/', requirePermission('punches.read'), (req, res) => {
  const { workerId, date } = req.query;
  const result = PUNCH_RESULT_RESTRICTION[req.user.role] || req.query.result;
  const scope = workerIdScopeSql(req.user, 'punches.worker_id');
  // Lists carry the 192 px thumbnail as selfie_data_url (full image only via ?full=1 for
  // one worker's compare view, or /punches/:id/selfie) — a 500-row list was ~400 MB.
  const full = req.query.full === '1' && workerId;
  const selfieCol = full ? 'punches.selfie_data_url' : "CASE WHEN punches.selfie_thumb IS NULL OR punches.selfie_thumb = 'none' THEN punches.selfie_data_url ELSE punches.selfie_thumb END";
  let sql = `SELECT ${PUNCH_LIST_COLS.split(', ').map(c => 'punches.' + c).join(', ')}, ${selfieCol} AS selfie_data_url, workers.name AS worker_name FROM punches LEFT JOIN workers ON workers.id = punches.worker_id WHERE ${scope.sql}`;
  const args = [...scope.args];
  if (workerId) { sql += ' AND punches.worker_id = ?'; args.push(workerId); }
  if (date) { sql += ` AND ${sqlDay('punches.ts')} = ?`; args.push(date); }
  if (req.query.from) { sql += ' AND punches.ts >= ?'; args.push(Number(req.query.from)); }
  if (req.query.to) { sql += ' AND punches.ts < ?'; args.push(Number(req.query.to)); }
  if (req.query.vendorId) { sql += ' AND punches.vendor_id = ?'; args.push(req.query.vendorId); }
  if (req.query.locationId) { sql += ' AND punches.location_id = ?'; args.push(req.query.locationId); }
  if (result) { sql += ' AND punches.result = ?'; args.push(result); }
  if (req.query.minRisk) { sql += ' AND punches.risk_score >= ?'; args.push(Number(req.query.minRisk)); }
  // Blocked/risky lists for dashboards default to the last 14 days unless a filter narrows them.
  if (!workerId && !date && !req.query.from && (result === 'blocked' || req.query.minRisk)) { sql += ' AND punches.ts >= ?'; args.push(Date.now() - 14 * 86400000); }
  sql += ` ORDER BY punches.ts DESC LIMIT ${Math.min(Number(req.query.limit) || 500, 1000)}`;
  res.json(db.prepare(sql).all(...args));
});

module.exports = router;
module.exports.evaluatePunch = evaluatePunch; // used by the gate tablet (routes/kiosk.js)
