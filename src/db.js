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
db.exec('CREATE TABLE IF NOT EXISTS vendor_invoices (id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL REFERENCES vendors(id), month TEXT NOT NULL, invoice_days REAL NOT NULL, invoice_ref TEXT, amount REAL, entered_by TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (vendor_id, month))');
db.exec('CREATE TABLE IF NOT EXISTS attendance_locks (month TEXT PRIMARY KEY, locked_by TEXT NOT NULL, locked_at INTEGER NOT NULL)');
// R17/R18: server-side login sessions (logout + admin 15-minute idle timeout).
db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT NOT NULL, identifier TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT)');
addColumnIfMissing('regularisations', 'maker_id', 'TEXT');
addColumnIfMissing('regularisations', 'checker_id', 'TEXT');

function addAudit(user, action, detail) {
  db.prepare('INSERT INTO audit_log (id, ts, user, action, detail) VALUES (?,?,?,?,?)')
    .run(require('node:crypto').randomUUID(), Date.now(), user || 'system', action, detail || '');
}

module.exports = { db, addAudit };
