// R20: "Gate tablet with face punch for workers without phones."
//
// An admin creates a gate tablet for a site and gets a one-time pairing code; the tablet
// enters it once and stays signed in as that site's kiosk. At the gate a worker types the
// last 4 digits of their mobile, taps their own photo, and looks at the camera. The punch
// then goes through the same server checks as a phone punch (evaluatePunch) with two
// differences: no personal-phone binding (it's the site's tablet) and the face must
// positively match — it's the only proof of who is punching. The tablet's own GPS must be
// inside its site, and only that site's workers can punch there.
const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { issueToken, requirePermission, requireKiosk } = require('../middleware/auth');
const { startSession } = require('../services/sessions');
const { evaluatePunch } = require('./punches');
const { sqlDay, today } = require('../services/time');

db.exec(`CREATE TABLE IF NOT EXISTS kiosks (id TEXT PRIMARY KEY, name TEXT NOT NULL, location_id TEXT NOT NULL REFERENCES locations(id),
  pairing_code TEXT, pairing_expires INTEGER, device_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_by TEXT, created_at INTEGER NOT NULL, paired_at INTEGER)`);

const router = express.Router();
const PAIR_TTL_MS = 24 * 3600000;

// ---- Admin: set up gate tablets ----
router.get('/kiosks', requirePermission('kiosks.manage'), (req, res) => {
  res.json(db.prepare('SELECT k.id, k.name, k.location_id, k.status, k.paired_at, k.created_at, l.name AS location_name FROM kiosks k LEFT JOIN locations l ON l.id = k.location_id ORDER BY k.created_at DESC').all());
});
router.post('/kiosks', requirePermission('kiosks.manage'), (req, res) => {
  const { name, locationId } = req.body || {};
  if (!(name || '').trim()) return res.status(400).json({ error: 'name is required' });
  const loc = db.prepare('SELECT id, name FROM locations WHERE id = ?').get(locationId || '');
  if (!loc) return res.status(400).json({ error: 'Pick the site this gate tablet is at' });
  const id = crypto.randomUUID();
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('INSERT INTO kiosks (id, name, location_id, pairing_code, pairing_expires, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name.trim(), loc.id, code, Date.now() + PAIR_TTL_MS, 'active', req.user.email, Date.now());
  addAudit(req.user.email, 'add_kiosk', `${name.trim()} at ${loc.name}`);
  res.status(201).json({ id, name: name.trim(), location: loc.name, pairingCode: code, pairingExpiresInHours: 24 });
});
router.post('/kiosks/:id/new-code', requirePermission('kiosks.manage'), (req, res) => {
  const k = db.prepare('SELECT * FROM kiosks WHERE id = ?').get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Not found' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  // Re-pairing replaces the tablet: the old device stops working.
  db.prepare("UPDATE kiosks SET pairing_code = ?, pairing_expires = ?, device_id = NULL, status = 'active' WHERE id = ?").run(code, Date.now() + PAIR_TTL_MS, k.id);
  addAudit(req.user.email, 'kiosk_new_code', k.name);
  res.json({ pairingCode: code, pairingExpiresInHours: 24 });
});
router.put('/kiosks/:id', requirePermission('kiosks.manage'), (req, res) => {
  const k = db.prepare('SELECT * FROM kiosks WHERE id = ?').get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Not found' });
  const status = (req.body || {}).status;
  if (status !== 'active' && status !== 'retired') return res.status(400).json({ error: 'status must be "active" or "retired"' });
  db.prepare('UPDATE kiosks SET status = ? WHERE id = ?').run(status, k.id);
  addAudit(req.user.email, 'kiosk_status', `${k.name} -> ${status}`);
  res.json({ ok: true });
});

// ---- Tablet: pair once ----
router.post('/kiosk/pair', (req, res) => {
  const { code, deviceId } = req.body || {};
  const k = db.prepare("SELECT * FROM kiosks WHERE pairing_code = ? AND status = 'active'").get(String(code || ''));
  if (!k || !deviceId || Date.now() > k.pairing_expires) return res.status(400).json({ error: 'Pairing code is wrong or expired — ask HR for a new one' });
  db.prepare('UPDATE kiosks SET device_id = ?, pairing_code = NULL, paired_at = ? WHERE id = ?').run(deviceId, Date.now(), k.id);
  const sid = startSession('kiosk', k.id, `kiosk:${k.name}`, `Gate tablet "${k.name}" paired`);
  const token = issueToken({ sub: k.id, role: 'kiosk', sid }, '365d');
  const loc = db.prepare('SELECT id, name, lat, lng, radius FROM locations WHERE id = ?').get(k.location_id);
  res.json({ token, kiosk: { id: k.id, name: k.name, location: loc } });
});

router.get('/kiosk/me', requireKiosk, (req, res) => {
  const loc = db.prepare('SELECT id, name, lat, lng, radius FROM locations WHERE id = ?').get(req.kiosk.location_id);
  res.json({ id: req.kiosk.id, name: req.kiosk.name, location: loc });
});

// Workers at this site whose mobile ends in the 4 digits typed. Only first name + photo
// go back to the tablet, so it can't be used to look people up.
router.get('/kiosk/candidates', requireKiosk, (req, res) => {
  const last4 = String(req.query.last4 || '');
  if (!/^\d{4}$/.test(last4)) return res.status(400).json({ error: 'Type the last 4 digits of your mobile number' });
  const rows = db.prepare("SELECT id, name, photo_data_url FROM workers WHERE status = 'approved' AND location_id = ? AND mobile LIKE ?").all(req.kiosk.location_id, '%' + last4);
  res.json(rows.map(r => {
    const done = db.prepare(`SELECT type FROM punches WHERE worker_id = ? AND result = 'ok' AND ${sqlDay('ts')} = ?`).all(r.id, today()).map(p => p.type);
    return { id: r.id, firstName: (r.name || '').split(/\s+/)[0], photo: r.photo_data_url, next: done.includes('out') ? 'done' : done.includes('in') ? 'out' : 'in' };
  }));
});

router.post('/kiosk/punch', requireKiosk, async (req, res) => {
  const b = req.body || {};
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number' || !b.selfieDataUrl || !b.workerId) return res.status(400).json({ error: 'workerId, lat, lng and selfieDataUrl are required' });
  const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(b.workerId);
  if (!w || w.status !== 'approved') return res.status(404).json({ error: 'Worker not found or not approved' });
  if (w.location_id !== req.kiosk.location_id) return res.status(403).json({ error: 'This gate tablet is for another site' });
  const done = db.prepare(`SELECT type FROM punches WHERE worker_id = ? AND result = 'ok' AND ${sqlDay('ts')} = ?`).all(w.id, today()).map(p => p.type);
  const type = done.includes('in') ? 'out' : 'in';
  const r = await evaluatePunch(w, { ...b, type, deviceId: req.kiosk.device_id }, Date.now(), { kiosk: req.kiosk });
  if (!r.ok) return res.status(r.status).json(r.body);
  res.json({ ok: true, worker: (w.name || '').split(/\s+/)[0], ...r.punch });
});

module.exports = router;
