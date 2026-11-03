// The terminal demo (scripts/demo-interview.js): it must send the model the same input as the evaluation, and show/save what it should.
jest.mock('../db/interviews', () => require('../../../scripts/eval/fake-stores').interviews);
jest.mock('../db/submissions', () => require('../../../scripts/eval/fake-stores').submissions);
jest.mock('../db/milestones', () => require('../../../scripts/eval/fake-stores').milestones);
jest.mock('../utils/logger', () => require('../../../scripts/eval/fake-stores').logger);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const bedrock = require('../agent/bedrock-client');
const { runEval } = require('../../../scripts/eval/run-eval');
const { runDemo, parseArgs, agentLines, numberedCode } = require('../../../scripts/demo-interview');
const { createFakeModel } = require('../../../scripts/eval/fake-model');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); jest.restoreAllMocks(); });

const REPLY = {
  text: JSON.stringify({ missing: ['r1'], action: 'follow_up', target: 'r1', isHint: false, question: 'What happens at the reading 40?', reason: 'r1 is not shown.' }),
  inputTokens: 10, outputTokens: 5, latencyMs: 1,
};
const demo = async (over = {}) => {
  const out = [];
  const result = await runDemo({
    caseId: 'case4', auto: 'vague', autoDelayMs: 0, outDir: path.join(tmp, 'demo'), output: (t) => out.push(t), converseFn: createFakeModel({ seed: 1, chaos: 0 }), ...over,
  });
  return { ...result, text: out.join('') };
};

describe('the model input', () => {
  it('is the same as the evaluation sends for case4 with host.v4.1 (system prompt, message with the rubric, temperature)', async () => {
    const evalSeen = [];
    jest.spyOn(bedrock, 'converse').mockImplementation(async (req) => { evalSeen.push(req); return REPLY; });
    await runEval({
      fakeModel: false, yes: true, log: () => {}, delayMs: 0, retryDelayMs: 0, prompts: 'host.v4.1@0', cases: 'case4', profiles: 'vague',
      repeats: 1, out: path.join(tmp, 'eval'), noPairs: true,
    });

    const demoSeen = [];
    await demo({ converseFn: async (req) => { demoSeen.push(req); return REPLY; }, promptVersion: 'host.v4.1', temperature: 0 });

    expect(demoSeen.length).toBeGreaterThan(0);
    // The first decision, after the first scripted answer: everything the model receives.
    const pick = (r) => ({ system: r.system, messages: r.messages, temperature: r.temperature });
    expect(pick(demoSeen[0])).toEqual(pick(evalSeen[0]));
    expect(demoSeen[0].messages[0].content[0].text).toMatch(/Rubric for this main question/);
    expect(demoSeen[0].messages[0].content[0].text).toMatch(/- r1: At 40 the controller stays/);
    expect(demoSeen[0].temperature).toBe(0);
    // and the one after the next main answer, history included
    expect(demoSeen).toHaveLength(evalSeen.length);
    demoSeen.forEach((r, i) => expect(pick(r)).toEqual(pick(evalSeen[i])));
  });

  it('defaults to host.v4.1 at temperature 0', async () => {
    const seen = [];
    await demo({ converseFn: async (req) => { seen.push(req); return REPLY; } });
    expect(seen.every((r) => r.temperature === 0)).toBe(true);
    expect(seen[0].system).toBe(require('../agent/interview-engine').loadPrompt('host.v4.1'));
  });
});

describe('the screen', () => {
  it('prints the code with line numbers, then the first main question, then the instructor view under each question', async () => {
    const { text } = await demo();
    expect(text).toMatch(/\n 1 \| #include <iostream>/);
    expect(text.indexOf(' 1 | #include')).toBeLessThan(text.indexOf('HOST:'));
    expect(text).toMatch(/thinking\.\.\./);
    expect(text).toMatch(/agent \(instructor view\):/);
    expect(text).toMatch(/missing:\n\s+r1: /);
    expect(text).toMatch(/action: follow_up/);
    expect(text).toMatch(/target: r1/);
    expect(text).toMatch(/isHint: (yes|no)/);
    expect(text).toMatch(/reason: /);
  });

  it('--hide-agent turns the instructor view off but keeps the summary', async () => {
    const { text } = await demo({ hideAgent: true });
    expect(text).not.toMatch(/agent \(instructor view\)/);
    expect(text).toMatch(/Instructor summary/);
  });

  it('colours are off by default (plain text) and dim only when asked for', async () => {
    expect((await demo()).text).not.toMatch(/\x1b\[/);
    expect((await demo({ color: true })).text).toMatch(/\x1b\[2magent \(instructor view\)/);
  });

  it('agentLines shows guard, repairs and fallbacks', () => {
    const lines = agentLines({
      action: 'follow_up', target: 'r2', isHint: true, reason: 'x', missing: ['r2'],
      guard: { fired: true, original: 'A? B?', fixedByRetry: true },
      repairs: [{ type: 'target', from: null, to: 'r2' }, { type: 'yes_no_rewrite', original: 'Does it?', fixed: true }],
    }, [{ id: 'r2', text: 'Says the thing.' }]).join('\n');
    expect(lines).toMatch(/r2: Says the thing\./);
    expect(lines).toMatch(/isHint: yes/);
    expect(lines).toMatch(/guard fired: two questions, rewritten as one/);
    expect(lines).toMatch(/repair: target \(none\) -> r2/);
    expect(lines).toMatch(/repair: yes_no_rewrite \(fixed\)/);
  });

  it('numbers the code lines', () => {
    expect(numberedCode('a\nb\n')).toEqual(['1 | a', '2 | b']);
  });
});

describe('the transcript and the summary', () => {
  it('--auto plays the case profile to the end, saves a JSON transcript, and summarises each main question', async () => {
    const { transcript, file, text } = await demo({ auto: 'strong' });
    expect(transcript.status).toBe('completed');
    expect(file.startsWith(path.join(tmp, 'demo'))).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.caseId).toBe('case4');
    expect(saved.mode).toBe('auto:strong');
    expect(saved.turns.filter((t) => t.role === 'host' && t.kind === 'main')).toHaveLength(5);
    expect(saved.turns.some((t) => t.role === 'host' && Array.isArray(t.missing))).toBe(true);
    expect(saved.endDetail).toBeDefined();
    expect((text.match(/\nQuestion \d \[/g) || [])).toHaveLength(5);
    expect(text).toMatch(/student \[\d\d:\d\d:\d\d/);
    expect(text).toMatch(/agent says missing:/);
    expect(text).toMatch(/Transcript saved to /);
  });

  it('case5 (the buggy code) uses its own program', async () => {
    const { text } = await demo({ caseId: 'case5' });
    expect(text).toMatch(/return TankState::IDLE;/);
  });

  it('marks a hint follow-up as a hint in the summary', async () => {
    const { text, transcript } = await demo({ auto: 'idk' });
    const hints = transcript.turns.filter((t) => t.role === 'host' && t.isHint);
    expect(hints.length).toBeGreaterThan(0);
    expect(text).toMatch(/follow-up \(hint\)/);
  });

  it('typed answers: /quit ends cleanly and still saves the transcript', async () => {
    const input = new PassThrough();
    input.end('my first answer\n/quit\n');
    const { transcript, file } = await demo({ auto: null, input });
    expect(transcript.status).toBe('abandoned');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.turns.find((t) => t.role === 'student').text).toBe('my first answer');
  });

  it('an interrupt while waiting for the model saves the transcript with status interrupted', async () => {
    let handle;
    const { transcript, file } = await demo({
      onReady: (h) => { handle = h; },
      converseFn: async () => { handle.interrupt(); return REPLY; },
    });
    expect(transcript.status).toBe('interrupted');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).status).toBe('interrupted');
  });
});

describe('no time limit, and how --auto is driven', () => {
  it('shows no countdown and never times out, even when the clock is far past ten minutes', async () => {
    let t = Date.parse('2026-01-01T09:00:00Z');
    const { text, transcript } = await demo({ auto: 'strong', now: () => { t += 5 * 60000; return t; } });
    expect(text).not.toMatch(/left\]|minutes|Time is up/);
    expect(text).toMatch(/no time limit/);
    expect(transcript.status).toBe('completed');
  });

  it('--auto without a delay waits for Enter before each scripted answer; /quit stops', async () => {
    const input = new PassThrough();
    const out = [];
    const run = runDemo({ caseId: 'case4', auto: 'vague', outDir: path.join(tmp, 'demo'), output: (t) => out.push(t), converseFn: createFakeModel({ seed: 1, chaos: 0 }), input });
    await new Promise((r) => setTimeout(r, 30));
    expect(out.join('')).toMatch(/press Enter to send the scripted answer/);
    expect(out.join('')).not.toMatch(/YOU: /); // nothing sent yet
    input.write('\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(out.join('')).toMatch(/YOU: I just go through them in order/);
    input.write('/quit\n');
    const { transcript } = await run;
    expect(transcript.status).toBe('abandoned');
    expect(transcript.turns.filter((x) => x.role === 'student')).toHaveLength(1);
  });

  it('--auto-delay waits that long (and does not read the keyboard)', async () => {
    const waits = [];
    const { transcript } = await demo({ auto: 'strong', autoDelayMs: 1500, sleep: async (ms) => { waits.push(ms); } });
    expect(transcript.status).toBe('completed');
    expect(waits.length).toBeGreaterThan(0);
    expect(new Set(waits)).toEqual(new Set([1500]));
  });
});

describe('options', () => {
  it('parses flags with and without a value', () => {
    expect(parseArgs(['--case', 'case4', '--hide-agent', '--auto', 'vague', '--auto-delay', '3', '--no-color'])).toEqual({ case: 'case4', 'hide-agent': true, auto: 'vague', 'auto-delay': '3', 'no-color': true });
  });
});
