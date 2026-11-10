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
  return Math.max(0, Date.parse(meta.deadline) - now);
}

function countMainQuestions(config) {
  return ((config && config.themes) || []).reduce((n, theme) => n + theme.mainQuestions.length, 0);
}

/** Student view. Built field by field from an allow-list, so a new recorded field can never leak by accident. */
function toStudentInterview(meta, turns, { now = Date.now(), code = null } = {}) {
  const shown = turns.map((t) => ({
    role: t.role,
    text: t.text,
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
      return { id: item.id, text: item.text, shown, evidence: quote };
    }),
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

  const { sk, configSnapshot, ...fields } = meta;
  return {
    ...fields,
    isPractice: meta.isPractice === true,
    promptVersion: meta.promptVersion || null,
    modelId: meta.modelId || null,
    checkerModelId: meta.checkerModelId || null,
    writerModelId: meta.writerModelId || null,
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

module.exports = { toStudentInterview, toAdminInterview, toInterviewSummary, toCheck, NOT_SHOWN };
