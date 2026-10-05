const express = require('express');
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { ROLES, ROLE_SCOPE, isAdminRole } = require('../rbac');
const { hashPassword, validatePassword, generateTempPassword } = require('../services/passwords');

const router = express.Router();

// ---- Admin-portal user management (BRD §5: System admin sets up users) ----

// Never hand the password hash to the app — not even to a System Admin.
function publicUser(u) { if (!u) return u; const { password_hash, ...rest } = u; return { ...rest, has_password: !!password_hash }; }
function getUser(id) { return publicUser(db.prepare('SELECT * FROM hr_users WHERE id = ?').get(id)); }

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
  res.json(db.prepare('SELECT * FROM hr_users ORDER BY created_at DESC').all().map(publicUser));
});

// A temporary password the System Admin can read out to the new user (who must change it).
router.get('/suggest-password', requirePermission('users.manage'), (req, res) => {
  res.json({ password: generateTempPassword() });
});

router.post('/', requirePermission('users.manage'), (req, res) => {
  const { email, name, role, locationId, vendorId, phone, password } = req.body || {};
  if (phone && !/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must be a 10-digit mobile number' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ error: 'Valid email required' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!isAdminRole(role)) return res.status(400).json({ error: `role must be one of: ${Object.keys(ROLES).join(', ')}` });
  const badPw = validatePassword(password);
  if (badPw) return res.status(400).json({ error: badPw });
  if (db.prepare('SELECT 1 FROM hr_users WHERE lower(email) = lower(?)').get(email)) return res.status(409).json({ error: 'A user with this email already exists' });
  const scope = resolveScope(role, locationId, vendorId);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO hr_users (id, email, name, role, location_id, vendor_id, phone, status, created_at, password_hash, must_change_password) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
    .run(id, email.trim(), name.trim(), role, scope.locationId, scope.vendorId, phone || null, 'active', Date.now(), hashPassword(password));
  addAudit(req.user.email, 'add_admin_user', `${email} as ${role}${scope.locationId ? ` @location ${scope.locationId}` : ''}${scope.vendorId ? ` @vendor ${scope.vendorId}` : ''} (temporary password set)`);
  res.status(201).json(getUser(id));
});

// System Admin resets a forgotten password; the user must pick their own at next login.
// Any live session of that user keeps working until it ends — a reset is for "I forgot",
// deactivating (status=inactive) is for "lock them out now".
router.post('/:id/reset-password', requirePermission('users.manage'), (req, res) => {
  const u = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const password = (req.body || {}).password || generateTempPassword();
  const badPw = validatePassword(password);
  if (badPw) return res.status(400).json({ error: badPw });
  db.prepare('UPDATE hr_users SET password_hash = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?').run(hashPassword(password), Date.now(), u.id);
  addAudit(req.user.email, 'reset_admin_password', `${u.email}: temporary password set by ${req.user.email}`);
  // Returned once so the admin can pass it on; it is not stored anywhere readable.
  res.json({ ok: true, password });
});

router.put('/:id', requirePermission('users.manage'), (req, res) => {
  const u = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(req.params.id);
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

  if (body.phone && !/^\d{10}$/.test(body.phone)) return res.status(400).json({ error: 'Phone must be a 10-digit mobile number' });
  const phone = body.phone !== undefined ? (body.phone || null) : u.phone;
  db.prepare('UPDATE hr_users SET name = ?, role = ?, location_id = ?, vendor_id = ?, status = ?, phone = ? WHERE id = ?')
    .run((body.name || u.name).trim(), role, scope.locationId, scope.vendorId, status, phone, u.id);
  const changes = [];
  if (role !== u.role) changes.push(`role ${u.role} -> ${role}`);
  if (status !== u.status) changes.push(`status ${u.status} -> ${status}`);
  if (scope.locationId !== u.location_id) changes.push(`location ${u.location_id || '-'} -> ${scope.locationId || '-'}`);
  if (scope.vendorId !== u.vendor_id) changes.push(`vendor ${u.vendor_id || '-'} -> ${scope.vendorId || '-'}`);
  addAudit(req.user.email, 'edit_admin_user', `${u.email}: ${changes.join(', ') || 'no changes'}`);
  res.json(getUser(u.id));
});

module.exports = router;
