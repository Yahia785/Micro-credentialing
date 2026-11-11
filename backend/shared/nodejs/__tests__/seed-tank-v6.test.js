// The tank seed script: the runs for Q1 and Q3, --prompt and --update. Dry only: nothing is written anywhere.
const { buildPlan, parseArgs, buildInterview } = require('../../../scripts/seed-tank-assessment');

describe('seed-tank-assessment with host.v6 runs', () => {
  it('keeps the host.v5 default and the runs for Q1 (trace) and Q3 (invalid reading) only', () => {
    const { milestone } = buildPlan();
    expect(milestone.interview.promptVersion).toBe('host.v5');
    const runs = milestone.interview.themes.map((theme) => theme.runs && theme.runs[0].map((r) => r.label));
    expect(runs[0]).toEqual(['the readings of the question', 'high level and max']);
    expect(runs[1]).toBeUndefined();
    expect(runs[2]).toEqual(['invalid reading while FILLING, then valid ones', 'reading above max']);
    expect(runs[3]).toBeUndefined();
    expect(runs[4]).toBeUndefined();
    expect(milestone.interview.themes[2].runs[0][0].stdin).toBe('20 80 100 10 -5 50 10');
  });

  it('--prompt sets host.v6 or host.v5 on the interview and refuses an unknown version', () => {
    expect(parseArgs(['--prompt', 'host.v6']).prompt).toBe('host.v6');
    expect(buildPlan({ promptVersion: 'host.v6' }).milestone.interview.promptVersion).toBe('host.v6');
    expect(buildInterview(undefined, 'host.v5').promptVersion).toBe('host.v5');
    expect(() => buildPlan({ promptVersion: 'host.v9' })).toThrow(/promptVersion must be one of/);
    expect(() => parseArgs(['--prompt'])).toThrow(/needs a value/);
  });

  it('--update is a flag; the rubric is still in the interview next to the runs', () => {
    expect(parseArgs(['--update', '--yes'])).toMatchObject({ update: true, yes: true });
    const theme = buildPlan({ promptVersion: 'host.v6' }).milestone.interview.themes[0];
    expect(theme.rubric[0]).toHaveLength(3);
    expect(theme.runs[0]).toHaveLength(2);
  });
});
