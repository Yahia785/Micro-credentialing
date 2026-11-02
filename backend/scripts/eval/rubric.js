/**
 * Rubric check numbers for the host.v4 arms.
 *
 * Three parties say which rubric items an answer did not show ("missing"):
 *   - the scripted answer (what the case file says it leaves out: gaps_left, mapped r1 = g1, r2 = g2, r3 = g3),
 *   - the Host (host.v4 checks the answer before it chooses what to do; stored on the Host turn as `missing`),
 *   - the rubric-check judge (a separate model call that sees the question, the rubric and the answer; stored on the
 *     student turn as `rubricCheck`).
 * This file compares them, and builds the sample a person labels by hand (rubric-check-blind.csv / rubric-check-key.csv).
 *
 * Comparing a rater with a reference, per rubric item: `agreed` (both say missing, or both say shown), `missed` (the
 * reference says missing, the rater says shown) and `wronglyMissing` (the rater says missing, the reference says shown).
 */
const crypto = require('crypto');
const { stepsOf, ratio, armOf } = require('./metrics');
const { toCsvText, parseCsvObjects } = require('./csv');

const NONE_TEXT = 'none';

/** The rubric id that goes with a gap id: g1 is r1, g2 is r2, g3 is r3. */
const gapToRubric = (gapId) => `r${String(gapId).slice(1)}`;
/** Gap ids to rubric ids. */
const scriptedMissing = (gaps) => (gaps || []).map(gapToRubric);

/** "r1 r3" or "none": how a list of rubric ids is written in the CSV files. */
const formatIds = (ids) => (ids && ids.length ? ids.join(' ') : NONE_TEXT);

const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * @param {Array<{ rater: string[], reference: string[], ids: string[] }>} pairs `ids` are the rubric ids of that question
 */
function tally(pairs) {
  const perItem = {};
  let exact = 0;
  for (const { rater, reference, ids } of pairs) {
    if (sameSet(rater, reference)) exact += 1;
    for (const id of ids) {
      const item = perItem[id] || (perItem[id] = { n: 0, agreed: 0, missed: 0, wronglyMissing: 0 });
      const r = rater.includes(id);
      const t = reference.includes(id);
      item.n += 1;
      if (r === t) item.agreed += 1;
      else if (t) item.missed += 1;
      else item.wronglyMissing += 1;
    }
  }
  return { n: pairs.length, exact: ratio(exact, pairs.length), perItem: Object.fromEntries(Object.entries(perItem).sort()) };
}

const hasJudge = (step) => !!step.rubricCheck && step.rubricCheck.valid;

/**
 * The rubric check numbers for the interviews of one arm. `rubricIdsOf(step)` gives the rubric ids of the question the step
 * answered; it defaults to r1..rN with N the number of gaps of that question.
 */
function summarizeRubric(transcripts, rubricIdsOf = (step) => Array.from({ length: step.gapCount }, (_, i) => `r${i + 1}`)) {
  const hostPairs = [];
  const judgePairs = [];
  const commonHost = [];
  const commonJudge = [];
  const hostVsJudge = [];
  let targeted = 0;
  let onTarget = 0;
  let targetedWithGaps = 0;
  let judgedAnswers = 0;
  let unjudged = 0;

  for (const transcript of transcripts) {
    if (transcript.pair) continue;
    for (const step of stepsOf(transcript)) {
      if (!step.gapCount) continue;
      const ids = rubricIdsOf(step);
      const scripted = scriptedMissing(step.gaps);
      const host = step.hostMissing && !step.fallback ? step.hostMissing : null;
      const judge = hasJudge(step) ? step.rubricCheck.missing : null;
      if (step.rubricCheck) { judgedAnswers += 1; if (!judge) unjudged += 1; }
      if (host) hostPairs.push({ rater: host, reference: scripted, ids });
      if (judge) judgePairs.push({ rater: judge, reference: scripted, ids });
      if (host && judge) {
        commonHost.push({ rater: host, reference: scripted, ids });
        commonJudge.push({ rater: judge, reference: scripted, ids });
        hostVsJudge.push({ rater: host, reference: judge, ids });
      }
      // The Host's target against the gaps the scripted answer left open (no judge): a follow-up with a target.
      if (step.action === 'follow_up' && !step.fallback && step.target) {
        targeted += 1;
        if (scripted.length) {
          targetedWithGaps += 1;
          if (scripted.includes(step.target)) onTarget += 1;
        }
      }
    }
  }
  return {
    hostChecks: hostPairs.length,
    judgedAnswers,
    unjudged,
    hostVsScripted: tally(hostPairs),
    judgeVsScripted: tally(judgePairs),
    hostVsJudge: tally(hostVsJudge),
    // The same answers for both, so the two can be read against each other
    commonHostVsScripted: tally(commonHost),
    commonJudgeVsScripted: tally(commonJudge),
    // Host target accuracy (no judge): of the follow-ups with a target asked after an answer that left at least one gap,
    // the share whose target is a gap the answer actually left. The judge's own targeting number is in the adaptive tables.
    hostTarget: { followUps: targeted, withGaps: targetedWithGaps, onTarget: ratio(onTarget, targetedWithGaps) },
  };
}

/** Attach `rubric` to the summaries of the arms that have rubric data (host.v4). */
function attachRubric(results, transcripts, rubricIdsOf) {
  for (const arm of Object.keys(results)) {
    const mine = transcripts.filter((t) => armOf(t) === arm);
    const asked = mine.some((t) => stepsOf(t).some((step) => step.hostMissing || step.rubricCheck));
    if (!asked) continue;
    const headline = mine.filter((t) => t.caseId !== 'case1');
    results[arm].rubric = summarizeRubric(headline.length ? headline : mine, rubricIdsOf);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// The sample for a person to label
// ---------------------------------------------------------------------------------------------

const BLIND_HEADER = ['id', 'case', 'main_question', 'rubric_items', 'student_answer', 'human_missing'];
const KEY_HEADER = ['id', 'host_arm', 'host_missing', 'judge_missing', 'scripted_gaps_left', 'host_target', 'host_follow_up', 'judge_reason'];

function seededRandom(seed) {
  let a = crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * About `count` distinct answers from the host.v4 interviews (case 1 left out), spread over the cases and the answer profiles
 * (strong, vague, wrong, short, idk and the three gaming profiles), so strong answers are in. Every answer was checked by the Host
 * (it has a `missing` list) and by the rubric judge. One answer text is one sample, whatever the arm or repeat. Fixed seed.
 * Rows are shuffled, so the order tells nothing about the profile.
 * @param {{ transcripts: object[], loaded: object, count?: number, seed?: string|number }} options
 * @returns {object[]}
 */
function buildRubricSample({ transcripts, loaded, count = 40, seed = 1 }) {
  const seen = new Set();
  const groups = new Map(); // case + profile -> candidates
  for (const transcript of transcripts) {
    if (transcript.pair || transcript.caseId === 'case1') continue;
    const caseData = loaded[transcript.caseId];
    if (!caseData) continue;
    for (const step of stepsOf(transcript)) {
      if (!step.hostMissing || step.fallback || !hasJudge(step)) continue;
      const key = [transcript.caseId, step.mainOrdinal, step.answerText].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const main = caseData.mains[step.mainOrdinal];
      const profile = step.source || transcript.profile;
      const groupKey = `${transcript.caseId}|${profile}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({
        caseId: transcript.caseId,
        arm: armOf(transcript),
        profile,
        mainQuestion: main.question,
        rubric: main.rubric,
        answer: step.answerText,
        hostMissing: step.hostMissing,
        judgeMissing: step.rubricCheck.missing,
        judgeReason: step.rubricCheck.reason,
        scriptedMissing: scriptedMissing(step.gaps),
        target: step.action === 'follow_up' ? step.target : null,
        followUp: step.action === 'follow_up' ? step.question : null,
      });
    }
  }
  const random = seededRandom(`${seed}|rubric-sample`);
  // Strong answers leave nothing out, so they are the check that a complete answer is not called incomplete: those groups
  // take part in the rotation twice, to get some into a sample of about 40.
  const keys = shuffled([...groups.keys()].sort(), random);
  const byKey = new Map(keys.map((k) => [k, shuffled(groups.get(k), random)]));
  const queues = [...keys, ...keys.filter((k) => k.endsWith('|strong'))].map((k) => byKey.get(k));
  const picked = [];
  while (picked.length < count && queues.some((q) => q.length)) {
    for (const queue of queues) {
      if (picked.length >= count) break;
      if (queue.length) picked.push(queue.shift());
    }
  }
  return shuffled(picked, random).map((row, i) => ({ id: `R${String(i + 1).padStart(2, '0')}`, ...row }));
}

const rubricText = (rubric) => rubric.map((item) => `${item.id}: ${item.text}`).join(' | ');

/** rubric-check-blind.csv: what a person needs to label an answer, and nothing from the Host, the judge or the scripted answer. */
function toBlindCsv(rows) {
  return toCsvText(BLIND_HEADER, rows.map((row) => [row.id, row.caseId, row.mainQuestion, rubricText(row.rubric), row.answer, '']));
}

/** rubric-check-key.csv: the answers to compare with (kept apart so the labelling is not influenced). */
function toKeyCsv(rows) {
  return toCsvText(KEY_HEADER, rows.map((row) => [
    row.id, row.arm, formatIds(row.hostMissing), formatIds(row.judgeMissing), formatIds(row.scriptedMissing),
    row.target || '', row.followUp === null ? '(moved on)' : row.followUp, row.judgeReason,
  ]));
}

// ---------------------------------------------------------------------------------------------
// Comparing with the person's labels (compare-rubric.js)
// ---------------------------------------------------------------------------------------------

/** "r1 r3" (also with commas or +) or "none" -> ['r1', 'r3'] | []; blank -> null (not filled in); anything else throws. */
function parseMissing(text, ids, where) {
  const raw = String(text === undefined ? '' : text).trim().toLowerCase();
  if (!raw) return null;
  if (raw === NONE_TEXT) return [];
  const tokens = raw.split(/[\s,;+]+/).filter(Boolean);
  const bad = tokens.filter((token) => !ids.includes(token));
  if (bad.length) throw new Error(`${where}: "${text}" is not "none" or a list of ${ids.join(', ')} (bad: ${bad.join(', ')})`);
  return ids.filter((id) => tokens.includes(id));
}

const idsInRubricText = (text) => [...String(text).matchAll(/(?:^|\| )(r\d+): /g)].map((m) => m[1]);

/**
 * Compare the Host, the judge and the scripted answer with a person's labels.
 * @param {string} blindText rubric-check-blind.csv with human_missing filled in
 * @param {string} keyText rubric-check-key.csv
 * @returns {{ rows: number, labelled: number, hostBlank: number, comparisons: { host: object, judge: object, scripted: object } }}
 */
function compareWithHuman(blindText, keyText) {
  const blind = parseCsvObjects(blindText);
  const key = new Map(parseCsvObjects(keyText).map((row) => [row.id, row]));
  const pairs = { host: [], judge: [], scripted: [] };
  let labelled = 0;
  let hostBlank = 0;
  for (const row of blind) {
    const keyRow = key.get(row.id);
    if (!keyRow) throw new Error(`${row.id} is in the blind file but not in the key file`);
    const ids = idsInRubricText(row.rubric_items);
    const human = parseMissing(row.human_missing, ids, row.id);
    if (human === null) continue;
    labelled += 1;
    const judge = parseMissing(keyRow.judge_missing, ids, `${row.id} judge_missing`);
    const scripted = parseMissing(keyRow.scripted_gaps_left, ids, `${row.id} scripted_gaps_left`);
    const host = parseMissing(keyRow.host_missing, ids, `${row.id} host_missing`);
    if (host === null) hostBlank += 1;
    else pairs.host.push({ rater: host, reference: human, ids });
    if (judge !== null) pairs.judge.push({ rater: judge, reference: human, ids });
    if (scripted !== null) pairs.scripted.push({ rater: scripted, reference: human, ids });
  }
  return {
    rows: blind.length,
    labelled,
    hostBlank,
    comparisons: { host: tally(pairs.host), judge: tally(pairs.judge), scripted: tally(pairs.scripted) },
  };
}

module.exports = {
  gapToRubric, scriptedMissing, formatIds, tally, summarizeRubric, attachRubric, buildRubricSample, toBlindCsv, toKeyCsv,
  parseMissing, compareWithHuman, BLIND_HEADER, KEY_HEADER, NONE_TEXT,
};
