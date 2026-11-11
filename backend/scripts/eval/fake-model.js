/**
 * A deterministic stand-in for Bedrock, so the evaluation runner can be tested without AWS.
 *
 * It reads the same message the real model gets (the allowed actions and the student's latest
 * answer) and answers with valid JSON: a follow-up for short or "I don't know" answers when one is
 * allowed, otherwise the next main question (or end). A seeded share of calls misbehave on purpose
 * so every metric path is exercised: transient and persistent throttling, other unavailability,
 * unusable output, a disallowed action, and a reason that contradicts the action.
 *
 * For host.v4 (the message has a rubric block) it also answers the new fields: "missing" (the rubric
 * items that share fewer than three words with the answer), "target" (the first missing one) and "isHint".
 * Some of its follow-ups ask two questions, so the engine's two-question guard has something to fix; when the
 * guard asks for a rewrite (a conversation of three messages) it answers with one question, or, for a
 * seeded share, with two again.
 *
 * Same seed and same input always give the same result.
 */
const crypto = require('crypto');
const { ModelUnavailableError } = require('../../shared/nodejs/agent/bedrock-client');

const FOLLOW_UP_QUESTIONS = [
  'Walk me through that part of your code again. What happens at each step?',
  'Can you explain that in more detail?',
  'What happens first, and what happens after that?',
  'Why is it written that way? What would change otherwise?',
];

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'and', 'or', 'that', 'this', 'for', 'on', 'what', 'how', 'does', 'not', 'says', 'say', 'why', 'would', 'with', 'are', 'be', 'as', 'at', 'by', 'if', 'when', 'student', 'explains', 'explain', 'about', 'i', 'you', 'so', 'then']);
const tokens = (text) => String(text).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
const SHOWN_WORDS = 3; // a rubric item counts as shown when the answer shares this many words with it

function hashOf(text, seed) {
  return crypto.createHash('sha256').update(`${seed}|${text}`).digest().readUInt32BE(0);
}

/** The rubric block of a host.v4 message, as [{ id, text }] (empty for the other prompt versions). */
function readRubric(text) {
  const lines = String(text).split('\n');
  const at = lines.findIndex((line) => line.startsWith('Rubric for this main question'));
  if (at === -1) return [];
  const items = [];
  for (let i = at + 1; i < lines.length && lines[i].startsWith('- '); i += 1) {
    const m = /^- ([^:]+): (.*)$/.exec(lines[i]);
    if (m) items.push({ id: m[1], text: m[2] });
  }
  return items;
}

function readMessage(text) {
  const allowedLine = /Allowed actions now: (.*)/.exec(text);
  const allowed = allowedLine ? allowedLine[1].split(',').map((a) => a.trim()) : ['next_main'];
  const answers = [...text.matchAll(/<student_answer>\n([\s\S]*?)\n<\/student_answer>/g)];
  const last = answers.length ? answers[answers.length - 1][1] : '';
  return { allowed, last };
}

function isWeak(answer) {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  return words < 6 || /don't know|not sure|no idea/i.test(answer);
}

function reply(action, question, reason, hash, extra) {
  const text = JSON.stringify({ ...extra, action, question, reason });
  return {
    text,
    inputTokens: 900 + (hash % 400),
    outputTokens: 40 + (hash % 30),
    latencyMs: 200 + (hash % 300),
  };
}

// ---------------------------------------------------------------------------------------------
// host.v5: the checker (check.v1) and the writer (write.v1) are separate calls with their own system prompts
// ---------------------------------------------------------------------------------------------

const isCheckCall = (request) => /^You check one student's answer/.test(request.system || '');
const isPlanCall = (request) => /^You plan test runs/.test(request.system || '');
const isAnalysisCall = (request) => /^You analyze a student's C\+\+ program/.test(request.system || '');
const isWriteCall = (request) => /^You write ONE follow-up/.test(request.system || '');
const tokenReply = (obj, hash) => ({ text: JSON.stringify(obj), inputTokens: 600 + (hash % 300), outputTokens: 60 + (hash % 40), latencyMs: 150 + (hash % 200) });

function readCheckMessage(text) {
  const lines = String(text).split('\n');
  const rubric = [];
  for (const line of lines) {
    const m = /^- (r\d+): (.*)$/.exec(line);
    if (m) rubric.push({ id: m[1], text: m[2] });
  }
  const m = /<student_answer>\n([\s\S]*?)\n<\/student_answer>/.exec(text);
  return { rubric, answer: m ? m[1] : '' };
}

function fakeCheck(request, { seed, chaos, attempts }) {
  const text = request.messages[0].content[0].text;
  const retry = request.messages.length > 1;
  const hash = hashOf(text, seed);
  const attempt = attempts.get(hash) || 0;
  attempts.set(hash, attempt + 1);
  const { rubric, answer } = readCheckMessage(text);
  const words = new Set(tokens(answer));
  const firstWords = (/^\s*(?:\S+\s+){0,3}\S+/.exec(answer) || [''])[0].trim();
  const evidence = {};
  const missing = [];
  rubric.forEach((item) => {
    const shown = tokens(item.text).filter((w) => words.has(w)).length >= SHOWN_WORDS && firstWords.length > 0;
    evidence[item.id] = { quote: shown ? firstWords : '', shown };
    if (!shown) missing.push(item.id);
  });
  // host.v7: with findings in the message, a third of the answers (by hash) are taken to contradict the first bug finding
  const bugFinding = /^- (f\d+) \(bug/m.exec(text);
  const extra = bugFinding && firstWords && hash % 3 === 0 ? { contradicted: [{ id: bugFinding[1], quote: firstWords }], addressed: [] } : {};
  const normal = tokenReply({ evidence, missing, ...extra }, hash);
  if (retry || (hash % 1000) / 1000 >= chaos) return normal;
  switch ((hash >>> 12) % 5) {
    case 0:
      if (attempt === 0) throw new ModelUnavailableError('ThrottlingException');
      return normal;
    case 1: return { ...normal, text: 'The answer looks fine to me.' }; // not JSON: the retry gets the real reply
    case 2: // a quote that is not in the answer: the retry gets the real reply
      return tokenReply({ evidence: Object.fromEntries(rubric.map((i) => [i.id, { quote: 'words the student never wrote', shown: true }])), missing: [] }, hash);
    case 3: throw new ModelUnavailableError('InternalServerException');
    default: return normal;
  }
}

function fakeWrite(request, { seed, chaos }) {
  const text = request.messages[0].content[0].text;
  const rewrite = request.messages.length > 1;
  const hash = hashOf(rewrite ? `${text}|rewrite` : text, seed);
  const target = (/\nTarget: (r\d+)/.exec(text) || [])[1] || 'r1';
  const rubric = readRubric(`Rubric for this main question${text.slice(text.indexOf('Rubric (private):') + 'Rubric (private):'.length)}`);
  const item = rubric.find((r) => r.id === target) || { text: 'this part' };
  const answers = [...text.matchAll(/<student_answer>\n([\s\S]*?)\n<\/student_answer>/g)];
  const last = answers.length ? answers[answers.length - 1][1] : '';
  const single = `Walk me through ${tokens(item.text).slice(0, 3).join(' ')} once more?`;
  let question = single;
  if (!rewrite && (hash >>> 4) % 5 === 0) question = `${single} How does that work?`;
  else if (!rewrite && (hash >>> 6) % 7 === 0) question = `Does ${tokens(item.text).slice(0, 3).join(' ')} matter here?`;
  if ((hash % 1000) / 1000 < chaos / 2 && !rewrite && (hash >>> 12) % 2 === 0) return { ...tokenReply({}, hash), text: 'Here is a good question for the student.' };
  return tokenReply({ target, isHint: /don't know|not sure|no idea/i.test(last), question }, hash);
}

// ---------------------------------------------------------------------------------------------
// host.v7: the plan call (which inputs to run) and the analysis call (findings). Deterministic stand-ins that read the same message the
// real model gets: they plan the inputs of the visible tests that failed (and an edge case or two), and report a bug when a failed visible
// test's input was run and printed what the test did not expect. Enough to exercise every path; they say nothing about a real model.
// ---------------------------------------------------------------------------------------------

function visibleTests(text) {
  return [...String(text).matchAll(/^Test \d+ \((passed|failed)\): input "(.*?)"; expected "(.*?)"; the program printed "(.*?)"$/gm)]
    .map((m) => ({ passed: m[1] === 'passed', input: m[2], expected: m[3], printed: m[4] }));
}

function fakePlan(request, { seed }) {
  const text = request.messages[0].content[0].text;
  const hash = hashOf(text, seed);
  const ran = new Set([...text.matchAll(/^Run "[^"]*" \(stdin: (.*?)\):/gm)].map((m) => m[1].trim()));
  const inputs = [];
  visibleTests(text).filter((t) => !t.passed).forEach((t) => { if (!ran.has(t.input)) inputs.push({ stdin: t.input, reason: 'a visible test failed on this input' }); });
  inputs.push({ stdin: '20 80 100 10 80', reason: 'a reading exactly at the high level' });
  inputs.push({ stdin: '20 80 100 10 -5 50', reason: 'an invalid reading while filling' });
  return tokenReply({ runs: inputs.filter((i) => !ran.has(i.stdin)).slice(0, 6) }, hash);
}
function fakeAnalysis(request, { seed }) {
  const text = request.messages[0].content[0].text;
  const hash = hashOf(text, seed);
  // the <runs> block: `Run "label" (stdin: X): finished; it printed:` then the output lines
  const block = (/<runs>\n([\s\S]*?)\n<\/runs>/.exec(text) || [, ''])[1].split('\n');
  const runs = [];
  block.forEach((line) => {
    const head = /^Run "[^"]*" \(stdin: (.*?)\): finished; it printed:$/.exec(line);
    if (head) runs.push({ stdin: head[1].trim(), lines: [] });
    else if (runs.length && !/^Run "/.test(line)) runs[runs.length - 1].lines.push(line);
  });
  const findings = [];
  if (/Code status: unfinished/.test(text)) {
    findings.push({ kind: 'unfinished', concept: 'a function that the program needs is empty or the code does not compile', lines: null, relatedQuestion: 1, evidence: null });
  }
  visibleTests(text).filter((t) => !t.passed).forEach((t) => {
    const run = runs.find((r) => r.stdin === t.input);
    // the first line the program printed that the test did not expect
    const odd = run ? run.lines.find((line) => line.trim() && !` ${t.expected} `.includes(` ${line.trim()} `)) : null;
    if (run && odd && findings.filter((f) => f.kind === 'bug').length < 2) {
      findings.push({ kind: 'bug', concept: `on this input the program prints "${odd.trim()}", which the problem does not allow`, lines: null, relatedQuestion: 1, evidence: { stdin: run.stdin, output: odd.trim() } });
    }
  });
  return tokenReply({ findings }, hash);
}



/**
 * @param {{ seed?: number|string, chaos?: number }} options chaos is the share of calls (0 to 1)
 *   that misbehave. Default 0.26.
 * @returns {(request: object) => Promise<object>} same shape as bedrock-client's converse
 */
function createFakeModel({ seed = 1, chaos = 0.26 } = {}) {
  const attempts = new Map();

  return async function fakeConverse(request) {
    if (isPlanCall(request)) return fakePlan(request, { seed });
    if (isAnalysisCall(request)) return fakeAnalysis(request, { seed });
    if (isCheckCall(request)) return fakeCheck(request, { seed, chaos, attempts });
    if (isWriteCall(request)) return fakeWrite(request, { seed, chaos });
    const text = request.messages[0].content[0].text;
    const rewrite = request.messages.length > 1; // the two-question guard asking for one question
    const hash = hashOf(rewrite ? `${text}|rewrite` : text, seed);
    const attempt = attempts.get(hash) || 0;
    attempts.set(hash, attempt + 1);

    const { allowed, last } = readMessage(text);
    const rubric = readRubric(text);
    const canFollowUp = allowed.includes('follow_up');
    const closing = allowed.includes('end') ? 'end' : 'next_main';
    const followUp = FOLLOW_UP_QUESTIONS[(hash >>> 8) % FOLLOW_UP_QUESTIONS.length];
    const noneMissing = rubric.length ? { missing: [], target: '', isHint: false } : undefined;
    const firstOnly = rubric.length ? { missing: [rubric[0].id], target: rubric[0].id, isHint: false } : undefined;

    let normal;
    let asksFollowUp;
    if (rubric.length) {
      // host.v4: check the answer against each rubric item first (word overlap), then aim at the first missing one.
      const words = new Set(tokens(last));
      const missing = rubric.filter((item) => tokens(item.text).filter((w) => words.has(w)).length < SHOWN_WORDS).map((item) => item.id);
      asksFollowUp = canFollowUp && missing.length > 0;
      if (asksFollowUp) {
        const item = rubric.find((r) => r.id === missing[0]);
        const single = `Walk me through this part again: ${tokens(item.text).slice(0, 3).join(' ')}?`;
        let question = single;
        if (!rewrite && (hash >>> 4) % 4 === 0) question = `${single} How does that work?`;
        if (rewrite && (hash >>> 4) % 3 === 0) question = `${single} And why?`;
        normal = reply('follow_up', question, `${missing[0]} is not shown in the answer.`, hash,
          { missing, target: missing[0], isHint: /don't know|not sure|no idea/i.test(last) });
      } else {
        normal = reply(closing, '', 'The answer is sufficient for this question.', hash, { missing, target: '', isHint: false });
      }
    } else {
      asksFollowUp = canFollowUp && isWeak(last);
      normal = asksFollowUp
        ? reply('follow_up', rewrite ? 'What happens at each step?' : followUp, 'The answer is short, so one follow-up is asked.', hash)
        : reply(closing, '', 'The answer is sufficient for this question.', hash);
    }

    const chaotic = !rewrite && (hash % 1000) / 1000 < chaos;
    if (!chaotic) return normal;

    switch ((hash >>> 12) % 7) {
      case 0: // throttled once, fine on the retry
        if (attempt === 0) throw new ModelUnavailableError('ThrottlingException');
        return normal;
      case 1: // throttled every time
        throw new ModelUnavailableError('ThrottlingException');
      case 2: // another service failure
        throw new ModelUnavailableError('InternalServerException');
      case 3: // not JSON
        return { ...normal, text: 'I would move on to the next question.' };
      case 4: // an action that is not allowed right now
        return canFollowUp
          ? (closing === 'end'
            ? reply('next_main', '', 'Moving on.', hash, noneMissing)
            : reply('end', '', 'Enough has been covered.', hash, noneMissing))
          : reply('follow_up', followUp, 'One more question is worth asking.', hash, firstOnly);
      case 5: // reason argues for the other action
        return asksFollowUp
          ? reply('follow_up', followUp, 'The answer is complete, no follow-up needed.', hash, firstOnly)
          : reply(closing, '', 'The answer needs clarification before moving on.', hash, noneMissing);
      default:
        return normal;
    }
  };
}

module.exports = { createFakeModel, readMessage, readRubric };
