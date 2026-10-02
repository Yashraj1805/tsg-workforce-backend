// AI chat-assistant for HR — ask attendance questions in plain Hindi/English/mixed text,
// get an answer grounded in real data. This is the "fully AI-based" direction: Zoho
// People's Zia does conversational check-in/queries, and Darwinbox/Keka are both moving
// from "AI bolted onto a module" toward an assistant layer over the whole product —
// this is that layer for TSG Workforce.
//
// The model is never allowed to invent a number or write SQL. It only ever:
//  1. extracts a date range / worker name / site / vendor from the question,
//  2. that's used to call the SAME scoped report functions (services/reports.js) the
//     dashboard and Excel exports already use — so the RBAC scope (a Site HR only ever
//     sees their own site, etc.) applies exactly as it does everywhere else,
//  3. a second call turns the real result into a short answer, told explicitly to only
//     state what's in the data — so every number in the reply traces back to an actual
//     DB row, not a hallucination.
const gemini = require('./geminiClient');
const reports = require('./reports');
const { db } = require('../db');
const { today, currentMonth } = require('./time');
const { workerScopeSql } = require('../rbac');

function findLocation(name) {
  if (!name) return null;
  return db.prepare('SELECT id, name FROM locations WHERE name LIKE ? LIMIT 1').get('%' + name + '%');
}
function findVendor(name) {
  if (!name) return null;
  return db.prepare('SELECT id, name FROM vendors WHERE name LIKE ? LIMIT 1').get('%' + name + '%');
}
function findWorkers(name, scope) {
  if (!name) return [];
  return db.prepare(`SELECT w.id, w.name, w.mobile FROM workers w WHERE w.name LIKE ? AND w.status = 'approved' AND ${scope.sql} LIMIT 5`)
    .all('%' + name + '%', ...scope.args);
}
// attendanceRows only covers successful punches (result='ok') — a "how many blocked"
// question needs this separately, not folded into that query. `scope` is the same
// {sql, args} shape workerScopeSql(user, 'w') already returns everywhere else here.
function findBlockedPunches(scope, from, to) {
  return db.prepare(`SELECT p.ts, p.type, p.reason, w.name AS worker FROM punches p JOIN workers w ON w.id = p.worker_id
      WHERE p.result = 'blocked' AND date(p.ts / 1000, 'unixepoch') BETWEEN ? AND ? AND ${scope.sql}
      ORDER BY p.ts DESC LIMIT 100`).all(from, to, ...scope.args);
}

async function extractParams(question, history) {
  const historyText = history && history.length
    ? `\nRecent conversation (oldest first, for resolving follow-ups like "uska", "aur kal ka?", "what about last week" that refer back to this):\n${history.map(h => `Q: ${h.question}\nA: ${h.answer}`).join('\n')}\n`
    : '';
  return gemini.ask(
    `Today's date is ${today()} (YYYY-MM-DD), current month ${currentMonth()}.${historyText}A workplace-attendance HR user asked this question (may be in Hindi, English, or mixed):\n"${question}"\n` +
    'Work out what data would answer it. "topic" is "blocked_punches" for anything about blocked/rejected/fraud/fake-GPS/suspicious punch attempts, else "attendance". "mode" is "summary" for a live today\'s-counts attendance question (how many present/absent/not-punched right now, with no specific date range), or "detail" for anything about a specific date range, a specific worker, or a listing (always "detail" for blocked_punches). Resolve relative dates (today, yesterday, this week, this month, last month) into actual YYYY-MM-DD dates using the anchor date above. If the question is a follow-up referring back to the conversation above (e.g. "uska", "and him", "what about last week" without repeating who/what), use the conversation to fill in the missing worker/site/vendor/date — otherwise leave a field blank. Never guess a name that was not actually mentioned anywhere.',
    {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: ['attendance', 'blocked_punches'] },
        mode: { type: 'string', enum: ['summary', 'detail'] },
        dateFrom: { type: 'string', description: 'YYYY-MM-DD or empty' },
        dateTo: { type: 'string', description: 'YYYY-MM-DD or empty' },
        workerName: { type: 'string', description: 'a specific worker named in the question, or empty' },
        locationName: { type: 'string', description: 'a specific site/location named, or empty' },
        vendorName: { type: 'string', description: 'a specific vendor named, or empty' },
      },
      required: ['topic', 'mode'],
    },
    10000
  );
}

async function composeAnswer(question, data) {
  return gemini.ask(
    `A workplace-attendance HR user asked: "${question}"\nHere is the real data that answers it (JSON):\n${JSON.stringify(data).slice(0, 6000)}\n` +
    'Write a short, direct answer (3-5 sentences max), in the same language mix as the question (Hindi/English/mixed, matching their script). Only state facts present in the data above — never invent a number, name or date not in it. If the data is empty or a "note" field explains why, say that plainly rather than guessing.',
    { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    12000
  );
}

async function ask(question, user, history) {
  if (!gemini.isConfigured()) return { ok: false, error: 'AI assistant needs GEMINI_API_KEY configured' };
  const scope = workerScopeSql(user, 'w');

  const extracted = await extractParams(question, history);
  if (!extracted.ok) return { ok: false, error: extracted.error || 'Could not understand the question' };

  let data;
  if (extracted.topic === 'blocked_punches') {
    const from = extracted.dateFrom || today();
    const to = extracted.dateTo || today();
    const rows = findBlockedPunches(scope, from, to);
    data = { from, to, blockedCount: rows.length, blocked: rows };
  } else if (extracted.workerName) {
    const matches = findWorkers(extracted.workerName, scope);
    if (!matches.length) {
      data = { note: `No approved worker matching "${extracted.workerName}" found in your scope.` };
    } else if (matches.length > 1) {
      data = { note: `More than one worker matches "${extracted.workerName}" — be more specific.`, candidates: matches.map(m => m.name) };
    } else {
      const from = extracted.dateFrom || today();
      const to = extracted.dateTo || today();
      data = { worker: matches[0].name, mobile: matches[0].mobile, rows: reports.attendanceRows(scope, {}, from, to).filter(r => r.mobile === matches[0].mobile) };
    }
  } else if (extracted.mode === 'summary' && !extracted.dateFrom) {
    const loc = findLocation(extracted.locationName);
    const ven = findVendor(extracted.vendorName);
    data = reports.dashboard(scope, { locationId: loc ? loc.id : undefined, vendorId: ven ? ven.id : undefined });
  } else {
    const loc = findLocation(extracted.locationName);
    const ven = findVendor(extracted.vendorName);
    const from = extracted.dateFrom || today();
    const to = extracted.dateTo || today();
    data = { rows: reports.attendanceRows(scope, { locationId: loc ? loc.id : undefined, vendorId: ven ? ven.id : undefined }, from, to) };
  }

  const composed = await composeAnswer(question, data);
  if (!composed.ok) return { ok: false, error: composed.error || 'Could not compose an answer' };
  return { ok: true, answer: composed.answer, data };
}

module.exports = { ask };
