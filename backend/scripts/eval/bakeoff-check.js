#!/usr/bin/env node
/**
 * Checker bake-off: which model checks a student's answer against the rubric best?
 *
 * No interviews. Each variant checks the same fixed answer set and its replies are compared with the reference:
 *   demo      the 5 main answers of the demo transcript (reference: nothing missing)
 *   scripted  every distinct scripted main answer of cases 4 and 5 (reference: gaps_left, r1 = g1, ...)
 *   claude-labels  the 40 answers of rubric-check-blind.csv (reference: the labels in its human_missing column, written by Claude, not by a person)
 * plus 3 repeats of the 5 demo answers per variant. Temperature 0.
 *
 * Variants: check.v1.md (evidence first, quotes verified) with each model in bakeoff-common.js MODELS, and host.v4.1's own
 * rubric check with the current Qwen as the baseline (key host-qwen).
 *
 *   node scripts/eval/bakeoff-check.js                       prints the plan and the cost, asks for y
 *   node scripts/eval/bakeoff-check.js --yes                 no question
 *   node scripts/eval/bakeoff-check.js --variants qwen3-coder-30b,claude-haiku-5.5
 *
 * Options: --variants a,b,... (default all)  --out <dir>  --concurrency N (default 4)  --yes
 * The answers and the rubric are sent to Bedrock (us-east-1; Claude through the US inference profile). Nothing else is sent.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const engine = require('../../shared/nodejs/agent/interview-engine');
const common = require('./bakeoff-common');
const { loadCase } = require('./cases');

const { MODELS } = common;
const HOST_VARIANT = 'host-qwen';
const HOST_MODEL = 'qwen3-coder-30b';
const DEMO_REPEATS = 3;
const CHECK_MAX_TOKENS = 700;
const ESTIMATE = { hostInput: 4300, hostOutput: 190, rewriteShare: 0.1, outputPerItem: 55, outputBase: 30, charsPerToken: 3.6 };
const RETRY_NOTE = (error) => `Your reply failed the check: ${error}. Reply with the corrected JSON object only.`;

const variantKeys = () => [...Object.keys(MODELS), HOST_VARIANT];
const labelOf = (key) => (key === HOST_VARIANT ? `host.v4.1's own rubric check, ${MODELS[HOST_MODEL].label}` : `check.v1, ${MODELS[key].label}`);
const modelOf = (key) => MODELS[key === HOST_VARIANT ? HOST_MODEL : key];

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

/** The answer set: each item once, then the demo answers again DEMO_REPEATS times (flagged `repeat`). */
function buildItems(sets = {}) {
  const demo = (sets.demo || common.loadDemoSet)();
  const items = [...demo, ...(sets.scripted || common.loadScriptedSet)(), ...(sets.claudeLabels || common.loadClaudeLabelsSet)()];
  for (let r = 1; r <= DEMO_REPEATS; r += 1) demo.forEach((d) => items.push({ ...d, id: `${d.id}.r${r}`, repeat: r }));
  return items;
}

function estimate(items, keys) {
  const rows = keys.map((key) => {
    const model = modelOf(key);
    let input = 0; let output = 0;
    items.forEach((item) => {
      if (key === HOST_VARIANT) {
        input += ESTIMATE.hostInput * (1 + ESTIMATE.rewriteShare);
        output += ESTIMATE.hostOutput * (1 + ESTIMATE.rewriteShare);
      } else {
        const chars = common.CHECK_SYSTEM.length + common.buildCheckMessage({ mainQuestion: item.question, rubric: item.rubric, answer: item.answer }).length;
        input += chars / ESTIMATE.charsPerToken;
        output += ESTIMATE.outputBase + ESTIMATE.outputPerItem * item.rubric.length;
      }
    });
    // about 5% of replies fail the check and are asked again
    const retry = key === HOST_VARIANT ? 1 : 1.05;
    return { key, checks: items.length, cost: common.costOf(model, input * retry, output * retry), minutes: (items.length * (key.startsWith('claude-s') || key === 'deepseek-v3.2' ? 5 : 3)) / 60 / 4 };
  });
  return { rows, total: rows.reduce((a, r) => a + r.cost, 0) };
}

/** Where in the case a main question sits, as the engine's state needs it. */
function stateFor(caseData, ordinal) {
  let seen = 0;
  for (let t = 0; t < caseData.config.themes.length; t += 1) {
    const n = caseData.config.themes[t].mainQuestions.length;
    if (ordinal < seen + n) return { ...engine.initialState(), themeIndex: t, mainIndex: ordinal - seen };
    seen += n;
  }
  throw new Error('No such main question');
}

/** Check one answer with check.v1. Asks again once, naming the problem, when the reply fails the evidence check. */
async function checkWithPrompt(caller, item) {
  const message = common.buildCheckMessage({ mainQuestion: item.question, rubric: item.rubric, answer: item.answer });
  const messages = [{ role: 'user', content: [{ text: message }] }];
  let inputTokens = 0; let outputTokens = 0; let latencyMs = 0; let retried = false; let verdict = { ok: false, error: 'no reply' };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await caller.converse({ system: common.CHECK_SYSTEM, messages, maxTokens: CHECK_MAX_TOKENS });
    inputTokens += result.inputTokens; outputTokens += result.outputTokens; latencyMs += result.latencyMs;
    verdict = common.validateCheck(result.text, item.rubric, item.answer);
    if (verdict.ok) break;
    if (attempt === 1) {
      retried = true;
      messages.push({ role: 'assistant', content: [{ text: result.text }] }, { role: 'user', content: [{ text: RETRY_NOTE(verdict.error) }] });
    }
  }
  return { valid: verdict.ok, missing: verdict.ok ? verdict.missing : null, error: verdict.ok ? null : verdict.error, retried, inputTokens, outputTokens, latencyMs, evidence: verdict.ok ? verdict.evidence : undefined };
}

/** host.v4.1's own rubric check: the Host is asked about the answer and its "missing" list is read. */
async function checkWithHost(caller, item) {
  const caseData = loadCase(item.caseId);
  const state = stateFor(caseData, item.mainOrdinal);
  const turns = [{ role: 'host', text: item.question, kind: 'main' }, { role: 'student', text: item.answer }];
  const decision = await engine.decideNext({
    config: caseData.config, state, code: caseData.code, turns, modelId: caller.model.modelId, promptVersion: 'host.v4.1', converseFn: caller.converse,
  });
  const valid = Array.isArray(decision.missing);
  return {
    valid, missing: valid ? decision.missing : null, error: valid ? null : (decision.rejected ? decision.rejected.code : decision.fallback || 'no missing list'),
    retried: !!(decision.repairs && decision.repairs.length),
    inputTokens: decision.usage.inputTokens, outputTokens: decision.usage.outputTokens, latencyMs: decision.usage.latencyMs,
  };
}

async function pool(list, size, worker) {
  let next = 0;
  const run = async () => { while (next < list.length) { const i = next; next += 1; await worker(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, run));
}

/** Run one variant over the items. Stops early if the model cannot be called at all. */
async function runVariant(key, items, { call, concurrency = 4, log = () => {}, sleep } = {}) {
  const model = modelOf(key);
  const caller = common.makeCaller(key === HOST_VARIANT ? HOST_MODEL : key, { call, sleep });
  const records = new Array(items.length);
  let failures = 0; let succeeded = 0;
  await pool(items, concurrency, async (item, i) => {
    if (failures >= 3 && succeeded === 0) return; // not callable
    try {
      const out = key === HOST_VARIANT ? await checkWithHost(caller, item) : await checkWithPrompt(caller, item);
      succeeded += 1;
      records[i] = {
        id: item.id, set: item.set, repeat: item.repeat || 0, caseId: item.caseId, reference: item.reference, rubricSize: item.rubric.length,
        ...out, cost: common.costOf(model, out.inputTokens, out.outputTokens),
      };
    } catch (error) {
      failures += 1;
      records[i] = { id: item.id, set: item.set, repeat: item.repeat || 0, caseId: item.caseId, reference: item.reference, rubricSize: item.rubric.length, valid: false, missing: null, error: `call failed: ${error.name}`, failed: true, inputTokens: 0, outputTokens: 0, latencyMs: 0, cost: 0 };
    }
  });
  const done = records.filter(Boolean);
  const callable = succeeded > 0;
  log(`  ${key}: ${succeeded}/${items.length} checked${callable ? '' : ` (not callable: ${Object.keys(caller.totals.errors).join(', ') || 'no reply'})`}`);
  return { key, label: labelOf(key), modelId: model.modelId, callable, errors: caller.totals.errors, records: done, summary: common.summarise(done.filter((r) => !r.failed)) };
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : 'n/a');
const usd = (x) => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(3)}`);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function toMarkdown(report) {
  const out = [`# Checker bake-off (${report.runId})`, ''];
  out.push('Reference sets: **demo** = the 5 main answers of the demo transcript (nothing missing); **scripted** = every distinct scripted main answer of cases 4 and 5 (gaps_left); **claude-labels** = the 40 answers of rubric-check-blind.csv, labelled by Claude, not by a person. ' +
    'Note: the Claude checker variants may agree with the claude-labels set more than the other models do, because they are the same model family; that set is therefore only used to break ties when checkers are ranked (the scripted set comes first). ' +
    'False missing = the variant says missing, the reference says shown (items). Missed = the variant says shown, the reference says missing (items). Invalid = the reply failed the check twice (or the call failed). Cost and latency are per check, retries included.', '');
  const vs = Object.values(report.variants);
  for (const set of common.SETS) {
    if (!vs.some((v) => v.summary[set])) continue;
    out.push(`## ${set}`, '');
    out.push(table(['Variant', 'Answers', 'Exact match', 'False missing', 'Missed', 'Invalid', 'Cost / 100 checks', 'Median latency'],
      vs.filter((v) => v.summary[set]).map((v) => {
        const s = v.summary[set];
        return [v.label, s.answers, pct(s.exact, s.answers), pct(s.falseMissing, s.falseMissingOutOf), pct(s.missed, s.missedOutOf), s.invalid, usd(s.costPer100), s.medianLatencyMs === null ? 'n/a' : `${Math.round(s.medianLatencyMs)} ms`];
      })), '');
  }
  out.push('## The 5 demo answers, one by one', '', 'Each cell: what the variant said was missing on the first run, then the three repeats (a reference of nothing missing is "-"). "x" = invalid.', '');
  const demoIds = [...new Set(vs.flatMap((v) => v.records.filter((r) => r.set === 'demo' && !r.repeat).map((r) => r.id)))];
  out.push(table(['Variant', ...demoIds], vs.map((v) => [v.label, ...demoIds.map((id) => {
    const cell = (r) => (r ? (r.valid ? (r.missing.join(' ') || '-') : 'x') : '?');
    const first = v.records.find((r) => r.id === id);
    const reps = [1, 2, 3].map((n) => v.records.find((r) => r.id === `${id}.r${n}`));
    return [first, ...reps].map(cell).join(' / ');
  })])), '');
  const notCallable = vs.filter((v) => !v.callable);
  if (notCallable.length) out.push('## Not callable', '', ...notCallable.map((v) => `- ${v.label} (${v.modelId}): ${Object.keys(v.errors).join(', ') || 'no reply'}`), '');
  out.push(`Total cost of this run: ${usd(report.totalCost)}.`);
  return out.join('\n');
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
  const keys = args.variants ? args.variants.split(',').map((s) => s.trim()) : variantKeys();
  const bad = keys.filter((k) => !variantKeys().includes(k));
  if (bad.length) throw new Error(`Unknown variant: ${bad.join(', ')}. Available: ${variantKeys().join(', ')}`);
  const log = deps.log || ((t) => console.log(t));
  const items = buildItems(deps.sets);
  const plan = estimate(items, keys);
  const bySet = common.SETS.map((s) => `${items.filter((i) => i.set === s && !i.repeat).length} ${s}`).join(', ');
  log(`Checker bake-off: ${items.length} checks per variant (${bySet}, plus ${items.filter((i) => i.repeat).length} demo repeats), ${keys.length} variants`);
  plan.rows.forEach((r) => log(`  ${r.key.padEnd(18)} ${r.checks} checks, about ${usd(r.cost)}, about ${Math.ceil(r.minutes)} min`));
  log(`  estimated total: ${usd(plan.total)} (prices from the AWS Price List API, us-east-1)`);
  if (!args.yes && !deps.yes) {
    if (!(await confirm('Run it? [y/N] '))) { log('Cancelled. Nothing was run.'); return null; }
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(args.out || path.join(__dirname, '..', '..', 'eval-results', `bakeoff-check-${runId}`));
  fs.mkdirSync(outDir, { recursive: true });
  const report = { runId, variants: {}, totalCost: 0 };
  for (const key of keys) {
    const result = await runVariant(key, items, { call: deps.call, concurrency: Number(args.concurrency) || 4, log, sleep: deps.sleep });
    report.variants[key] = result;
    report.totalCost += result.records.reduce((a, r) => a + r.cost, 0);
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(report, null, 2));
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), toMarkdown(report));
  log(`Done. Total cost ${usd(report.totalCost)}. Results in ${outDir}`);
  return { report, outDir };
}

if (require.main === module) {
  main().catch((error) => { console.error(`Failed: ${error.name}: ${error.message}`); process.exit(1); });
}

module.exports = { main, parseArgs, buildItems, estimate, runVariant, checkWithPrompt, checkWithHost, stateFor, toMarkdown, variantKeys, HOST_VARIANT };
