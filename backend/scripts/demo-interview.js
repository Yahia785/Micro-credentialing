#!/usr/bin/env node
/**
 * Terminal demo of the interview agent.
 *
 * Runs the real Host loop (the same engine and the same case files as the evaluation) against Amazon Bedrock with your
 * local AWS credentials. You type the student's answers, or --auto plays a scripted student. Under each Host question
 * the instructor view shows what the agent decided and why (--hide-agent turns that off). DynamoDB is never touched.
 *
 *   node scripts/demo-interview.js --case case4
 *   node scripts/demo-interview.js --case case5 --auto vague
 *
 * Options:
 *   --case <id>          case4 (tank controller, correct code) or case5 (same program with a bug); any eval case works (required)
 *   --prompt <version>   prompt version (default host.v4.1)
 *   --temperature <n>    0 to 1 (default 0)
 *   --auto <profile>     play a scripted student from the case's student file (strong, vague, wrong, short, idk, mixed,
 *                        keywords, echo, inject). Press Enter to send each scripted answer (/quit stops)
 *   --auto-delay <sec>   with --auto: wait this many seconds before each answer instead of waiting for Enter (unattended run)
 *   --hide-agent         do not show the instructor view under the questions
 *   --no-color           plain text (colours are also off when the output is not a terminal, or NO_COLOR is set)
 *   --model <id>         Bedrock model ID (default: AGENT_MODEL_ID or the platform default)
 *   --out-dir <dir>      where the transcript goes (default: eval-results/demo)
 *   --fake-model         no Bedrock: the evaluation's fake model (for trying the demo out)
 *
 * Type /quit or press Ctrl+C to stop; the transcript is still saved. Your answers and the code are sent to Bedrock (us-east-1).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const engine = require('../shared/nodejs/agent/interview-engine');
const bedrock = require('../shared/nodejs/agent/bedrock-client');
const { loadCase } = require('./eval/cases');
const { buildProfile } = require('./eval/students');
const { createFakeModel } = require('./eval/fake-model');

const MAX_ANSWER_LENGTH = 2000;
const DEFAULT_PROMPT = 'host.v4.1';
const DEFAULT_TEMPERATURE = 0;
const RUBRIC_TEXT_LENGTH = 90;
const BOOLEAN_FLAGS = ['hide-agent', 'no-color', 'fake-model', 'help'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    if (BOOLEAN_FLAGS.includes(name)) args[name] = true;
    else args[name] = argv[i + 1];
    if (!BOOLEAN_FLAGS.includes(name)) i += 1;
  }
  return args;
}

const USAGE = 'usage: node scripts/demo-interview.js --case case4|case5 [--auto <profile>] [--prompt host.v4.1] [--temperature 0] [--hide-agent] [--no-color] [--fake-model]';

const clock = (iso) => new Date(iso).toISOString().slice(11, 19);
const shorten = (text, n) => (text.length > n ? `${text.slice(0, n - 3)}...` : text);

/** ANSI styles, or no-ops when colours are off. */
function stylesFor(color) {
  const wrap = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { dim: wrap('2'), bold: wrap('1'), cyan: wrap('36'), yellow: wrap('33'), red: wrap('31'), green: wrap('32') };
}

function numberedCode(code) {
  const lines = code.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`);
}

/**
 * The instructor view of one Host decision, as lines: what the agent found missing in the answer it just read, what it
 * did about it, and anything the engine repaired. `rubric` is the rubric of the main question that answer belonged to.
 */
function agentLines(decision, rubric) {
  const lines = [];
  const text = new Map((rubric || []).map((item) => [item.id, item.text]));
  if (decision.engineDecision) {
    lines.push('checked: not checked - only one action was allowed, so the model was not asked');
  } else if (Array.isArray(decision.missing)) {
    if (decision.missing.length === 0) lines.push('missing: nothing (every rubric item is shown)');
    else {
      lines.push('missing:');
      decision.missing.forEach((id) => lines.push(`  ${id}: ${shorten(text.get(id) || '', RUBRIC_TEXT_LENGTH)}`));
    }
  }
  lines.push(`action: ${decision.action}`);
  if (decision.action === engine.ACTIONS.FOLLOW_UP) {
    lines.push(`target: ${decision.target || '-'}`);
    lines.push(`isHint: ${decision.isHint ? 'yes' : 'no'}`);
  }
  lines.push(`reason: ${decision.reason}`);
  if (decision.fallback) lines.push(`fallback: ${decision.fallback}${decision.rejected ? ` (${decision.rejected.code})` : ''}`);
  if (decision.guard) lines.push(`guard fired: two questions${decision.guard.fixedByRetry ? ', rewritten as one' : ', kept the first only'} (was: ${shorten(decision.guard.original, 120)})`);
  (decision.repairs || []).forEach((repair) => {
    if (repair.type === 'target') lines.push(`repair: target ${repair.from || '(none)'} -> ${repair.to}`);
    else lines.push(`repair: ${repair.type}${repair.fixed === undefined ? '' : repair.fixed ? ' (fixed)' : ' (not fixed)'}${repair.original ? ` (was: ${shorten(repair.original, 120)})` : ''}`);
  });
  return lines;
}

/**
 * The instructor summary: per main question, the student's answers, what the agent said was missing after each, the
 * follow-ups (and whether each was a hint), with timestamps. Built from the saved transcript.
 */
function summaryLines(transcript, rubricByMain, style = stylesFor(false)) {
  const lines = [];
  let ordinal = -1;
  const turns = transcript.turns;
  const agentCheck = (source) => {
    const rubric = rubricByMain[ordinal] || [];
    if (source.engineDecision) return '  agent: not checked (engine decision, only one action allowed)';
    if (!Array.isArray(source.missing)) return `  agent: ${source.action || 'decided'} - ${source.reason}`;
    const missing = source.missing.length ? source.missing.map((id) => `${id}`).join(', ') : 'nothing';
    const detail = source.missing.map((id) => (rubric.find((item) => item.id === id) || {}).text).filter(Boolean);
    return `  agent says missing: ${missing}${detail.length ? ` (${detail.map((t) => shorten(t, 60)).join('; ')})` : ''}`;
  };
  turns.forEach((turn, i) => {
    if (turn.role === 'host') {
      if (i > 0) {
        lines.push(agentCheck(turn));
        if (turn.fallback) lines.push(`  fallback: ${turn.fallback}`);
      }
      if (turn.kind === 'main') {
        ordinal += 1;
        lines.push('', style.bold(`Question ${ordinal + 1} [${clock(turn.createdAt)}]: ${turn.text}`));
      } else {
        lines.push(`  follow-up${turn.isHint ? ' (hint)' : ''} [${clock(turn.createdAt)}]${turn.target ? ` aimed at ${turn.target}` : ''}: ${turn.text}`);
      }
    } else {
      const secs = turn.clientTiming && turn.clientTiming.secondsToAnswer !== undefined ? `, ${turn.clientTiming.secondsToAnswer}s to answer` : '';
      lines.push(`  student [${clock(turn.createdAt)}${secs}]: ${turn.text}`);
    }
  });
  if (transcript.endDetail) lines.push(agentCheck(transcript.endDetail));
  lines.push('', `Status: ${transcript.status}${transcript.endReason ? ` (${transcript.endReason})` : ''}`);
  return lines;
}

/**
 * Run one interview.
 * @param {object} o
 *   caseId, promptVersion, temperature, hideAgent, auto (profile name), autoDelayMs (null = wait for Enter), color, outDir, modelId
 *   output(text), input (readable stream), sleep(ms), converseFn (the model call, default Bedrock), now()
 */
async function runDemo(o) {
  const {
    caseId, promptVersion = DEFAULT_PROMPT, temperature = DEFAULT_TEMPERATURE, hideAgent = false, auto = null,
    autoDelayMs = null, color = false, outDir, modelId: modelArg,
    output = (text) => process.stdout.write(text), input = process.stdin,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(),
  } = o;
  const style = stylesFor(color);
  const say = (text = '') => output(`${text}\n`);

  const caseData = loadCase(caseId);
  const config = caseData.config;
  const code = caseData.code;
  engine.resolvePromptVersion(promptVersion);
  const modelId = bedrock.resolveModelId(modelArg);
  const base = o.converseFn || bedrock.converse;
  const converseFn = (request) => base({ ...request, temperature });
  const answers = auto ? buildProfile(caseData.studentsRaw, auto, caseData.mains) : null;
  const rubricByMain = caseData.mains.map((m) => m.rubric);

  const startedAt = now();
  const transcript = {
    schema: 'demo.1',
    caseId,
    caseTitle: caseData.title,
    promptVersion,
    temperature,
    modelId: o.fakeModel ? 'fake-model' : modelId,
    mode: auto ? `auto:${auto}` : 'live',
    startedAt: new Date(startedAt).toISOString(),
    endedAt: null,
    status: 'in_progress',
    fallbackCount: 0,
    turns: [],
  };
  const fileName = `demo-${caseId}-${promptVersion}-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`;
  const file = path.resolve(outDir, fileName);
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(transcript, null, 2));
  };

  say('');
  say(style.bold(`${caseData.title} (${caseId})`));
  say(style.dim(`prompt ${promptVersion}, temperature ${temperature}, model ${transcript.modelId}, no time limit${auto ? `, scripted student: ${auto}` : ''}`));
  say('');
  say(style.bold('The student\'s code:'));
  numberedCode(code).forEach((line) => say(line));
  say('');

  const first = engine.firstQuestion(config);
  let state = first.state;
  let asked = { themeId: first.themeId, kind: first.kind };
  let askedAt = now();
  transcript.turns.push({ role: 'host', text: first.question, ...asked, createdAt: new Date(askedAt).toISOString(), reason: 'first main question' });
  let question = first.question;
  let mainOrdinal = 0;

  // One place for the end of the run, whichever way it ends (also reached from Ctrl+C).
  let finished = false;
  const finish = (status, endReason) => {
    if (finished) return;
    finished = true;
    transcript.status = status;
    if (endReason) transcript.endReason = endReason;
    transcript.endedAt = new Date(now()).toISOString();
    save();
  };
  const interrupt = () => { finish('interrupted', 'ctrl_c'); };

  const rl = auto && autoDelayMs !== null ? null : readline.createInterface({ input, output: { write: () => {} }, terminal: false });
  // Typed lines wait in a queue (piped input arrives all at once); null means the input ended.
  const queue = [];
  let closed = false;
  let waiting = null;
  if (rl) {
    rl.on('line', (line) => {
      if (waiting) { const w = waiting; waiting = null; w(line); } else queue.push(line);
    });
    rl.on('close', () => {
      closed = true;
      if (waiting) { const w = waiting; waiting = null; w(null); }
    });
  }
  const readLine = (prompt) => new Promise((resolve) => {
    output(prompt);
    if (queue.length) { resolve(queue.shift()); return; }
    if (closed) { resolve(null); return; }
    waiting = resolve;
  });
  const stopReading = () => { if (rl) rl.close(); };
  o.onReady && o.onReady({ interrupt: () => { interrupt(); stopReading(); }, transcript, file });

  try {
    for (;;) {
      say(`${style.bold('HOST:')} ${question}`);
      say('');
      const typedAt = now();
      let answer;
      if (auto) {
        const entry = answers[mainOrdinal];
        if (!entry) { say('(the scripted student has no answer for this question)'); finish('error', 'no_scripted_answer'); break; }
        if (autoDelayMs === null) {
          const key = await readLine(style.dim('(press Enter to send the scripted answer, /quit to stop) '));
          if (key === null || key.trim() === '/quit') { say(''); finish('abandoned', 'quit'); break; }
        } else if (autoDelayMs > 0) await sleep(autoDelayMs);
        answer = (asked.kind === 'main' ? entry.main : entry.followUp).text;
        say(`${style.cyan('YOU:')} ${answer}`);
      } else {
        answer = await readLine(style.cyan('YOU: '));
      }

      if (finished) break; // Ctrl+C while waiting
      if (answer === null || answer.trim() === '/quit') { finish('abandoned', 'quit'); break; }
      // Same length rule as the server. The demo has no time limit, so there is no deadline check.
      if (!answer.trim() || answer.length > MAX_ANSWER_LENGTH) {
        say(`(answer must be 1-${MAX_ANSWER_LENGTH} characters, try again)`);
        say('');
        continue;
      }
      transcript.turns.push({
        role: 'student',
        text: answer.trim(),
        ...asked,
        mainOrdinal,
        createdAt: new Date(now()).toISOString(),
        clientTiming: { secondsToAnswer: Math.round((now() - typedAt) / 100) / 10, secondsSinceQuestion: Math.round((now() - askedAt) / 100) / 10 },
      });

      say('');
      say(style.dim('thinking...'));
      const decision = await engine.decideNext({ config, state, code, turns: transcript.turns, modelId, promptVersion, converseFn });
      if (finished) break; // Ctrl+C while the model was working
      state = decision.state;
      transcript.fallbackCount = state.fallbackCount;
      const record = engine.recordFields(decision);

      if (!hideAgent) {
        say(style.dim('agent (instructor view):'));
        agentLines(decision, rubricByMain[mainOrdinal]).forEach((line) => say(style.dim(`  ${line}`)));
        say('');
      }

      if (decision.action === engine.ACTIONS.END) {
        transcript.endDetail = {
          reason: decision.reason,
          ...(decision.modelReason && { modelReason: decision.modelReason }),
          ...(decision.fallback && { fallback: decision.fallback }),
          action: decision.action,
          ...record,
        };
        transcript.endUsage = decision.usage;
        say('HOST: Thank you, that is the end of the interview.');
        finish('completed', 'completed');
        break;
      }

      question = decision.question;
      asked = { themeId: decision.themeId, kind: decision.kind };
      if (decision.kind === 'main') mainOrdinal += 1;
      askedAt = now();
      transcript.turns.push({
        role: 'host',
        text: question,
        ...asked,
        mainOrdinal,
        action: decision.action,
        reason: decision.reason,
        ...(decision.modelReason && { modelReason: decision.modelReason }),
        ...(decision.fallback && { fallback: decision.fallback }),
        ...record,
        latencyMs: decision.usage.latencyMs,
        inputTokens: decision.usage.inputTokens,
        outputTokens: decision.usage.outputTokens,
        createdAt: new Date(askedAt).toISOString(),
      });
      save();
    }
  } catch (error) {
    transcript.error = `${error.name}: ${error.message}`;
    finish('error', 'exception');
  } finally {
    stopReading();
    finish('abandoned', 'quit'); // no-op when the run already ended
  }

  say('');
  say(style.bold('Instructor summary'));
  summaryLines(transcript, rubricByMain, style).forEach((line) => say(line));
  say('');
  say(`Transcript saved to ${file}`);
  return { transcript, file };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.case) {
    console.error(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const temperature = args.temperature === undefined ? DEFAULT_TEMPERATURE : Number(args.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    console.error('Error: --temperature must be a number from 0 to 1');
    process.exit(1);
  }
  const color = !args['no-color'] && !process.env.NO_COLOR && !!process.stdout.isTTY;
  let handle = null;
  const onSignal = () => {
    if (handle) handle.interrupt();
    process.stdout.write(`\nCtrl+C: stopped. Transcript saved${handle ? ` to ${handle.file}` : ''}.\n`);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);

  const result = await runDemo({
    caseId: args.case,
    promptVersion: args.prompt || DEFAULT_PROMPT,
    temperature,
    hideAgent: !!args['hide-agent'],
    auto: args.auto || null,
    autoDelayMs: args['auto-delay'] === undefined ? null : Number(args['auto-delay']) * 1000,
    color,
    modelId: args.model,
    fakeModel: !!args['fake-model'],
    converseFn: args['fake-model'] ? createFakeModel({ seed: 1, chaos: 0 }) : undefined,
    outDir: path.resolve(args['out-dir'] || path.join(__dirname, '..', 'eval-results', 'demo')),
    onReady: (h) => { handle = h; },
  });
  process.exit(result.transcript.status === 'error' ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    // Only the error class and message; never request text.
    console.error(`Failed: ${error.name}: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, runDemo, agentLines, summaryLines, numberedCode, stylesFor };
