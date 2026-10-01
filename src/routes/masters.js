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

// ---- Jobs (BRD §10 screen 8: "One choice. The list is set by admin.") ----
router.get('/jobs', requireAuth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY sort, name').all());
});
router.post('/jobs', requirePermission('masters.write'), (req, res) => {
  const { name, nameHi, icon } = req.body || {};
  if (!(name || '').trim()) return res.status(400).json({ error: 'name is required' });
  const id = crypto.randomUUID();
  const sort = (db.prepare('SELECT MAX(sort) m FROM jobs').get().m || 0) + 1;
  db.prepare('INSERT INTO jobs (id, name, name_hi, icon, active, sort) VALUES (?,?,?,?,1,?)').run(id, name.trim(), (nameHi || '').trim() || null, (icon || '').trim() || null, sort);
  addAudit(req.auth.email, 'add_job', name.trim());
  res.status(201).json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
});
router.put('/jobs/:id', requirePermission('masters.write'), (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? String(b.name).trim() : j.name,
    name_hi: b.nameHi !== undefined ? (String(b.nameHi).trim() || null) : j.name_hi,
    icon: b.icon !== undefined ? (String(b.icon).trim() || null) : j.icon,
    active: b.active !== undefined ? (b.active ? 1 : 0) : j.active,
  };
  if (!next.name) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE jobs SET name = ?, name_hi = ?, icon = ?, active = ? WHERE id = ?').run(next.name, next.name_hi, next.icon, next.active, j.id);
  addAudit(req.auth.email, 'edit_job', `${j.name}${next.name !== j.name ? ' -> ' + next.name : ''}${next.active !== j.active ? (next.active ? ' (re-activated)' : ' (retired)') : ''}`);
  res.json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(j.id));
});

// Everything the registration wizard offers as a choice, plus the current consent text.
router.get('/registration-options', requireAuth(), (req, res) => {
  const { EDUCATION, EXPERIENCE, CONSENT } = require('../registrationOptions');
  res.json({ jobs: db.prepare('SELECT * FROM jobs WHERE active = 1 ORDER BY sort, name').all(), education: EDUCATION, experience: EXPERIENCE, consent: CONSENT });
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
  // BRD §11 screen 9: weekly off day shows grey on the worker calendar (0 = Sunday … 6, null = none).
  const wo = (req.body || {}).weeklyOff;
  if (wo !== undefined && wo !== null && !(Number.isInteger(wo) && wo >= 0 && wo <= 6)) return res.status(400).json({ error: 'weeklyOff must be 0 (Sunday) to 6 (Saturday) or null' });
  const v = (x) => (x === undefined ? null : x);
  db.prepare('UPDATE locations SET name=COALESCE(?,name), brand=COALESCE(?,brand), lat=COALESCE(?,lat), lng=COALESCE(?,lng), radius=COALESCE(?,radius), accuracy_limit=COALESCE(?,accuracy_limit) WHERE id=?')
    .run(v(name), v(brand), v(lat), v(lng), v(radius), v(accuracyLimit), req.params.id);
  if (wo !== undefined) db.prepare('UPDATE locations SET weekly_off = ? WHERE id = ?').run(wo, l.id);
  addAudit(req.auth.email, 'edit_location', `${l.name} -> ${lat ?? l.lat}, ${lng ?? l.lng}, radius ${radius ?? l.radius}m${wo !== undefined ? `, weekly off ${wo ?? 'none'}` : ''}`);
  res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id));
});

module.exports = router;
