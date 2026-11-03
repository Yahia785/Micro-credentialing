#!/usr/bin/env node
/**
 * Writer bake-off: which model writes the best follow-up question, given the rubric items the answer did not show?
 *
 * Input per item: the student's code, the main question, the rubric, the student's answer and the correct missing list (the
 * scripted gaps_left). Items: every distinct scripted main answer of cases 4 and 5 that leaves at least one gap. The writer
 * (write.v1.md) writes ONE follow-up aimed at the first missing item. The two-question, yes/no and rubric-wording guards
 * are applied as in the engine (one rewrite each; the yes/no and rubric-wording rewrites that fail make the reply invalid;
 * a two-question rewrite that fails keeps the first question). Every follow-up is then labelled by the existing blind
 * judge (judge.v2, Mistral Large 3), which never sees the answer. A variant must not be the judge's own model.
 *
 *   node scripts/eval/bakeoff-write.js --check-results eval-results/bakeoff-check-<run>/results.json
 *   node scripts/eval/bakeoff-write.js --writers qwen3-coder-30b,claude-sonnet-5.5,deepseek-v3.2
 *
 * Options: --writers a,b,c  or  --check-results <results.json of bakeoff-check.js> (the current Qwen, the best Claude and
 * the best other non-Mistral model there)  --out <dir>  --concurrency N (default 4)  --yes
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const engine = require('../../shared/nodejs/agent/interview-engine');
const { isYesNo, isMultiPart, firstQuestionOnly } = require('../../shared/nodejs/agent/follow-up-check');
const bedrock = require('../../shared/nodejs/agent/bedrock-client');
const judging = require('./judge');
const common = require('./bakeoff-common');
const { loadCase } = require('./cases');

const { MODELS } = common;
const WRITE_SYSTEM = fs.readFileSync(path.join(__dirname, '../../shared/nodejs/agent/prompts/write.v1.md'), 'utf8').trim();
const JUDGE_KEY = 'mistral-large-3';
const CURRENT = 'qwen3-coder-30b';
const MAX_FOLLOW_UP_LENGTH = engine.MAX_FOLLOW_UP_LENGTH;
const WRITE_MAX_TOKENS = 400;
const ESTIMATE = { fixedInput: 1300, charsPerToken: 3.6, output: 90, judgeInput: 800, judgeOutput: 60, guardShare: 0.2 };
const NEUTRAL = /<\/?\s*student_(answer|code)\s*>/gi;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    if (name === 'yes') args.yes = true;
    else { args[name] = argv[i + 1]; i += 1; }
  }
  return args;
}

/** The items: scripted main answers of cases 4 and 5 that leave at least one gap. */
function buildItems(loader = common.loadScriptedSet) {
  return loader().filter((item) => item.reference.length > 0);
}

function buildWriteMessage({ code, question, rubric, answer, missing }) {
  return [
    '<student_code>',
    String(code).replace(NEUTRAL, ''),
    '</student_code>',
    `Main question: ${question}`,
    'Rubric (private):',
    ...rubric.map((item) => `- ${item.id}: ${item.text}`),
    '<student_answer>',
    String(answer).replace(NEUTRAL, ''),
    '</student_answer>',
    `Missing items: ${missing.join(', ')}`,
    'Reply with the JSON object only.',
  ].join('\n');
}

/** { target, isHint, question } from the writer's reply, or null. */
function parseWrite(text, ids) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed.question !== 'string') return null;
  const target = typeof parsed.target === 'string' ? ids.find((id) => id.toLowerCase() === parsed.target.trim().toLowerCase()) || null : null;
  return { target, isHint: parsed.isHint === true, question: parsed.question.replace(/\s+/g, ' ').trim() };
}

/** Why the question is not acceptable (the engine's checks), or null. */
function problemWith(question, secrets) {
  if (!question || question.length > MAX_FOLLOW_UP_LENGTH) return 'question_invalid';
  if (/\b(rubric|criteria|criterion)\b/i.test(question)) return 'rubric_word';
  if (engine.leaksCriterion(question, secrets)) return 'rubric_leak';
  return null;
}

/**
 * Write one follow-up, with the guards. Returns { valid, question, target, isHint, guards, error, tokens, latencyMs } where `guards`
 * counts what fired: json retry, rubric-wording rewrite, yes/no rewrite, two-question rewrite (and whether each fixed it).
 */
async function writeFollowUp(caller, item, caseData) {
  const missing = item.reference;
  const ids = item.rubric.map((r) => r.id);
  const secrets = [...caseData.mains[item.mainOrdinal].criteria, ...item.rubric.map((r) => r.text)];
  const messages = [{ role: 'user', content: [{ text: buildWriteMessage({ code: caseData.code, question: item.question, rubric: item.rubric, answer: item.answer, missing }) }] }];
  const tally = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  const guards = { json: [0, 0], leak: [0, 0], yesNo: [0, 0], twoQuestions: [0, 0] };
  let last = '';

  const call = async (request) => {
    const result = await caller.converse({ system: WRITE_SYSTEM, messages: request ? [...messages, { role: 'assistant', content: [{ text: last }] }, { role: 'user', content: [{ text: request }] }] : messages, maxTokens: WRITE_MAX_TOKENS });
    tally.inputTokens += result.inputTokens; tally.outputTokens += result.outputTokens; tally.latencyMs += result.latencyMs;
    last = result.text;
    return parseWrite(result.text, ids);
  };
  const done = (extra) => ({ guards, ...tally, ...extra });

  let reply = await call();
  if (!reply) {
    guards.json[0] += 1;
    reply = await call(engine.JSON_RETRY_REQUEST);
    if (reply) guards.json[1] += 1;
    else return done({ valid: false, error: 'bad_json' });
  }
  let problem = problemWith(reply.question, secrets);
  if (problem === 'rubric_leak') {
    guards.leak[0] += 1;
    const again = await call(engine.LEAK_REWRITE_REQUEST);
    if (again && !problemWith(again.question, secrets)) { guards.leak[1] += 1; reply = { ...reply, ...again, target: again.target || reply.target }; problem = null; } else problem = 'rubric_leak';
  }
  if (problem) return done({ valid: false, error: problem });
  if (isYesNo(reply.question)) {
    guards.yesNo[0] += 1;
    const again = await call(engine.YES_NO_REWRITE_REQUEST);
    if (again && !isYesNo(again.question) && !problemWith(again.question, secrets)) { guards.yesNo[1] += 1; reply = { ...reply, ...again, target: again.target || reply.target }; } else return done({ valid: false, error: 'yes_no' });
  }
  if (isMultiPart(reply.question)) {
    guards.twoQuestions[0] += 1;
    const again = await call(engine.REWRITE_REQUEST);
    if (again && !isMultiPart(again.question) && !isYesNo(again.question) && !problemWith(again.question, secrets)) { guards.twoQuestions[1] += 1; reply = { ...reply, ...again, target: again.target || reply.target }; } else reply = { ...reply, question: firstQuestionOnly(reply.question) };
  }
  return done({ valid: true, question: reply.question, target: reply.target, isHint: reply.isHint });
}

async function pool(list, size, worker) {
  let next = 0;
  const run = async () => { while (next < list.length) { const i = next; next += 1; await worker(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, run));
}

const gapOf = (rubricId) => rubricId.replace(/^r/, 'g');

async function runVariant(key, items, { judge, call, concurrency = 4, sleep, log = () => {} }) {
  const model = MODELS[key];
  const caller = common.makeCaller(key, { call, sleep });
  const cases = {};
  const records = new Array(items.length);
  let ok = 0; let failed = 0;
  await pool(items, concurrency, async (item, i) => {
    if (failed >= 3 && ok === 0) return;
    cases[item.caseId] = cases[item.caseId] || loadCase(item.caseId);
    const caseData = cases[item.caseId];
    let out;
    try { out = await writeFollowUp(caller, item, caseData); ok += 1; } catch (error) {
      failed += 1;
      records[i] = { id: item.id, caseId: item.caseId, profile: item.profile, valid: false, error: `call failed: ${error.name}`, failed: true, cost: 0, judgeCost: 0, latencyMs: 0 };
      return;
    }
    const intended = gapOf(item.reference[0]);
    const record = { id: item.id, caseId: item.caseId, profile: item.profile, mainOrdinal: item.mainOrdinal, intended, ...out, cost: common.costOf(model, out.inputTokens, out.outputTokens), judgeCost: 0 };
    if (out.valid) {
      const labels = await judge.judge({
        mainQuestion: item.question, criteria: cases[item.caseId].mains[item.mainOrdinal].criteria, gaps: cases[item.caseId].studentsRaw.gaps[item.mainOrdinal], followUp: out.question,
      });
      record.judgement = labels.valid ? { targets: labels.targets, reveals: labels.reveals, twoPart: labels.twoPart, beyondScope: labels.beyondScope, reason: labels.reason } : { invalid: true };
    }
    records[i] = record;
  });
  const done = records.filter(Boolean);
  log(`  ${key}: ${ok}/${items.length} written${ok ? '' : ` (not callable: ${Object.keys(caller.totals.errors).join(', ')})`}`);
  return { key, label: model.label, modelId: model.modelId, callable: ok > 0, errors: caller.totals.errors, records: done, summary: summarise(done) };
}

/** Per variant: valid follow-ups, the judge's labels, guard counts, cost and latency. */
function summarise(records) {
  const real = records.filter((r) => !r.failed);
  const valid = real.filter((r) => r.valid);
  const judged = valid.filter((r) => r.judgement && !r.judgement.invalid);
  const count = (fn) => judged.filter(fn).length;
  const sumGuard = (name) => real.reduce((a, r) => [a[0] + r.guards[name][0], a[1] + r.guards[name][1]], [0, 0]);
  const hintItems = valid.filter((r) => r.profile === 'idk');
  return {
    items: records.length,
    valid: valid.length,
    invalid: real.length - valid.length,
    invalidBy: real.filter((r) => !r.valid).reduce((a, r) => ({ ...a, [r.error]: (a[r.error] || 0) + 1 }), {}),
    judged: judged.length,
    targetsIntended: count((r) => r.judgement.targets.includes(r.intended)),
    targetsOnlyIntended: count((r) => r.judgement.targets.length === 1 && r.judgement.targets[0] === r.intended),
    reveals: count((r) => r.judgement.reveals.length > 0),
    twoPart: count((r) => r.judgement.twoPart),
    beyondScope: count((r) => r.judgement.beyondScope),
    hintOnIdk: { hints: hintItems.filter((r) => r.isHint).length, of: hintItems.length },
    guards: { json: sumGuard('json'), leak: sumGuard('leak'), yesNo: sumGuard('yesNo'), twoQuestions: sumGuard('twoQuestions') },
    writerCost: real.reduce((a, r) => a + r.cost, 0),
    costPerFollowUp: real.length ? real.reduce((a, r) => a + r.cost, 0) / real.length : null,
    medianLatencyMs: common.median(real.map((r) => r.latencyMs)),
  };
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : 'n/a');
const usd = (x) => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(4)}`);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const fired = (g) => `${g[0]} (fixed ${g[1]})`;

function toMarkdown(report) {
  const vs = Object.values(report.variants);
  const out = [`# Writer bake-off (${report.runId})`, ''];
  out.push(`${report.items} items: scripted main answers of cases 4 and 5 that leave at least one gap. The writer aims at the first missing item. Labels come from the blind judge (${report.judgeModel}), which never sees the answer. "Targets the intended item" = the judge lists the first missing gap among the gaps the follow-up asks about. Reveals, two-part and beyond scope are the judge's labels, after the guards.`, '');
  out.push(table(['Writer', 'Valid', 'Judged', 'Targets the intended item', 'Only that item', 'Reveals', 'Two-part', 'Beyond scope', 'Hint on "idk"', 'Cost / follow-up', 'Median latency'],
    vs.map((v) => {
      const s = v.summary;
      return [v.label, `${s.valid}/${s.items}`, s.judged, pct(s.targetsIntended, s.judged), pct(s.targetsOnlyIntended, s.judged), pct(s.reveals, s.judged), pct(s.twoPart, s.judged), pct(s.beyondScope, s.judged), pct(s.hintOnIdk.hints, s.hintOnIdk.of), usd(s.costPerFollowUp), s.medianLatencyMs === null ? 'n/a' : `${Math.round(s.medianLatencyMs)} ms`];
    })), '');
  out.push('## Guards and invalid replies', '');
  out.push(table(['Writer', 'JSON retry', 'Rubric-wording rewrite', 'Yes/no rewrite', 'Two-question rewrite', 'Invalid replies'],
    vs.map((v) => [v.label, fired(v.summary.guards.json), fired(v.summary.guards.leak), fired(v.summary.guards.yesNo), fired(v.summary.guards.twoQuestions), `${v.summary.invalid} ${JSON.stringify(v.summary.invalidBy)}`])), '');
  out.push(`Total cost: writers ${usd(report.writerCost)}, judge ${usd(report.judgeCost)}.`);
  return out.join('\n');
}

/** The writers to compare: the current Qwen, the best Claude and the best other model that is neither Mistral Large 3 nor Qwen-30B nor Claude. */
function chooseWriters(checkResults) {
  const keys = Object.keys(MODELS).filter((k) => !checkResults[k] || checkResults[k].callable !== false); // a model that could not be called is not a candidate
  const claude = common.pickBest(checkResults, keys.filter(common.isClaude));
  const other = common.pickBest(checkResults, keys.filter((k) => !common.isClaude(k) && k !== JUDGE_KEY && k !== CURRENT));
  return [CURRENT, claude, other].filter(Boolean);
}

function estimate(items, keys) {
  const rows = keys.map((key) => {
    const m = MODELS[key];
    const per = items.map((item) => {
      const caseData = loadCase(item.caseId);
      return common.costOf(m, (WRITE_SYSTEM.length + caseData.code.length) / ESTIMATE.charsPerToken + ESTIMATE.fixedInput, ESTIMATE.output) * (1 + ESTIMATE.guardShare);
    });
    return { key, cost: per.reduce((a, b) => a + b, 0) };
  });
  const judgeCost = items.length * keys.length * common.costOf(MODELS[JUDGE_KEY], ESTIMATE.judgeInput, ESTIMATE.judgeOutput);
  return { rows, judgeCost, total: rows.reduce((a, r) => a + r.cost, 0) + judgeCost };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const log = deps.log || ((t) => console.log(t));
  let keys;
  if (args.writers) keys = args.writers.split(',').map((s) => s.trim());
  else if (args['check-results']) keys = chooseWriters(JSON.parse(fs.readFileSync(path.resolve(args['check-results']), 'utf8')).variants);
  else throw new Error('Give --writers a,b,c or --check-results <results.json of bakeoff-check.js>');
  const bad = keys.filter((k) => !MODELS[k]);
  if (bad.length) throw new Error(`Unknown writer: ${bad.join(', ')}. Available: ${Object.keys(MODELS).join(', ')}`);
  if (keys.includes(JUDGE_KEY)) throw new Error('Mistral Large 3 is the blind judge and must not grade its own writing');
  const items = buildItems(deps.loader);
  const plan = estimate(items, keys);
  log(`Writer bake-off: ${items.length} items, writers: ${keys.join(', ')}`);
  plan.rows.forEach((r) => log(`  ${r.key.padEnd(18)} about ${usd(r.cost)}`));
  log(`  judge (${MODELS[JUDGE_KEY].modelId}): about ${usd(plan.judgeCost)}; estimated total ${usd(plan.total)}`);
  if (!args.yes && !deps.yes && !(await confirm('Run it? [y/N] '))) { log('Cancelled. Nothing was run.'); return null; }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(args.out || path.join(__dirname, '..', '..', 'eval-results', `bakeoff-write-${runId}`));
  fs.mkdirSync(outDir, { recursive: true });
  const judgeCaller = common.makeCaller(JUDGE_KEY, { call: deps.call, sleep: deps.sleep });
  const judge = judging.createJudge({ modelId: MODELS[JUDGE_KEY].modelId, converseFn: deps.judgeConverse || ((request) => judgeCaller.converse(request)) });
  const report = { runId, items: items.length, judgeModel: MODELS[JUDGE_KEY].modelId, variants: {}, writerCost: 0, judgeCost: 0 };
  for (const key of keys) {
    const result = await runVariant(key, items, { judge, call: deps.call, concurrency: Number(args.concurrency) || 4, sleep: deps.sleep, log });
    report.variants[key] = result;
    report.writerCost += result.summary.writerCost;
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2));
  }
  report.judgeCost = judging.estimateJudgeCost(judge.usage, { inputPerMillion: MODELS[JUDGE_KEY].input, outputPerMillion: MODELS[JUDGE_KEY].output });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.md'), toMarkdown(report));
  log(`Done. Writers ${usd(report.writerCost)}, judge ${usd(report.judgeCost)}. Results in ${outDir}`);
  return { report, outDir };
}

if (require.main === module) {
  main().catch((error) => { console.error(`Failed: ${error.name}: ${error.message}`); process.exit(1); });
}

module.exports = { main, parseArgs, buildItems, buildWriteMessage, parseWrite, problemWith, writeFollowUp, runVariant, summarise, chooseWriters, estimate, toMarkdown };
