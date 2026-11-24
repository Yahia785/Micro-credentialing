#!/usr/bin/env node
// Does the case 2 judge give the same verdict for the same answer? Takes every case 2 answer ("why" and "which line") from a results.md of the
// scripted run, judges each one N times (default 3) with the engine's own judge (the clear cases are decided without the model, the rest by the
// checker model at temperature 0) and reports every answer whose verdicts differ, and every answer with its verdicts.
//
//   node scripts/a2-judge-stability.js --results D:/a2-pilot-test/old-m5b-real-run/results.md [--repeat 3] [--fake-model | --real-model] [--yes]
//
// --real-model prints how many Bedrock calls it needs and stops unless --yes is given. Student code and answers are read from D:/a2-pilot-test
// (outside the repo) and are not written anywhere except the printed report.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHARED = path.join(__dirname, '..', 'shared', 'nodejs');
const BASE = process.platform === 'win32' ? 'D:/a2-pilot-test' : path.join(os.tmpdir(), 'a2-pilot-test');
const git = require('./a2-import/lib/git');
const { judgeExplanation } = require(path.join(SHARED, 'a2', 'check'));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : fallback; };
const RESULTS = option('--results', `${BASE}/scripted/results.md`);
const REPEAT = Number(option('--repeat', '3'));
const REAL = flag('--real-model');

/** The case 2 answers of a results.md: [{ id, mode, asked, typed, earlier }]. */
function answersOf(markdown) {
  const out = [];
  let id = null;
  let why = null;
  for (const line of markdown.split('\n')) {
    const header = /^### (\S+): /.exec(line);
    if (header) { id = header[1]; why = null; continue; }
    if (!id || !line.startsWith('| ')) continue;
    const cells = line.split(/ \| /).map((c) => c.replace(/^\| /, '').replace(/ \|$/, ''));
    const asked = cells[1] || '';
    if (/ Why does it give that instead of /.test(asked)) { why = cells[2]; out.push({ id, mode: 'why', asked, typed: cells[2], earlier: null }); }
    else if (asked === 'Which line would you change, and how?') out.push({ id, mode: 'line', asked, typed: cells[2], earlier: why });
  }
  return out;
}

function contextOf(id) {
  const [student, fn] = id.split('/');
  const plans = fs.readdirSync(`${BASE}/plans`).filter((f) => f.endsWith('.json') && f !== 'reference.json').map((f) => JSON.parse(fs.readFileSync(`${BASE}/plans/${f}`, 'utf8')));
  const plan = plans.find((p) => p.githubUsername === student);
  const q = plan && plan.questions.find((x) => x.function === fn);
  const f1 = q && q.cases && q.cases.case2 && q.cases.case2.followUp1;
  if (!f1) return null;
  const record = fs.readdirSync(`${BASE}/out`).map((f) => JSON.parse(fs.readFileSync(`${BASE}/out/${f}`, 'utf8'))).map((r) => r.record || r).find((r) => r.githubUsername === student);
  const code = git.showFile(path.join(`${BASE}/repos`, `assignment-02-${student}`), record.commitHash, 'functions.cpp');
  return { code, input: f1.input.display, theirOutput: f1.theirOutput, specAnswer: f1.specAnswer };
}

async function main() {
  const answers = answersOf(fs.readFileSync(RESULTS, 'utf8'));
  const jobs = answers.map((a) => ({ ...a, context: contextOf(a.id) })).filter((a) => a.context);
  let converseFn;
  let modelId = 'fake';
  if (REAL) {
    const bedrock = require(path.join(SHARED, 'agent', 'bedrock-client'));
    modelId = require(path.join(SHARED, 'agent', 'split-agent-v6')).resolveSplitModels().checker;
    converseFn = bedrock.converse;
  } else {
    const { fakeModel } = require(path.join(SHARED, '__tests__', 'helpers', 'a2-fakes'));
    converseFn = fakeModel();
  }
  // how many calls would the model need: the answers the engine does not decide on its own
  const counting = { n: 0 };
  const dry = async () => { counting.n += 1; return { text: JSON.stringify({ verdict: 'unclear', quote: '' }), inputTokens: 0, outputTokens: 0, latencyMs: 0 }; };
  for (const job of jobs) await judgeExplanation({ mode: job.mode, question: job.asked, ...job.context, earlier: job.earlier, answer: job.typed, converseFn: dry, modelId });
  const calls = counting.n * REPEAT;
  console.log(`${jobs.length} case 2 answers from ${RESULTS}; ${counting.n} need the model, so ${calls} model calls for ${REPEAT} rounds each.`);
  if (REAL && !flag('--yes')) { console.log('Not run. Add --yes to run them (Bedrock, your AWS credentials).'); return; }

  const rows = [];
  for (const job of jobs) {
    const verdicts = [];
    for (let i = 0; i < REPEAT; i += 1) {
      const r = await judgeExplanation({ mode: job.mode, question: job.asked, ...job.context, earlier: job.earlier, answer: job.typed, converseFn, modelId });
      verdicts.push(`${r.verdict}${r.modelUsed ? '' : ' (rule)'}`);
    }
    rows.push({ ...job, verdicts, same: new Set(verdicts).size === 1 });
  }
  rows.forEach((r) => console.log(`${r.same ? 'same  ' : 'DIFFER'} ${r.id} ${r.mode}: ${r.verdicts.join(' / ')}  <- "${r.typed.slice(0, 90)}"`));
  const differ = rows.filter((r) => !r.same);
  console.log(`\n${rows.length - differ.length} of ${rows.length} answers got the same verdict every time; ${differ.length} differed.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
