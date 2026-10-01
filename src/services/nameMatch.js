// Name matching for KYC (BRD R05: "Aadhaar and PAN verified through API. Names must
// match"). Exact string equality is too strict for Indian ID documents — the same
// person is routinely "RAVI KUMAR SHARMA" on PAN, "Ravi Kumar Sharma" on Aadhaar and
// "Ravi K Sharma" on a form, or has words in a different order. This accepts those
// and nothing looser:
//  - case, punctuation, extra spaces and honorifics (Mr, Shri, Smt, ...) ignored
//  - word order ignored
//  - a single-letter initial matches a word starting with that letter
//  - one name may omit words of the other (e.g. a middle name), as long as at least two
//    words match and the first-name position agrees
//  - one typo (edit distance 1) allowed in words of 5+ letters
// Anything else is a mismatch, reported with both names so HR/the worker can fix it.

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'shri', 'sri', 'smt', 'kumari', 'km', 'dr', 'late', 'md']);

function tokens(name) {
  return (name || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t && !HONORIFICS.has(t));
}

function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return a.length >= 5 && b.length >= 5 && editDistanceAtMost1(a, b);
}

// Greedy pairing of the shorter name's words onto the longer name's words.
function namesMatch(nameA, nameB) {
  const a = tokens(nameA), b = tokens(nameB);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set();
  let fullWordMatches = 0;
  for (const word of short) {
    // Exact word first, so "Kumar" pairs with "Kumar" rather than with an initial "K".
    let k = long.findIndex((w, idx) => !used.has(idx) && w === word);
    if (k === -1) k = long.findIndex((w, idx) => !used.has(idx) && wordsMatch(word, w));
    if (k === -1) return false;
    used.add(k);
    if (word.length > 1 && long[k].length > 1) fullWordMatches++;
  }
  if (short.length === long.length) return fullWordMatches >= 1;
  // Some words omitted: demand enough overlap that "Ravi" doesn't match "Ravi Shankar Prasad".
  return short.length >= 2 && fullWordMatches >= 2 && wordsMatch(short[0], long[0]);
}

module.exports = { namesMatch };
