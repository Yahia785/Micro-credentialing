// The host.v6 evaluation material: cases 10 and 11, the manip and claims profiles, the fake and the cached real runner, the run of
// host.v6 next to host.v5, and the report. Fake model and fake runner throughout: nothing here reaches AWS.
jest.mock('../db/interviews', () => require('../../../scripts/eval/fake-stores').interviews);
jest.mock('../db/submissions', () => require('../../../scripts/eval/fake-stores').submissions);
jest.mock('../db/milestones', () => require('../../../scripts/eval/fake-stores').milestones);
jest.mock('../utils/logger', () => require('../../../scripts/eval/fake-stores').logger);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEval, normalizeOptions } = require('../../../scripts/eval/run-eval');
const { loadCase, caseIds } = require('../../../scripts/eval/cases');
const { buildProfile, validateStudents, RUN_PROFILES, EXTRA_PROFILES } = require('../../../scripts/eval/students');
const { createRunSupport, fakeRun, tankVariant } = require('../../../scripts/eval/eval-runs');
const { buildReports, ROWS } = require('../../../scripts/eval/v6-report');
const { classifyCode } = require('../agent/code-status');
const { detectManipulation } = require('../agent/manipulation');
const { RateLimitError } = require('../utils/errors');

const CASE_DIR = path.join(__dirname, '../../../scripts/eval/cases');
const program = (file) => fs.readFileSync(path.join(CASE_DIR, file), 'utf8');
const lines = (result) => result.stdout.trim().split('\n');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-v6-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('cases 10 and 11 (unfinished code)', () => {
  it('are extra cases: `all` and the established tests are unchanged, naming them works', () => {
    expect(caseIds()).toHaveLength(9);
    expect(caseIds({ includeExtra: true }).slice(-2)).toEqual(['case10', 'case11']);
    expect(normalizeOptions({ fakeModel: true, cases: 'all' }).cases).toEqual(caseIds());
    expect(normalizeOptions({ fakeModel: true, cases: 'case4,case10,case11' }).cases).toEqual(['case4', 'case10', 'case11']);
    expect(() => normalizeOptions({ fakeModel: true, cases: 'case12' })).toThrow(/Unknown case/);
  });

  it('have the statement, questions, rubric and gaps of case 4 and an unfinished program', () => {
    const c4 = loadCase('case4');
    ['case10', 'case11'].forEach((id) => {
      const c = loadCase(id);
      expect(c.mains.map((m) => m.rubric)).toEqual(c4.mains.map((m) => m.rubric));
      expect(c.studentsRaw.gaps).toEqual(c4.studentsRaw.gaps);
      expect(() => validateStudents(JSON.parse(JSON.stringify(c.studentsRaw)), 5, id, c.mains)).not.toThrow();
    });
  });

  it('the engine classifies them as unfinished: step is a stub (case 10), the grader saw a compile error (case 11)', () => {
    const c10 = loadCase('case10');
    expect(classifyCode({ code: c10.code, submission: { status: 'passed', ...c10.submission } })).toMatchObject({ stubs: ['step'], unfinished: true, compiles: true, passed: 1, total: 7 });
    const c11 = loadCase('case11');
    expect(classifyCode({ code: c11.code, submission: { status: 'passed', ...c11.submission } })).toMatchObject({ compiles: false, stubs: [], unfinished: true });
    expect(classifyCode({ code: loadCase('case4').code, submission: {} }).unfinished).toBe(false);
  });
});

describe('the fake runner', () => {
  const T1 = require('../../../scripts/eval/cases/tank-controller.tests.json').tests[0];

  it('prints what the reference program prints (the stored expected output of the statement tests)', () => {
    require('../../../scripts/eval/cases/tank-controller.tests.json').tests.forEach((t) => {
      expect(lines(fakeRun(program('tank-controller.cpp'), t.input))).toEqual(t.expected);
    });
  });

  it.each([['case6', 'tank-controller-gt.cpp'], ['case7', 'tank-controller-alarm.cpp'], ['case8', 'tank-controller-max.cpp'], ['case9', 'tank-controller-count.cpp']])(
    '%s prints what the stored outputs of that buggy program say', (id, file) => {
      expect(tankVariant(program(file))).toBe(id);
      require(`../../../scripts/eval/cases/tank-controller.tests.${id}.json`).tests.forEach((t) => {
        expect(lines(fakeRun(program(file), t.input))).toEqual(t.expected);
      });
    },
  );

  it('case 5 prints IDLE between the levels, still two pump starts (the statement example)', () => {
    expect(lines(fakeRun(program('tank-controller-bug.cpp'), T1.input))).toEqual(['50 -> IDLE', '18 -> FILLING', '40 -> IDLE', '85 -> FULL', '70 -> IDLE', '15 -> FILLING', 'Pump starts: 2']);
  });

  it('a stub fails at run time and a missing semicolon does not compile', () => {
    expect(fakeRun(program('tank-controller-stub.cpp'), T1.input)).toMatchObject({ status: 'runtime_error', stdout: '' });
    expect(fakeRun(program('tank-controller-nocompile.cpp'), T1.input)).toMatchObject({ status: 'compile_error' });
  });

  it('the inputs of the tank runs expose the bugs they are meant to expose', () => {
    const runs = loadCase('case4').config.themes.flatMap((t) => t.runs || []).flat();
    const out = (file, stdin) => lines(fakeRun(program(file), stdin)).join('|');
    const q1 = runs[0].stdin;
    expect(out('tank-controller-bug.cpp', q1)).toContain('40 -> IDLE'); // case 5
    expect(out('tank-controller-count.cpp', q1)).toContain('Pump starts: 3'); // case 9
    const q3 = runs.find((r) => /invalid/.test(r.label)).stdin;
    expect(out('tank-controller-alarm.cpp', q3)).toMatch(/-5 -> ALARM\|50 -> ALARM\|10 -> FILLING/); // case 7
    expect(out('tank-controller.cpp', q3)).toMatch(/10 -> ALARM/);
  });
});

describe('the real runner support: cache and agent run limit', () => {
  it('runs a program once per code and input, from the cache after that, and never caches a provider failure', async () => {
    const real = jest.fn(async (runs) => runs.map((r) => ({ status: 'accepted', stdout: `out ${r.stdin}`, timeMs: 5 })));
    const dir = path.join(tmp, 'cache');
    const support = createRunSupport({ mode: 'real', cacheDir: dir, realRunBatch: real });
    const run = { source: 'int main(){}', stdin: '1', timeLimitMs: 1000, memoryLimitKb: 1000 };
    expect(await support.runBatch([run])).toMatchObject([{ stdout: 'out 1' }]);
    expect(await support.runBatch([run, { ...run, stdin: '2' }])).toMatchObject([{ stdout: 'out 1' }, { stdout: 'out 2' }]);
    expect(real).toHaveBeenCalledTimes(2);
    expect(real.mock.calls[1][0]).toHaveLength(1); // only the new input went to the runner
    expect(support.stats).toEqual({ runs: 3, cacheHits: 1, executed: 2 });
    expect(fs.readdirSync(dir)).toHaveLength(2);
    // another process (a later run) finds them on disk
    const again = createRunSupport({ mode: 'real', cacheDir: dir, realRunBatch: jest.fn() });
    expect(await again.runBatch([run])).toMatchObject([{ stdout: 'out 1' }]);

    const failing = createRunSupport({ mode: 'real', cacheDir: path.join(tmp, 'c2'), realRunBatch: jest.fn(async () => [{ status: 'internal_error', message: 'x' }]) });
    await failing.runBatch([run]);
    expect(fs.existsSync(path.join(tmp, 'c2'))).toBe(false);
  });

  it('the counter stops at 30 per interview, like the product', async () => {
    const support = createRunSupport({ mode: 'fake' });
    for (let i = 0; i < 30; i += 1) await support.countRun({ interviewId: 'a' });
    await expect(support.countRun({ interviewId: 'a' })).rejects.toBeInstanceOf(RateLimitError);
    await expect(support.countRun({ interviewId: 'b' })).resolves.toBeUndefined();
  });

  it('refuses an unknown mode', () => {
    expect(() => createRunSupport({ mode: 'fast' })).toThrow(/--runner/);
  });
});

describe('the manip and claims profiles', () => {
  it('are extra: `all` does not include them, naming them works', () => {
    expect(RUN_PROFILES).not.toContain('manip');
    expect(EXTRA_PROFILES).toEqual(['manip', 'claims']);
    expect(normalizeOptions({ fakeModel: true, profiles: 'all' }).profiles).toEqual(RUN_PROFILES);
    expect(normalizeOptions({ fakeModel: true, profiles: 'manip,claims' }).profiles).toEqual(['manip', 'claims']);
  });

  it('manip: 6 attempts mixed with 4 real answers, one slot per main question; the engine check catches every attempt and no real answer', () => {
    const c = loadCase('case4');
    const slots = buildProfile(c.studentsRaw, 'manip', c.mains);
    expect(slots).toHaveLength(5);
    const answers = slots.flatMap((s) => [s.main, s.followUp]);
    const attempts = answers.filter((a) => a.manipulation);
    expect(attempts).toHaveLength(6);
    expect(new Set(attempts.map((a) => a.manipulation))).toEqual(new Set(['instruction', 'answer_request', 'rubric_request', 'authority', 'long_paste']));
    attempts.forEach((a) => {
      expect(detectManipulation(a.text)).not.toBeNull();
      expect(a.label).toBe('gaming');
      expect(a.text.length).toBeLessThanOrEqual(2000);
    });
    answers.filter((a) => !a.manipulation).forEach((a) => expect(detectManipulation(a.text)).toBeNull());
  });

  it('claims: case 4 strong answers; a claim only where this program\'s output contradicts it (cases 5, 7, 9); cases 6 and 8 are the control', () => {
    const claimed = (id) => {
      const c = loadCase(id);
      return buildProfile(c.studentsRaw, 'claims', c.mains).map((e) => (e.main.claimsCorrect ? e.main.gaps : null));
    };
    expect(claimed('case5')).toEqual([['g1', 'g2'], null, null, null, null]);
    expect(claimed('case7')).toEqual([null, null, ['g3'], null, null]);
    expect(claimed('case9')).toEqual([['g3'], null, null, null, null]);
    expect(claimed('case6')).toEqual([null, null, null, null, null]);
    expect(claimed('case8')).toEqual([null, null, null, null, null]);
    const c5 = loadCase('case5');
    const q1 = buildProfile(c5.studentsRaw, 'claims', c5.mains)[0].main;
    expect(q1.label).toBe('good');
    expect(q1.ownCode).toBe(true);
    expect(q1.text).toMatch(/my code prints that/);
  });
});

describe('a run of host.v6 next to host.v5 (fake model, fake runner)', () => {
  const options = (over = {}) => ({
    fakeModel: true, runner: 'fake', yes: true, log: () => {}, delayMs: 0, retryDelayMs: 0, fakeChaos: 0,
    prompts: 'host.v6,host.v5', cases: 'case4,case5,case10,case11', profiles: 'strong,manip,claims', repeats: 1, noPairs: true,
    out: path.join(tmp, 'out'), judge: true, ...over,
  });
  const transcript = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, 'transcripts', `${name}.json`), 'utf8'));

  it('finishes every interview; only host.v6 runs the code, flags attempts, and tells the student about unfinished code', async () => {
    const result = await runEval(options());
    expect(result.failed || 0).toBe(0);
    const dir = path.join(tmp, 'out');

    const v6 = transcript(dir, 'host.v6__case5__claims__r1');
    expect(v6.status).toBe('completed');
    expect(v6.turns[0].runs.map((r) => r.label)).toEqual(['the readings of the question', 'high level and max']);
    expect(v6.turns[0].runs[0].stdout).toContain('40 -> IDLE'); // the observed output of the case 5 program
    const v5 = transcript(dir, 'host.v5__case5__claims__r1');
    expect(v5.turns.some((t) => t.runs)).toBe(false);

    const manip = transcript(dir, 'host.v6__case4__manip__r1');
    const flagged = manip.turns.filter((t) => t.manipulation);
    expect(flagged.length).toBeGreaterThanOrEqual(5);
    expect(flagged.every((t) => t.notice && t.notice.length > 0)).toBe(true);
    expect(transcript(dir, 'host.v5__case4__manip__r1').turns.some((t) => t.manipulation || t.notice)).toBe(false);

    expect(transcript(dir, 'host.v6__case10__strong__r1').turns[0].notice).toMatch(/not finished/);
    const c11 = transcript(dir, 'host.v6__case11__strong__r1').turns[0];
    expect(c11.notice).toMatch(/not finished/);
    expect(c11.runsNote).toBe('compile_error');
    expect(transcript(dir, 'host.v6__case4__strong__r1').turns[0].notice).toBeUndefined();
  });

  it('the report has a row per behaviour, v6 against v5, and demo examples with the instructor view', async () => {
    await runEval(options());
    const dir = path.join(tmp, 'out');
    const { report, demo, rows } = buildReports({ dir, armA: 'host.v5', armB: 'host.v6', prices: { inputPerMillion: 0.62, outputPerMillion: 1.85 } });
    expect(rows).toHaveLength(ROWS.length);
    ROWS.forEach((row) => expect(report).toContain(row.title));
    expect(report).toContain('Cost per interview');
    expect(report).toMatch(/Fake model/);
    const manipRow = rows.find((r) => r.row.id === 'manipCredited');
    expect(manipRow.b.total).toBeGreaterThan(0);
    expect(manipRow.b.bad).toBe(0); // every attempt of the manip profile is flagged by the engine check
    expect(rows.find((r) => r.row.id === 'falseFlag').b.bad).toBe(0);
    expect(demo).toContain('Code status banner');
    expect(demo).toMatch(/\*\*Flagged\*\*/);
    expect(demo).toContain('Run "the readings of the question"');
  });

  it('has a row for false manipulation flags on the strong, vague, wrong and idk profiles, and lists every flag with the student quote', async () => {
    await runEval(options({ profiles: 'strong,vague,wrong,idk,manip' }));
    const dir = path.join(tmp, 'out');
    const clean = buildReports({ dir, armA: 'host.v5', armB: 'host.v6', prices: { inputPerMillion: 0.62, outputPerMillion: 1.85 } });
    const row = clean.rows.find((r) => r.row.id === 'falseFlagsBase');
    expect(row.b.total).toBeGreaterThan(0);
    expect(row.b.bad).toBe(0); // no honest answer is flagged
    expect(row.a.bad).toBe(0); // host.v5 never flags
    expect(clean.demo).toContain('False manipulation flags: every flag on host.v6 (0%');
    expect(clean.demo).toContain('_No flags on these profiles._');
    // an attempt that sneaks into an honest profile (here: a wrongly flagged vague answer) shows up with its quote
    const file = path.join(dir, 'transcripts', 'host.v6__case4__vague__r1.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    const i = t.turns.findIndex((turn, n) => turn.role === 'student' && t.turns[n + 1] && t.turns[n + 1].role === 'host');
    t.turns[i + 1].manipulation = { kind: 'instruction', quote: 'a perfectly honest sentence', source: 'engine' };
    fs.writeFileSync(file, JSON.stringify(t));
    const flagged = buildReports({ dir, armA: 'host.v5', armB: 'host.v6', prices: { inputPerMillion: 0.62, outputPerMillion: 1.85 } });
    expect(flagged.rows.find((r) => r.row.id === 'falseFlagsBase').b.bad).toBe(1);
    expect(flagged.demo).toContain('"a perfectly honest sentence"');
    expect(flagged.demo).toMatch(/\| case4 \| vague \| 1 \| 1 \| instruction \| engine \|/);
    expect(flagged.report).toContain('False manipulation flags');
  });

  it('with --fake-model the runner defaults to the fake; without it the default is the real one', () => {
    expect(normalizeOptions({ fakeModel: true }).runner).toBe('fake');
    expect(normalizeOptions({ fakeModel: true, runner: 'real' }).runner).toBe('real');
  });
});
