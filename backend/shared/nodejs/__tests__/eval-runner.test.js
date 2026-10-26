// The runner drives the real interview service. Under Jest the database and logger modules are
// replaced by the same in-memory stores the command line uses.
jest.mock('../db/interviews', () => require('../../../scripts/eval/fake-stores').interviews);
jest.mock('../db/submissions', () => require('../../../scripts/eval/fake-stores').submissions);
jest.mock('../db/milestones', () => require('../../../scripts/eval/fake-stores').milestones);
jest.mock('../utils/logger', () => require('../../../scripts/eval/fake-stores').logger);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEval, planOf, parseArgs, withRetry } = require('../../../scripts/eval/run-eval');
const { loadCase } = require('../../../scripts/eval/cases');
const { ModelUnavailableError } = require('../agent/bedrock-client');
const metrics = require('../../../scripts/eval/metrics');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const base = (over = {}) => ({
  fakeModel: true, yes: true, log: () => {}, delayMs: 0, retryDelayMs: 0,
  prompts: 'host.v2,host.v3', cases: 'case2', profiles: 'strong,vague', repeats: 1,
  out: path.join(tmp, 'out'), fakeChaos: 0, ...over,
});
const readTranscripts = (outDir) => fs.readdirSync(path.join(outDir, 'transcripts'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(outDir, 'transcripts', f), 'utf8')));

describe('runEval with --fake-model', () => {
  it('runs the whole evaluation on one case and writes every output file', async () => {
    const { outDir, report } = await runEval(base());

    for (const file of ['summary.json', 'summary.csv', 'summary.md']) {
      expect(fs.existsSync(path.join(outDir, file))).toBe(true);
    }
    const transcripts = readTranscripts(outDir);
    expect(transcripts).toHaveLength(4); // 2 prompts x 2 profiles
    expect(Object.keys(report.results)).toEqual(['host.v2', 'host.v3']);

    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    expect(summary.results['host.v3'].overall.interviews).toBe(2);
    expect(Object.keys(summary.results['host.v3'].byCase)).toEqual(['case2']);
    expect(Object.keys(summary.results['host.v3'].byProfile)).toEqual(['strong', 'vague']);

    const md = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8');
    expect(md).toContain('## Comparison (overall)');
    expect(md).toContain('## host.v2');
    expect(md).toContain('## host.v3');
    expect(md).toContain('Missed follow-up by answer label');

    const csv = fs.readFileSync(path.join(outDir, 'summary.csv'), 'utf8').trim().split('\n');
    expect(csv[0].split(',').slice(0, 3)).toEqual(['prompt', 'scope', 'key']);
    expect(csv.length).toBe(1 + 2 * (1 + 1 + 2)); // per prompt: overall, 1 case, 2 profiles
  });

  it('runs the real service: interview records, deadline, prompt version and model reasons are the server\'s', async () => {
    const { outDir } = await runEval(base({ prompts: 'host.v3', profiles: 'vague' }));
    const [t] = readTranscripts(outDir);
    expect(t.status).toBe('completed');
    expect(t.promptVersionStored).toBe('host.v3');
    expect(t.endReason).toBe('completed');
    expect(Date.parse(t.deadline) - Date.parse(t.startedAt)).toBe(10 * 60000);
    expect(t.turns[0]).toMatchObject({ role: 'host', kind: 'main', reason: 'first main question' });
    expect(t.turns.filter((x) => x.role === 'host' && x.kind === 'main')).toHaveLength(t.mains);
  });

  it('stores the scripted label and profile on every student turn', async () => {
    const { outDir } = await runEval(base({ profiles: 'strong,wrong,mixed' }));
    for (const t of readTranscripts(outDir)) {
      const students = t.turns.filter((x) => x.role === 'student');
      expect(students.length).toBeGreaterThan(0);
      students.forEach((s) => {
        expect(s.scripted.profile).toBe(t.profile);
        expect(['good', 'vague', 'wrong', 'short', 'idk']).toContain(s.scripted.label);
        expect(['main', 'followUp']).toContain(s.scripted.answerType);
        expect(Number.isInteger(s.scripted.mainOrdinal)).toBe(true);
      });
    }
  });

  it('a strong profile gets no unnecessary follow-ups from the clean fake model', async () => {
    const { report } = await runEval(base({ profiles: 'strong' }));
    expect(report.results['host.v3'].overall.unnecessaryFollowUp).toMatchObject({ num: 0, den: 5 });
  });

  it('uses the same follow-up answer text for whatever follow-up is asked, per main question', async () => {
    const { outDir } = await runEval(base({ prompts: 'host.v3', profiles: 'short', cases: 'case1' }));
    const [t] = readTranscripts(outDir);
    const followUpAnswers = t.turns.filter((x) => x.role === 'student' && x.scripted.answerType === 'followUp');
    expect(followUpAnswers.length).toBeGreaterThan(0);
    const raw = loadCase('case1').studentsRaw.profiles.short;
    followUpAnswers.forEach((x) => expect(x.text).toBe(raw[x.scripted.mainOrdinal].followUp.text));
  });

  describe('the mixed profile', () => {
    it('is the same sequence of labels in every prompt version and repeat', async () => {
      const { outDir } = await runEval(base({ profiles: 'mixed', repeats: 2, cases: 'case1,case3' }));
      const sequences = {};
      for (const t of readTranscripts(outDir)) {
        const labels = t.turns.filter((x) => x.role === 'student' && x.scripted.answerType === 'main').map((x) => x.scripted.label);
        (sequences[t.caseId] = sequences[t.caseId] || new Set()).add(labels.join(','));
      }
      expect(sequences.case1.size).toBe(1);
      expect(sequences.case3.size).toBe(1);
      expect([...sequences.case1][0]).toBe(loadCase('case1').studentsRaw.mixed.join(','));
    });
  });

  describe('simulated clock', () => {
    it('applies the time limit without waiting', async () => {
      const started = Date.now();
      const { outDir } = await runEval(base({ prompts: 'host.v3', profiles: 'strong', answerSeconds: 200 }));
      const [t] = readTranscripts(outDir);
      // answers arrive at 200 s, 400 s, 600 s (still allowed), 800 s (after the 10 minute limit)
      expect(t.status).toBe('timed_out');
      expect(t.turns.filter((x) => x.role === 'student')).toHaveLength(3);
      expect(t.timedOutOnAnswer).toMatchObject({ label: 'good' });
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('does not time out at the default 30 seconds per turn', async () => {
      const { outDir } = await runEval(base({ prompts: 'host.v3', profiles: 'idk' }));
      expect(readTranscripts(outDir)[0].status).toBe('completed');
    });
  });

  describe('failures and throttling', () => {
    it('records throttling separately from other model failures, and keeps going', async () => {
      const { outDir, report } = await runEval(base({ fakeChaos: 1, cases: 'case1,case2,case3', profiles: 'all', prompts: 'host.v3' }));
      const f = report.results['host.v3'].overall.fallbacks;
      expect(f.throttled).toBeGreaterThan(0);
      expect(f.modelUnavailable).toBeGreaterThan(0);
      expect(f.invalidOutput).toBeGreaterThan(0);
      expect(f.throttleRetries).toBeGreaterThan(0);

      const transcripts = readTranscripts(outDir);
      expect(transcripts).toHaveLength(18);
      const throttledTurn = transcripts.flatMap((t) => t.turns).find((x) => x.modelCall && x.modelCall.throttled);
      expect(throttledTurn.fallback).toBe('model_unavailable');
      expect(throttledTurn.modelCall.errorName).toBe('ThrottlingException');
      expect(throttledTurn.reason).toMatch(/^fallback: model unavailable/);
      expect(report.failures).toEqual([]); // a model failure falls back; it is not an interview failure
    });

    it('withRetry retries a throttled call once, then gives up and says it was throttling', async () => {
      const sleeps = [];
      const sleep = async (ms) => { sleeps.push(ms); };

      const calls = [];
      let n = 0;
      const flaky = withRetry(async () => {
        n += 1;
        if (n === 1) throw new ModelUnavailableError('ThrottlingException');
        return { text: '{}', inputTokens: 5, outputTokens: 2, latencyMs: 9 };
      }, { calls, sleep, delayMs: 10, retryDelayMs: 100 });
      await expect(flaky({})).resolves.toMatchObject({ inputTokens: 5 });
      expect(calls[0]).toMatchObject({ attempts: 2, throttleRetries: 1, throttled: false, inputTokens: 5, latencyMs: 9 });
      expect(sleeps).toEqual([10, 100]);

      const stuck = withRetry(async () => { throw new ModelUnavailableError('ThrottlingException'); }, { calls, sleep, delayMs: 0, retryDelayMs: 0 });
      await expect(stuck({})).rejects.toMatchObject({ name: 'ModelUnavailableError' });
      expect(calls[1]).toMatchObject({ attempts: 2, throttleRetries: 1, throttled: true, errorName: 'ThrottlingException' });

      const broken = withRetry(async () => { throw new ModelUnavailableError('InternalServerException'); }, { calls, sleep, delayMs: 0, retryDelayMs: 0 });
      await expect(broken({})).rejects.toMatchObject({ name: 'ModelUnavailableError' });
      expect(calls[2]).toMatchObject({ attempts: 1, throttleRetries: 0, throttled: false, errorName: 'InternalServerException' });
    });

    it('records an unexpected error as an interview failure and continues with the next one', async () => {
      const engine = require('../agent/interview-engine');
      const spy = jest.spyOn(engine, 'decideNext').mockRejectedValueOnce(new TypeError('boom'));
      try {
        const { report, outDir } = await runEval(base({ prompts: 'host.v3', profiles: 'strong,vague', cases: 'case2' }));
        expect(report.failures).toHaveLength(1);
        expect(report.failures[0].error).toBe('TypeError: boom');
        const transcripts = readTranscripts(outDir);
        expect(transcripts).toHaveLength(2);
        expect(transcripts.map((t) => t.status).sort()).toEqual(['completed', 'error']);
        expect(report.results['host.v3'].overall).toMatchObject({ interviews: 2, completed: 1, errored: 1 });
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('gives the same numbers when run twice', async () => {
    const a = await runEval(base({ fakeChaos: 0.5, out: path.join(tmp, 'a'), runId: 'x' }));
    const b = await runEval(base({ fakeChaos: 0.5, out: path.join(tmp, 'b'), runId: 'x' }));
    expect(b.report.results).toEqual(a.report.results);
  });

  it('keeps repeats and prompts independent (a fresh store and fake model per interview)', async () => {
    const { report } = await runEval(base({ repeats: 2, prompts: 'host.v2,host.v3', fakeChaos: 0.5 }));
    const v2 = report.results['host.v2'].overall;
    const v3 = report.results['host.v3'].overall;
    expect(v2.interviews).toBe(4);
    expect(v2).toEqual(v3); // the fake model ignores the prompt, so the two must match exactly
  });
});

describe('planning and confirmation', () => {
  it('estimates the number of interviews and model calls', () => {
    const opts = { prompts: ['host.v2', 'host.v3'], cases: ['case1', 'case2'], profiles: ['strong', 'vague', 'idk'], repeats: 3 };
    const loaded = { case1: loadCase('case1'), case2: loadCase('case2') };
    const plan = planOf(opts, loaded);
    expect(plan.interviews).toBe(2 * 2 * 3 * 3);
    // 5 mains each, budget 1: between 5 and 10 calls per interview
    expect(plan.minCalls).toBe(plan.interviews * 5);
    expect(plan.maxCalls).toBe(plan.interviews * 10);
  });

  it('asks before starting and runs nothing when declined', async () => {
    const asked = [];
    const result = await runEval(base({ yes: false, confirm: async (plan) => { asked.push(plan); return false; } }));
    expect(result.cancelled).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].interviews).toBe(4);
    expect(fs.existsSync(path.join(tmp, 'out'))).toBe(false);
  });

  it('runs after the user confirms', async () => {
    const result = await runEval(base({ yes: false, confirm: async () => true }));
    expect(result.cancelled).toBe(false);
    expect(fs.existsSync(path.join(result.outDir, 'summary.md'))).toBe(true);
  });

  it('prints the estimate before asking', async () => {
    const lines = [];
    await runEval(base({ yes: false, confirm: async () => false, log: (l) => lines.push(l) }));
    expect(lines.join('\n')).toMatch(/4 interviews, about \d+-\d+ model calls/);
  });

  it('rejects unknown prompt versions, cases and profiles with the valid choices', async () => {
    await expect(runEval(base({ prompts: 'host.v9' }))).rejects.toThrow(/Unknown prompt version.*host\.v1/);
    await expect(runEval(base({ cases: 'case9' }))).rejects.toThrow(/Unknown case.*case1/);
    await expect(runEval(base({ profiles: 'nobody' }))).rejects.toThrow(/Unknown profile.*strong/);
    await expect(runEval(base({ repeats: 0 }))).rejects.toThrow(/repeats/);
  });
});

describe('command line', () => {
  it('parses values and flags', () => {
    expect(parseArgs(['--prompts', 'host.v1,host.v2', '--fake-model', '--yes', '--repeats', '3', '--delay-ms', '0']))
      .toEqual({ prompts: 'host.v1,host.v2', fakeModel: true, yes: true, repeats: '3', delayMs: '0' });
    expect(() => parseArgs(['--out'])).toThrow(/needs a value/);
    expect(() => parseArgs(['stray'])).toThrow(/Unexpected argument/);
  });

  it('adds host.v1 to the comparison', async () => {
    const { report } = await runEval(base({ prompts: 'host.v1,host.v2,host.v3', profiles: 'strong', cases: 'case1,case2' }));
    expect(Object.keys(report.results)).toEqual(['host.v1', 'host.v2', 'host.v3']);
    expect(report.notes.join(' ')).toMatch(/host\.v1 has no examples/);
  });

  it('defaults the output folder under eval-results/', () => {
    const { normalizeOptions } = require('../../../scripts/eval/run-eval');
    const opts = normalizeOptions({ fakeModel: true, runId: 'run-1' });
    expect(opts.out.replace(/\\/g, '/')).toMatch(/backend\/eval-results\/run-1$/);
    expect(metrics.DEFAULT_PRICES.inputPerMillion).toBe(0.15);
  });
});
