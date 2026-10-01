// BRD §11 screen 6 "Blocked: save the attempt and alert Security"; §16 "Blocked punches →
// Security, central HR". One email per worker + reason + day, so a worker retrying ten
// times outside the fence doesn't send ten emails. Security also sees every attempt live
// on the Exceptions screen; this is the push.
const { db, addAudit } = require('../db');
const { sendEmail } = require('./notify');
const { today } = require('./time');

db.exec('CREATE TABLE IF NOT EXISTS alerts_sent (key TEXT PRIMARY KEY, ts INTEGER NOT NULL)');

const REASON_TEXT = {
  outside_geofence: 'tried to punch from outside the site',
  low_accuracy: 'tried to punch with very poor GPS accuracy',
  device_mismatch: "tried to punch from a phone that isn't theirs",
  face_mismatch: "selfie didn't match the registered photo",
  spoof_suspected: 'selfie looked like a photo of a photo / screen',
  fake_gps: 'fake GPS detected',
  gps_suspicious: 'punch location looks copied from another day (possible fake GPS)',
};

function alertBlockedPunch(worker, reason, note) {
  const key = `${worker.id}|${reason}|${today()}`;
  if (db.prepare('SELECT 1 FROM alerts_sent WHERE key = ?').get(key)) return;
  db.prepare('INSERT INTO alerts_sent (key, ts) VALUES (?, ?)').run(key, Date.now());
  const loc = worker.location_id ? db.prepare('SELECT name FROM locations WHERE id = ?').get(worker.location_id) : null;
  const to = db.prepare("SELECT email FROM hr_users WHERE status = 'active' AND role IN ('security', 'central_hr')").all().map(r => r.email);
  const subject = `Blocked punch: ${worker.name || worker.mobile} — ${REASON_TEXT[reason] || reason}`;
  const body = [
    `Worker: ${worker.name || '-'} (mobile …${(worker.mobile || '').slice(-4)})`,
    `Site: ${loc ? loc.name : '-'}`,
    `What happened: ${REASON_TEXT[reason] || reason}`,
    note ? `Details: ${note}` : '',
    `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
    '',
    'See TSG Workforce → Exceptions for the selfie and location.',
  ].filter(Boolean).join('\n');
  sendEmail(to, subject, body).then(r => addAudit('system', 'security_alert', `${subject}${r.ok ? '' : ' (email not sent: ' + (r.error || 'no SMTP') + ')'}`));
}

module.exports = { alertBlockedPunch };
