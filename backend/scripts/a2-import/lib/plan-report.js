// What plan.js says about every record it read: one outcome per record, and a summary that names each record that got no plan and why.
// Nothing is skipped silently: a record that was read but has no outcome is reported as "not processed".

/** The outcome of one record: planned, no plan (with the plan's own reason), or not selected by --only. */
function outcomeFor(record, plan, { selected = true, written = false } = {}) {
  const who = { importId: record.importId, githubUsername: record.githubUsername, status: record.status };
  if (!selected) return { ...who, result: 'skipped', reason: 'not selected (--only)' };
  if (!plan) return { ...who, result: 'skipped', reason: 'not processed' };
  if (plan.noPlan) return { ...who, result: 'skipped', reason: plan.noPlan };
  return { ...who, result: 'planned', form: plan.form, questions: plan.questions.length, written };
}

/** Lines for the end of the run. `records` is everything read; `outcomes` what was done with each. */
function summaryLines(records, outcomes) {
  const byId = new Map(outcomes.map((o) => [o.importId, o]));
  const all = records.map((r) => byId.get(r.importId) || outcomeFor(r, null));
  const planned = all.filter((o) => o.result === 'planned');
  const skipped = all.filter((o) => o.result === 'skipped');
  return [
    `${records.length} records read: ${planned.length} planned, ${skipped.length} skipped.`,
    ...skipped.map((o) => `  skipped ${o.githubUsername} (${o.status}): ${o.reason}`),
  ];
}

module.exports = { outcomeFor, summaryLines };
