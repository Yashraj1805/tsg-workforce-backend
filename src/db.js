// SQLite via Node's built-in node:sqlite (no native build toolchain needed).
// Node flags this API "experimental" — fine for getting a real backend running now;
// swap to Postgres for actual production scale/hosting later if needed.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'tsg_workforce.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');   // a deploy overlap or a maintenance shell must wait, not 500
db.exec('PRAGMA synchronous = NORMAL;');  // safe with WAL; FULL only slows every punch down

db.exec(`
CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gstin TEXT,
  pan TEXT,
  contact_person TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius INTEGER NOT NULL DEFAULT 150,
  accuracy_limit INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  mobile TEXT NOT NULL UNIQUE,
  name TEXT,
  father_name TEXT,
  dob TEXT,
  gender TEXT,
  address TEXT,
  emergency_contact TEXT,
  vendor_id TEXT REFERENCES vendors(id),
  vendor_code TEXT,
  location_id TEXT REFERENCES locations(id),
  designation TEXT,
  doj TEXT,
  qualification TEXT,
  experience TEXT,
  photo_data_url TEXT,
  aadhaar_ref_id TEXT,
  aadhaar_masked TEXT,
  aadhaar_verified INTEGER NOT NULL DEFAULT 0,
  pan_number TEXT,
  pan_verified INTEGER NOT NULL DEFAULT 0,
  kyc_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'draft',
  send_back_reason TEXT,
  device_id TEXT,
  blacklisted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS punches (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  accuracy REAL,
  distance_m REAL,
  selfie_data_url TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  device_id TEXT,
  face_match_note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS regularisations (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  date TEXT NOT NULL,
  reason TEXT,
  maker TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  checker TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hr_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'site_hr',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  identifier TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (identifier, purpose)
);

CREATE TABLE IF NOT EXISTS digilocker_requests (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  user TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
`);

// Lightweight migration guard: CREATE TABLE IF NOT EXISTS doesn't add new columns to
// a table that already exists on disk from an earlier run.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('punches', 'face_match_note', 'TEXT');

// Role model (see rbac.js): scope columns on admin users, the manager link on workers
// that the reporting_manager role is scoped by, and id-based maker/checker so BR-08
// can't be satisfied by two different people who happen to share a display name.
addColumnIfMissing('hr_users', 'location_id', 'TEXT REFERENCES locations(id)');
addColumnIfMissing('hr_users', 'vendor_id', 'TEXT REFERENCES vendors(id)');
addColumnIfMissing('hr_users', 'status', "TEXT NOT NULL DEFAULT 'active'");
addColumnIfMissing('workers', 'reporting_manager_email', 'TEXT');
addColumnIfMissing('workers', 'reporting_manager_name', 'TEXT'); // R08
// R04: Aadhaar QR + PAN photo capture. aadhaar_key (last-4 + DOB) is the duplicate /
// blacklist key — the full Aadhaar number is never stored (BRD §9).
addColumnIfMissing('workers', 'aadhaar_key', 'TEXT');
addColumnIfMissing('workers', 'aadhaar_name', 'TEXT');
addColumnIfMissing('workers', 'aadhaar_qr_format', 'TEXT');
addColumnIfMissing('workers', 'aadhaar_qr_signature', 'TEXT');
addColumnIfMissing('workers', 'aadhaar_qr_at', 'INTEGER');
addColumnIfMissing('workers', 'pan_photo_data_url', 'TEXT');
addColumnIfMissing('workers', 'pan_ocr_number', 'TEXT');
addColumnIfMissing('workers', 'pan_ocr_name', 'TEXT');
addColumnIfMissing('workers', 'pan_name', 'TEXT'); // R05: name returned by the PAN verification API
addColumnIfMissing('workers', 'face_check_note', 'TEXT'); // R06: duplicate/blacklist face check outcome, shown to HR
addColumnIfMissing('vendors', 'contract_start', 'TEXT'); // R01, YYYY-MM-DD
addColumnIfMissing('vendors', 'contract_end', 'TEXT');
// R14: exit details + per-worker change history (transfer / exit / device reset / ...).
addColumnIfMissing('workers', 'exit_date', 'TEXT');
addColumnIfMissing('workers', 'exit_reason', 'TEXT');
db.exec('CREATE TABLE IF NOT EXISTS worker_events (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id), ts INTEGER NOT NULL, by_user TEXT, type TEXT NOT NULL, detail TEXT, reason TEXT)');
// R16 vendor bill check + month-end lock (proposal: "Attendance locked by 2nd by Central
// HR; vendor invoices on portal days only; Finance checks the bill").
addColumnIfMissing('punches', 'vendor_id', 'TEXT');
addColumnIfMissing('punches', 'location_id', 'TEXT');
addColumnIfMissing('punches', 'offline', 'INTEGER NOT NULL DEFAULT 0'); // R19: captured offline, synced later
addColumnIfMissing('punches', 'client_id', 'TEXT'); // R19: phone-side id, so a retried upload isn't saved twice
// AI risk score (0-100): a deterministic triage signal for HR on ALLOWED punches that
// passed every individual check but were borderline on several at once — e.g. a face
// match that only just cleared the confidence bar, right at the geofence edge, GPS
// accuracy near the limit. Not a block decision (evaluatePunch's own checks already
// make that call) — purely "worth a second look", visible on the Exceptions screen.
addColumnIfMissing('punches', 'risk_score', 'INTEGER');
addColumnIfMissing('punches', 'risk_reasons', 'TEXT');
// Document-tamper flag from the PAN photo OCR call (readPanCard) — shown to HR at
// approval, never auto-rejects a worker on its own (heuristic, not a forensic tool).
addColumnIfMissing('workers', 'pan_tamper_note', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS punches_client_id ON punches(client_id) WHERE client_id IS NOT NULL');
// Every punch check, register, dashboard and report reads punches by worker and/or time;
// without these each one was a full scan of a table whose rows carry selfies.
db.exec('CREATE INDEX IF NOT EXISTS punches_worker_ts ON punches(worker_id, ts)');
db.exec('CREATE INDEX IF NOT EXISTS punches_ts ON punches(ts)');
db.exec('CREATE INDEX IF NOT EXISTS punches_result_ts ON punches(result, ts)');
db.exec('CREATE INDEX IF NOT EXISTS workers_location_status ON workers(location_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS workers_vendor_status ON workers(vendor_id, status)');
// 192 px thumbnails (services/thumbs.js) so list screens never download full photos.
// 'none' marks a row whose image can't be thumbnailed (PNG/corrupt) so it isn't retried.
addColumnIfMissing('punches', 'selfie_thumb', 'TEXT');
addColumnIfMissing('workers', 'photo_thumb', 'TEXT');
addColumnIfMissing('workers', 'reject_reason', 'TEXT');
// Meon DigiLocker: the request id is Meon's `state`; the client token is needed again to
// fetch the result. provider = 'meon' | 'setu'.
addColumnIfMissing('digilocker_requests', 'client_token', 'TEXT');
addColumnIfMissing('digilocker_requests', 'provider', 'TEXT');
// Vendor contact-person KYC through the same DigiLocker flow (HR starts it from the
// Add/Edit vendor form; the contact completes consent on their own phone or HR's).
db.exec(`CREATE TABLE IF NOT EXISTS vendor_digilocker_requests (
  id TEXT PRIMARY KEY, hr_user_id TEXT NOT NULL, vendor_id TEXT, status TEXT NOT NULL, client_token TEXT, provider TEXT,
  result_json TEXT, created_at INTEGER NOT NULL, completed_at INTEGER)`);
addColumnIfMissing('vendors', 'contact_aadhaar_verified', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('vendors', 'contact_digilocker_request_id', 'TEXT');
addColumnIfMissing('workers', 'aadhaar_photo_url', 'TEXT'); // DigiLocker-issued photo (URL on the provider), for HR face review
db.exec('CREATE TABLE IF NOT EXISTS vendor_invoices (id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id), month TEXT NOT NULL, invoice_days REAL NOT NULL, invoice_ref TEXT, amount REAL, entered_by TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (vendor_id, month))');
db.exec('CREATE TABLE IF NOT EXISTS attendance_locks (month TEXT PRIMARY KEY, locked_by TEXT NOT NULL, locked_at INTEGER NOT NULL)');
// R17/R18: server-side login sessions (logout + admin 15-minute idle timeout).
db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT NOT NULL, identifier TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT)');
db.exec('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, ended_at)');
addColumnIfMissing('workers', 'registered_by', 'TEXT'); // Team Lead email when registered on the Team Lead's phone (assisted)

// BRD §10 registration screens: job list set by admin (screen 8), consent saved with
// date/time/version (screen 4), live one-face check on the photo (screen 5), optional
// bank passbook photo (design rule 4), and the face-check verdict approval depends on.
db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_hi TEXT, icon TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE IF NOT EXISTS consents (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id), version TEXT NOT NULL, language TEXT, accepted_at INTEGER NOT NULL, device_id TEXT, assisted_by TEXT)`);
addColumnIfMissing('workers', 'job_id', 'TEXT');
addColumnIfMissing('workers', 'consent_version', 'TEXT');
addColumnIfMissing('workers', 'consent_at', 'INTEGER');
addColumnIfMissing('workers', 'photo_check_note', 'TEXT');
addColumnIfMissing('workers', 'face_check_status', 'TEXT'); // clear | review | skipped | blocked
addColumnIfMissing('workers', 'bank_passbook_data_url', 'TEXT');
// BRD §11 screen 9 (grey = off day) and screen 10 (missed punch "calls Team Lead").
addColumnIfMissing('locations', 'weekly_off', 'INTEGER'); // 0 = Sunday … 6 = Saturday; NULL = no weekly off
addColumnIfMissing('hr_users', 'phone', 'TEXT');
// Password login for the admin portal (replaces email OTP): scrypt hash, and a flag set
// whenever a System Admin sets/resets it so the user is made to choose their own.
addColumnIfMissing('hr_users', 'password_hash', 'TEXT');
addColumnIfMissing('hr_users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('hr_users', 'password_changed_at', 'INTEGER');
if (!db.prepare('SELECT 1 FROM jobs LIMIT 1').get()) {
  // BRD §4 scope list; System Admin can rename/add/retire these.
  const seed = [['Washing staff', 'धुलाई कर्मचारी', '🚿'], ['Driver', 'ड्राइवर', '🚗'], ['Security guard', 'सुरक्षा गार्ड', '🛡️'],
    ['Housekeeping', 'हाउसकीपिंग', '🧹'], ['Office boy', 'ऑफिस बॉय', '☕'], ['Denter / painter', 'डेंटर / पेंटर', '🔧'],
    ['Audit staff', 'ऑडिट स्टाफ', '📋'], ['IT staff', 'आईटी स्टाफ', '💻']];
  const ins = db.prepare('INSERT INTO jobs (id, name, name_hi, icon, active, sort) VALUES (?,?,?,?,1,?)');
  seed.forEach(([n, h, i], k) => ins.run(require('node:crypto').randomUUID(), n, h, i, k));
}
addColumnIfMissing('regularisations', 'maker_id', 'TEXT');
addColumnIfMissing('regularisations', 'checker_id', 'TEXT');
// AI triage at raise time (routes/regularisations.js): a category tag for reporting,
// and a short note for the approver — e.g. "4th request this month, worth asking about".
addColumnIfMissing('regularisations', 'reason_category', 'TEXT');
addColumnIfMissing('regularisations', 'ai_triage_note', 'TEXT');
// Vendor onboarding KYC: the contact person's (not the company's — Aadhaar is an
// individual document) Aadhaar + PAN, captured by HR the same way worker KYC is —
// PAN photo OCR + tamper check, Aadhaar QR scan + UIDAI signature check.
addColumnIfMissing('vendors', 'contact_pan_photo_data_url', 'TEXT');
addColumnIfMissing('vendors', 'contact_pan_number', 'TEXT');
addColumnIfMissing('vendors', 'contact_pan_name', 'TEXT');
addColumnIfMissing('vendors', 'contact_pan_tamper_note', 'TEXT');
addColumnIfMissing('vendors', 'contact_pan_verified', 'INTEGER');
addColumnIfMissing('vendors', 'contact_aadhaar_masked', 'TEXT');
addColumnIfMissing('vendors', 'contact_aadhaar_key', 'TEXT');
addColumnIfMissing('vendors', 'contact_aadhaar_name', 'TEXT');
addColumnIfMissing('vendors', 'contact_aadhaar_qr_format', 'TEXT');
addColumnIfMissing('vendors', 'contact_aadhaar_qr_signature', 'TEXT');
addColumnIfMissing('vendors', 'contact_aadhaar_qr_at', 'INTEGER');

function addAudit(user, action, detail) {
  db.prepare('INSERT INTO audit_log (id, ts, user, action, detail) VALUES (?,?,?,?,?)')
    .run(require('node:crypto').randomUUID(), Date.now(), user || 'system', action, detail || '');
}

module.exports = { db, addAudit, DATA_DIR, DB_PATH };
