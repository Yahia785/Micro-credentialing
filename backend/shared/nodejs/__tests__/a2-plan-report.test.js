// plan.js never skips a record silently: every record read gets an outcome, and the summary names each one without a plan and why.
const { outcomeFor, summaryLines } = require('../../../scripts/a2-import/lib/plan-report');

const rec = (n, status = 'ok', headerUsed = 'student') => ({ importId: `id-${n}`, githubUsername: `fakeuser${n}`, status, headerUsed });
const plan = (n) => ({ importId: `id-${n}`, form: 'A', questions: [1, 2, 3] });

describe('plan report', () => {
  const records = [rec('03'), rec('04', 'ok', 'official'), rec('06', 'no_version_before_deadline')];

  it('counts a record that built its plan as planned, whatever header it used', () => {
    expect(outcomeFor(records[1], plan('04'), { written: true })).toMatchObject({ result: 'planned', form: 'A', questions: 3, written: true });
  });

  it('names a record without a plan and the plan\'s own reason', () => {
    const o = outcomeFor(records[2], { noPlan: 'status no_version_before_deadline: there is no code to ask about' });
    expect(o).toMatchObject({ result: 'skipped', reason: 'status no_version_before_deadline: there is no code to ask about' });
  });

  it('lists every record read: planned ones are counted, skipped ones are named with a reason', () => {
    const outcomes = [outcomeFor(records[0], plan('03')), outcomeFor(records[1], plan('04')), outcomeFor(records[2], { noPlan: 'no code' })];
    expect(summaryLines(records, outcomes)).toEqual(['3 records read: 2 planned, 1 skipped.', '  skipped fakeuser06 (no_version_before_deadline): no code']);
  });

  it('reports a record that was read but never processed instead of dropping it', () => {
    const lines = summaryLines(records, [outcomeFor(records[0], plan('03'))]);
    expect(lines[0]).toBe('3 records read: 1 planned, 2 skipped.');
    expect(lines).toContain('  skipped fakeuser04 (ok): not processed');
  });

  it('reports records left out by --only', () => {
    const lines = summaryLines(records, [outcomeFor(records[0], null, { selected: false }), outcomeFor(records[1], plan('04')), outcomeFor(records[2], null, { selected: false })]);
    expect(lines).toEqual(['3 records read: 1 planned, 2 skipped.', '  skipped fakeuser03 (ok): not selected (--only)', '  skipped fakeuser06 (no_version_before_deadline): not selected (--only)']);
  });
});
