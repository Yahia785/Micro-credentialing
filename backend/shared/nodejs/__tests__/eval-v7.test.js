// host.v7 in the evaluation: the prepare step runs synchronously with the arm's model and the runner of the run, the transcripts keep the
// analysis, and the report has the three arms side by side plus the code analysis rows. Fake model and fake runner: nothing reaches AWS.
jest.mock('../db/interviews', () => require('../../../scripts/eval/fake-stores').interviews);
jest.mock('../db/submissions', () => require('../../../scripts/eval/fake-stores').submissions);
jest.mock('../db/milestones', () => require('../../../scripts/eval/fake-stores').milestones);
jest.mock('../utils/logger', () => require('../../../scripts/eval/fake-stores').logger);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEval } = require('../../../scripts/eval/run-eval');
const { buildReports, ROWS, knownBugLine, coversLine } = require('../../../scripts/eval/v6-report');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-v7-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const options = (over = {}) => ({
  fakeModel: true, runner: 'fake', yes: true, log: () => {}, delayMs: 0, retryDelayMs: 0, fakeChaos: 0,
  prompts: 'host.v5,host.v6,host.v7', cases: 'case4,case5,case10', profiles: 'strong,vague,claims', repeats: 1, noPairs: true,
  out: path.join(tmp, 'out'), ...over,
});
const transcript = (name) => JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'transcripts', `${name}.json`), 'utf8'));
const PRICES = { inputPerMillion: 0.62, outputPerMillion: 1.85 };

describe('a run of host.v7 next to host.v6 and host.v5', () => {
  it('finishes every interview; only host.v7 has an analysis, and the prepare step is not part of the other arms', async () => {
    const result = await runEval(options());
    expect(result.failed || 0).toBe(0);

    const v7 = transcript('host.v7__case5__claims__r1');
    expect(v7.status).toBe('completed');
    expect(v7.analysis.status).toBe('ok');
    expect(v7.analysis.calls.map((c) => c.step)).toEqual(['plan', 'analysis']);
    expect(v7.analysis.runs.length).toBeGreaterThan(0);
    expect(v7.analysis.runs.every((r) => r.chosenBy === 'agent' && r.reason)).toBe(true);
    expect(typeof v7.prepareMs).toBe('number');
    // the bug finding cites a run that happened: its input is one of the runs, its output is in what that run printed
    const bug = v7.analysis.findings.find((f) => f.kind === 'bug');
    expect(bug).toBeTruthy();
    const ran = [...v7.analysis.runs, ...v7.turns.flatMap((t) => t.runs || [])].find((r) => r.stdin === bug.evidence.stdin);
    expect(ran.stdout).toContain(bug.evidence.output);

    ['host.v5', 'host.v6'].forEach((arm) => expect(transcript(`${arm}__case5__claims__r1`).analysis).toBeUndefined());
    // the instructor's runs are still there (host.v7 is the v6 family) and the unfinished sentence too
    expect(v7.turns[0].runs.map((r) => r.label)).toEqual(['the readings of the question', 'high level and max']);
    expect(transcript('host.v7__case10__strong__r1').turns[0].notice).toMatch(/not finished/);
    expect(transcript('host.v7__case10__strong__r1').analysis.findings.some((f) => f.kind === 'unfinished')).toBe(true);
  });

  it('correct code (case 4): no bug finding', async () => {
    await runEval(options());
    ['strong', 'vague', 'claims'].forEach((profile) => {
      expect(transcript(`host.v7__case4__${profile}__r1`).analysis.findings.filter((f) => f.kind === 'bug')).toEqual([]);
    });
  });

  it('the grader result the interview is given has every visible test in full and the hidden ones as pass or fail', async () => {
    await runEval(options({ prompts: 'host.v7', cases: 'case5', profiles: 'strong' }));
    const t = transcript('host.v7__case5__strong__r1');
    expect(t.codeStatus).toMatchObject({ compiles: true, total: 7, unfinished: false });
    expect(t.codeStatus.passed).toBeLessThan(7); // case 5 fails T1, T2 and T7
  });

  it('the report has a column per arm, the code analysis rows and table, and the cost of the prepare step', async () => {
    await runEval(options());
    const dir = path.join(tmp, 'out');
    const { report, demo, rows } = buildReports({ dir, arms: ['host.v5', 'host.v6', 'host.v7'], prices: PRICES });
    expect(rows).toHaveLength(ROWS.length);
    ROWS.forEach((row) => expect(report).toContain(row.title));
    expect(report).toContain('| Behaviour | host.v5 | host.v6 | host.v7 |');
    ['Known bug not found by the analysis', 'False findings on correct code', 'Follow-ups aimed at a finding', 'Contradiction not caught', 'Items shown only in a follow-up'].forEach((title) => expect(report).toContain(title));
    expect(report).toContain('## Code analysis (host.v7)');
    expect(report).toContain('### The prepare step of host.v7');
    expect(report).toMatch(/Model time, median \/ 95th percentile/);

    const byId = (id) => rows.find((r) => r.row.id === id);
    // only host.v7 analyzes the code
    expect(byId('bugMissed').byArm['host.v5'].total).toBe(0);
    expect(byId('bugMissed').byArm['host.v6'].total).toBe(0);
    expect(byId('bugMissed').byArm['host.v7']).toMatchObject({ total: 3, bad: 0 }); // case 5, three profiles, every one found
    expect(byId('falseFindings').byArm['host.v7']).toMatchObject({ total: 3, bad: 0 });
    expect(byId('unfinishedMissed').byArm['host.v7']).toMatchObject({ total: 3, bad: 0 });
    // v7 aims some follow-ups at findings; the other arms never do
    expect(byId('findingFollowUps').byArm['host.v7'].bad).toBeGreaterThan(0);
    expect(byId('findingFollowUps').byArm['host.v6'].total).toBe(0);

    // the demo shows the analysis panel and what each follow-up was aimed at
    expect(demo).toContain('**Code analysis**');
    expect(demo).toMatch(/Run chosen by the agent: input `[^`]+` \(a visible test failed on this input\)/);
    expect(demo).toMatch(/Follow-up aimed at finding f1/);
    expect(demo).toContain('Cost of the step: 2 calls');
  });

  it('two arms still work the old way (armA and armB)', async () => {
    await runEval(options({ prompts: 'host.v6,host.v5' }));
    const { report } = buildReports({ dir: path.join(tmp, 'out'), armA: 'host.v5', armB: 'host.v6', prices: PRICES });
    expect(report).toContain('| Behaviour | host.v5 | host.v6 |');
    expect(report).not.toContain('## Code analysis (host.v7)');
  });
});

describe('where the known bug is', () => {
  it('finds the line of each known bug, and "located" is within 3 lines', () => {
    ['case5', 'case6', 'case7', 'case8', 'case9'].forEach((id) => expect(knownBugLine(id)).toBeGreaterThan(0));
    const line = knownBugLine('case6');
    expect(coversLine({ lines: String(line) }, line)).toBe(true);
    expect(coversLine({ lines: `${line - 8}-${line - 4}` }, line)).toBe(false);
    expect(coversLine({ lines: `${line - 5}-${line - 2}` }, line)).toBe(true);
    expect(coversLine({ lines: null }, line)).toBe(false);
  });
});
