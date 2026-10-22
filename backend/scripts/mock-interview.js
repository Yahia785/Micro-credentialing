#!/usr/bin/env node
/**
 * Mock interview in the terminal.
 *
 * Runs the real Host loop (same engine as the Lambda) against Amazon Bedrock using your local
 * AWS credentials. You type the student's answers. The full transcript, including the model's
 * reasons, timings and token counts, is written to a JSON file. DynamoDB is never touched.
 *
 *   node scripts/mock-interview.js --code scripts/sample.cpp --config scripts/sample-interview.json
 *
 * Options:
 *   --code   <file>   C++ source the "student" submitted (required)
 *   --config <file>   interview config JSON (required)
 *   --out    <file>   transcript file (default: mock-interview-<timestamp>.json)
 *   --model  <id>     Bedrock model ID (default: AGENT_MODEL_ID or the platform default)
 *
 * Type /quit to stop early. Note: your answers and the code are sent to Bedrock (us-east-1).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const engine = require('../shared/nodejs/agent/interview-engine');
const bedrock = require('../shared/nodejs/agent/bedrock-client');
const { parseInterview } = require('../shared/nodejs/utils/interview-config');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.code || !args.config) {
    fail('usage: node scripts/mock-interview.js --code <file.cpp> --config <interview.json> [--out transcript.json] [--model id]');
  }

  const code = fs.readFileSync(path.resolve(args.code), 'utf8');
  const rawConfig = JSON.parse(fs.readFileSync(path.resolve(args.config), 'utf8'));
  const parsed = parseInterview(rawConfig, { language: 'cpp' });
  if (parsed.error) fail(`invalid interview config: ${parsed.error}`);
  if (!parsed.value.enabled) fail('the config has "enabled": false');
  const config = parsed.value;

  const modelId = bedrock.resolveModelId(args.model);
  const outFile = path.resolve(args.out || `mock-interview-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  const startedAt = Date.now();
  const deadline = startedAt + config.timeLimitMinutes * 60000;
  const transcript = {
    modelId,
    promptVersion: engine.PROMPT_VERSION,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: null,
    status: 'in_progress',
    config,
    fallbackCount: 0,
    turns: [],
  };
  const save = () => fs.writeFileSync(outFile, JSON.stringify(transcript, null, 2));

  const first = engine.firstQuestion(config);
  let state = first.state;
  let question = first.question;
  let asked = { themeId: first.themeId, kind: first.kind };
  let askedAt = Date.now();
  transcript.turns.push({ role: 'host', text: question, ...asked, createdAt: new Date(askedAt).toISOString(), reason: 'first main question' });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });
  const ask = (prompt) => new Promise((resolve) => {
    if (closed) return resolve(null);
    rl.question(prompt, resolve);
    rl.once('close', () => resolve(null));
  });

  console.log(`\nInterview started (model ${modelId}, ${config.timeLimitMinutes} min). Type /quit to stop.\n`);

  while (true) {
    console.log(`HOST: ${question}\n`);
    const remaining = deadline - Date.now();
    const typedAt = Date.now();
    const answer = await ask(`YOU (${Math.max(0, Math.round(remaining / 1000))}s left): `);

    if (answer === null || answer.trim() === '/quit') {
      transcript.status = 'abandoned';
      break;
    }
    if (Date.now() > deadline) {
      console.log('\nTime is up. This answer is not counted.');
      transcript.status = 'timed_out';
      break;
    }
    if (!answer.trim()) {
      console.log('(empty answer, try again)\n');
      continue;
    }

    const studentTurn = {
      role: 'student',
      text: answer.trim().slice(0, 2000),
      ...asked,
      createdAt: new Date().toISOString(),
      clientTiming: {
        secondsToAnswer: Math.round((Date.now() - typedAt) / 100) / 10,
        secondsSinceQuestion: Math.round((Date.now() - askedAt) / 100) / 10,
      },
    };
    transcript.turns.push(studentTurn);

    console.log('\n...thinking\n');
    const decision = await engine.decideNext({ config, state, code, turns: transcript.turns, modelId });
    state = decision.state;
    transcript.fallbackCount = state.fallbackCount;

    if (decision.action === engine.ACTIONS.END) {
      transcript.status = 'completed';
      transcript.endReason = decision.reason;
      transcript.endUsage = decision.usage;
      if (decision.fallback) transcript.endFallback = decision.fallback;
      console.log('HOST: Thank you, that is the end of the interview.\n');
      break;
    }

    question = decision.question;
    asked = { themeId: decision.themeId, kind: decision.kind };
    askedAt = Date.now();
    transcript.turns.push({
      role: 'host',
      text: question,
      ...asked,
      reason: decision.reason,
      ...(decision.fallback && { fallback: decision.fallback }),
      latencyMs: decision.usage.latencyMs,
      inputTokens: decision.usage.inputTokens,
      outputTokens: decision.usage.outputTokens,
      createdAt: new Date(askedAt).toISOString(),
    });
    save();
  }

  rl.close();
  transcript.endedAt = new Date().toISOString();
  save();
  console.log(`Transcript written to ${outFile}`);
}

main().catch((error) => {
  // Only the error class and message; never request text.
  console.error(`Failed: ${error.name}: ${error.message}`);
  process.exit(1);
});
