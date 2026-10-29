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
const NAV = [
  { key: 'dashboard', label: 'Dashboard', perm: 'reports.read', icon: '📊' },
  { key: 'workers', label: 'Workers', perm: 'workers.read', icon: '👷' },
  { key: 'regularisations', label: 'Missed Punch', perm: 'regularisations.read', icon: '🕒' },
  { key: 'vendor-bill', label: 'Vendor Bill', perm: 'billing.read', icon: '💰' },
  { key: 'users', label: 'Admin Users', perm: 'users.manage', icon: '⚙️' },
];
function defaultRoute() { const first = NAV.find(n => state.permissions.includes(n.perm)); return first ? first.key : 'dashboard'; }

function renderShell() {
  const items = NAV.filter(n => state.permissions.includes(n.perm));
  const current = (location.hash || '#' + defaultRoute()).replace('#', '');
  document.getElementById('app').innerHTML = `
    <div class="sidebar-backdrop" id="backdrop"></div>
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">TSG Workforce<span class="sub">Admin Portal</span></div>
        <nav>${items.map(n => `<a href="#${n.key}" data-key="${n.key}">${n.icon} ${n.label}</a>`).join('') || '<p style="padding:10px;color:#9ba0d6;font-size:12.5px">No sections available for your role.</p>'}</nav>
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
  if (key === 'workers') return renderWorkers(content);
  if (key === 'regularisations') return renderRegularisations(content);
  if (key === 'vendor-bill') return renderVendorBill(content);
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
        ${canManage && w.status === 'approved' ? `<button class="btn danger small" id="actExit">Mark exited</button>` : ''}
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

boot();
