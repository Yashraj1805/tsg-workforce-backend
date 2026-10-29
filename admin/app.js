// TSG Workforce — Admin Portal (HR / Finance / MIS / managers / System Admin).
// Plain JS, no build step — same pattern as the worker app's www/app.js, just desktop-first.
// Talks to the same backend (same origin, /api/*) and the same login (POST /api/auth/hr/login)
// the worker app's HR screens already used — nothing new on the server side.

const API_BASE = '/api';
const TOKEN_KEY = 'tsg_admin_token';
let state = { token: localStorage.getItem(TOKEN_KEY) || null, user: null, permissions: [] };

const ROLE_LABELS = {
  reporting_manager: 'Reporting Manager', site_hr: 'Team Lead', central_hr: 'Central HR',
  location_head: 'Location Head', vendor_coordinator: 'Vendor Coordinator', mis_finance: 'MIS / Finance',
  security: 'Security', system_admin: 'System Admin',
};
function roleLabel(r) { return ROLE_LABELS[r] || r; }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTime(ts) { if (!ts) return '—'; return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtDateTime(ts) { if (!ts) return '—'; return new Date(ts).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function minutesOfDay(ts) { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); }
function fmtMinutes(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); const d = new Date(); d.setHours(h, m, 0, 0); return fmtTime(d.getTime()); }
function todayStr(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(API_BASE + path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && state.token) { doLogout(true); throw new Error('Session expired — please sign in again'); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
async function apiBlob(path) {
  const res = await fetch(API_BASE + path, { headers: { Authorization: 'Bearer ' + state.token } });
  if (!res.ok) { let d = null; try { d = await res.json(); } catch (e) {} throw new Error((d && d.error) || 'Download failed'); }
  return res.blob();
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- Boot ----
async function boot() {
  if (!state.token) return renderLogin();
  try {
    const me = await api('/auth/me');
    state.user = me.hrUser; state.permissions = me.permissions;
    if (me.mustChangePassword) return renderChangePassword(true);
    renderShell();
  } catch (e) {
    renderLogin();
  }
}
function doLogout(silent) {
  if (!silent) api('/auth/logout', { method: 'POST' }).catch(() => {});
  state = { token: null, user: null, permissions: [] };
  localStorage.removeItem(TOKEN_KEY);
  location.hash = '';
  renderLogin();
}

// ---- Login ----
function renderLogin(err) {
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1>TSG Workforce</h1>
        <p class="sub">Admin Portal — sign in with your TSG email</p>
        ${err ? `<div class="error-box">${esc(err)}</div>` : ''}
        <form id="loginForm">
          <div class="field"><label>Email</label><input id="f_email" type="email" required autocomplete="username" /></div>
          <div class="field"><label>Password</label><input id="f_password" type="password" required autocomplete="current-password" /></div>
          <button class="btn primary block" type="submit">Sign in</button>
        </form>
        <p class="hint">Workers use the TSG Workforce phone app, not this page.</p>
      </div>
    </div>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('f_email').value.trim();
    const password = document.getElementById('f_password').value;
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await api('/auth/hr/login', { method: 'POST', body: { email, password } });
      state.token = r.token; state.user = r.hrUser; state.permissions = r.permissions;
      localStorage.setItem(TOKEN_KEY, r.token);
      if (r.mustChangePassword) renderChangePassword(true);
      else renderShell();
    } catch (err) {
      renderLogin(err.message);
    }
  };
}

function renderChangePassword(forced) {
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1>Set a new password</h1>
        <p class="sub">${forced ? 'You\'re signed in with a temporary password — set your own to continue.' : 'Change your password'}</p>
        <div id="cpErr"></div>
        <form id="cpForm">
          <div class="field"><label>Current password</label><input id="f_cur" type="password" required /></div>
          <div class="field"><label>New password</label><input id="f_new" type="password" required /></div>
          <button class="btn primary block" type="submit">Save and continue</button>
        </form>
        ${!forced ? `<button class="btn secondary block" style="margin-top:8px" id="cpCancel">Cancel</button>` : ''}
      </div>
    </div>`;
  document.getElementById('cpForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/auth/hr/change-password', { method: 'POST', body: { currentPassword: document.getElementById('f_cur').value, newPassword: document.getElementById('f_new').value } });
      toast('Password updated', 'success');
      renderShell();
    } catch (err) {
      document.getElementById('cpErr').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  };
  const cancel = document.getElementById('cpCancel'); if (cancel) cancel.onclick = () => renderRoute((location.hash || '#' + defaultRoute()).replace('#', ''));
}

// ---- Shell / nav ----
// Stroke-based line icons (Feather-style paths), not emoji — emoji render differently
// per OS/browser and look out of place against the dark sidebar (2026-10-29 feedback).
const ICON_PATHS = {
  dashboard: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M9 13h6M9 17h6"/>',
  rupee: '<path d="M6 3h12M6 8h12M9 13c6.667 0 6.667-10 0-10M6 13h3m0 0 8.5 8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  sparkle: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
function svgIcon(key) { return `<svg class="nav-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[key] || ''}</svg>`; }

const NAV = [
  { key: 'dashboard', label: 'Dashboard', perms: ['reports.read'], icon: 'dashboard' },
  { key: 'gate-check', label: 'Gate Check', perms: ['workers.gatecheck'], icon: 'search' },
  { key: 'workers', label: 'Workers', perms: ['workers.read'], icon: 'users' },
  { key: 'attendance', label: 'Attendance', perms: ['workers.read', 'punches.read'], icon: 'calendar' },
  { key: 'exceptions', label: 'Exceptions', perms: ['punches.read'], icon: 'alert' },
  { key: 'timeguard', label: 'TimeGuard', perms: ['workers.read', 'punches.read'], icon: 'shield' },
  { key: 'regularisations', label: 'Missed Punch', perms: ['regularisations.read'], icon: 'clock' },
  { key: 'requests', label: 'Transfer & Exit', perms: ['requests.view'], icon: 'file' },
  { key: 'vendor-bill', label: 'Vendor Bill', perms: ['billing.read'], icon: 'rupee' },
  { key: 'reports', label: 'Reports', perms: ['reports.read'], icon: 'download' },
  { key: 'ask-ai', label: 'Ask AI', perms: ['reports.read'], icon: 'sparkle' },
  { key: 'masters', label: 'Vendors / Sites / Jobs', perms: ['masters.write'], icon: 'building' },
  { key: 'kiosks', label: 'Gate Tablets', perms: ['kiosks.manage'], icon: 'camera' },
  { key: 'emails', label: 'Automatic Emails', perms: ['emails.manage'], icon: 'mail' },
  { key: 'audit', label: 'Audit Log', perms: ['audit.read'], icon: 'list' },
  { key: 'users', label: 'Admin Users', perms: ['users.manage'], icon: 'settings' },
];
function navVisible(n) { return n.perms.every(p => state.permissions.includes(p)); }
function defaultRoute() { const first = NAV.find(navVisible); return first ? first.key : 'dashboard'; }

function renderShell() {
  const items = NAV.filter(navVisible);
  const current = (location.hash || '#' + defaultRoute()).replace('#', '');
  document.getElementById('app').innerHTML = `
    <div class="sidebar-backdrop" id="backdrop"></div>
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">TSG Workforce<span class="sub">Admin Portal</span></div>
        <nav>${items.map(n => `<a href="#${n.key}" data-key="${n.key}">${svgIcon(n.icon)}<span>${n.label}</span></a>`).join('') || '<p style="padding:10px;color:#9ba0d6;font-size:12.5px">No sections available for your role.</p>'}</nav>
        <div class="userbox">
          <div class="name">${esc(state.user.name || state.user.email)}</div>
          <div class="role">${esc(roleLabel(state.user.role))}</div>
          <button class="btn secondary small block" id="changePwBtn" style="margin-bottom:6px">Change password</button>
          <button class="btn secondary small block" id="logoutBtn">Sign out</button>
        </div>
      </aside>
      <div class="main">
        <div class="topbar"><button class="hamburger" id="hamburger">☰</button><strong>TSG Workforce</strong><span></span></div>
        <div class="content" id="content"></div>
      </div>
    </div>`;
  document.getElementById('logoutBtn').onclick = () => doLogout(false);
  document.getElementById('changePwBtn').onclick = () => renderChangePassword(false);
  document.getElementById('hamburger').onclick = () => { document.getElementById('sidebar').classList.toggle('open'); document.getElementById('backdrop').classList.toggle('open'); };
  document.getElementById('backdrop').onclick = () => { document.getElementById('sidebar').classList.remove('open'); document.getElementById('backdrop').classList.remove('open'); };
  if (!items.find(n => n.key === current)) { renderRoute(items[0] ? items[0].key : null); }
  else renderRoute(current);
}
window.addEventListener('hashchange', () => { if (state.token && state.user) renderRoute(location.hash.replace('#', '')); });

function renderRoute(key) {
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.key === key));
  document.getElementById('sidebar').classList.remove('open'); document.getElementById('backdrop').classList.remove('open');
  const content = document.getElementById('content');
  if (!key) { content.innerHTML = '<div class="empty">Nothing to show for your role yet.</div>'; return; }
  content.innerHTML = '<div class="empty">Loading…</div>';
  if (key === 'dashboard') return renderDashboard(content);
  if (key === 'gate-check') return renderGateCheck(content);
  if (key === 'workers') return renderWorkers(content);
  if (key === 'attendance') return renderAttendance(content);
  if (key === 'exceptions') return renderExceptions(content);
  if (key === 'timeguard') return renderTimeGuard(content);
  if (key === 'regularisations') return renderRegularisations(content);
  if (key === 'requests') return renderRequests(content);
  if (key === 'vendor-bill') return renderVendorBill(content);
  if (key === 'reports') return renderReports(content);
  if (key === 'ask-ai') return renderAskAi(content);
  if (key === 'masters') return renderMasters(content);
  if (key === 'kiosks') return renderKiosks(content);
  if (key === 'emails') return renderEmails(content);
  if (key === 'audit') return renderAudit(content);
  if (key === 'users') return renderUsers(content);
  content.innerHTML = '<div class="empty">Not found</div>';
}

function statCard(n, label) { return `<div class="stat-card"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`; }
function emptyRow(cols, msg) { return `<tr><td colspan="${cols}" class="empty">${esc(msg || 'No data')}</td></tr>`; }
function badge(status) { return `<span class="badge ${esc(status || '')}">${esc((status || '—').replace(/_/g, ' '))}</span>`; }

// ---- Dashboard ----
async function renderDashboard(content) {
  try {
    const dash = await api('/reports/dashboard');
    content.innerHTML = `
      <h2>Dashboard</h2>
      <p class="page-sub">${esc(dash.date)}</p>
      <div class="stat-row">
        ${statCard(dash.active, 'Active workers')}
        ${statCard(dash.punchedIn, 'Punched in today')}
        ${statCard(dash.stillIn, 'Still on site')}
        ${statCard(dash.notPunched, 'Not punched in')}
        ${statCard(dash.pendingApprovals, 'Pending approvals')}
        ${statCard(dash.blocked, 'Blocked attempts')}
      </div>
      <div class="card">
        <h3>By location</h3>
        <div class="table-wrap"><table class="data"><thead><tr><th>Location</th><th>Active</th><th>Punched in</th><th>Punched out</th></tr></thead>
        <tbody>${dash.byLocation.map(r => `<tr><td>${esc(r.location)}</td><td>${r.active}</td><td>${r.punchedIn}</td><td>${r.punchedOut}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
      </div>
      <div class="card">
        <h3>By vendor</h3>
        <div class="table-wrap"><table class="data"><thead><tr><th>Vendor</th><th>Active</th><th>Punched in</th><th>Punched out</th></tr></thead>
        <tbody>${dash.byVendor.map(r => `<tr><td>${esc(r.vendor)}</td><td>${r.active}</td><td>${r.punchedIn}</td><td>${r.punchedOut}</td></tr>`).join('') || emptyRow(4)}</tbody></table></div>
      </div>
      <div class="card">
        <h3>Download reports</h3>
        <div class="actions-row">
          <button class="btn secondary small" id="dlAttendance">Attendance (last 30 days) .xlsx</button>
          <button class="btn secondary small" id="dlMuster">Muster roll (this month) .xlsx</button>
        </div>
      </div>`;
    document.getElementById('dlAttendance').onclick = async () => {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
      try { downloadBlob(await apiBlob(`/reports/attendance.xlsx?from=${from}&to=${to}`), `attendance-${from}-to-${to}.xlsx`); }
      catch (e) { toast(e.message, 'error'); }
    };
    document.getElementById('dlMuster').onclick = async () => {
      try { downloadBlob(await apiBlob('/reports/muster.xlsx'), 'muster-roll.xlsx'); }
      catch (e) { toast(e.message, 'error'); }
    };
  } catch (e) { content.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}

// ---- Workers ----
async function renderWorkers(content) {
  content.innerHTML = `
    <h2>Workers</h2>
    <p class="page-sub">Within your scope</p>
    <div class="filter-bar">
      <div class="field"><label>Status</label>
        <select id="statusFilter">
          <option value="">All</option>
          <option value="pending">Pending approval</option>
          <option value="sent_back">Sent back</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="exited">Exited</option>
        </select>
      </div>
      <div class="field" style="flex:1"><label>Search</label><input id="searchBox" placeholder="Name or mobile" /></div>
    </div>
    <div class="table-wrap"><table class="data" id="workersTable"><thead><tr><th>Name</th><th>Mobile</th><th>Vendor</th><th>Site</th><th>Status</th></tr></thead><tbody><tr><td colspan="5" class="empty">Loading…</td></tr></tbody></table></div>`;
  let all = [];
  async function load() {
    const status = document.getElementById('statusFilter').value;
    try { all = await api('/workers' + (status ? `?status=${encodeURIComponent(status)}` : '')); renderRows(); }
    catch (e) { document.querySelector('#workersTable tbody').innerHTML = emptyRow(5, e.message); }
  }
  function renderRows() {
    const q = document.getElementById('searchBox').value.trim().toLowerCase();
    const rows = all.filter(w => !q || (w.name || '').toLowerCase().includes(q) || (w.mobile || '').includes(q));
    const tbody = document.querySelector('#workersTable tbody');
    tbody.innerHTML = rows.map(w => `<tr class="clickable" data-id="${esc(w.id)}"><td>${esc(w.name || '(unnamed)')}</td><td>${esc(w.mobile || '—')}</td><td>${esc(w.vendor_name || '—')}</td><td>${esc(w.location_name || '—')}</td><td>${badge(w.status)}</td></tr>`).join('') || emptyRow(5, 'No workers found');
    tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openWorkerDrawer(tr.dataset.id, load));
  }
  document.getElementById('statusFilter').onchange = load;
  document.getElementById('searchBox').oninput = renderRows;
  load();
}

async function openWorkerDrawer(id, onChange) {
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  overlay.innerHTML = `<div class="drawer"><button class="close">&times;</button><div class="empty">Loading…</div></div>`;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('.close').onclick = () => overlay.remove();
  try {
    const w = await api(`/workers/${id}`);
    const canApprove = state.permissions.includes('workers.approve');
    const canManage = state.permissions.includes('workers.manage');
    overlay.querySelector('.drawer').innerHTML = `
      <button class="close">&times;</button>
      <h2 style="margin-bottom:6px">${esc(w.name || 'Worker')}</h2>
      ${badge(w.status)}
      <dl class="kv">
        <dt>Mobile</dt><dd>${esc(w.mobile || '—')}</dd>
        <dt>Vendor</dt><dd>${esc(w.vendor ? w.vendor.name : '—')}</dd>
        <dt>Site</dt><dd>${esc(w.location ? w.location.name : '—')}</dd>
        <dt>Designation</dt><dd>${esc(w.designation || '—')}</dd>
        <dt>Aadhaar</dt><dd>${esc(w.aadhaar_masked || (w.aadhaar_verified ? 'verified' : 'not verified'))}</dd>
        <dt>PAN</dt><dd>${esc(w.pan_number || (w.pan_verified ? 'verified' : 'not verified'))}</dd>
        <dt>Reporting mgr</dt><dd>${esc(w.reporting_manager_name || '—')}${w.reporting_manager_email ? ` (${esc(w.reporting_manager_email)})` : ''}</dd>
        ${w.send_back_reason ? `<dt>Sent back</dt><dd>${esc(w.send_back_reason)}</dd>` : ''}
        ${w.reject_reason ? `<dt>Rejected</dt><dd>${esc(w.reject_reason)}</dd>` : ''}
      </dl>
      <div class="actions-row">
        ${canApprove && w.status === 'pending' ? `<button class="btn primary small" id="actApprove">Approve</button><button class="btn secondary small" id="actSendBack">Send back</button><button class="btn danger small" id="actReject">Reject</button>` : ''}
        ${canManage && w.status === 'approved' ? `<button class="btn secondary small" id="actTransfer">Transfer</button><button class="btn secondary small" id="actResetDevice">Reset device</button><button class="btn danger small" id="actExit">Mark exited</button>` : ''}
      </div>`;
    overlay.querySelector('.close').onclick = () => overlay.remove();

    const act = async (path, body) => {
      try { await api(`/workers/${id}/${path}`, { method: 'POST', body: body || {} }); toast('Done', 'success'); overlay.remove(); onChange && onChange(); }
      catch (e) { toast(e.message, 'error'); }
    };
    const approveBtn = overlay.querySelector('#actApprove');
    if (approveBtn) approveBtn.onclick = async () => {
      const name = prompt('Reporting manager name:', w.reporting_manager_name || ''); if (name == null) return;
      const email = prompt('Reporting manager email:', w.reporting_manager_email || ''); if (email == null) return;
      try {
        await api(`/workers/${id}/approve`, { method: 'POST', body: { reportingManagerName: name, reportingManagerEmail: email } });
        toast('Approved', 'success'); overlay.remove(); onChange && onChange();
      } catch (e) {
        if (/face review/i.test(e.message)) {
          const note = prompt(e.message + '\n\nEnter a note confirming you compared the photos:');
          if (note) {
            try { await api(`/workers/${id}/approve`, { method: 'POST', body: { reportingManagerName: name, reportingManagerEmail: email, faceReviewNote: note } }); toast('Approved', 'success'); overlay.remove(); onChange && onChange(); }
            catch (e2) { toast(e2.message, 'error'); }
          }
        } else toast(e.message, 'error');
      }
    };
    const sb = overlay.querySelector('#actSendBack'); if (sb) sb.onclick = () => { const reason = prompt('Reason to send back to the worker:'); if (reason) act('send-back', { reason }); };
    const rj = overlay.querySelector('#actReject'); if (rj) rj.onclick = () => { const reason = prompt('Reason for rejecting (the worker is told this):'); if (reason) act('reject', { reason }); };
    const ex = overlay.querySelector('#actExit'); if (ex) ex.onclick = () => {
      const reason = prompt('Reason for exit:'); if (!reason) return;
      if (!confirm(`Mark ${w.name} as exited today?`)) return;
      act('exit', { exitDate: new Date().toISOString().slice(0, 10), reason });
    };
    const rd = overlay.querySelector('#actResetDevice'); if (rd) rd.onclick = () => {
      const reason = prompt('Reason for resetting this worker\'s bound device (lets them bind a new phone):'); if (!reason) return;
      act('reset-device', { reason });
    };
    const tr = overlay.querySelector('#actTransfer'); if (tr) tr.onclick = async () => {
      const [locations, vendors] = await Promise.all([api('/locations').catch(() => []), api('/vendors').catch(() => [])]);
      const locName = prompt(`New site (leave blank to keep "${w.location ? w.location.name : 'current'}"):\n\nOptions: ${locations.map(l => l.name).join(', ')}`, '');
      const venName = prompt(`New vendor (leave blank to keep "${w.vendor ? w.vendor.name : 'current'}"):\n\nOptions: ${vendors.map(v => v.name).join(', ')}`, '');
      const reason = prompt('Reason for transfer:'); if (!reason) return;
      const loc = locName ? locations.find(l => l.name.toLowerCase() === locName.trim().toLowerCase()) : null;
      const ven = venName ? vendors.find(v => v.name.toLowerCase() === venName.trim().toLowerCase()) : null;
      if (locName && !loc) { toast(`No site matches "${locName}"`, 'error'); return; }
      if (venName && !ven) { toast(`No vendor matches "${venName}"`, 'error'); return; }
      act('transfer', { locationId: loc ? loc.id : undefined, vendorId: ven ? ven.id : undefined, reason });
    };
  } catch (e) {
    overlay.querySelector('.drawer').innerHTML = `<button class="close">&times;</button><div class="error-box">${esc(e.message)}</div>`;
    overlay.querySelector('.close').onclick = () => overlay.remove();
  }
}

// ---- Regularisations (missed punch) ----
async function renderRegularisations(content) {
  const canDecide = state.permissions.includes('regularisations.decide');
  content.innerHTML = `
    <h2>Missed Punch Requests</h2>
    <div class="filter-bar">
      <div class="field"><label>Status</label>
        <select id="regStatus"><option value="pending">Pending</option><option value="">All</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
      </div>
    </div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Worker</th><th>Reason</th><th>Raised by</th><th>Status</th>${canDecide ? '<th></th>' : ''}</tr></thead><tbody id="regBody"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div>`;
  let workerNames = {};
  try { (await api('/workers')).forEach(w => { workerNames[w.id] = w.name; }); } catch (e) { /* non-fatal */ }
  async function load() {
    const status = document.getElementById('regStatus').value;
    try {
      const rows = await api('/regularisations' + (status ? `?status=${encodeURIComponent(status)}` : ''));
      document.getElementById('regBody').innerHTML = rows.map(r => `<tr>
        <td>${esc(r.date)}</td><td>${esc(workerNames[r.worker_id] || r.worker_id)}</td>
        <td>${esc(r.reason)}${r.ai_triage_note ? `<div class="muted" style="font-size:11.5px;margin-top:2px">🤖 ${esc(r.ai_triage_note)}</div>` : ''}</td>
        <td>${esc(r.maker)}</td><td>${badge(r.status)}</td>
        ${canDecide ? `<td>${r.status === 'pending' ? `<button class="btn primary small" data-id="${esc(r.id)}" data-d="approved">Approve</button> <button class="btn danger small" data-id="${esc(r.id)}" data-d="rejected">Reject</button>` : ''}</td>` : ''}
      </tr>`).join('') || emptyRow(6, 'No requests');
      document.querySelectorAll('#regBody button[data-id]').forEach(b => b.onclick = async () => {
        try { await api(`/regularisations/${b.dataset.id}/decide`, { method: 'POST', body: { decision: b.dataset.d } }); toast('Updated', 'success'); load(); }
        catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { document.getElementById('regBody').innerHTML = emptyRow(6, e.message); }
  }
  document.getElementById('regStatus').onchange = load;
  load();
}

// ---- Vendor bill ----
async function renderVendorBill(content) {
  const canWrite = state.permissions.includes('billing.write');
  const canLock = state.permissions.includes('attendance.lock');
  const month = new Date().toISOString().slice(0, 7);
  content.innerHTML = `
    <h2>Vendor Bill Check</h2>
    <div class="filter-bar">
      <div class="field"><label>Month</label><input type="month" id="billMonth" value="${month}" /></div>
      <button class="btn secondary small" id="dlBill">Download .xlsx</button>
      ${canLock ? `<button class="btn secondary small" id="lockBtn">…</button>` : ''}
    </div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Vendor</th><th>Workers</th><th>System days</th><th>Invoice days</th><th>Gap</th><th>Status</th>${canWrite ? '<th></th>' : ''}</tr></thead><tbody id="billBody"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    const m = document.getElementById('billMonth').value;
    try {
      const data = await api(`/reports/vendor-bill?month=${m}`);
      if (canLock) {
        const lockBtn = document.getElementById('lockBtn');
        lockBtn.textContent = data.locked ? 'Locked ✓ — unlock' : 'Lock month';
        lockBtn.onclick = async () => {
          try {
            if (data.locked) { const reason = prompt('Reason to unlock:'); if (!reason) return; await api(`/reports/attendance-lock/${m}`, { method: 'DELETE', body: { reason } }); }
            else { if (!confirm(`Lock attendance for ${m}? No more corrections after this.`)) return; await api('/reports/attendance-lock', { method: 'POST', body: { month: m } }); }
            load();
          } catch (e) { toast(e.message, 'error'); }
        };
      }
      document.getElementById('billBody').innerHTML = data.rows.map(r => `<tr>
        <td>${esc(r.vendorName)}</td><td>${r.workers}</td><td>${r.systemDays}</td>
        <td>${r.invoiceDays == null ? '—' : r.invoiceDays}</td><td>${r.gap == null ? '—' : r.gap}</td>
        <td>${badge(r.status)}</td>
        ${canWrite ? `<td><button class="btn secondary small" data-v="${esc(r.vendorId)}">Edit</button></td>` : ''}
      </tr>`).join('') || emptyRow(7, 'No data for this month');
      document.querySelectorAll('#billBody button[data-v]').forEach(b => b.onclick = async () => {
        const invoiceDays = prompt('Invoice days:'); if (invoiceDays == null || invoiceDays === '') return;
        const invoiceRef = prompt('Invoice ref (optional):') || '';
        try { await api('/reports/vendor-invoices', { method: 'PUT', body: { vendorId: b.dataset.v, month: m, invoiceDays: Number(invoiceDays), invoiceRef } }); toast('Saved', 'success'); load(); }
        catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { document.getElementById('billBody').innerHTML = emptyRow(7, e.message); }
  }
  document.getElementById('billMonth').onchange = load;
  document.getElementById('dlBill').onclick = async () => {
    const m = document.getElementById('billMonth').value;
    try { downloadBlob(await apiBlob(`/reports/vendor-bill.xlsx?month=${m}`), `vendor-bill-${m}.xlsx`); }
    catch (e) { toast(e.message, 'error'); }
  };
  load();
}

// ---- Admin users (System Admin) ----
async function renderUsers(content) {
  content.innerHTML = `
    <h2>Admin Users</h2>
    <p class="page-sub">HR / Finance / MIS / manager logins for this portal</p>
    <div class="actions-row" style="margin-bottom:14px"><button class="btn primary small" id="addUserBtn">+ Add user</button></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody id="usersBody"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody></table></div>`;
  let roles = [];
  try { roles = await api('/admin-users/roles'); } catch (e) { /* non-fatal, form just won't have options */ }
  async function load() {
    try {
      const rows = await api('/admin-users');
      document.getElementById('usersBody').innerHTML = rows.map(u => `<tr>
        <td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(roleLabel(u.role))}</td><td>${badge(u.status)}</td>
        <td><button class="btn secondary small" data-reset="${esc(u.id)}">Reset password</button></td>
      </tr>`).join('') || emptyRow(5, 'No admin users yet');
      document.querySelectorAll('#usersBody button[data-reset]').forEach(b => b.onclick = async () => {
        if (!confirm('Reset this user\'s password to a new temporary one?')) return;
        try { const r = await api(`/admin-users/${b.dataset.reset}/reset-password`, { method: 'POST', body: {} }); alert(`New temporary password: ${r.password}\n\nShare this with the user — it won't be shown again.`); }
        catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { document.getElementById('usersBody').innerHTML = emptyRow(5, e.message); }
  }
  document.getElementById('addUserBtn').onclick = () => openAddUserForm(roles, load);
  load();
}

async function openAddUserForm(roles, onChange) {
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  const [locations, vendors] = await Promise.all([
    api('/locations').catch(() => []), api('/vendors').catch(() => []),
  ]);
  overlay.innerHTML = `<div class="drawer">
    <button class="close">&times;</button>
    <h2>Add admin user</h2>
    <form id="addUserForm">
      <div class="field"><label>Name</label><input id="nu_name" required /></div>
      <div class="field"><label>Email</label><input id="nu_email" type="email" required /></div>
      <div class="field"><label>Phone (optional)</label><input id="nu_phone" /></div>
      <div class="field"><label>Role</label>
        <select id="nu_role" required>${roles.map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('')}</select>
      </div>
      <div class="field" id="nu_locationWrap" style="display:none"><label>Location</label>
        <select id="nu_location"><option value="">Select…</option>${locations.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select>
      </div>
      <div class="field" id="nu_vendorWrap" style="display:none"><label>Vendor</label>
        <select id="nu_vendor"><option value="">Select…</option>${vendors.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Temporary password</label><input id="nu_password" required /></div>
      <button type="button" class="btn secondary small" id="nu_suggest" style="margin-bottom:12px">Suggest one</button>
      <button class="btn primary block" type="submit">Create user</button>
    </form>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('.close').onclick = () => overlay.remove();
  function syncScopeFields() {
    const role = roles.find(r => r.id === document.getElementById('nu_role').value);
    document.getElementById('nu_locationWrap').style.display = role && role.scope === 'location' ? '' : 'none';
    document.getElementById('nu_vendorWrap').style.display = role && role.scope === 'vendor' ? '' : 'none';
  }
  document.getElementById('nu_role').onchange = syncScopeFields; syncScopeFields();
  document.getElementById('nu_suggest').onclick = async () => { try { const r = await api('/admin-users/suggest-password'); document.getElementById('nu_password').value = r.password; } catch (e) { toast(e.message, 'error'); } };
  document.getElementById('addUserForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/admin-users', { method: 'POST', body: {
        name: document.getElementById('nu_name').value, email: document.getElementById('nu_email').value,
        phone: document.getElementById('nu_phone').value || undefined, role: document.getElementById('nu_role').value,
        locationId: document.getElementById('nu_location') ? document.getElementById('nu_location').value || undefined : undefined,
        vendorId: document.getElementById('nu_vendor') ? document.getElementById('nu_vendor').value || undefined : undefined,
        password: document.getElementById('nu_password').value,
      } });
      toast('User created', 'success'); overlay.remove(); onChange && onChange();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---- Gate Check (Security's main screen: quick lookup before letting someone in) ----
async function renderGateCheck(content) {
  content.innerHTML = `
    <h2>Gate Check</h2>
    <p class="page-sub">Search by name or the last digits of the mobile number</p>
    <div class="filter-bar"><div class="field" style="flex:1;max-width:360px"><input id="gateQ" placeholder="Type at least 3 characters…" autofocus /></div></div>
    <div id="gateResults"></div>`;
  let t;
  document.getElementById('gateQ').oninput = (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    if (q.length < 3) { document.getElementById('gateResults').innerHTML = ''; return; }
    t = setTimeout(async () => {
      try {
        const rows = await api('/workers/gate-check?q=' + encodeURIComponent(q));
        document.getElementById('gateResults').innerHTML = rows.map(r => `
          <div class="card" style="display:flex;gap:14px;align-items:center">
            ${r.photo ? `<img src="${esc(r.photo)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;flex-shrink:0" />` : '<div style="width:56px;height:56px;border-radius:50%;background:var(--border-soft);flex-shrink:0"></div>'}
            <div style="flex:1">
              <strong>${esc(r.name || '(unnamed)')}</strong> <span class="muted">•••${esc(r.mobileLast4)}</span><br/>
              <span class="muted">${esc(r.designation || '—')} · ${esc(r.vendor || '—')} · ${esc(r.location || '—')}</span>
            </div>
            <span class="badge ${r.entryAllowed ? 'approved' : 'rejected'}">${r.entryAllowed ? 'Allow entry' : 'Do not allow'}</span>
          </div>`).join('') || '<div class="empty">No match</div>';
      } catch (e) { document.getElementById('gateResults').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
    }, 300);
  };
}

// ---- Attendance (punch register) ----
async function renderAttendance(content) {
  const today = new Date().toISOString().slice(0, 10);
  content.innerHTML = `
    <h2>Attendance</h2>
    <div class="filter-bar">
      <div class="field"><label>Date</label><input type="date" id="attDate" value="${today}" /></div>
      <div class="field"><label>Result</label><select id="attResult"><option value="">All</option><option value="ok">OK</option><option value="blocked">Blocked</option></select></div>
    </div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Time</th><th>Worker</th><th>Type</th><th>Result</th><th>Distance</th><th>Reason</th></tr></thead><tbody id="attBody"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    const date = document.getElementById('attDate').value;
    const result = document.getElementById('attResult').value;
    try {
      const rows = await api(`/punches?date=${date}${result ? `&result=${result}` : ''}`);
      document.getElementById('attBody').innerHTML = rows.map(p => `<tr>
        <td>${fmtTime(p.ts)}</td><td>${esc(p.worker_name || p.worker_id)}</td><td>${esc(p.type)}</td>
        <td>${badge(p.result)}</td><td>${p.distance_m != null ? Math.round(p.distance_m) + 'm' : '—'}</td><td>${esc(p.reason || '—')}</td>
      </tr>`).join('') || emptyRow(6, 'No punches for this day');
    } catch (e) { document.getElementById('attBody').innerHTML = emptyRow(6, e.message); }
  }
  document.getElementById('attDate').onchange = load;
  document.getElementById('attResult').onchange = load;
  load();
}

// ---- Exceptions (blocked / flagged punches, with reference-photo confirm) ----
async function renderExceptions(content) {
  const canConfirmRef = state.permissions.includes('workers.approve');
  content.innerHTML = `
    <h2>Exceptions</h2>
    <p class="page-sub">Blocked punch attempts, last 14 days</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Photo</th><th>Time</th><th>Worker</th><th>Reason</th><th>Risk</th>${canConfirmRef ? '<th></th>' : ''}</tr></thead><tbody id="excBody"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    try {
      const rows = await api('/punches?result=blocked');
      document.getElementById('excBody').innerHTML = rows.map(p => `<tr>
        <td>${p.selfie_data_url ? `<img src="${esc(p.selfie_data_url)}" style="width:40px;height:40px;border-radius:6px;object-fit:cover" />` : '—'}</td>
        <td>${fmtDateTime(p.ts)}</td><td>${esc(p.worker_name || p.worker_id)}</td><td>${esc(p.reason || p.face_match_note || '—')}</td><td>${p.risk_score != null ? p.risk_score : '—'}</td>
        ${canConfirmRef ? `<td>${p.selfie_data_url ? `<button class="btn secondary small" data-w="${esc(p.worker_id)}" data-p="${esc(p.id)}">Set as reference photo</button>` : ''}</td>` : ''}
      </tr>`).join('') || emptyRow(6, 'No blocked attempts in the last 14 days');
      document.querySelectorAll('#excBody button[data-w]').forEach(b => b.onclick = async () => {
        if (!confirm('Confirm this selfie is genuinely this worker, and use it as their reference photo for future face-match checks?')) return;
        try { await api(`/workers/${b.dataset.w}/reference-photo`, { method: 'POST', body: { punchId: b.dataset.p } }); toast('Reference photo updated', 'success'); }
        catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { document.getElementById('excBody').innerHTML = emptyRow(6, e.message); }
  }
  load();
}

// ---- TimeGuard (pattern-based fraud/anomaly flags - computed client-side from real data,
// same logic as the phone app's HR screen: unusual punch times, geofence-edge patterns,
// overtime risk, high regularisation rate, and two workers punching from ~the same spot). ----
function computeTimeGuardFlags({ workers, locations, punches, regularisations }) {
  const flags = [];
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86400000, thirtyDaysAgo = now - 30 * 86400000;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const locById = Object.fromEntries(locations.map(l => [l.id, l]));
  const nameById = Object.fromEntries(workers.map(w => [w.id, w.name || w.mobile]));

  workers.filter(w => w.status === 'approved').forEach(w => {
    const wPunches = punches.filter(p => p.worker_id === w.id && p.result === 'ok');
    const inPunches = wPunches.filter(p => p.type === 'in').sort((a, b) => a.ts - b.ts);
    if (inPunches.length >= 4) {
      const recentIns = inPunches.slice(-10);
      const avgMinute = recentIns.reduce((sum, p) => sum + minutesOfDay(p.ts), 0) / recentIns.length;
      const last = recentIns[recentIns.length - 1], lastMinute = minutesOfDay(last.ts);
      if (last.ts > sevenDaysAgo && Math.abs(lastMinute - avgMinute) > 45) {
        flags.push({ severity: 'warn', workerId: w.id, ts: last.ts, message: `Punched in ${Math.round(Math.abs(lastMinute - avgMinute))} min ${lastMinute > avgMinute ? 'later' : 'earlier'} than usual (average ${fmtMinutes(avgMinute)})` });
      }
    }
    const blocked7d = punches.filter(p => p.worker_id === w.id && p.result === 'blocked' && p.reason === 'outside_geofence' && p.ts > sevenDaysAgo);
    if (blocked7d.length >= 2) flags.push({ severity: 'bad', workerId: w.id, ts: blocked7d[blocked7d.length - 1].ts, message: `${blocked7d.length} outside-geofence attempts in the last 7 days` });
    const loc = locById[w.location_id];
    if (loc) {
      const nearEdge = wPunches.filter(p => p.distance_m != null && p.distance_m > loc.radius * 0.8 && p.distance_m <= loc.radius && p.ts > thirtyDaysAgo);
      if (nearEdge.length >= 3) flags.push({ severity: 'warn', workerId: w.id, ts: nearEdge[nearEdge.length - 1].ts, message: `${nearEdge.length} punches within 80-100% of the geofence radius in 30 days` });
    }
    const regThisMonth = regularisations.filter(r => r.worker_id === w.id && r.created_at >= monthStart.getTime());
    const punchDaysThisMonth = new Set(wPunches.filter(p => p.ts >= monthStart.getTime()).map(p => todayStr(p.ts))).size || 1;
    const regRate = regThisMonth.length / punchDaysThisMonth;
    if (regThisMonth.length >= 2 && regRate > 0.02) flags.push({ severity: 'warn', workerId: w.id, ts: now, message: `${regThisMonth.length} regularisations this month (${Math.round(regRate * 100)}% of days)` });
  });

  const okPunches = punches.filter(p => p.result === 'ok' && p.lat != null).sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < okPunches.length; i++) {
    for (let j = i + 1; j < okPunches.length; j++) {
      const a = okPunches[i], b = okPunches[j];
      if (b.ts - a.ts > 120000) break;
      if (a.worker_id === b.worker_id) continue;
      const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      if (d < 5) flags.push({ severity: 'bad', workerId: a.worker_id, ts: b.ts, message: `${esc(nameById[a.worker_id])} and ${esc(nameById[b.worker_id])} punched ${Math.round((b.ts - a.ts) / 1000)}s apart ${d.toFixed(1)}m apart — check for a shared device` });
    }
  }
  return flags.sort((a, b) => b.ts - a.ts);
}
async function renderTimeGuard(content) {
  content.innerHTML = `<h2>TimeGuard</h2><p class="page-sub">Pattern-based flags from the last 30 days — not proof, a prompt to look closer</p><div id="tgBody" class="empty">Loading…</div>`;
  try {
    const since = Date.now() - 30 * 86400000;
    const [workers, locations, punches, regularisations] = await Promise.all([
      api('/workers'), api('/locations'), api(`/punches?from=${since}&limit=1000`), api('/regularisations'),
    ]);
    const nameById = Object.fromEntries(workers.map(w => [w.id, w.name || w.mobile]));
    const flags = computeTimeGuardFlags({ workers, locations, punches, regularisations });
    document.getElementById('tgBody').innerHTML = flags.length ? flags.map(f => `
      <div class="card" style="border-left:4px solid var(--${f.severity === 'bad' ? 'bad' : 'warn'})">
        <strong>${esc(nameById[f.workerId] || f.workerId)}</strong> <span class="muted">· ${fmtDateTime(f.ts)}</span>
        <p style="margin:4px 0 0">${f.message}</p>
      </div>`).join('') : '<div class="empty">No flags right now</div>';
  } catch (e) { document.getElementById('tgBody').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}

// ---- Transfer & Exit Requests ----
async function renderRequests(content) {
  const canRaise = state.permissions.includes('requests.raise');
  const canComplete = state.permissions.includes('workers.manage');
  content.innerHTML = `
    <h2>Transfer &amp; Exit Requests</h2>
    <div class="actions-row" style="margin-bottom:14px">${canRaise ? '<button class="btn primary small" id="raiseBtn">+ Raise request</button>' : ''}</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Worker</th><th>Type</th><th>Detail</th><th>Reason</th><th>Status</th><th>Raised by</th><th></th></tr></thead><tbody id="reqBody"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    try {
      const rows = await api('/worker-requests');
      document.getElementById('reqBody').innerHTML = rows.map(r => `<tr>
        <td>${esc(r.worker_name)}</td><td>${esc(r.type)}</td>
        <td>${r.type === 'transfer' ? `→ ${esc(r.to_location || r.to_vendor || '—')}` : esc(r.exit_date || '—')}</td>
        <td>${esc(r.reason)}</td><td>${badge(r.status)}</td><td>${esc(r.raised_by)}</td>
        <td>
          ${r.status === 'pending' && r.type === 'transfer' && canRaise ? `<button class="btn primary small" data-act="accept" data-id="${esc(r.id)}">Accept</button>` : ''}
          ${(r.status === 'accepted' || (r.status === 'pending' && r.type === 'exit')) && canComplete ? `<button class="btn primary small" data-act="complete" data-id="${esc(r.id)}">Complete</button>` : ''}
          ${(r.status === 'pending' || r.status === 'accepted') && canRaise ? `<button class="btn danger small" data-act="reject" data-id="${esc(r.id)}">Reject</button>` : ''}
        </td>
      </tr>`).join('') || emptyRow(7, 'No requests');
      document.querySelectorAll('#reqBody button[data-act]').forEach(b => b.onclick = async () => {
        const id = b.dataset.id, act = b.dataset.act;
        try {
          if (act === 'accept') await api(`/worker-requests/${id}/accept`, { method: 'POST', body: {} });
          else if (act === 'complete') { if (!confirm('Carry out this request now?')) return; await api(`/worker-requests/${id}/complete`, { method: 'POST', body: {} }); }
          else if (act === 'reject') { const reason = prompt('Reason for rejecting:'); if (!reason) return; await api(`/worker-requests/${id}/reject`, { method: 'POST', body: { reason } }); }
          toast('Updated', 'success'); load();
        } catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { document.getElementById('reqBody').innerHTML = emptyRow(7, e.message); }
  }
  const raiseBtn = document.getElementById('raiseBtn');
  if (raiseBtn) raiseBtn.onclick = async () => {
    const workers = await api('/workers?status=approved').catch(() => []);
    const name = prompt(`Worker name (approved workers only):\n\n${workers.map(w => w.name).join(', ')}`);
    if (!name) return;
    const w = workers.find(x => (x.name || '').toLowerCase() === name.trim().toLowerCase());
    if (!w) { toast('No approved worker matches that name', 'error'); return; }
    const type = (prompt('Type: "transfer" or "exit"?', 'transfer') || '').trim().toLowerCase();
    if (type !== 'transfer' && type !== 'exit') { toast('Must be "transfer" or "exit"', 'error'); return; }
    const reason = prompt('Reason:'); if (!reason) return;
    const body = { workerId: w.id, type, reason };
    if (type === 'transfer') {
      const [locations, vendors] = await Promise.all([api('/locations').catch(() => []), api('/vendors').catch(() => [])]);
      const locName = prompt(`New site (blank to keep current):\n\n${locations.map(l => l.name).join(', ')}`, '');
      const venName = prompt(`New vendor (blank to keep current):\n\n${vendors.map(v => v.name).join(', ')}`, '');
      const loc = locName ? locations.find(l => l.name.toLowerCase() === locName.trim().toLowerCase()) : null;
      const ven = venName ? vendors.find(v => v.name.toLowerCase() === venName.trim().toLowerCase()) : null;
      if (loc) body.toLocationId = loc.id;
      if (ven) body.toVendorId = ven.id;
    } else {
      body.exitDate = prompt('Exit date (YYYY-MM-DD):', new Date().toISOString().slice(0, 10)) || undefined;
      body.blacklist = confirm('Flag for blacklisting (misconduct)?');
    }
    try { await api('/worker-requests', { method: 'POST', body }); toast('Request raised', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  };
  load();
}

// ---- Reports (Excel downloads with real filters) ----
async function renderReports(content) {
  let filters = { brands: [], locations: [], vendors: [], jobs: [] };
  try { filters = await api('/reports/filters'); } catch (e) { /* non-fatal */ }
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  content.innerHTML = `
    <h2>Reports</h2>
    <div class="card">
      <h3>Attendance (date range, max 3 months)</h3>
      <div class="filter-bar">
        <div class="field"><label>From</label><input type="date" id="rFrom" value="${monthAgo}" /></div>
        <div class="field"><label>To</label><input type="date" id="rTo" value="${today}" /></div>
        <div class="field"><label>Location</label><select id="rLoc"><option value="">All</option>${filters.locations.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Vendor</label><select id="rVen"><option value="">All</option>${filters.vendors.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></div>
        <button class="btn primary small" id="dlAtt">Download .xlsx</button>
      </div>
    </div>
    <div class="card">
      <h3>Muster roll (month)</h3>
      <div class="filter-bar"><div class="field"><label>Month</label><input type="month" id="rMonth" value="${month}" /></div><button class="btn primary small" id="dlMuster">Download .xlsx</button></div>
    </div>`;
  document.getElementById('dlAtt').onclick = async () => {
    const from = document.getElementById('rFrom').value, to = document.getElementById('rTo').value;
    const locationId = document.getElementById('rLoc').value, vendorId = document.getElementById('rVen').value;
    const qs = new URLSearchParams({ from, to, ...(locationId ? { locationId } : {}), ...(vendorId ? { vendorId } : {}) });
    try { downloadBlob(await apiBlob(`/reports/attendance.xlsx?${qs}`), `attendance-${from}-to-${to}.xlsx`); } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('dlMuster').onclick = async () => {
    const m = document.getElementById('rMonth').value;
    try { downloadBlob(await apiBlob(`/reports/muster.xlsx?month=${m}`), `muster-roll-${m}.xlsx`); } catch (e) { toast(e.message, 'error'); }
  };
}

// ---- Ask AI ----
async function renderAskAi(content) {
  content.innerHTML = `
    <h2>Ask AI</h2>
    <p class="page-sub">Answers only from data your role can already see</p>
    <div class="card" id="aiThread" style="min-height:200px"></div>
    <div class="filter-bar"><div class="field" style="flex:1"><input id="aiQ" placeholder="e.g. How many workers are pending approval at Narela?" /></div><button class="btn primary small" id="aiSend">Ask</button></div>`;
  const history = [];
  function addBubble(role, text) {
    const div = document.createElement('div');
    div.style.margin = '0 0 12px'; div.style.padding = '10px 12px'; div.style.borderRadius = '8px';
    div.style.background = role === 'user' ? 'var(--primary-tint)' : 'var(--border-soft)';
    div.innerHTML = `<strong>${role === 'user' ? 'You' : 'AI'}:</strong> ${esc(text)}`;
    document.getElementById('aiThread').appendChild(div);
    div.scrollIntoView({ behavior: 'smooth' });
  }
  async function send() {
    const q = document.getElementById('aiQ').value.trim();
    if (!q) return;
    addBubble('user', q);
    document.getElementById('aiQ').value = '';
    try {
      const r = await api('/assistant/ask', { method: 'POST', body: { question: q, history } });
      addBubble('ai', r.answer);
      history.push({ question: q, answer: r.answer });
    } catch (e) { addBubble('ai', e.message); }
  }
  document.getElementById('aiSend').onclick = send;
  document.getElementById('aiQ').onkeydown = (e) => { if (e.key === 'Enter') send(); };
}

// ---- Masters: Vendors / Sites / Jobs (System Admin) ----
async function renderMasters(content, tab) {
  tab = tab || 'vendors';
  content.innerHTML = `
    <h2>Vendors / Sites / Jobs</h2>
    <div class="filter-bar" style="margin-bottom:0">
      <button class="btn ${tab === 'vendors' ? 'primary' : 'secondary'} small" data-tab="vendors">Vendors</button>
      <button class="btn ${tab === 'locations' ? 'primary' : 'secondary'} small" data-tab="locations">Sites</button>
      <button class="btn ${tab === 'jobs' ? 'primary' : 'secondary'} small" data-tab="jobs">Jobs</button>
    </div>
    <div id="mastersBody" style="margin-top:16px"></div>`;
  content.querySelectorAll('button[data-tab]').forEach(b => b.onclick = () => renderMasters(content, b.dataset.tab));
  const body = document.getElementById('mastersBody');
  if (tab === 'vendors') return renderVendorsTab(body);
  if (tab === 'locations') return renderLocationsTab(body);
  return renderJobsTab(body);
}
async function renderVendorsTab(body) {
  body.innerHTML = `<div class="actions-row" style="margin-bottom:12px"><button class="btn primary small" id="addVendor">+ Add vendor</button></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>GSTIN</th><th>Contact</th><th>Phone</th><th>Status</th><th></th></tr></thead><tbody id="vList"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    try {
      const rows = await api('/vendors');
      document.getElementById('vList').innerHTML = rows.map(v => `<tr><td>${esc(v.name)}</td><td>${esc(v.gstin || '—')}</td><td>${esc(v.contact_person || '—')}</td><td>${esc(v.phone || '—')}</td><td>${badge(v.status)}</td><td><button class="btn secondary small" data-edit="${esc(v.id)}">Edit</button></td></tr>`).join('') || emptyRow(6, 'No vendors yet');
      document.querySelectorAll('#vList button[data-edit]').forEach(b => b.onclick = () => openVendorForm(rows.find(v => v.id === b.dataset.edit), load));
    } catch (e) { document.getElementById('vList').innerHTML = emptyRow(6, e.message); }
  }
  document.getElementById('addVendor').onclick = () => openVendorForm(null, load);
  load();
}
function openVendorForm(v, onChange) {
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  overlay.innerHTML = `<div class="drawer"><button class="close">&times;</button>
    <h2>${v ? 'Edit vendor' : 'Add vendor'}</h2>
    <form id="vForm">
      <div class="field"><label>Name</label><input id="v_name" value="${esc(v ? v.name : '')}" required /></div>
      <div class="field"><label>GSTIN</label><input id="v_gstin" value="${esc(v ? v.gstin || '' : '')}" /></div>
      <div class="field"><label>PAN</label><input id="v_pan" value="${esc(v ? v.pan || '' : '')}" /></div>
      <div class="field"><label>Contact person</label><input id="v_contact" value="${esc(v ? v.contact_person || '' : '')}" /></div>
      <div class="field"><label>Phone</label><input id="v_phone" value="${esc(v ? v.phone || '' : '')}" /></div>
      <div class="field"><label>Contract start</label><input type="date" id="v_start" value="${esc(v ? v.contract_start || '' : '')}" /></div>
      <div class="field"><label>Contract end</label><input type="date" id="v_end" value="${esc(v ? v.contract_end || '' : '')}" /></div>
      <div class="field"><label>Status</label><select id="v_status"><option value="active" ${v && v.status === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${v && v.status === 'inactive' ? 'selected' : ''}>Inactive</option></select></div>
      <button class="btn primary block" type="submit">Save</button>
    </form>
    <p class="hint">Vendor contact KYC (Aadhaar/PAN verification) is done from the phone app, which can take document photos.</p>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('.close').onclick = () => overlay.remove();
  document.getElementById('vForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: document.getElementById('v_name').value, gstin: document.getElementById('v_gstin').value || undefined,
      pan: document.getElementById('v_pan').value || undefined, contactPerson: document.getElementById('v_contact').value || undefined,
      phone: document.getElementById('v_phone').value || undefined, contractStart: document.getElementById('v_start').value || undefined,
      contractEnd: document.getElementById('v_end').value || undefined, status: document.getElementById('v_status').value };
    try {
      if (v) await api(`/vendors/${v.id}`, { method: 'PUT', body }); else await api('/vendors', { method: 'POST', body });
      toast('Saved', 'success'); overlay.remove(); onChange && onChange();
    } catch (err) { toast(err.message, 'error'); }
  };
}
async function renderLocationsTab(body) {
  body.innerHTML = `<div class="actions-row" style="margin-bottom:12px"><button class="btn primary small" id="addLoc">+ Add site</button></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Brand</th><th>Radius</th><th></th></tr></thead><tbody id="lList"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    try {
      const rows = await api('/locations');
      document.getElementById('lList').innerHTML = rows.map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.brand || '—')}</td><td>${l.radius}m</td><td><button class="btn secondary small" data-edit="${esc(l.id)}">Edit</button></td></tr>`).join('') || emptyRow(4, 'No sites yet');
      document.querySelectorAll('#lList button[data-edit]').forEach(b => b.onclick = () => openLocationForm(rows.find(l => l.id === b.dataset.edit), load));
    } catch (e) { document.getElementById('lList').innerHTML = emptyRow(4, e.message); }
  }
  document.getElementById('addLoc').onclick = () => openLocationForm(null, load);
  load();
}
function openLocationForm(l, onChange) {
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  overlay.innerHTML = `<div class="drawer"><button class="close">&times;</button>
    <h2>${l ? 'Edit site' : 'Add site'}</h2>
    <form id="lForm">
      <div class="field"><label>Name</label><input id="l_name" value="${esc(l ? l.name : '')}" required /></div>
      <div class="field"><label>Brand</label><input id="l_brand" value="${esc(l ? l.brand || '' : '')}" /></div>
      <div class="field"><label>Latitude</label><input id="l_lat" type="number" step="any" value="${l ? l.lat : ''}" required /></div>
      <div class="field"><label>Longitude</label><input id="l_lng" type="number" step="any" value="${l ? l.lng : ''}" required /></div>
      <div class="field"><label>Geofence radius (m)</label><input id="l_radius" type="number" value="${l ? l.radius : 150}" /></div>
      <div class="field"><label>GPS accuracy limit (m)</label><input id="l_accuracy" type="number" value="${l ? l.accuracy_limit : 100}" /></div>
      <button class="btn primary block" type="submit">Save</button>
    </form>
    <p class="hint">Tip: open the site in Google Maps, right-click the exact spot, and copy the lat/lng shown.</p>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('.close').onclick = () => overlay.remove();
  document.getElementById('lForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: document.getElementById('l_name').value, brand: document.getElementById('l_brand').value || undefined,
      lat: Number(document.getElementById('l_lat').value), lng: Number(document.getElementById('l_lng').value),
      radius: Number(document.getElementById('l_radius').value), accuracyLimit: Number(document.getElementById('l_accuracy').value) };
    try {
      if (l) await api(`/locations/${l.id}`, { method: 'PUT', body }); else await api('/locations', { method: 'POST', body });
      toast('Saved', 'success'); overlay.remove(); onChange && onChange();
    } catch (err) { toast(err.message, 'error'); }
  };
}
async function renderJobsTab(body) {
  body.innerHTML = `<div class="actions-row" style="margin-bottom:12px"><button class="btn primary small" id="addJob">+ Add job</button></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Icon</th><th>Name (English)</th><th>Name (Hindi)</th><th>Status</th><th></th></tr></thead><tbody id="jList"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    try {
      const rows = await api('/jobs');
      document.getElementById('jList').innerHTML = rows.map(j => `<tr><td>${esc(j.icon || '—')}</td><td>${esc(j.name)}</td><td>${esc(j.name_hi || '—')}</td><td><span class="badge ${j.active ? 'approved' : 'rejected'}">${j.active ? 'active' : 'retired'}</span></td><td><button class="btn secondary small" data-edit="${esc(j.id)}">Edit</button></td></tr>`).join('') || emptyRow(5, 'No jobs yet');
      document.querySelectorAll('#jList button[data-edit]').forEach(b => b.onclick = () => openJobForm(rows.find(j => j.id === b.dataset.edit), load));
    } catch (e) { document.getElementById('jList').innerHTML = emptyRow(5, e.message); }
  }
  document.getElementById('addJob').onclick = () => openJobForm(null, load);
  load();
}
function openJobForm(j, onChange) {
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  overlay.innerHTML = `<div class="drawer"><button class="close">&times;</button>
    <h2>${j ? 'Edit job' : 'Add job'}</h2>
    <form id="jForm">
      <div class="field"><label>Name (English)</label><input id="j_name" value="${esc(j ? j.name : '')}" required /></div>
      <div class="field"><label>Name (Hindi)</label><input id="j_nameHi" value="${esc(j ? j.name_hi || '' : '')}" /></div>
      <div class="field"><label>Icon (emoji)</label><input id="j_icon" value="${esc(j ? j.icon || '' : '')}" /></div>
      ${j ? `<div class="field"><label><input type="checkbox" id="j_active" ${j.active ? 'checked' : ''} style="width:auto;margin-right:6px" />Active (shown to workers)</label></div>` : ''}
      <button class="btn primary block" type="submit">Save</button>
    </form>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('.close').onclick = () => overlay.remove();
  document.getElementById('jForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: document.getElementById('j_name').value, nameHi: document.getElementById('j_nameHi').value || undefined, icon: document.getElementById('j_icon').value || undefined };
    if (j) body.active = document.getElementById('j_active').checked;
    try {
      if (j) await api(`/jobs/${j.id}`, { method: 'PUT', body }); else await api('/jobs', { method: 'POST', body });
      toast('Saved', 'success'); overlay.remove(); onChange && onChange();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---- Gate Tablets (kiosks) ----
async function renderKiosks(content) {
  content.innerHTML = `<h2>Gate Tablets</h2>
    <div class="actions-row" style="margin-bottom:14px"><button class="btn primary small" id="addKiosk">+ Add gate tablet</button></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Site</th><th>Status</th><th>Paired</th><th></th></tr></thead><tbody id="kList"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody></table></div>`;
  async function load() {
    try {
      const rows = await api('/kiosks');
      document.getElementById('kList').innerHTML = rows.map(k => `<tr><td>${esc(k.name)}</td><td>${esc(k.location_name || '—')}</td><td>${badge(k.status)}</td><td>${k.paired_at ? 'Yes' : 'Not yet'}</td>
        <td><button class="btn secondary small" data-code="${esc(k.id)}">New code</button> <button class="btn ${k.status === 'active' ? 'danger' : 'secondary'} small" data-toggle="${esc(k.id)}" data-next="${k.status === 'active' ? 'retired' : 'active'}">${k.status === 'active' ? 'Retire' : 'Reactivate'}</button></td>
      </tr>`).join('') || emptyRow(5, 'No gate tablets yet');
      document.querySelectorAll('#kList button[data-code]').forEach(b => b.onclick = async () => {
        try { const r = await api(`/kiosks/${b.dataset.code}/new-code`, { method: 'POST', body: {} }); alert(`Pairing code: ${r.pairingCode}\n\nValid for ${r.pairingExpiresInHours} hours. Enter it on the tablet.`); }
        catch (e) { toast(e.message, 'error'); }
      });
      document.querySelectorAll('#kList button[data-toggle]').forEach(b => b.onclick = async () => {
        try { await api(`/kiosks/${b.dataset.toggle}`, { method: 'PUT', body: { status: b.dataset.next } }); toast('Updated', 'success'); load(); }
        catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { document.getElementById('kList').innerHTML = emptyRow(5, e.message); }
  }
  document.getElementById('addKiosk').onclick = async () => {
    const locations = await api('/locations').catch(() => []);
    const name = prompt('Tablet name (e.g. "Narela Showroom Gate"):'); if (!name) return;
    const locName = prompt(`Site:\n\n${locations.map(l => l.name).join(', ')}`); if (!locName) return;
    const loc = locations.find(l => l.name.toLowerCase() === locName.trim().toLowerCase());
    if (!loc) { toast('No site matches that name', 'error'); return; }
    try { const r = await api('/kiosks', { method: 'POST', body: { name, locationId: loc.id } }); alert(`Pairing code: ${r.pairingCode}\n\nValid for ${r.pairingExpiresInHours} hours. Enter it on the tablet.`); load(); }
    catch (e) { toast(e.message, 'error'); }
  };
  load();
}

// ---- Automatic Emails ----
async function renderEmails(content) {
  content.innerHTML = `<h2>Automatic Emails</h2><div id="emBody" class="empty">Loading…</div>`;
  async function load() {
    try {
      const data = await api('/email-reports');
      document.getElementById('emBody').innerHTML = `
        <p class="page-sub">Email delivery: ${data.delivery.email ? '✅ configured' : '⚠️ not configured'} · WhatsApp: ${data.delivery.whatsapp ? '✅ configured' : '⚠️ not configured'}</p>
        ${data.reports.map(r => `
        <div class="card">
          <h3>${esc(r.title)} <span class="badge ${r.enabled ? 'approved' : 'rejected'}" style="margin-left:8px">${r.enabled ? 'on' : 'off'}</span></h3>
          <p class="muted" style="margin:0 0 10px">${esc(r.shows)} · to: ${esc(r.to)} · ${esc(r.schedule)} at ${esc(r.time)}</p>
          <div class="actions-row">
            <button class="btn secondary small" data-toggle="${esc(r.key)}" data-next="${r.enabled ? '0' : '1'}">${r.enabled ? 'Turn off' : 'Turn on'}</button>
            <button class="btn secondary small" data-time="${esc(r.key)}">Change time</button>
            <button class="btn secondary small" data-send="${esc(r.key)}">Send now</button>
          </div>
        </div>`).join('')}`;
      document.querySelectorAll('#emBody button[data-toggle]').forEach(b => b.onclick = async () => {
        try { await api(`/email-reports/${b.dataset.toggle}`, { method: 'PUT', body: { enabled: b.dataset.next === '1' } }); toast('Saved', 'success'); load(); }
        catch (e) { toast(e.message, 'error'); }
      });
      document.querySelectorAll('#emBody button[data-time]').forEach(b => b.onclick = async () => {
        const time = prompt('New time (24h, HH:MM):'); if (!time) return;
        try { await api(`/email-reports/${b.dataset.time}`, { method: 'PUT', body: { time } }); toast('Saved', 'success'); load(); }
        catch (e) { toast(e.message, 'error'); }
      });
      document.querySelectorAll('#emBody button[data-send]').forEach(b => b.onclick = async () => {
        b.disabled = true; b.textContent = 'Sending…';
        try { await api(`/email-reports/${b.dataset.send}/send-now`, { method: 'POST', body: {} }); toast('Sent', 'success'); }
        catch (e) { toast(e.message, 'error'); }
        finally { load(); }
      });
    } catch (e) { document.getElementById('emBody').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  }
  load();
}

// ---- Audit log ----
async function renderAudit(content) {
  content.innerHTML = `<h2>Audit Log</h2><p class="page-sub">Last 300 actions</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody id="auBody"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody></table></div>`;
  try {
    const rows = await api('/audit');
    document.getElementById('auBody').innerHTML = rows.map(a => `<tr><td>${fmtDateTime(a.ts)}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.detail || '—')}</td></tr>`).join('') || emptyRow(4, 'No entries');
  } catch (e) { document.getElementById('auBody').innerHTML = emptyRow(4, e.message); }
}

boot();
