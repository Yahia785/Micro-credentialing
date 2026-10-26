/**
 * In-memory stand-ins for the DynamoDB-backed modules the interview service uses, so the evaluation
 * can run the real server code (services/interview-service.js) without touching any table.
 *
 * They keep the rules the real tables enforce: one interview per submission, turn appends only when
 * the turn count is unchanged and the interview is in progress.
 */
const { AppError } = require('../../shared/nodejs/utils/errors');

const state = {
  metas: new Map(),
  turns: new Map(),
  submissions: new Map(),
  milestones: new Map(),
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const turnSk = (position) => `T#${String(position).padStart(4, '0')}`;

function reset() {
  Object.values(state).forEach((map) => map.clear());
}

const interviews = {
  interviewIdFor: (submissionId) => `int_${submissionId}`,

  async createInterview(meta, firstTurn) {
    if (state.metas.has(meta.interviewId)) {
      throw new AppError('An interview already exists for this submission', 409);
    }
    state.metas.set(meta.interviewId, clone({ ...meta, sk: 'META' }));
    state.turns.set(meta.interviewId, [clone({ interviewId: meta.interviewId, sk: turnSk(1), ...firstTurn })]);
    return meta;
  },

  async getInterviewMeta(interviewId) {
    return state.metas.has(interviewId) ? clone(state.metas.get(interviewId)) : null;
  },

  async getInterviewTurns(interviewId) {
    return clone(state.turns.get(interviewId) || []);
  },

  async getInterviewBySubmission(submissionId) {
    for (const meta of state.metas.values()) {
      if (meta.submissionId === submissionId) return clone(meta);
    }
    return null;
  },

  async appendTurns({ interviewId, expectedTurnCount, turns, metaUpdates, now = Date.now() }) {
    const meta = state.metas.get(interviewId);
    if (!meta || meta.turnCount !== expectedTurnCount || meta.status !== 'in_progress') {
      throw new AppError('This interview was updated by another request. Please retry.', 409);
    }
    const stored = state.turns.get(interviewId);
    turns.forEach((turn, i) => {
      stored.push(clone({ interviewId, sk: turnSk(expectedTurnCount + i + 1), ...turn }));
    });
    Object.assign(meta, clone(metaUpdates), {
      turnCount: expectedTurnCount + turns.length,
      updatedAt: new Date(now).toISOString(),
    });
  },

  async endInterview(interviewId, { status, endReason, now = Date.now() }) {
    const meta = state.metas.get(interviewId);
    if (!meta || meta.status !== 'in_progress') return false;
    Object.assign(meta, { status, endReason, endedAt: new Date(now).toISOString() });
    return true;
  },
};

const submissions = {
  async getSubmission(submissionId) {
    return state.submissions.has(submissionId) ? clone(state.submissions.get(submissionId)) : undefined;
  },
  register(submission) {
    state.submissions.set(submission.submissionId, clone(submission));
  },
};

const milestones = {
  async getMilestone(milestoneId) {
    return state.milestones.has(milestoneId) ? clone(state.milestones.get(milestoneId)) : undefined;
  },
  register(milestone) {
    state.milestones.set(milestone.milestoneId, clone(milestone));
  },
};

// The service logs IDs and counts only; the evaluation prints its own progress.
const logger = { debug() {}, info() {}, warn() {}, error() {} };

module.exports = { interviews, submissions, milestones, logger, reset };
