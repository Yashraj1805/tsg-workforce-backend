const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// ---- Vendors (BRD R01) ----
// GET is readable by any authenticated role — a worker needs the vendor/location
// list during registration to pick from; only mutations are HR-only.
router.get('/vendors', requireAuth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM vendors ORDER BY created_at DESC').all());
});

router.post('/vendors', requirePermission('masters.write'), (req, res) => {
  const { name, gstin, pan, contactPerson, phone } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO vendors (id, name, gstin, pan, contact_person, phone, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, gstin || null, pan || null, contactPerson || null, phone || null, 'active', Date.now());
  addAudit(req.auth.email, 'add_vendor', name);
  res.status(201).json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(id));
});

router.put('/vendors/:id', requirePermission('masters.write'), (req, res) => {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const { name, gstin, pan, contactPerson, phone, status } = req.body || {};
  db.prepare('UPDATE vendors SET name=COALESCE(?,name), gstin=COALESCE(?,gstin), pan=COALESCE(?,pan), contact_person=COALESCE(?,contact_person), phone=COALESCE(?,phone), status=COALESCE(?,status) WHERE id=?')
    .run(name, gstin, pan, contactPerson, phone, status, req.params.id);
  addAudit(req.auth.email, 'edit_vendor', v.name);
  res.json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id));
});

// ---- Locations (BRD R02) ----
router.get('/locations', requireAuth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM locations ORDER BY created_at DESC').all());
});

router.post('/locations', requirePermission('masters.write'), (req, res) => {
  const { name, brand, lat, lng, radius, accuracyLimit } = req.body || {};
  if (!name || typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'name, lat and lng are required' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO locations (id, name, brand, lat, lng, radius, accuracy_limit, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, brand || null, lat, lng, radius || 150, accuracyLimit || 100, Date.now());
  addAudit(req.auth.email, 'add_location', name);
  res.status(201).json(db.prepare('SELECT * FROM locations WHERE id = ?').get(id));
});

router.put('/locations/:id', requirePermission('masters.write'), (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  const { name, brand, lat, lng, radius, accuracyLimit } = req.body || {};
  db.prepare('UPDATE locations SET name=COALESCE(?,name), brand=COALESCE(?,brand), lat=COALESCE(?,lat), lng=COALESCE(?,lng), radius=COALESCE(?,radius), accuracy_limit=COALESCE(?,accuracy_limit) WHERE id=?')
    .run(name, brand, lat, lng, radius, accuracyLimit, req.params.id);
  addAudit(req.auth.email, 'edit_location', `${l.name} -> ${lat ?? l.lat}, ${lng ?? l.lng}, radius ${radius ?? l.radius}m`);
  res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id));
});

module.exports = router;
