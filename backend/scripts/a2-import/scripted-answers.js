#!/usr/bin/env node
// Writes the SCRIPTED ANSWERS for the fake students: what a student would type at each step of the interview, with the check result the
// engine should give and what should be asked next. They are for a person to read first; nothing here runs them through anything.
//
//   node scripts/a2-import/scripted-answers.js [--plans D:/a2-pilot-test/plans] [--out D:/a2-pilot-test/scripted]
//
// Reads the plans (plan.js) and writes scripted-answers.md and scripted-answers.json to --out. Both hold the fake students' own code
// answers, so they are written OUTSIDE the repo only (the script refuses a folder inside it).
//
// Coverage: for every function, each case (1 to 4) that the fake students' code allows gets at least two scripted paths, and the unclear
// path (a vague answer, then "Can you give the exact result?") at least two. A path is one main answer and the follow-ups that follow it.
// Case 1 and 3 need a student whose code is right for that function; cases 2 and 4 one whose code is wrong.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BASE = process.platform === 'win32' ? 'D:/a2-pilot-test' : path.join(os.tmpdir(), 'a2-pilot-test');
const A2 = path.join(__dirname, '..', 'eval', 'a2');
const insideRepo = (p) => { const rel = path.relative(REPO_ROOT, path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

// ---- what a student might type ----------------------------------------------------------------------------------------------------

/** The main logic answer in three formats (right) and the wrong ones, per function. `key` is the plan's answer key. */
const LOGIC = {
  reverseList: {
    right: (key) => [key, `It needs ${key} swaps: the outer pair and then the next pair`, `${key} I think`],
    wrong: () => ['5', 'I would say 4 swaps, one for every element but the last', '3'],
    unclear: ['A few, it depends on how the loop is written', 'Not sure, maybe half of them'],
  },
  splitString: {
    right: (key) => [key, `It returns four pieces: empty, a, empty, b`, `[ ${key.replace(/", "/g, '" , "')} ]`],
    wrong: () => ['"a", "b"', 'Just two pieces, a and b, because the empty ones are skipped', '"", "a", "b"'],
    unclear: ['A list with the letters in it, not sure about the empty ones', 'It splits it at the commas'],
  },
  playCraps: {
    right: (key) => [key, `It returns ${key}, the house wins on the 7`, `${key}, i think`],
    wrong: () => ['0', 'The player wins right away so 0', '2'],
    unclear: ['Somebody wins at some point', 'It depends on the point number'],
  },
  mode: {
    right: (key) => [key, `${key}, the tie goes to the smaller number`, `it's ${key}`],
    wrong: () => ['5', 'The mode is 9', '5 and 2'],
    unclear: ['5 or 2, they appear equally often', 'Not sure about the tie'],
  },
};

const bigger = (text) => {
  const t = String(text);
  if (/-?\d+/.test(t)) return t.replace(/-?\d+/, (n) => String(Number(n) + 1));
  if (/"[^",]/.test(t)) return t.replace(/"([^",])/, '"x');
  if (t.includes('""')) return t.replace('""', '"x"');
  return t === '[]' ? '[0]' : `${t}x`;
};

/** A code answer (predict output, a trace stop "name=value, ...", a what-if output) in three formats. */
function codeFormats(answer) {
  const a = String(answer);
  const stop = a.split(/,\s*(?=[^,=]+=)/).map((p) => ({ name: p.slice(0, p.indexOf('=')), value: p.slice(p.indexOf('=') + 1) }));
  if (stop.length && a.includes('=') && !/^[\[{]/.test(a)) {
    // an empty string is typed as "" (an empty answer is not an answer)
    const values = stop.map((s) => s.value.replace(/^"|"$/g, '') || '""');
    return [values.join(' and '), stop.map((s) => `${s.name} is ${s.value.replace(/^"|"$/g, '') || '""'}`).join(', '), a];
  }
  return [a, `It gives ${a}`, a.replace(/[\[\]{}]/g, '').replace(/,\s*/g, ' ')];
}
/** The first variable of a stop ("left number=1, right number=5" gives "left number=1"): the scripted answers to a smaller code step are about ONE variable at the first stop. */
const firstPair = (stop) => String(stop).split(/,\s*(?=[^,=]+=)/)[0];
/** A wrong answer to a smaller logic question: the key made different (a number one more; a list without its empty pieces). */
function wrongLogic(key, variant) {
  const k = String(key);
  const wrong = /^-?\d+$/.test(k.trim()) ? String(Number(k) + 1) : (k.match(/"([^"]+)"/g) || []).join(', ') || 'nothing';
  return variant % 3 === 1 ? `I think it is ${wrong}` : wrong;
}
const wrongCode = (answer) => codeFormats(bigger(answer))[0];

// ---- the scripted paths ------------------------------------------------------------------------------------------------------------

const caseOf = (q, logicRight) => (q.codeRight === true ? (logicRight ? 1 : 3) : (logicRight ? 2 : 4));

/** What is expected to be asked after the main answer, by case (the text exactly as the student would see it). */
function nextAfterMain(q, c) {
  const co = q.cases[`case${c}`];
  if (!co || !co.available) return { text: null, note: `case ${c} is not prepared for this student` };
  const f = co.followUp1;
  return { text: f.text || null, note: f.unavailable ? `not available: ${f.unavailable}` : null, f };
}

/** The follow-up steps of one case, each with a right (`good`) or wrong answer. */
function followUpSteps(q, c, good, variant) {
  const co = q.cases[`case${c}`];
  const steps = [];
  const f1 = co.followUp1;
  const f2 = co.followUp2;
  const pick = (answer) => codeFormats(answer)[variant % 3];
  const bug = (f) => (f && f.bug) || null;
  const bugText = (b) => {
    if (!b) return null;
    const dir = fs.readdirSync(path.join(A2, 'variants')).find((d) => d.startsWith(`${b}-`));
    if (!dir) return null;
    const meta = JSON.parse(fs.readFileSync(path.join(A2, 'variants', dir, 'meta.json'), 'utf8'));
    return meta.bugs && meta.bugs[0] ? meta.bugs[0].description : null;
  };

  if (c === 1) {
    if (f1 && f1.text) steps.push({ asks: f1.text, kind: f1.type, answer: good ? pick(f1.answer) : wrongCode(f1.answer), expected: good ? 'correct' : 'wrong', answerType: 'code', key: f1.answer });
    if (f2 && f2.text) steps.push({ asks: f2.text, kind: f2.type, answer: good ? pick(f2.answer) : (f2.type === 'whatIf' ? 'It would stay the same' : wrongCode(f2.answer)), expected: good ? 'correct' : 'wrong', answerType: 'code', key: f2.answer });
  } else if (c === 2) {
    const why = bugText(bug(f1));
    steps.push({ asks: f1.text, kind: 'debug', answer: good ? `Because ${why ? why.charAt(0).toLowerCase() + why.slice(1) : 'of a mistake in my code that I can see once I read it again'}` : 'I think the compiler or the test is wrong, my code looks fine', expected: good ? 'correct' : 'wrong', answerType: 'code', key: `explains why their code gives ${f1.theirOutput} (the bug${why ? `: ${why}` : ''})` });
    steps.push({ asks: f2.text, kind: 'change', answer: good ? `I would fix it: ${why ? why.charAt(0).toLowerCase() + why.slice(1) : 'the line that causes the wrong result'}` : 'The first line of the function, I would add a check there', expected: good ? 'correct' : 'wrong', answerType: 'code', key: 'the line that causes the difference, and a change that fixes it' });
  } else if (c === 3) {
    if (f1 && f1.text) steps.push({ asks: f1.text, kind: 'predict', answer: good ? pick(f1.answer) : wrongCode(f1.answer), expected: good ? 'correct' : 'wrong', answerType: 'code', key: f1.answer });
    const m = f2.material;
    if (m && m.available) steps.push({ asks: `(a smaller code step written by the agent in M5b, about line ${m.line} on ${m.input.display})`, kind: 'smallStep', answer: good ? pick(firstPair(m.stops[0])) : wrongCode(firstPair(m.stops[0])), expected: good ? 'correct' : 'wrong', answerType: 'code', key: firstPair(m.stops[0]) });
  } else {
    steps.push({ asks: f1.text, kind: 'smallLogic', answer: good ? LOGIC[q.function].right(f1.answerKey)[variant % 3] : wrongLogic(f1.answerKey, variant), expected: good ? 'correct' : 'wrong', answerType: 'logic', key: f1.answerKey });
    const m = f2.material;
    if (m && m.available) steps.push({ asks: `(a smaller code step written by the agent in M5b, about line ${m.line} on ${m.input.display})`, kind: 'smallStep', answer: good ? pick(firstPair(m.stops[0])) : wrongCode(firstPair(m.stops[0])), expected: good ? 'correct' : 'wrong', answerType: 'code', key: firstPair(m.stops[0]) });
  }
  return steps;
}

/** The paths of one student and function: [{ id, label, case, steps: [...] }]. A step is { asks, answer, expected, answerType, key, next }. */
function pathsFor(plan, q, wanted) {
  const out = [];
  const fn = q.function;
  const L = LOGIC[fn];
  wanted.forEach(({ kind, logicRight, variant, goodFollowUps }, n) => {
    const id = `${plan.githubUsername}/${fn}/${n + 1}`;
    const steps = [];
    if (kind === 'unclear') {
      const vague = L.unclear[variant % 2];
      steps.push({ asks: q.text, answer: vague, expected: 'unclear', answerType: 'logic', key: q.answerKey, next: q.clarify, note: 'asked once, not counted as a follow-up' });
      const exact = logicRight ? L.right(q.answerKey)[variant % 3] : L.wrong()[variant % 3];
      const c = caseOf(q, logicRight);
      steps.push({ asks: q.clarify, answer: exact, expected: logicRight ? 'correct' : 'wrong', answerType: 'logic', key: q.answerKey, case: c, next: nextAfterMain(q, c).text || nextAfterMain(q, c).note });
      followUpSteps(q, c, goodFollowUps, variant).forEach((s) => steps.push(s));
      out.push({ id, label: `unclear, then ${logicRight ? 'right' : 'wrong'}`, case: c, unclear: true, steps });
      return;
    }
    const c = caseOf(q, logicRight);
    const answer = logicRight ? L.right(q.answerKey)[variant % 3] : L.wrong()[variant % 3];
    steps.push({ asks: q.text, answer, expected: logicRight ? 'correct' : 'wrong', answerType: 'logic', key: q.answerKey, case: c, next: nextAfterMain(q, c).text || nextAfterMain(q, c).note });
    followUpSteps(q, c, goodFollowUps, variant).forEach((s) => steps.push(s));
    out.push({ id, label: `logic ${logicRight ? 'right' : 'wrong'}, follow-ups ${goodFollowUps ? 'right' : 'wrong'}`, case: c, unclear: false, steps });
  });
  return out;
}

/** The compile-error and the logic-only questions: one scripted path each, right for the first and wrong for the others. */
function simplePath(plan, q, right) {
  const id = `${plan.githubUsername}/${q.function}/compile`;
  if (q.kind === 'logic') {
    const L = LOGIC[q.function];
    return { id, label: 'logic only, no follow-ups (no code to ask about)', case: null, unclear: false, steps: [{ asks: q.text, answer: right ? L.right(q.answerKey)[0] : L.wrong()[0], expected: right ? 'correct' : 'wrong', answerType: 'logic', key: q.answerKey, next: 'nothing: the interview moves to the next function' }] };
  }
  return {
    id, label: `compile error, answer ${right ? 'right' : 'wrong'}, no follow-ups`, case: null, unclear: false,
    steps: [{ asks: q.text, answer: right ? `The compiler says "${q.answerKey}" on that line, so I forgot something there. I would fix that one line.` : 'I think the function name is spelled wrong, I would rename it', expected: right ? 'correct' : 'wrong', answerType: 'compile', key: `${q.answerKey} (a fix on the line before also counts)`, next: 'nothing: the interview moves to the next function' }],
  };
}

/**
 * Choose the paths so that every reachable case and the unclear path appear at least twice per function, spreading them over the students.
 * Returns Map "student|function" -> wanted list.
 */
function assign(plans) {
  const wanted = new Map();
  const load = new Map();
  const add = (plan, q, spec) => { const k = `${plan.githubUsername}|${q.function}|${q.index}`; wanted.set(k, [...(wanted.get(k) || []), spec]); load.set(plan.githubUsername, (load.get(plan.githubUsername) || 0) + 1); };
  const logicQs = plans.flatMap((p) => p.questions.filter((q) => q.kind === 'logic' && q.cases).map((q) => ({ plan: p, q })));
  const functions = [...new Set(logicQs.map(({ q }) => q.function))];
  for (const fn of functions) {
    const list = logicQs.filter(({ q }) => q.function === fn);
    const byLoad = (items) => [...items].sort((a, b) => (load.get(a.plan.githubUsername) || 0) - (load.get(b.plan.githubUsername) || 0));
    for (const c of [1, 2, 3, 4]) {
      const reachable = list.filter(({ q }) => q.cases[`case${c}`].available && caseOf(q, c === 1 || c === 2) === c);
      if (reachable.length === 0) continue;
      const chosen = byLoad(reachable).slice(0, 2);
      // two paths: with one student, the same student twice with different formats and different follow-up answers
      [0, 1].forEach((i) => { const { plan, q } = chosen[i] || chosen[0]; add(plan, q, { kind: 'main', logicRight: c === 1 || c === 2, variant: i, goodFollowUps: i === 0 }); });
    }
    // unclear: one that ends right and one that ends wrong, on the students with the least so far
    const few = byLoad(list);
    [0, 1].forEach((i) => { const { plan, q } = few[i] || few[0]; add(plan, q, { kind: 'unclear', logicRight: i === 0, variant: i, goodFollowUps: i === 1 }); });
  }
  return wanted;
}

function build(plans) {
  const wanted = assign(plans);
  const out = [];
  let simpleRight = true;
  for (const plan of plans) {
    if (plan.noPlan) continue;
    const student = { student: plan.githubUsername, rotation: plan.form, status: plan.status, functions: [] };
    for (const q of plan.questions) {
      if (q.kind === 'unaskable') continue;
      const key = `${plan.githubUsername}|${q.function}|${q.index}`;
      let paths;
      if (q.kind === 'logic' && q.cases) paths = pathsFor(plan, q, wanted.get(key) || []);
      else { paths = [simplePath(plan, q, simpleRight)]; simpleRight = !simpleRight; }
      student.functions.push({ function: q.function, replaces: q.replaces || null, kind: q.kind, codeRight: q.codeRight === undefined ? null : q.codeRight, question: q.text, key: q.answerKey, paths });
    }
    out.push(student);
  }
  return out;
}

function coverage(students) {
  const table = {};
  for (const s of students) for (const f of s.functions) for (const p of f.paths) {
    const row = table[f.function] || (table[f.function] = { 1: 0, 2: 0, 3: 0, 4: 0, unclear: 0, compile: 0, logicOnly: 0 });
    if (p.unclear) row.unclear += 1;
    else if (p.case) row[p.case] += 1;
    else if (f.kind === 'logic') row.logicOnly += 1; else row.compile += 1;
  }
  return table;
}

const cell = (text) => String(text === undefined || text === null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function render(students) {
  const md = ['# A2 scripted answers (for a person to read; nothing here has been run)', '', 'Each path is one main answer and what follows it. "Expected check" is what the engine should decide about the answer. "Asks next" is the question the student should be given after it. Answers are typed the way a student might: a plain value, a sentence, a bit messy.', ''];
  const cov = coverage(students);
  md.push('## Coverage: scripted paths per case and function', '', '| function | case 1 (logic right, code right) | case 2 (logic right, code wrong) | case 3 (logic wrong, code right) | case 4 (logic wrong, code wrong) | unclear answer | compile-error | logic only |', '|---|---|---|---|---|---|---|---|');
  for (const [fn, r] of Object.entries(cov)) md.push(`| ${fn} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} | ${r.unclear} | ${r.compile} | ${r.logicOnly} |`);
  md.push('', 'A case that is missing for a function has no fake student whose code allows it (cases 1 and 3 need code that is right for that function; 2 and 4 code that is wrong).', '');
  for (const s of students) {
    md.push(`## ${s.student} (rotation ${s.rotation}, status ${s.status})`, '');
    for (const f of s.functions) {
      md.push(`### ${f.function}${f.replaces ? ` (replaces ${f.replaces})` : ''}: ${f.kind === 'logic' ? `their code is ${f.codeRight === true ? 'right' : f.codeRight === false ? 'wrong' : 'not checked'}` : f.kind}`, '');
      for (const p of f.paths) {
        md.push(`**Path ${p.id}: ${p.label}${p.case ? ` (case ${p.case})` : ''}**`, '', '| # | asked | typed answer | answer type | expected check | expected answer | asks next |', '|---|---|---|---|---|---|---|');
        p.steps.forEach((st, i) => md.push(`| ${i + 1} | ${cell(st.asks)} | ${cell(st.answer)} | ${st.answerType} | ${st.expected}${st.case ? ` (then case ${st.case})` : ''} | ${cell(st.key)} | ${cell(st.next || (p.steps[i + 1] ? p.steps[i + 1].asks : 'nothing: the interview moves to the next function'))} |`));
        md.push('');
      }
    }
  }
  return `${md.join('\n')}\n`;
}

function main() {
  const args = { plans: `${BASE}/plans`, out: `${BASE}/scripted` };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) { if (argv[i] === '--plans' || argv[i] === '--out') { args[argv[i].slice(2)] = argv[i + 1]; i += 1; } else throw new Error(`unknown argument ${argv[i]}`); }
  if (insideRepo(args.out) || insideRepo(args.plans)) throw new Error('the plans and the scripted answers must be outside the repo folder (the repo is public)');
  const plans = fs.readdirSync(args.plans).filter((f) => f.endsWith('.json') && f !== 'reference.json' && f !== 'overrides.json').map((f) => JSON.parse(fs.readFileSync(path.join(args.plans, f), 'utf8'))).sort((a, b) => (a.githubUsername < b.githubUsername ? -1 : 1));
  const students = build(plans);
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'scripted-answers.md'), render(students));
  fs.writeFileSync(path.join(args.out, 'scripted-answers.json'), `${JSON.stringify({ coverage: coverage(students), students }, null, 2)}\n`);
  console.log(`scripted answers for ${students.length} students in ${args.out}`);
  console.log(JSON.stringify(coverage(students)));
}

module.exports = { build, coverage, render, assign, codeFormats, wrongCode, caseOf };

if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exit(1); } }
