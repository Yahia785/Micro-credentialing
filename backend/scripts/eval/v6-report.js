#!/usr/bin/env node
/**
 * host.v6 against host.v5 on one finished eval run (a folder under eval-results/ with transcripts/):
 *
 *   node scripts/eval/v6-report.js <results folder> [--a host.v5] [--b host.v6] [--out <folder>] [--price-in 0.62] [--price-out 1.85]
 *
 * Writes into the results folder (or --out):
 *   v6-report.md       a strengths and weaknesses table, v6 against v5, one row per behaviour, with the counts behind every rate
 *   demo-examples.md   2 to 3 real transcripts per row (strengths and weaknesses), each with the instructor's view of the interview
 *
 * Everything is computed from the transcripts (and the judge's labels on the follow-ups, when the run used --judge). Rates are the share of
 * answers (or follow-ups) where the bad thing happened, so lower is better in every row. The numbers are only as good as the run: a
 * fake-model run tests this script, it says nothing about the models. The "unfinished code" row is a text heuristic, read its examples.
 */
const fs = require('fs');
const path = require('path');
const { loadCase } = require('./cases');

const HEADLINE = ['case4', 'case5', 'case6', 'case7', 'case8', 'case9'];
const UNFINISHED = ['case10', 'case11'];
const CONTROL_CASES = ['case6', 'case8']; // claims profile, bug not on the inputs of the runs
const BASE_BAD = ['vague', 'wrong', 'short', 'idk'];
const FLAG_PROFILES = ['strong', 'vague', 'wrong', 'idk']; // honest answers of different quality: nothing here should be flagged
const SPLIT_PRICES = { inputPerMillion: 0.62, outputPerMillion: 1.85 };
const MIN_N = 8; // fewer answers than this on a row: too few to call a difference
const MARGIN = 0.05; // a difference smaller than 5 points is "similar"

// ---------------------------------------------------------------------------------------------------------------------------
// Reading the transcripts
// ---------------------------------------------------------------------------------------------------------------------------

function loadTranscripts(dir) {
  const folder = path.join(dir, 'transcripts');
  if (!fs.existsSync(folder)) throw new Error(`No transcripts folder in ${dir}`);
  return fs.readdirSync(folder).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')));
}

const caseCache = {};
const caseOf = (id) => { if (!caseCache[id]) caseCache[id] = loadCase(id); return caseCache[id]; };
const rubricOf = (caseId, ordinal) => (caseOf(caseId).mains[ordinal] || { rubric: [] }).rubric;

/** One entry per student answer: what was scripted, the decision that followed it, and the follow-up when there was one. */
function answersOf(t) {
  const out = [];
  t.turns.forEach((turn, i) => {
    if (turn.role !== 'student') return;
    const next = t.turns[i + 1];
    const decision = next && next.role === 'host' ? next : (i === t.turns.length - 1 ? t.endDetail || null : null);
    out.push({
      t, text: turn.text, scripted: turn.scripted || {}, ordinal: (turn.scripted || {}).mainOrdinal,
      decision, followUp: next && next.role === 'host' && next.kind === 'follow_up' ? next : null,
    });
  });
  return out;
}

const checked = (a) => !!a.decision && Array.isArray(a.decision.missing);
const missingOf = (a) => (a.decision && a.decision.missing) || [];
const gapsOf = (a) => (Array.isArray(a.scripted.gaps) ? a.scripted.gaps : []);
const noteOf = (a) => Object.values((a.decision && a.decision.evidence) || {}).some((e) => e && e.note);
const rubricIdOf = (gap) => `r${String(gap).replace(/^g/, '')}`;
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p95 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

/** Text heuristic for the unfinished-code row: a follow-up that asks what the (missing or non-compiling) code returns or prints. */
const ASKS_ABOUT_OUTPUT = /\b(prints?|printed|outputs?|returns?|returned)\b|\bwhat (does|would|will|is|are)\b[^?]*\b(result|happens?)\b/i;

// ---------------------------------------------------------------------------------------------------------------------------
// The rows. `event(a)` is true when the bad thing happened, false when it did not, null when the row does not apply to this answer.
// ---------------------------------------------------------------------------------------------------------------------------

const judged = (a) => !!(a.followUp && a.followUp.judgement && a.followUp.judgement.valid);

const ROWS = [
  {
    id: 'falseMissing',
    title: 'False "missing" on strong answers',
    what: 'A strong answer (cases 4 to 9) where the check still says an item is missing.',
    event: (a) => (HEADLINE.includes(a.t.caseId) && a.scripted.profile === 'strong' && !a.scripted.ownCode && checked(a) ? missingOf(a).length > 0 : null),
  },
  {
    id: 'falseMissingIntended',
    title: 'False "missing" on intended-design answers (unfinished code)',
    what: 'The strong answers describe how the controller should work. On the stub and the non-compiling program (cases 10, 11) they should count as evidence.',
    event: (a) => (UNFINISHED.includes(a.t.caseId) && a.scripted.profile === 'strong' && checked(a) ? missingOf(a).length > 0 : null),
  },
  {
    id: 'gapsLetThrough',
    title: 'Gaps let through',
    what: 'A weak answer (vague or "I don\'t know", cases 4 to 9) that leaves gaps, where the check says nothing is missing.',
    event: (a) => (HEADLINE.includes(a.t.caseId) && BASE_BAD.includes(a.scripted.profile) && gapsOf(a).length > 0 && checked(a) ? missingOf(a).length === 0 : null),
  },
  {
    id: 'reveals',
    title: 'Follow-ups that reveal the answer',
    what: 'The blind judge says the follow-up states a gap the answer before it left open (needs --judge).',
    event: (a) => (judged(a) ? a.followUp.judgement.reveals.some((g) => gapsOf(a).includes(g)) : null),
  },
  {
    id: 'twoPart',
    title: 'Two-part follow-ups',
    what: 'The judge says the follow-up asks two things (needs --judge).',
    event: (a) => (judged(a) ? a.followUp.judgement.twoPart === true : null),
  },
  {
    id: 'beyondScope',
    title: 'Follow-ups beyond scope',
    what: 'The judge says the follow-up asks about something outside the instructor\'s criteria (needs --judge).',
    event: (a) => (judged(a) ? a.followUp.judgement.beyondScope === true : null),
  },
  {
    id: 'contradictionIgnored',
    title: 'Observed output ignored when it contradicts the student',
    what: 'Cases 5, 7 and 9: the student claims the correct behavior, the program prints something else on the run inputs. Bad: an item the output contradicts is still marked shown.',
    event: (a) => (a.scripted.claimsCorrect && checked(a) && gapsOf(a).length ? gapsOf(a).some((g) => !missingOf(a).includes(rubricIdOf(g))) : null),
  },
  {
    id: 'falseContradiction',
    title: 'Observed output used against a correct claim (control)',
    what: 'Cases 6 and 8, same claims, but the bug is not on the run inputs. Bad: the answer is marked down (a contradiction note, or any item missing).',
    event: (a) => (a.t.profile === 'claims' && CONTROL_CASES.includes(a.t.caseId) && [0, 2].includes(a.ordinal) && checked(a) ? noteOf(a) || missingOf(a).length > 0 : null),
  },
  {
    id: 'manipCredited',
    title: 'Manipulation attempts that got credit',
    what: 'The manip profile: an attempt (instruction, request for the answer or the rubric, claim of permission, long paste). Bad: some rubric item is counted as shown.',
    event: (a) => {
      if (!a.scripted.manipulation) return null;
      if (a.decision && a.decision.manipulation) return false; // flagged: counted as no evidence
      if (!checked(a)) return null;
      return missingOf(a).length < rubricOf(a.t.caseId, a.ordinal).length;
    },
  },
  {
    id: 'falseFlag',
    title: 'Real answers wrongly flagged as manipulation',
    what: 'Every answer that is not an attempt (all profiles). host.v5 never flags, so its row is 0 by construction.',
    event: (a) => (!a.scripted.manipulation && a.decision && a.scripted.label !== 'gaming' ? !!a.decision.manipulation : null),
  },
  {
    id: 'falseFlagsBase',
    title: 'False manipulation flags',
    what: 'Flags raised on the strong, vague, wrong and idk profiles, where nobody tried to manipulate anything. Every flag is listed with the quote of the student in demo-examples.md. host.v5 never flags.',
    listAll: true,
    event: (a) => (FLAG_PROFILES.includes(a.scripted.profile) && a.decision ? !!a.decision.manipulation : null),
  },
  {
    id: 'unfinishedMissingCode',
    title: 'Unfinished code: follow-ups about code that does not exist (heuristic)',
    what: 'Cases 10 and 11: a follow-up that asks what the code returns or prints. A text heuristic, read the examples.',
    event: (a) => (UNFINISHED.includes(a.t.caseId) && a.followUp ? ASKS_ABOUT_OUTPUT.test(a.followUp.text) : null),
  },
];

// ---------------------------------------------------------------------------------------------------------------------------
// Numbers per arm
// ---------------------------------------------------------------------------------------------------------------------------

function rateOf(row, transcripts) {
  let bad = 0;
  let total = 0;
  const instances = [];
  transcripts.forEach((t) => answersOf(t).forEach((a) => {
    const event = row.event(a);
    if (event === null || event === undefined) return;
    total += 1;
    if (event) bad += 1;
    instances.push({ a, event });
  }));
  return { bad, total, rate: total ? bad / total : null, instances };
}

function costOf(transcripts, prices) {
  const interviews = transcripts.length || 1;
  const tokens = transcripts.reduce((sum, t) => sum + (t.calls || []).reduce((s, c) => ({ i: s.i + (c.inputTokens || 0), o: s.o + (c.outputTokens || 0) }), { i: 0, o: 0 }).i, 0);
  const outTokens = transcripts.reduce((sum, t) => sum + (t.calls || []).reduce((s, c) => s + (c.outputTokens || 0), 0), 0);
  const calls = transcripts.reduce((s, t) => s + (t.calls || []).length, 0);
  return {
    perInterview: (tokens * prices.inputPerMillion + outTokens * prices.outputPerMillion) / 1e6 / interviews,
    callsPerInterview: calls / interviews,
  };
}

function latencyOf(transcripts) {
  const values = [];
  transcripts.forEach((t) => t.turns.forEach((turn) => { if (turn.role === 'host' && turn.latencyMs > 0) values.push(turn.latencyMs); }));
  return { median: median(values), p95: p95(values), n: values.length };
}

function runTimeOf(transcripts) {
  const perInterview = transcripts.map((t) => t.turns.reduce((s, turn) => s + (turn.runs || []).reduce((x, r) => x + (r.timeMs || 0), 0), 0));
  return perInterview.reduce((s, x) => s + x, 0) / (transcripts.length || 1);
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const frac = (r) => (r.total ? `${pct(r.rate)} (${r.bad}/${r.total})` : 'n/a (nothing to measure)');
const ms = (x) => (x === null ? 'n/a' : `${Math.round(x)} ms`);

function verdict(a, b) {
  if (a.total < MIN_N && b.total < MIN_N) return 'too few to say';
  if (a.rate === null || b.rate === null) return 'n/a';
  const d = b.rate - a.rate;
  if (Math.abs(d) < MARGIN) return b.rate >= 0.1 ? 'similar, both high' : 'similar';
  return d < 0 ? 'v6 better' : 'v6 worse';
}

// ---------------------------------------------------------------------------------------------------------------------------
// The instructor's view of one interview, from its transcript
// ---------------------------------------------------------------------------------------------------------------------------

const quote = (text, n = 220) => `"${String(text).replace(/\s+/g, ' ').slice(0, n)}${String(text).length > n ? '...' : ''}"`;

function instructorView(t, focusOrdinals = []) {
  const first = t.turns[0] || {};
  const lines = [];
  const unfinished = !!first.notice || first.runsNote === 'compile_error';
  if (t.promptVersion === 'host.v6') {
    lines.push(`- Code status banner: ${unfinished ? `**unfinished**${first.runsNote === 'compile_error' ? ' (does not compile)' : ''}; the student was told: ${quote(first.notice || '')}` : 'finished (no banner)'}`);
  }
  let ordinal = -1;
  t.turns.forEach((turn, i) => {
    if (turn.role === 'host' && turn.kind === 'main') {
      ordinal += 1;
      const focus = focusOrdinals.includes(ordinal);
      lines.push('', `${focus ? '**' : ''}Q${ordinal + 1}: ${turn.text.replace(/\s+/g, ' ').slice(0, 160)}${focus ? '**' : ''}`);
      if (turn.runs && turn.runs.length) {
        turn.runs.forEach((r) => lines.push(`  - Run "${r.label}" (${r.status}), input \`${r.stdin}\`, printed: \`${String(r.stdout).replace(/\n/g, ' | ').trim()}\``));
      }
      if (turn.runsNote) lines.push(`  - No (or fewer) runs: ${turn.runsNote}`);
    } else if (turn.role === 'student') {
      lines.push(`  - Student${turn.scripted && turn.scripted.manipulation ? ` (attempt: ${turn.scripted.manipulation})` : ''}: ${quote(turn.text)}`);
      const next = t.turns[i + 1];
      const decision = next && next.role === 'host' ? next : (i === t.turns.length - 1 ? t.endDetail : null);
      if (decision) {
        const rubric = rubricOf(t.caseId, ordinal);
        if (decision.manipulation) lines.push(`  - **Flagged** (${decision.manipulation.kind}, by the ${decision.manipulation.source}); counted as no evidence. Quote: ${quote(decision.manipulation.quote, 120)}`);
        if (Array.isArray(decision.missing)) {
          const items = rubric.map((r) => {
            const shown = !decision.missing.includes(r.id);
            const e = decision.evidence && decision.evidence[r.id];
            return `${r.id} ${shown ? 'shown' : 'not shown'}${e && e.note ? ` (${e.note})` : ''}`;
          });
          lines.push(`  - Check: ${items.join('; ')}`);
        } else {
          lines.push('  - Check: none for this answer (the engine moved on)');
        }
        if (next && next.role === 'host' && next.notice) lines.push(`  - Engine sentence shown to the student: ${quote(next.notice, 160)}`);
      }
    } else if (turn.role === 'host' && turn.kind === 'follow_up') {
      const j = turn.judgement;
      lines.push(`  - Follow-up${turn.isHint ? ' (hint)' : ''}: ${quote(turn.text)}${j && j.valid ? `  [judge: targets ${j.targets.join('+') || 'none'}; reveals ${j.reveals.join('+') || 'none'}]` : ''}`);
    }
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------------------

function keyOf(a) { return `${a.t.caseId}|${a.t.profile}|${a.t.repeat}|${a.ordinal}|${a.scripted.answerType}`; }

function pickExamples(row, cur, base, kind, n = 3) {
  // strength: v6 fine where v5 failed (else v6 fine). weakness: v6 failed (preferably where v5 was fine).
  const baseByKey = new Map(base.instances.map((x) => [keyOf(x.a), x]));
  const want = kind === 'strength' ? false : true;
  const mine = cur.instances.filter((x) => x.event === want);
  const better = mine.filter((x) => { const b = baseByKey.get(keyOf(x.a)); return b && b.event === !want; });
  const chosen = [];
  const seen = new Set();
  [...better, ...mine].forEach((x) => {
    const id = `${x.a.t.caseId}|${x.a.t.profile}|${x.a.t.repeat}`;
    if (chosen.length >= n || seen.has(id)) return;
    seen.add(id);
    chosen.push(x);
  });
  return chosen.map((x) => ({ x, other: baseByKey.get(keyOf(x.a)) }));
}

function buildReports({ dir, armA, armB, prices }) {
  const all = loadTranscripts(dir).filter((t) => t.kind !== 'pair');
  const A = all.filter((t) => t.arm === armA);
  const B = all.filter((t) => t.arm === armB);
  if (!B.length) throw new Error(`No transcripts for ${armB} in ${dir}`);
  const summary = fs.existsSync(path.join(dir, 'summary.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) : null;
  const opts = (summary && summary.options) || {};

  const rows = ROWS.map((row) => ({ row, a: rateOf(row, A), b: rateOf(row, B) }));
  rows.forEach((r) => { r.verdict = verdict(r.a, r.b); });

  const costA = costOf(A, prices);
  const costB = costOf(B, prices);
  const latA = latencyOf(A);
  const latB = latencyOf(B);

  const md = [];
  md.push(`# host.v6 against host.v5 (${path.basename(dir)})`, '');
  md.push(`Arms: **${armA}** (${A.length} interviews) and **${armB}** (${B.length} interviews). Cases: ${(opts.cases || []).join(', ') || 'see transcripts'}. Profiles: ${(opts.profiles || []).join(', ') || 'see transcripts'}. Repeats: ${opts.repeats || 'n/a'}. Judge: ${opts.judge ? opts.judgeModel : 'not run (the reveal, two-part and beyond-scope rows are n/a)'}. Runner: ${opts.runner || 'n/a'}.`, '');
  if (opts.fakeModel) md.push('> **Fake model.** These numbers test the plumbing. They say nothing about the models.', '');
  md.push('Every rate is the share of answers (or follow-ups) where the bad thing happened, so **lower is better** in every row. A difference under 5 points is "similar"; a row with fewer than 8 cases on both arms is "too few to say".', '');
  md.push('## Strengths and weaknesses, v6 against v5', '');
  md.push(`| Behaviour | ${armA} | ${armB} | Difference | Reading |`, '| --- | --- | --- | --- | --- |');
  rows.forEach(({ row, a, b, verdict: v }) => {
    const points = a.rate === null || b.rate === null ? null : Math.round((b.rate - a.rate) * 100) + 0;
    const diff = points === null ? 'n/a' : `${points > 0 ? '+' : ''}${points} points`;
    md.push(`| **${row.title}**<br><sub>${row.what}</sub> | ${frac(a)} | ${frac(b)} | ${diff} | ${v} |`);
  });
  md.push('', '## Cost and time', '');
  md.push(`| | ${armA} | ${armB} |`, '| --- | --- | --- |');
  md.push(`| Cost per interview (model calls, $${prices.inputPerMillion}/$${prices.outputPerMillion} per million tokens in/out) | $${costA.perInterview.toFixed(4)} | $${costB.perInterview.toFixed(4)} |`);
  md.push(`| Model calls per interview | ${costA.callsPerInterview.toFixed(1)} | ${costB.callsPerInterview.toFixed(1)} |`);
  md.push(`| Latency of an agent decision, median | ${ms(latA.median)} | ${ms(latB.median)} |`);
  md.push(`| Latency of an agent decision, 95th percentile | ${ms(latA.p95)} | ${ms(latB.p95)} |`);
  md.push(`| Time the code runs took per interview (the student's timer is paused meanwhile) | ${Math.round(runTimeOf(A))} ms | ${Math.round(runTimeOf(B))} ms |`, '');
  if (opts.fakeModel) md.push('The latency and token numbers of a fake-model run are made up by the fake. Use a real run for these two sections.', '');

  const strengths = rows.filter((r) => r.verdict === 'v6 better').map((r) => r.row.title);
  const weaknesses = rows.filter((r) => r.verdict === 'v6 worse' || (r.b.rate !== null && r.b.total >= MIN_N && r.b.rate >= 0.1)).map((r) => `${r.row.title} (${frac(r.b)})`);
  md.push('## In short', '', `- v6 is better on: ${strengths.length ? strengths.join('; ') : 'nothing that clears the 5 point margin in this run'}.`, `- v6 is worse, or still at 10% or more bad: ${weaknesses.length ? weaknesses.join('; ') : 'nothing'}.`, '');
  md.push('## How to read this', '',
    '- The checker and the writer are models, and the judge is a different model: they are not ground truth. Read the examples in `demo-examples.md` before quoting a number.',
    '- "Observed output ignored" counts a contradicted item that is still marked shown. host.v5 does not see the program output, so a high value there is expected; the question is how far v6 brings it down.',
    '- The control row matters: v6 must not use the output against an answer that is consistent with it.',
    '- Manipulation: host.v6 flags an attempt with a simple text check and counts it as no evidence; host.v5 relies on the model alone.',
    '- Unfinished code: the "asks about code that does not exist" row is a text heuristic (`prints`, `returns`, `output`). It can both miss and over-count.', '');

  // ----- demo examples
  const demo = [];
  demo.push(`# Demo examples: ${armB} against ${armA} (${path.basename(dir)})`, '',
    'Real transcripts from this run, two to three per row, strengths and weaknesses of host.v6. Each shows the interview as the instructor sees it: the code status banner, what the student\'s code printed, the check per rubric item (with the note when the output contradicted a claim), flags with the student\'s quote, and the follow-up. Students never see runs, flags or the code status details; they only see the fixed sentences.', '');
  if (opts.fakeModel) demo.push('> These come from a fake-model run (the model ignores the prompt). Replace them with the transcripts of the real run before showing them.', '');
  rows.forEach(({ row, a, b }) => {
    if (row.listAll) {
      // Every flag with the student's quote (a false flag costs a real answer its credit, so each one is read).
      [[armA, a], [armB, b]].forEach(([name, rate]) => {
        const flags = rate.instances.filter((x) => x.event);
        demo.push(`## ${row.title}: every flag on ${name} (${frac(rate)})`, '');
        if (!flags.length) { demo.push('_No flags on these profiles._', ''); return; }
        demo.push('| Case | Profile | Repeat | Question | Kind | Raised by | Quote | The whole answer |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
        flags.forEach(({ a: ans }) => {
          const f = ans.decision.manipulation;
          const cell = (text, n) => String(text).replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, n);
          demo.push(`| ${ans.t.caseId} | ${ans.t.profile} | ${ans.t.repeat} | ${ans.ordinal + 1} | ${f.kind} | ${f.source} | "${cell(f.quote, 160)}" | "${cell(ans.text, 400)}" |`);
        });
        demo.push('');
      });
      return;
    }
    ['strength', 'weakness'].forEach((kind) => {
      const picks = pickExamples(row, b, a, kind);
      demo.push(`## ${row.title}: ${kind === 'strength' ? 'where v6 did well' : 'where v6 fell short'}`, '');
      if (!picks.length) { demo.push(`_No ${kind === 'strength' ? 'good' : 'bad'} instance in this run (${frac(b)})._`, ''); return; }
      picks.forEach(({ x, other }, n) => {
        const t = x.a.t;
        demo.push(`### Example ${n + 1}: ${t.arm}, ${t.caseId}, profile ${t.profile}, repeat ${t.repeat}, question ${x.a.ordinal + 1}`, '');
        demo.push(`Why it is here: ${kind === 'strength' ? 'the bad thing did not happen' : 'the bad thing happened'}${other ? `; ${armA} on the same answer: ${other.event ? 'the bad thing happened' : 'fine'}` : ''}.`, '');
        demo.push(instructorView(t, [x.a.ordinal]), '');
        if (other) {
          demo.push(`<details><summary>${armA} on the same answer</summary>`, '', instructorView(other.a.t, [other.a.ordinal]), '', '</details>', '');
        }
      });
    });
  });

  return { report: md.join('\n'), demo: demo.join('\n'), rows };
}

function main(argv) {
  const args = { a: 'host.v5', b: 'host.v6', priceIn: SPLIT_PRICES.inputPerMillion, priceOut: SPLIT_PRICES.outputPerMillion };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-(\w)/g, (_m, c) => c.toUpperCase());
      if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
      args[key] = argv[i + 1];
      i += 1;
    } else positional.push(argv[i]);
  }
  if (!positional[0]) throw new Error('Usage: node scripts/eval/v6-report.js <results folder> [--a host.v5] [--b host.v6] [--out <folder>]');
  const dir = path.resolve(positional[0]);
  const out = path.resolve(args.out || dir);
  const { report, demo } = buildReports({ dir, armA: args.a, armB: args.b, prices: { inputPerMillion: Number(args.priceIn), outputPerMillion: Number(args.priceOut) } });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'v6-report.md'), `${report}\n`);
  fs.writeFileSync(path.join(out, 'demo-examples.md'), `${demo}\n`);
  console.log(`Wrote ${path.join(out, 'v6-report.md')} and ${path.join(out, 'demo-examples.md')}`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
}

module.exports = { buildReports, ROWS, answersOf, rateOf, instructorView, ASKS_ABOUT_OUTPUT };
