// Data minimisation (DPDP: keep personal data only as long as the purpose needs it).
// Runs nightly right after the backup. Each rule is deliberately conservative — rows are
// kept, only the heavy/personal blobs are dropped once they've served their purpose:
//   - punch selfies: the face check already ran; keep the 192 px thumbnail + notes
//     (SELFIE_RETENTION_DAYS, default 90; blocked attempts kept twice as long for review)
//   - rejected registrations: photos/ID images removed 30 days after rejection
//   - sessions, OTP codes, alert de-dup rows, client error rows: pruned after 30–90 days
// Also backfills thumbnails for rows created before thumbnails existed.
const { db, addAudit } = require('../db');
const { makeThumb } = require('./thumbs');
require('./otp'); // owns the otp_codes/otp_locks shape (adds sent_at) — load it before pruning them

const DAY = 86400000;
const SELFIE_DAYS = Number(process.env.SELFIE_RETENTION_DAYS || 90);

async function backfillThumbs(limit = 40) {
  let n = 0;
  for (const p of db.prepare("SELECT id, selfie_data_url FROM punches WHERE selfie_data_url IS NOT NULL AND selfie_thumb IS NULL AND selfie_data_url LIKE 'data:image/jpeg%' LIMIT ?").all(limit)) {
    const t = await makeThumb(p.selfie_data_url);
    db.prepare('UPDATE punches SET selfie_thumb = ? WHERE id = ?').run(t || 'none', p.id); n++;
  }
  for (const w of db.prepare("SELECT id, photo_data_url FROM workers WHERE photo_data_url IS NOT NULL AND photo_thumb IS NULL AND photo_data_url LIKE 'data:image/jpeg%' LIMIT ?").all(limit)) {
    const t = await makeThumb(w.photo_data_url);
    db.prepare('UPDATE workers SET photo_thumb = ? WHERE id = ?').run(t || 'none', w.id); n++;
  }
  return n;
}

function runRetention() {
  const now = Date.now();
  const out = {};
  out.selfiesOk = db.prepare("UPDATE punches SET selfie_data_url = NULL WHERE selfie_data_url IS NOT NULL AND result = 'ok' AND ts < ?").run(now - SELFIE_DAYS * DAY).changes;
  out.selfiesBlocked = db.prepare("UPDATE punches SET selfie_data_url = NULL WHERE selfie_data_url IS NOT NULL AND result != 'ok' AND ts < ?").run(now - 2 * SELFIE_DAYS * DAY).changes;
  out.rejectedDocs = db.prepare(`UPDATE workers SET photo_data_url = NULL, pan_photo_data_url = NULL, bank_passbook_data_url = NULL
    WHERE status = 'rejected' AND created_at < ? AND (photo_data_url IS NOT NULL OR pan_photo_data_url IS NOT NULL OR bank_passbook_data_url IS NOT NULL)`).run(now - 30 * DAY).changes;
  out.sessions = db.prepare('DELETE FROM sessions WHERE COALESCE(ended_at, last_seen_at) < ?').run(now - 30 * DAY).changes;
  out.otps = db.prepare('DELETE FROM otp_codes WHERE COALESCE(sent_at, 0) < ?').run(now - DAY).changes;
  try { out.alerts = db.prepare('DELETE FROM alerts_sent WHERE day < ?').run(new Date(now - 90 * DAY).toISOString().slice(0, 10)).changes; } catch (e) { /* table shape differs */ }
  const summary = Object.entries(out).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
  if (summary) addAudit('system', 'data_retention', summary);
  return out;
}

module.exports = { runRetention, backfillThumbs };
