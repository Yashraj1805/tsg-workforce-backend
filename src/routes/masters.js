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

// R01: "Vendor list: name, GSTIN, contact, contract dates". Validates what's given and
// merges it over the existing row (for PUT), so the same function serves both.
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function readVendor(body, existing) {
  const pick = (k, col) => body[k] !== undefined ? (String(body[k]).trim() || null) : (existing ? existing[col] : null);
  const v = {
    name: pick('name', 'name'),
    gstin: pick('gstin', 'gstin'), pan: pick('pan', 'pan'),
    contact_person: pick('contactPerson', 'contact_person'), phone: pick('phone', 'phone'),
    contract_start: pick('contractStart', 'contract_start'), contract_end: pick('contractEnd', 'contract_end'),
    status: pick('status', 'status') || 'active',
  };
  if (v.gstin) v.gstin = v.gstin.toUpperCase();
  if (v.pan) v.pan = v.pan.toUpperCase();
  if (!v.name) return { error: 'name is required' };
  if (v.gstin && !GSTIN_RE.test(v.gstin)) return { error: 'GSTIN should be 15 characters, e.g. 07ABCDE1234F1Z5' };
  if (v.phone && !/^\d{10}$/.test(v.phone)) return { error: 'Phone should be a 10-digit mobile number' };
  for (const d of ['contract_start', 'contract_end']) if (v[d] && !DATE_RE.test(v[d])) return { error: 'Contract dates must be YYYY-MM-DD' };
  if (v.contract_start && v.contract_end && v.contract_end < v.contract_start) return { error: 'Contract end date is before the start date' };
  if (!['active', 'inactive'].includes(v.status)) return { error: 'status must be "active" or "inactive"' };
  return { v };
}

router.post('/vendors', requirePermission('masters.write'), (req, res) => {
  const { v, error } = readVendor(req.body || {}, null);
  if (error) return res.status(400).json({ error });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO vendors (id, name, gstin, pan, contact_person, phone, contract_start, contract_end, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, v.name, v.gstin, v.pan, v.contact_person, v.phone, v.contract_start, v.contract_end, v.status, Date.now());
  addAudit(req.auth.email, 'add_vendor', `${v.name} (contract ${v.contract_start || '?'} to ${v.contract_end || '?'})`);
  res.status(201).json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(id));
});

router.put('/vendors/:id', requirePermission('masters.write'), (req, res) => {
  const old = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const { v, error } = readVendor(req.body || {}, old);
  if (error) return res.status(400).json({ error });
  db.prepare('UPDATE vendors SET name=?, gstin=?, pan=?, contact_person=?, phone=?, contract_start=?, contract_end=?, status=? WHERE id=?')
    .run(v.name, v.gstin, v.pan, v.contact_person, v.phone, v.contract_start, v.contract_end, v.status, old.id);
  const changed = Object.keys(v).filter(k => v[k] !== old[k]).map(k => `${k}: ${old[k] ?? '-'} -> ${v[k] ?? '-'}`);
  addAudit(req.auth.email, 'edit_vendor', `${old.name}: ${changed.join(', ') || 'no changes'}`);
  res.json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(old.id));
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
