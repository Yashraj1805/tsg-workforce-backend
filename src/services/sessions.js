// Server-side login sessions (BRD R17 "Audit log of every change, login and logout",
// R18 "Admin login ... Logout after 15 minutes idle"). Kinds: worker, admin, and
// assisted (Site HR registering a worker on HR's phone — idles out like admin).
//
// Every token carries a session id (`sid`). The session row is what makes logout and
// idle-timeout real: once it's ended, the token stops working server-side even though
// the JWT itself hasn't expired — the phone can't keep a session alive by ignoring a
// logout. Each login, logout, idle-timeout and failed OTP attempt is audited.
const crypto = require('node:crypto');
const { db, addAudit } = require('../db');

const ADMIN_IDLE_MS = 15 * 60 * 1000;
const TOUCH_EVERY_MS = 30 * 1000; // don't write last_seen on every single request

function startSession(kind, userId, identifier, detail) {
  const sid = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, kind, user_id, identifier, created_at, last_seen_at) VALUES (?,?,?,?,?,?)')
    .run(sid, kind, userId, identifier, now, now);
  addAudit(identifier, kind === 'admin' ? 'admin_login' : kind === 'assisted' ? 'assisted_session_start' : 'worker_login', detail || '');
  return sid;
}

function endSession(sid, reason) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!s || s.ended_at) return false;
  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(Date.now(), reason, sid);
  addAudit(s.identifier, s.kind === 'admin' ? 'admin_logout' : s.kind === 'assisted' ? 'assisted_session_end' : 'worker_logout', reason === 'logout' ? 'Logged out' : `Signed out: ${reason}`);
  return true;
}

// Called by the auth middleware on every request. Returns null if the session is live
// (and records activity), else the error message to send with a 401.
function checkSession(payload) {
  if (!payload.sid) return 'Session expired — please sign in again';
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(payload.sid);
  if (!s || s.user_id !== payload.sub) return 'Session not found — please sign in again';
  if (s.ended_at) return s.end_reason === 'idle_timeout' ? 'Signed out after 15 minutes without use — please sign in again' : 'You have signed out — please sign in again';
  const now = Date.now();
  if (s.kind !== 'worker' && now - s.last_seen_at > ADMIN_IDLE_MS) {
    endSession(s.id, 'idle_timeout');
    return 'Signed out after 15 minutes without use — please sign in again';
  }
  if (now - s.last_seen_at > TOUCH_EVERY_MS) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, s.id);
  return null;
}

function auditFailedLogin(identifier, kind, error) {
  addAudit(identifier, kind === 'admin' ? 'admin_login_failed' : 'worker_login_failed', error);
}

module.exports = { startSession, endSession, checkSession, auditFailedLogin, ADMIN_IDLE_MS };
