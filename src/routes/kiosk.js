const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth } = require('../middleware/auth');
const gemini = require('../services/geminiClient');

const router = express.Router();

// R20: "Gate tablet with face punch for workers without phones." The kiosk is bound to
// one location at activation time (see /api/auth/kiosk/activate) — every check here
// trusts req.auth.locationId, never anything the request body claims.

router.post('/identify', requireAuth('kiosk'), async (req, res) => {
  const { frameDataUrl } = req.body || {};
  if (!frameDataUrl) return res.status(400).json({ error: 'frameDataUrl is required' });
  if (!gemini.isConfigured()) return res.status(503).json({ error: 'Face identification is not configured (no Gemini key)' });

  const candidates = db.prepare("SELECT id, name, photo_data_url FROM workers WHERE location_id = ? AND status = 'approved' AND photo_data_url IS NOT NULL")
    .all(req.auth.locationId);
  if (!candidates.length) return res.json({ matched: false, reason: 'No registered workers with a photo at this location yet' });

  const result = await gemini.identifyFace(frameDataUrl, candidates.map(c => ({ workerId: c.id, name: c.name, photoDataUrl: c.photo_data_url })));
  if (!result.ok) return res.status(502).json({ error: result.error || 'Face identification failed' });
  if (!result.matchedWorkerId || result.confidence < 0.7) {
    return res.json({ matched: false, reason: result.reason || 'No confident match' });
  }
  const worker = candidates.find(c => c.id === result.matchedWorkerId);
  if (!worker) return res.json({ matched: false, reason: 'Matched an unrecognised worker id' });
  res.json({ matched: true, workerId: worker.id, name: worker.name, confidence: result.confidence });
});

router.post('/punch', requireAuth('kiosk'), async (req, res) => {
  const { workerId, selfieDataUrl } = req.body || {};
  if (!workerId || !selfieDataUrl) return res.status(400).json({ error: 'workerId and selfieDataUrl are required' });

  const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  if (w.status !== 'approved') return res.status(403).json({ error: `Cannot punch — registration status is "${w.status}", not approved` });
  if (w.location_id !== req.auth.locationId) return res.status(403).json({ error: 'This worker is not assigned to this kiosk\'s location' });

  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.auth.locationId);
  const now = Date.now();

  // The kiosk IS the site, so there's no geofence/GPS to check — unlike the phone punch
  // route, the client never gets a say in type either: the server works out whether
  // this is an in or an out from today's existing punches, so the kiosk UI is just
  // "scan a face, done" with no second tap.
  const todaysPunches = db.prepare("SELECT * FROM punches WHERE worker_id = ? AND result = 'ok' AND date(ts / 1000, 'unixepoch') = date(? / 1000, 'unixepoch') ORDER BY ts")
    .all(w.id, now);
  const hasIn = todaysPunches.some(p => p.type === 'in');
  const hasOut = todaysPunches.some(p => p.type === 'out');
  const type = !hasIn ? 'in' : (!hasOut ? 'out' : null);
  if (!type) return res.status(409).json({ error: 'Already punched in and out today' });

  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO punches (id, worker_id, type, ts, lat, lng, accuracy, distance_m, selfie_data_url, result, reason, device_id, face_match_note, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, w.id, type, now, loc ? loc.lat : null, loc ? loc.lng : null, 0, 0, selfieDataUrl, 'ok', null, 'kiosk:' + req.auth.locationId, 'Identified via gate kiosk face match', now);
  addAudit(w.mobile, 'kiosk_punch_' + type, `${type.toUpperCase()} via gate kiosk at ${loc ? loc.name : req.auth.locationId}`);

  res.json({ ok: true, id, type, ts: now, workerName: w.name });
});

module.exports = router;
