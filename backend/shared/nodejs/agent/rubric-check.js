/**
 * Step A of the split agent (host.v5): check a student's answer against the rubric of the main question.
 *
 * The checker (check.v1.md) gets the main question, the rubric items and the student's answer, nothing else. It replies
 * evidence first: a quote and a shown flag for every item, then the list of missing items. The reply is only used when
 * it passes validateCheck: every item marked shown has a non-empty quote, every non-empty quote really appears in the
 * answer, and "missing" is exactly the items whose evidence says not shown. Pure functions apart from loading the prompt.
 */
const fs = require('fs');
const path = require('path');

const CHECK_PROMPT_VERSION = 'check.v1';
const CHECK_SYSTEM = fs.readFileSync(path.join(__dirname, 'prompts', 'check.v1.md'), 'utf8').trim();
const ANSWER_TAGS = /<\/?\s*student_answer\s*>/gi;

function buildCheckMessage({ mainQuestion, rubric, answer }) {
  return [
    `Main question: ${mainQuestion}`,
    'Rubric items:',
    ...rubric.map((item) => `- ${item.id}: ${item.text}`),
    '<student_answer>',
    String(answer).replace(ANSWER_TAGS, ''),
    '</student_answer>',
    'Reply with the JSON object only.',
  ].join('\n');
}

// Case, spacing and typographic quotes and dashes are ignored: a model copies a curly apostrophe back as a straight one.
const squash = (text) => String(text).toLowerCase()
  .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ').trim();

/**
 * @returns {{ ok: true, missing: string[], evidence: object } | { ok: false, error: string }}
 */
function validateCheck(text, rubric, answer) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: 'no JSON object' };
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return { ok: false, error: 'bad JSON' }; }
  if (!parsed || typeof parsed !== 'object' || !parsed.evidence || typeof parsed.evidence !== 'object' || Array.isArray(parsed.evidence)) {
    return { ok: false, error: 'no evidence object' };
  }
  const ids = rubric.map((item) => item.id);
  const haystack = squash(answer);
  for (const id of ids) {
    const entry = parsed.evidence[id];
    if (!entry || typeof entry !== 'object') return { ok: false, error: `no evidence for ${id}` };
    if (typeof entry.quote !== 'string' || typeof entry.shown !== 'boolean') return { ok: false, error: `bad evidence for ${id}` };
    if (entry.shown && !squash(entry.quote)) return { ok: false, error: `${id} is marked shown without a quote` };
    if (squash(entry.quote) && !haystack.includes(squash(entry.quote))) return { ok: false, error: `quote for ${id} is not in the answer` };
  }
  if (Object.keys(parsed.evidence).some((id) => !ids.includes(id))) return { ok: false, error: 'evidence for an unknown id' };
  if (!Array.isArray(parsed.missing) || parsed.missing.some((id) => typeof id !== 'string' || !ids.includes(id))) return { ok: false, error: 'bad missing list' };
  const fromEvidence = ids.filter((id) => !parsed.evidence[id].shown);
  const stated = ids.filter((id) => parsed.missing.includes(id));
  if (stated.length !== parsed.missing.length || stated.join(',') !== fromEvidence.join(',')) return { ok: false, error: 'missing does not match the evidence' };
  return { ok: true, missing: fromEvidence, evidence: parsed.evidence };
}

const RETRY_NOTE = (error) => `Your reply failed the check: ${error}. Reply with the corrected JSON object only.`;

module.exports = { CHECK_PROMPT_VERSION, CHECK_SYSTEM, buildCheckMessage, validateCheck, squash, RETRY_NOTE };
