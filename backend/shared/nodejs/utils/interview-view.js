/**
 * What each caller may see of an interview.
 *
 * Student view: an allow-list. Status, timing, the questions asked so far and the student's own answers. Nothing the
 * engine or the model recorded (criteria, rubric, evidence, reasons, model ids, guards, the next question) is ever copied.
 * Admin view: the full instructor record, grouped per main question.
 */
const { rubricFor } = require('../agent/interview-engine');

const NOT_SHOWN = 'not shown';

function timeLeftMs(meta, now) {
  if (meta.status !== 'in_progress') return 0;
  // A real interview whose clock has not started yet has all its time.
  if (!meta.deadline) return ((meta.configSnapshot && meta.configSnapshot.timeLimitMinutes) || 0) * 60000;
  return Math.max(0, Date.parse(meta.deadline) - now);
}

function countMainQuestions(config) {
  return ((config && config.themes) || []).reduce((n, theme) => n + theme.mainQuestions.length, 0);
}

/**
 * What the student reads for a host turn: the engine's fixed sentence (unfinished code, a flagged answer) in front of the question.
 * `notice` is one of our own constants, never model text; nothing else the engine recorded on the turn is copied.
 */
const visibleText = (turn) => (turn.role === 'host' && typeof turn.notice === 'string' && turn.notice ? `${turn.notice}\n\n${turn.text}` : turn.text);

/** Student view. Built field by field from an allow-list, so a new recorded field can never leak by accident. */
function toStudentInterview(meta, turns, { now = Date.now(), code = null } = {}) {
  const shown = turns.map((t) => ({
    role: t.role,
    text: visibleText(t),
    createdAt: t.createdAt,
  }));
  const last = shown[shown.length - 1];
  const waiting = meta.status === 'in_progress' && last && last.role === 'host';
  const asked = turns.filter((t) => t.role === 'host' && t.kind === 'main').length;
  return {
    interviewId: meta.interviewId,
    status: meta.status,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt || null,
    deadline: meta.deadline,
    // "preparing" while the prepare step runs (the waiting page polls for it), then "ready" (or "failed" / "skipped": the interview goes on
    // without what was not ready). Interviews from before the step existed are ready.
    prepareStatus: meta.prepareStatus || 'ready',
    endReason: meta.endReason || null,
    timeLeftMs: timeLeftMs(meta, now),
    serverNow: new Date(now).toISOString(),
    // The question the student is answering now (already in `turns`); null when nothing is waiting for an answer.
    currentQuestion: waiting ? last.text : null,
    // The submitted code is held for the instructor, so it is shown only while the interview is running (never after it ends).
    code: meta.status === 'in_progress' && typeof code === 'string' ? code : null,
    progress: {
      questionNumber: asked,
      questionCount: countMainQuestions(meta.configSnapshot),
    },
    turns: shown,
  };
}

/** The [themeIndex, mainIndex] of every main question, in the order they are asked. */
function mainPositions(config) {
  const out = [];
  ((config && config.themes) || []).forEach((theme, themeIndex) => {
    theme.mainQuestions.forEach((_q, mainIndex) => out.push({ themeIndex, mainIndex }));
  });
  return out;
}

/**
 * What the engine decided after one student answer, as the instructor reads it. `source` is the record of that decision
 * (the host turn that followed the answer, or the interview's endDetail for the last answer).
 */
function toCheck(source, rubric) {
  if (!source) return null;
  const missing = Array.isArray(source.missing) ? source.missing : null;
  const evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : null;
  return {
    reason: source.reason || null,
    ...(source.modelReason && { modelReason: source.modelReason }),
    engineDecision: source.engineDecision === true,
    fallback: source.fallback || null,
    // One entry per rubric item. `evidence` is the student's quote, or "not shown". Without a check (an engine-only
    // decision, a fallback, or a prompt version without evidence) `shown` is null.
    items: rubric.map((item) => {
      const shown = missing ? !missing.includes(item.id) : null;
      const entry = evidence && evidence[item.id];
      let quote = null;
      if (shown === false) quote = NOT_SHOWN;
      else if (shown === true && entry && typeof entry.quote === 'string' && entry.quote.trim()) quote = entry.quote;
      // host.v6: the checker's note when the observed output contradicted the student's claim (the claim is the quote)
      const contradiction = shown === false && entry && typeof entry.note === 'string' && entry.note ? { note: entry.note, claim: entry.quote || null } : null;
      // An item counts as shown only when the quote states the whole item: what the student did say about a not-shown item is kept as evidence.
      const partialQuote = shown === false && entry && typeof entry.quote === 'string' && entry.quote.trim() ? entry.quote : null;
      return {
        id: item.id, text: item.text, shown, evidence: quote,
        ...(partialQuote && { partialQuote }),
        // the claim in the quote is contradicted by what the program printed: it counts as not shown
        ...(shown === false && entry && entry.contradicted === true && { contradictedByProgram: true }),
        // the evidence as a list of exact fragments of the answer, when the evidence is in several places
        ...(shown === true && entry && Array.isArray(entry.fragments) && { fragments: entry.fragments }),
        // shown by an answer to a follow-up question (and after a hint when the follow-up was one)
        ...(shown === true && entry && entry.viaFollowUp && { viaFollowUp: true, ...(entry.afterHint && { afterHint: true }) }),
        ...(contradiction && { contradiction }),
      };
    }),
    // host.v6: the answer was flagged (an attempt to instruct the agent, a request for the answer, ...): { kind, quote, source }
    manipulation: source.manipulation || null,
    // host.v7: the findings of the code analysis this answer contradicted (with the student's words) and the ones it addressed
    ...(Array.isArray(source.contradicted) && source.contradicted.length && { contradicted: source.contradicted }),
    ...(Array.isArray(source.addressed) && source.addressed.length && { addressed: source.addressed }),
    // after a follow-up aimed at a contradiction: did the student explain the real output ("explained") or repeat the claim ("still_contradicts")?
    ...(source.followUpOutcome && { followUpOutcome: source.followUpOutcome }),
    // host.v6: the fixed sentence the engine added to the next question
    notice: source.notice || null,
    missing,
    target: source.target === undefined ? null : source.target,
    isHint: source.isHint === true,
    guard: source.guard || null,
    repairs: source.repairs || [],
    ...(source.rejected && { rejected: source.rejected }),
    ...(source.models && { models: source.models }),
    ...(source.calls && { calls: source.calls }),
  };
}

/**
 * Per rubric item of one main question: what the agent found across all the answers (shown if any answer showed it), the
 * instructor's override when there is one, and the final value. The agent's own checks stay as recorded on the answers.
 */
function toRubricSummary(group, overrides) {
  const checks = group.answers.map((a) => a.check).filter(Boolean);
  return group.rubric.map((item) => {
    let agentShown = null;
    let evidence = null;
    let viaFollowUp = false;
    let afterHint = false;
    checks.forEach((check) => {
      const found = check.items.find((i) => i.id === item.id);
      if (!found || found.shown === null) return;
      if (found.shown === true) {
        // the first check that showed the item says where it was shown (later checks repeat it)
        if (agentShown !== true) { viaFollowUp = found.viaFollowUp === true; afterHint = found.afterHint === true; }
        agentShown = true;
        if (found.evidence && found.evidence !== NOT_SHOWN) evidence = found.evidence;
      } else if (agentShown === null) {
        agentShown = false;
      }
    });
    const override = overrides && typeof overrides[item.id] === 'boolean' ? overrides[item.id] : null;
    return {
      id: item.id,
      text: item.text,
      agentShown,
      evidence,
      ...(viaFollowUp && { viaFollowUp: true, ...(afterHint && { afterHint: true }) }),
      instructorShown: override,
      changed: override !== null && override !== agentShown,
      shown: override !== null ? override : agentShown,
    };
  });
}

/** Admin view: the full instructor record. */
function toAdminInterview(meta, turns, { code = null, now = Date.now() } = {}) {
  const config = meta.configSnapshot || { themes: [] };
  const positions = mainPositions(config);
  const endSource = meta.endDetail || null;
  const groups = [];

  turns.forEach((turn, i) => {
    if (turn.role === 'host' && turn.kind === 'main') {
      const position = positions[groups.length] || positions[positions.length - 1] || { themeIndex: 0, mainIndex: 0 };
      const theme = (config.themes || [])[position.themeIndex] || {};
      let rubric = [];
      try {
        rubric = rubricFor(config, position);
      } catch {
        rubric = [];
      }
      groups.push({
        index: groups.length + 1,
        themeId: theme.id || turn.themeId || null,
        themeTitle: theme.title || null,
        question: turn.text,
        askedAt: turn.createdAt,
        rubric,
        // host.v6: what the student's code printed on the inputs set for this question, and why nothing was run when it was not
        runs: Array.isArray(turn.runs) ? turn.runs : [],
        runsNote: turn.runsNote || null,
        // the engine's fixed sentence in front of the question (unfinished code at the start, or a flagged answer before it)
        notice: turn.notice || null,
        answers: [],
        followUps: [],
      });
      return;
    }
    const group = groups[groups.length - 1];
    if (!group) return;
    if (turn.role === 'host') {
      group.followUps.push({
        question: turn.text,
        askedAt: turn.createdAt,
        afterAnswer: group.answers.length,
        isHint: turn.isHint === true,
        target: turn.target === undefined ? null : turn.target,
        // host.v7: 'finding' when the follow-up was aimed at a finding of the code analysis (target is then its id)
        targetKind: turn.targetKind === 'finding' ? 'finding' : 'rubric',
        ...(turn.contradictionTarget && { aimedAtContradiction: true }),
        // the instructor's fixed follow-up, asked because the written one was rejected
        ...(turn.fixedFollowUp && { fixedFollowUp: true }),
        ...(turn.notice && { notice: turn.notice }),
      });
    } else if (turn.role === 'student') {
      // The decision about this answer is recorded on the host turn that followed it, or on the interview for the last one.
      const next = turns[i + 1];
      const source = next && next.role === 'host' ? next : (i === turns.length - 1 ? endSource : null);
      group.answers.push({
        text: turn.text,
        answeredAt: turn.createdAt,
        clientTiming: turn.clientTiming || null,
        check: toCheck(source, group.rubric),
      });
    }
  });

  const review = meta.review || null;
  groups.forEach((group) => {
    group.rubricSummary = toRubricSummary(group, review && review.overrides ? review.overrides[String(group.index)] : null);
  });

  // The session key's hash is never given out.
  const { sk, configSnapshot, sessionKeyHash, ...fields } = meta;
  return {
    ...fields,
    prepareStatus: meta.prepareStatus || 'ready',
    // host.v7: what the analysis of the code found, the runs the agent chose (with its reasons) and what the calls cost; null for other versions
    analysis: meta.analysis || null,
    // The student left the page (or confirmed leaving): the interview ended there, with the answers given until then
    abandoned: meta.status === 'abandoned' ? { at: meta.endedAt || null, reason: meta.endReason || null } : null,
    review,
    isPractice: meta.isPractice === true,
    promptVersion: meta.promptVersion || null,
    modelId: meta.modelId || null,
    checkerModelId: meta.checkerModelId || null,
    writerModelId: meta.writerModelId || null,
    // host.v6: { compiles, passed, total, stubs, unfinished } decided once at the start; null for other prompt versions
    codeStatus: meta.codeStatus || null,
    // every flagged answer of the interview with the student's quote, in order: [{ question, kind, quote, source }]
    manipulationFlags: groups.flatMap((group) => group.answers.filter((a) => a.check && a.check.manipulation)
      .map((a) => ({ question: group.index, ...a.check.manipulation }))),
    // Total time added to the deadline while the agent was working on the student's answers.
    extraTimeMs: meta.extraTimeMs || 0,
    timeLeftMs: timeLeftMs(meta, now),
    serverNow: new Date(now).toISOString(),
    code,
    mainQuestions: groups,
    // The raw turns exactly as stored (minus the sort key), for anything the grouped view does not show.
    turns: turns.map(({ sk: _sk, ...t }) => t),
  };
}

/** One row of the per-submission list (admin). */
function toInterviewSummary(meta) {
  return {
    interviewId: meta.interviewId,
    submissionId: meta.submissionId,
    userId: meta.userId,
    isPractice: meta.isPractice === true,
    status: meta.status,
    promptVersion: meta.promptVersion || null,
    startedAt: meta.startedAt,
    deadline: meta.deadline,
    endedAt: meta.endedAt || null,
    turnCount: meta.turnCount || 0,
  };
}

module.exports = { mainPositions, toRubricSummary, toStudentInterview, toAdminInterview, toInterviewSummary, toCheck, NOT_SHOWN };
