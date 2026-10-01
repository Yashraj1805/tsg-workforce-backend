// Which calendar day a timestamp belongs to. All TSG sites are in India, so a "day" is
// an IST day (UTC+05:30) — using UTC dates made a 05:00 IST punch-in count as the
// previous day, so an early-shift worker could not punch out the same morning.
// TZ_OFFSET_MINUTES exists only in case a site outside IST is ever added.
const OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES || 330);
const OFFSET_MS = OFFSET_MIN * 60000;

// 'YYYY-MM-DD' for a timestamp (ms).
function dayOf(ts) { return new Date(ts + OFFSET_MS).toISOString().slice(0, 10); }
function today() { return dayOf(Date.now()); }
function currentMonth() { return today().slice(0, 7); }

// SQL expression giving the local 'YYYY-MM-DD' of a millisecond timestamp column.
function sqlDay(column) { return `date((${column}) / 1000 + ${OFFSET_MIN * 60}, 'unixepoch')`; }

// [from, to) millisecond range covering a local 'YYYY-MM' month.
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: Date.UTC(y, m - 1, 1) - OFFSET_MS, to: Date.UTC(y, m, 1) - OFFSET_MS };
}

module.exports = { dayOf, today, currentMonth, sqlDay, monthRange, OFFSET_MIN };
