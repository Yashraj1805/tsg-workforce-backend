// Role model (BRD §5 "Users and access"). One place that answers two questions for
// every admin-portal request: "is this role allowed to do X at all" (permissions) and
// "which workers can this person see" (scope). Routes never check role names directly —
// they ask for a permission and apply the scope, so changing who-can-do-what is an edit
// to this file only.
//
// The worker role isn't an hr_users row; workers authenticate separately (mobile OTP)
// and only ever see their own record, so they're not part of the permission table.

const ROLES = {
  reporting_manager: 'Reporting Manager',
  site_hr: 'Team Lead',
  central_hr: 'Central HR',
  location_head: 'Location Head',
  vendor_coordinator: 'Vendor Coordinator',
  mis_finance: 'MIS / Finance',
  security: 'Security',
  system_admin: 'System Admin',
  // 2026-10-29 (Harpreet): System Admin is deliberately scoped to setup-only (masters/
  // users), not worker data - see ROLE_SCOPE below. Super Admin is the separate "sees and
  // can do everything" role, for whoever should have the full picture.
  super_admin: 'Super Admin',
};

// Which scope column each role needs set on its hr_users row. A role whose scope
// column is empty sees no workers at all (fail closed), rather than everyone.
const ROLE_SCOPE = {
  reporting_manager: 'manager',   // workers.reporting_manager_email = user's email
  site_hr: 'location',            // workers.location_id = user's location_id
  location_head: 'location',
  vendor_coordinator: 'vendor',   // workers.vendor_id = user's vendor_id
  central_hr: 'all',
  mis_finance: 'all',
  security: 'all',
  system_admin: 'none',           // sets up masters/users; no access to worker data
  super_admin: 'all',
};

// BRD §5, mapped onto what the API actually exposes. "Cannot do" column is enforced by
// omission — e.g. nobody but central_hr has workers.approve, so Team Lead can't approve
// their own requests, and security/MIS/location head/vendor coordinator have no write
// permission at all.
const PERMISSIONS = {
  'workers.read':          ['reporting_manager', 'site_hr', 'central_hr', 'location_head', 'vendor_coordinator', 'mis_finance'],
  'workers.approve':       ['central_hr'],             // approve / send back / reject
  'workers.manage':        ['central_hr'],             // transfer / exit / blacklist
  'punches.read':          ['reporting_manager', 'site_hr', 'central_hr', 'location_head', 'vendor_coordinator', 'mis_finance', 'security'],
  'regularisations.read':  ['reporting_manager', 'site_hr', 'central_hr', 'location_head', 'mis_finance'],
  'regularisations.raise': ['site_hr', 'central_hr'],
  'regularisations.decide':['central_hr'],             // maker != checker still enforced on top
  'masters.write':         ['system_admin'],
  'users.manage':          ['system_admin'],
  'audit.read':            ['central_hr', 'security', 'system_admin'],
  // R16 vendor bill check: Finance enters invoice days; vendor coordinators see their own
  // vendor's system days (scope applies). Month lock is Central HR's month-end step.
  'billing.read':          ['mis_finance', 'central_hr', 'vendor_coordinator'],
  // R16 dashboard + Excel reports (BRD 16), always within the caller's scope.
  'reports.read':          ['reporting_manager', 'site_hr', 'central_hr', 'location_head', 'vendor_coordinator', 'mis_finance'],
  // R15: "Automatic emails — set once by central HR" (times, receivers, on/off).
  'emails.manage':         ['central_hr'],
  'billing.write':         ['mis_finance'],
  'attendance.lock':       ['central_hr'],
  // BRD §7.8: Team Lead registers a worker on their own phone, worker present (face + OTP).
  'workers.register_assisted': ['site_hr'],
  // Team lead pre-creates a worker's login (name, mobile, vendor, site, job) before the
  // worker ever opens the app; the worker then only has to log in and clear KYC — never
  // self-register from scratch. Punch-in still waits on approval (Aadhaar+PAN verified),
  // same gate as every other path — this only skips the initial blank-form step.
  // system_admin included so one bulk-import run (masters + people) needs only one login.
  'workers.create_direct': ['site_hr', 'central_hr', 'system_admin'],
  // Proposal: "No HR approval, no entry. Security at the gate checks the portal."
  'workers.gatecheck':     ['security', 'site_hr', 'central_hr', 'location_head'],
  // R20 gate tablets: set up / pair / retire a site's kiosk.
  'kiosks.manage':         ['system_admin', 'central_hr'],
  // Proposal process 3: hiring manager / Team Lead request a transfer or exit; Central HR completes it.
  'requests.raise':        ['reporting_manager', 'site_hr', 'central_hr'],
  'requests.view':         ['reporting_manager', 'site_hr', 'central_hr', 'location_head'],
};

// Super Admin: every permission, by construction, so it can never drift out of sync as
// new permissions get added above (unlike every other role, which is hand-scoped).
for (const key in PERMISSIONS) PERMISSIONS[key].push('super_admin');

// Security's punch access is limited to blocked attempts (BRD: "View blocked punches").
const PUNCH_RESULT_RESTRICTION = { security: 'blocked' };

function isAdminRole(role) { return Object.prototype.hasOwnProperty.call(ROLES, role); }

function can(role, permission) {
  return (PERMISSIONS[permission] || []).includes(role);
}

function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter(p => can(role, p));
}

// SQL fragment restricting a `workers` row (aliased as `alias`) to what `user` may see.
// `user` is the hr_users row loaded by requireAuth, not the token payload, so a scope
// change by a system admin takes effect on the very next request.
function workerScopeSql(user, alias = 'workers') {
  const scope = ROLE_SCOPE[user.role];
  if (scope === 'all') return { sql: '1=1', args: [] };
  if (scope === 'location' && user.location_id) return { sql: `${alias}.location_id = ?`, args: [user.location_id] };
  if (scope === 'vendor' && user.vendor_id) return { sql: `${alias}.vendor_id = ?`, args: [user.vendor_id] };
  if (scope === 'manager' && user.email) return { sql: `lower(${alias}.reporting_manager_email) = ?`, args: [user.email.toLowerCase()] };
  return { sql: '0=1', args: [] };
}

// Same restriction, for tables keyed by worker_id (punches, regularisations).
function workerIdScopeSql(user, column = 'worker_id') {
  const s = workerScopeSql(user, 'w');
  return { sql: `${column} IN (SELECT w.id FROM workers w WHERE ${s.sql})`, args: s.args };
}

module.exports = {
  ROLES, ROLE_SCOPE, PERMISSIONS, PUNCH_RESULT_RESTRICTION,
  isAdminRole, can, permissionsFor, workerScopeSql, workerIdScopeSql,
};
