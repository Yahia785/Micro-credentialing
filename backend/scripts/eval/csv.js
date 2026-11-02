/**
 * A small CSV writer and reader (RFC 4180 quoting) for the evaluation files that a person fills in by hand.
 */

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsvText(header, rows) {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

/**
 * Parse CSV text into rows of cells. Handles quoted cells with commas, quotes ("") and line breaks, and CRLF files
 * (a spreadsheet may save them that way). A leading byte-order mark is ignored. Empty trailing lines are dropped.
 * @returns {string[][]}
 */
function parseCsv(text) {
  const source = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Parse CSV text with a header row into objects keyed by the header names. */
function parseCsvObjects(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name.trim(), row[i] === undefined ? '' : row[i]])));
}

module.exports = { csvCell, toCsvText, parseCsv, parseCsvObjects };
