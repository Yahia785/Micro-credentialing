// plan-review.md: every plan in plain, readable form. Written under D:/a2-pilot-test, never inside the repo.
const q = (text) => '`' + String(text).replace(/`/g, "'") + '`';

const KIND_LABEL = {
  predict: 'predict', tracing: 'tracing', compileError: 'compile error', compileErrorOutside: 'compile error outside the functions', logic: 'logic', unaskable: 'no question',
};

function summarize(plans) {
  const withPlan = plans.filter((p) => !p.noPlan);
  const questions = withPlan.flatMap((p) => p.questions.map((x) => ({ plan: p, q: x })));
  const count = (fn) => questions.filter(fn).length;
  const kinds = {};
  for (const { q: x } of questions) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  const manual = questions.filter(({ q: x }) => x.typeChanged && /^needs manual/.test(x.typeChanged.reason));
  return {
    students: withPlan.length,
    formA: withPlan.filter((p) => p.form === 'A').length,
    formB: withPlan.filter((p) => p.form === 'B').length,
    withoutPlan: plans.filter((p) => p.noPlan),
    kinds,
    manual,
    typeChanged: count(({ q: x }) => x.typeChanged),
    overridden: count(({ q: x }) => x.overridden),
    withFollowUp: count(({ q: x }) => x.fixedFollowUp),
  };
}

function questionBlock(x) {
  const lines = [];
  const title = `${x.replaces ? `${x.function} replaces ${x.replaces}` : x.function}${x.replacedFunction ? ` (replaces the ${x.replacedFunction} question)` : ''}`;
  lines.push(`#### Question ${x.index}: ${title}, ${KIND_LABEL[x.kind]}${x.formType && x.kind !== x.formType ? ` (the form asks ${x.formType})` : ''}`, '');
  if (x.kind === 'unaskable') { lines.push(`No question: ${x.reason}`, ''); return lines; }
  lines.push(`> ${x.text}`, '');
  if (x.typeChanged) lines.push(`- Type changed from ${x.typeChanged.from} to ${x.typeChanged.to}: ${x.typeChanged.reason}`);
  if (x.kind === 'logic') {
    lines.push(`- Why a logic question: ${x.reason}`, '- Answer from their code: none (no run)', `- Answer key (spec answer): ${q(x.answerKey)}`);
  } else if (x.kind === 'compileError' || x.kind === 'compileErrorOutside') {
    lines.push(`- Line of their code: ${x.line}: ${q(x.lineText)}`, `- Answer key (the compiler message): ${q(x.answerKey)}`);
  } else {
    if (x.kind === 'tracing') lines.push(`- Line of their code: ${x.line}: ${q(x.lineText)}`, `- Traced: ${x.variables.map((v) => `${v.name} = ${q(v.expr)}`).join(', ')}; K = ${x.k} of ${x.totalStops} stops`);
    lines.push(`- Answer from their code: ${q(x.answer)}${x.kind === 'predict' && x.correct === false ? ' (differs from the spec answer)' : ''}`);
    if (x.kind === 'predict') lines.push(`- Spec answer: ${q(x.spec)}`);
    lines.push(`- Flags: targeted ${x.targeted ? `yes (${x.bug || 'bug'})` : `no (${x.selectionReason.replace(/^standard input: /, '')})`}${x.kind === 'tracing' ? `; trace differs from reference: ${x.traceDiffersFromReference ? 'yes' : 'no'}` : ''}${x.overridden ? '; override applied' : ''}`);
  }
  if (x.fixedFollowUp) lines.push('- Fixed follow-up (asked only after a correct main answer):', `  > ${x.fixedFollowUp.question}`, `  - Answer key: ${x.fixedFollowUp.answerKey}`);
  else if (x.kind !== 'unaskable') lines.push('- Fixed follow-up: none for this kind of question');
  lines.push('');
  return lines;
}

function renderReview(plans, { records = {} } = {}) {
  const s = summarize(plans);
  const md = ['# A2 plan review', '', '## Summary', ''];
  md.push(`- Students with a plan: ${s.students} (form A: ${s.formA}, form B: ${s.formB}). Without a plan: ${s.withoutPlan.length}${s.withoutPlan.length ? ` (${s.withoutPlan.map((p) => `${p.githubUsername}: ${p.noPlan}`).join('; ')})` : ''}.`);
  md.push(`- Questions by type: ${Object.entries(s.kinds).map(([k, n]) => `${KIND_LABEL[k]} ${n}`).join(', ') || 'none'}.`);
  md.push(`- Breakpoint lines that needed manual: ${s.manual.length}${s.manual.length ? ` (${s.manual.map(({ plan, q: x }) => `${plan.githubUsername} ${x.function}`).join(', ')})` : ''}. Type changed (tracing to predict): ${s.typeChanged}. Overrides applied: ${s.overridden}.`);
  md.push(`- Fixed follow-ups attached: ${s.withFollowUp} (predict and tracing questions); compile-error and logic questions have none.`, '');
  for (const p of plans) {
    md.push(`## ${p.githubUsername}: form ${p.form || '-'}, status ${p.status}`, '');
    if (p.noPlan) { md.push(`No plan: ${p.noPlan}`, ''); continue; }
    const rec = records[p.importId];
    if (rec) md.push(`Commit ${String(rec.commitHash).slice(0, 7)}; header used: ${rec.headerUsed || '-'}.`, '');
    if (p.notes.length) md.push(...p.notes.map((n) => `- Note: ${n}`), '');
    for (const x of p.questions) md.push(...questionBlock(x));
  }
  return `${md.join('\n')}\n`;
}

module.exports = { renderReview, summarize };
