const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET is not set in .env — generate one (e.g. `openssl rand -hex 32`) before starting the server');

function issueToken(payload, expiresIn) {
  return jwt.sign(payload, SECRET, { expiresIn });
}

function requireAuth(role) {
  // role may be a single role string ('worker') or, where an endpoint is deliberately
  // shared (e.g. the face-detect check used by both the phone and gate-kiosk scan
  // loops), an array of allowed roles (['worker', 'kiosk']).
  const allowed = Array.isArray(role) ? role : (role ? [role] : null);
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
    try {
      const payload = jwt.verify(token, SECRET);
      if (allowed && !allowed.includes(payload.role)) return res.status(403).json({ error: `This endpoint requires role ${allowed.map(r => `"${r}"`).join(' or ')}` });
      req.auth = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

module.exports = { issueToken, requireAuth };
