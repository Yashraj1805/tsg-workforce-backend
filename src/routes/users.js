const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { ROLES, ROLE_SCOPE, isAdminRole } = require('../rbac');

const router = express.Router();

// ---- Admin-portal user management (BRD §5: System admin sets up users) ----

function getUser(id) { return db.prepare('SELECT * FROM hr_users WHERE id = ?').get(id); }

// Checks the role's scope column is filled in with something that exists, and returns
// the {locationId, vendorId} to store — the column the role doesn't use is cleared, so a
// user's row never carries a stale scope from a previous role.
function resolveScope(role, locationId, vendorId) {
  const scope = ROLE_SCOPE[role];
  if (scope === 'location') {
    if (!locationId) return { error: `${ROLES[role]} must be assigned a location` };
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locationId)) return { error: 'Selected location does not exist' };
    return { locationId, vendorId: null };
  }
  if (scope === 'vendor') {
    if (!vendorId) return { error: `${ROLES[role]} must be assigned a vendor` };
    if (!db.prepare('SELECT 1 FROM vendors WHERE id = ?').get(vendorId)) return { error: 'Selected vendor does not exist' };
    return { locationId: null, vendorId };
  }
  return { locationId: null, vendorId: null };
}

router.get('/roles', requirePermission('users.manage'), (req, res) => {
  res.json(Object.entries(ROLES).map(([id, label]) => ({ id, label, scope: ROLE_SCOPE[id] })));
});

router.get('/', requirePermission('users.manage'), (req, res) => {
  res.json(db.prepare('SELECT * FROM hr_users ORDER BY created_at DESC').all());
});

router.post('/', requirePermission('users.manage'), (req, res) => {
  const { email, name, role, locationId, vendorId } = req.body || {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ error: 'Valid email required' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!isAdminRole(role)) return res.status(400).json({ error: `role must be one of: ${Object.keys(ROLES).join(', ')}` });
  if (db.prepare('SELECT 1 FROM hr_users WHERE lower(email) = lower(?)').get(email)) return res.status(409).json({ error: 'A user with this email already exists' });
  const scope = resolveScope(role, locationId, vendorId);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO hr_users (id, email, name, role, location_id, vendor_id, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, email.trim(), name.trim(), role, scope.locationId, scope.vendorId, 'active', Date.now());
  addAudit(req.user.email, 'add_admin_user', `${email} as ${role}${scope.locationId ? ` @location ${scope.locationId}` : ''}${scope.vendorId ? ` @vendor ${scope.vendorId}` : ''}`);
  res.status(201).json(getUser(id));
});

router.put('/:id', requirePermission('users.manage'), (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const role = body.role ?? u.role;
  const status = body.status ?? u.status;
  if (!isAdminRole(role)) return res.status(400).json({ error: `role must be one of: ${Object.keys(ROLES).join(', ')}` });
  if (status !== 'active' && status !== 'inactive') return res.status(400).json({ error: 'status must be "active" or "inactive"' });
  // Stops a System Admin locking everyone out by demoting/deactivating themselves.
  if (u.id === req.user.id && (role !== u.role || status !== 'active')) {
    return res.status(400).json({ error: 'You cannot change your own role or deactivate yourself — ask another System Admin' });
  }
  const scope = resolveScope(role, body.locationId !== undefined ? body.locationId : u.location_id, body.vendorId !== undefined ? body.vendorId : u.vendor_id);
  if (scope.error) return res.status(400).json({ error: scope.error });

  db.prepare('UPDATE hr_users SET name = ?, role = ?, location_id = ?, vendor_id = ?, status = ? WHERE id = ?')
    .run((body.name || u.name).trim(), role, scope.locationId, scope.vendorId, status, u.id);
  const changes = [];
  if (role !== u.role) changes.push(`role ${u.role} -> ${role}`);
  if (status !== u.status) changes.push(`status ${u.status} -> ${status}`);
  if (scope.locationId !== u.location_id) changes.push(`location ${u.location_id || '-'} -> ${scope.locationId || '-'}`);
  if (scope.vendorId !== u.vendor_id) changes.push(`vendor ${u.vendor_id || '-'} -> ${scope.vendorId || '-'}`);
  addAudit(req.user.email, 'edit_admin_user', `${u.email}: ${changes.join(', ') || 'no changes'}`);
  res.json(getUser(u.id));
});

module.exports = router;
