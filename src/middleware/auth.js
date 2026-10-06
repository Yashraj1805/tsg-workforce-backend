const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { can } = require('../rbac');
const { checkSession } = require('../services/sessions');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET is not set in .env — generate one (e.g. `openssl rand -hex 32`) before starting the server');

function issueToken(payload, expiresIn) {
  return jwt.sign(payload, SECRET, { expiresIn });
}

function readToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { error: 'Missing Authorization: Bearer <token>' };
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch (e) { return { error: 'Invalid or expired token' }; }
  // The session must still be live: ended by logout / idle timeout means the token is
  // dead even if the JWT hasn't expired (R17/R18, services/sessions.js).
  const sessionError = checkSession(payload);
  if (sessionError) return { error: sessionError };
  return { payload };
}

// Admin tokens only identify the user — their role and scope are re-read from hr_users on
// every request, so a role change or deactivation by a system admin applies immediately
// instead of when the token happens to expire.
function loadAdminUser(payload) {
  const user = db.prepare('SELECT * FROM hr_users WHERE id = ?').get(payload.sub);
  if (!user || user.status !== 'active') return null;
  return user;
}

// requireAuth()         — any signed-in user (worker or admin)
// requireAuth('worker') — workers only
function requireAuth(role) {
  return (req, res, next) => {
    const { payload, error } = readToken(req);
    if (error) return res.status(401).json({ error });
    if (role === 'worker' && payload.role !== 'worker') return res.status(403).json({ error: 'This endpoint is for workers only' });
    if (payload.role !== 'worker') {
      const user = loadAdminUser(payload);
      if (!user) return res.status(401).json({ error: 'Account not found or deactivated — sign in again' });
      req.user = user;
    }
    req.auth = payload;
    next();
  };
}

// Admin-portal endpoints: the signed-in admin's current role must hold `permission`
// (see rbac.js). Sets req.user to the hr_users row so routes can apply its scope.
function requirePermission(permission) {
  return (req, res, next) => {
    const { payload, error } = readToken(req);
    if (error) return res.status(401).json({ error });
    if (payload.role === 'worker') return res.status(403).json({ error: 'Workers cannot access this endpoint' });
    const user = loadAdminUser(payload);
    if (!user) return res.status(401).json({ error: 'Account not found or deactivated — sign in again' });
    if (!can(user.role, permission)) return res.status(403).json({ error: `Your role (${user.role}) does not have permission "${permission}"` });
    req.auth = payload;
    req.user = user;
    next();
  };
}

// R20 gate tablet: a paired kiosk's token. The kiosk row must still be active and on the
// same device it was paired on.
function requireKiosk(req, res, next) {
  const { payload, error } = readToken(req);
  if (error) return res.status(401).json({ error });
  if (payload.role !== 'kiosk') return res.status(403).json({ error: 'Gate tablet only' });
  const kiosk = db.prepare('SELECT * FROM kiosks WHERE id = ?').get(payload.sub);
  if (!kiosk || kiosk.status !== 'active') return res.status(401).json({ error: 'This gate tablet has been retired — pair it again' });
  // The header is mandatory: a stolen kiosk token must not work from a device that simply
  // leaves it out.
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) return res.status(400).json({ error: 'X-Device-Id header is required' });
  if (kiosk.device_id && kiosk.device_id !== deviceId) return res.status(403).json({ error: 'This tablet is not the one paired for this gate' });
  req.auth = payload;
  req.kiosk = kiosk;
  next();
}

module.exports = { issueToken, requireAuth, requirePermission, requireKiosk };
