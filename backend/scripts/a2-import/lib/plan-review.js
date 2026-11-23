// plan-review.md (version 3): every plan in plain, readable form. Written under D:/a2-pilot-test, never inside the repo.
const q = (text) => '`' + String(text).replace(/`/g, "'") + '`';
const PRIMARY_FUNCTIONS = ['reverseList', 'splitString', 'playCraps', 'mode'];

const CASE_TITLES = {
  case1: 'Case 1: logic answer right, their code right',
  case2: 'Case 2: logic answer right, their code wrong',
  case3: 'Case 3: logic answer wrong, their code right',
  case4: 'Case 4: logic answer wrong, their code wrong',
};

const logicQuestions = (plans) => plans.filter((p) => !p.noPlan).flatMap((p) => p.questions.filter((x) => x.kind === 'logic').map((x) => ({ plan: p, q: x })));

function summarize(plans) {
  const withPlan = plans.filter((p) => !p.noPlan);
  const logic = logicQuestions(plans);
  const withCases = logic.filter(({ q: x }) => x.cases);
  const codeRight = {};
  for (const fn of PRIMARY_FUNCTIONS) {
    const list = withCases.filter(({ q: x }) => x.function === fn);
    if (list.length) codeRight[fn] = { right: list.filter(({ q: x }) => x.codeRight === true).length, wrong: list.filter(({ q: x }) => x.codeRight === false).length, unknown: list.filter(({ q: x }) => x.codeRight === null).length };
  }
  const rotation = { predict: 0, tracing: 0, changed: 0 };
  const whatIf = { prepared: [], skipped: [] };
  for (const { plan, q: x } of withCases) {
    const c1 = x.cases.case1;
    if (!c1.available) continue;
    if (c1.followUp1.typeChanged) rotation.changed += 1;
    if (c1.followUp1.type) rotation[c1.followUp1.type] = (rotation[c1.followUp1.type] || 0) + 1;
    if (c1.followUp2 && c1.followUp2.type === 'whatIf') whatIf.prepared.push({ plan, q: x });
    else whatIf.skipped.push({ plan, q: x, reason: (c1.followUp2 && c1.followUp2.whatIfSkipped) || 'unknown' });
  }
  const compile = {
    byStatus: withPlan.reduce((acc, p) => ({ ...acc, [p.status]: (acc[p.status] || 0) + 1 }), {}),
    compileErrorQuestions: withPlan.flatMap((p) => p.questions).filter((x) => x.kind === 'compileError' || x.kind === 'compileErrorOutside').length,
    noFollowUps: logic.filter(({ q: x }) => !x.cases).length,
  };
  const mismatchedUnavailable = [];
  for (const { plan, q: x } of withCases) {
    for (const [name, c] of Object.entries(x.cases)) {
      for (const key of ['followUp1', 'followUp2']) {
        const f = c[key];
        if (c.available && f && f.unavailable) mismatchedUnavailable.push(`${plan.githubUsername} ${x.function} ${name} ${key}: ${f.unavailable}`);
      }
    }
  }
  return { students: withPlan.length, formA: withPlan.filter((p) => p.form === 'A').length, formB: withPlan.filter((p) => p.form === 'B').length, withoutPlan: plans.filter((p) => p.noPlan), codeRight, rotation, whatIf, compile, unavailable: mismatchedUnavailable };
}

/** One follow-up exactly as the student would see it, with the expected answer and what kind of answer it is. */
function followUpLines(label, f) {
  if (!f) return [`- ${label}: none`];
  if (f.unavailable) return [`- ${label} (${f.type}): not available: ${f.unavailable}`];
  const out = [];
  if (f.type === 'smallStep') {
    out.push(`- ${label}: a smaller code step, written by the agent in M5b (code answer). Private material, never shown to the student:`);
    const m = f.material;
    if (!m.available) out.push(`  - No material: ${m.reason}`);
    else {
      out.push(`  - Main input ${m.input.display}; breakpoint line ${m.line}: ${q(m.lineText)}`);
      out.push(`  - Their variables (real names): ${m.variables.map((v) => `${v.name} = ${q(v.expr)}`).join(', ')}`);
      m.stops.forEach((s, i) => out.push(`  - Stop ${i + 1}: ${q(s)}`));
    }
    return out;
  }
  out.push(`- ${label} (${f.type}${f.typeChanged ? `, changed from ${f.typeChanged.from}: ${f.typeChanged.reason}` : ''}):`, `  > ${f.text}`);
  if (f.type === 'tracing') out.push(`  - Line ${f.line}: ${q(f.lineText)}; traced ${f.variables.map((v) => `${v.name} = ${q(v.expr)}`).join(', ')}; K = ${f.k} of ${f.totalStops} stops; trace differs from reference: ${f.traceDiffersFromReference ? 'yes' : 'no'}${f.overridden ? '; override applied' : ''}`);
  if (f.type === 'whatIf') out.push(`  - Line ${f.line}: ${q(f.oldLine)} becomes ${q(f.newLine)} (their output before the change: ${q(f.theirOutputBeforeTheChange)})`);
  if (f.type === 'debug') out.push(`  - Shows their output ${q(f.theirOutput)} and the spec answer ${q(f.specAnswer)}${f.targeted ? ` (targeted input, ${f.bug || 'bug'})` : ''}`);
  if (f.type === 'change') out.push('  - Expected: a line of their code and a change that fixes it (judged against the line the debug question found).');
  if (f.answer !== undefined && f.answer !== null) out.push(`  - Expected answer (${f.answerType} answer, from their code${f.answerBasis ? `: ${f.answerBasis}` : ''}): ${q(f.answer)}`);
  if (f.type === 'smallLogic') out.push(`  - Expected answer (logic answer, the spec): ${q(f.answerKey)}`);
  if (f.whatIfSkipped) out.push(`  - No what-if because: ${f.whatIfSkipped}`);
  return out;
}

function questionBlock(x) {
  const lines = [];
  const title = `${x.replaces ? `${x.function} replaces ${x.replaces}` : x.function}${x.replacedFunction ? ` (replaces the ${x.replacedFunction} question)` : ''}`;
  if (x.kind === 'unaskable') { lines.push(`#### Question ${x.index}: ${title}, no question`, '', `No question: ${x.reason}`, ''); return lines; }
  if (x.kind === 'compileError' || x.kind === 'compileErrorOutside') {
    lines.push(`#### Question ${x.index}: ${title}, compile error`, '', `> ${x.text}`, '', `- Line of their code: ${x.line}: ${q(x.lineText)}`, `- Answer key (the compiler message; a fix on the line just before also counts): ${q(x.answerKey)}`, '- No follow-ups for a compile-error question.', '');
    return lines;
  }
  lines.push(`#### Question ${x.index}: ${title}, logic (the main question)${x.reason ? '' : ''}`, '', `> ${x.text}`, '');
  lines.push(`- Expected answer (logic answer, the spec): ${q(x.answerKey)}`);
  lines.push(`- If the answer is unclear, once and not counted as a follow-up: > ${x.clarify}`);
  if (!x.cases) { lines.push(`- No follow-ups: ${x.note}`, ''); return lines; }
  const right = x.codeRight === true ? `yes (the spec answer on all ${x.codeRightChecked} safe inputs)` : x.codeRight === false ? `no (differs on ${x.codeRightFailing.length} of ${x.codeRightChecked} safe inputs: ${x.codeRightFailing.map(q).join(', ')})` : 'unknown (no input ran cleanly)';
  lines.push(`- Their code is right for ${x.function}: ${right}`, '');
  for (const key of ['case1', 'case2', 'case3', 'case4']) {
    const c = x.cases[key];
    lines.push(`**${CASE_TITLES[key]}**`, '');
    if (!c.available) { lines.push(`Not possible for this student: ${c.reason}`, ''); continue; }
    lines.push(...followUpLines('Follow-up 1', c.followUp1), ...followUpLines('Follow-up 2', c.followUp2), '');
  }
  return lines;
}

function renderReview(plans, { records = {} } = {}) {
  const s = summarize(plans);
  const md = ['# A2 plan review (version 3, the case design)', '', '## Summary', ''];
  md.push(`- Students with a plan: ${s.students} (rotation A: ${s.formA}, B: ${s.formB}). Without a plan: ${s.withoutPlan.length}${s.withoutPlan.length ? ` (${s.withoutPlan.map((p) => `${p.githubUsername}: ${p.noPlan}`).join('; ')})` : ''}.`);
  md.push(`- "Their code is right" per function (logic questions that have follow-ups): ${Object.entries(s.codeRight).map(([fn, c]) => `${fn} right ${c.right}, wrong ${c.wrong}${c.unknown ? `, unknown ${c.unknown}` : ''}`).join('; ') || 'none'}.`);
  md.push(`- Case 1 follow-up 1 types (rotation): predict ${s.rotation.predict}, tracing ${s.rotation.tracing}${s.rotation.changed ? `; ${s.rotation.changed} changed from tracing to predict because the breakpoint line needs a person` : ''}.`);
  md.push(`- What-ifs: ${s.whatIf.prepared.length} prepared, ${s.whatIf.skipped.length} skipped${s.whatIf.skipped.length ? ` (${s.whatIf.skipped.map(({ plan, q: x, reason }) => `${plan.githubUsername} ${x.function}: ${reason}`).join('; ')})` : ''}.`);
  md.push(`- Compile groups: ${Object.entries(s.compile.byStatus).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}. Compile-error questions: ${s.compile.compileErrorQuestions}. Logic questions with no follow-ups (no code to ask about): ${s.compile.noFollowUps}.`);
  md.push(`- Follow-ups that could not be prepared: ${s.unavailable.length}${s.unavailable.length ? `: ${s.unavailable.join('; ')}` : ''}.`, '');
  for (const p of plans) {
    md.push(`## ${p.githubUsername}: rotation ${p.form || '-'}, status ${p.status}`, '');
    if (p.noPlan) { md.push(`No plan: ${p.noPlan}`, ''); continue; }
    const rec = records[p.importId];
    if (rec) md.push(`Commit ${String(rec.commitHash).slice(0, 7)}; header used: ${rec.headerUsed || '-'}.`, '');
    if (p.notes.length) md.push(...p.notes.map((n) => `- Note: ${n}`), '');
    for (const x of p.questions) md.push(...questionBlock(x));
  }
  return `${md.join('\n')}\n`;
}

module.exports = { renderReview, summarize };
