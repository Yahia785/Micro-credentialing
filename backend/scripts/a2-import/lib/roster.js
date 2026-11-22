// The GitHub Classroom assignment export (CSV). Only the GitHub handle and the roster identifier are used: the export's grade columns
// (points_awarded, points_available) and names are never read, so they cannot end up in a record.
const { normalizeUsername } = require('./common');

/** Minimal CSV reader (quotes, doubled quotes, commas and newlines inside quotes). Returns an array of rows of strings. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Map of lower-case GitHub username -> { rosterIdentifier } (null when the cell is empty). */
function parseRoster(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return new Map();
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const userCol = header.indexOf('github_username');
  const idCol = header.indexOf('roster_identifier');
  if (userCol < 0) throw new Error('the roster CSV has no github_username column');
  const map = new Map();
  for (const row of rows.slice(1)) {
    const username = normalizeUsername(row[userCol]);
    if (!username) continue;
    const identifier = idCol >= 0 ? String(row[idCol] || '').trim() : '';
    map.set(username, { rosterIdentifier: identifier || null });
  }
  return map;
}

module.exports = { parseCsv, parseRoster };
