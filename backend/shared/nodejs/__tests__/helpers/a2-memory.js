// An in-memory stand-in for db/interviews.js (same functions the interview service calls), for the A2 tests and the scripted local run.
// It keeps the META item and the turns of each interview, applies the same updates the real transactions do, and checks the same conditions
// (turn count, in progress, still preparing).
const clone = (value) => JSON.parse(JSON.stringify(value));

function makeMemoryInterviews() {
  const store = new Map(); // interviewId -> { meta, turns }
  let counter = 0;
  const api = {
    store,
    reset: () => { store.clear(); counter = 0; },
    interviewIdFor: (submissionId) => `int_${submissionId}`,
    practiceInterviewId: () => { counter += 1; return `intp_memory${counter}`; },
    async createInterview(meta, firstTurn) {
      if (store.has(meta.interviewId)) throw new Error('exists');
      store.set(meta.interviewId, { meta: clone(meta), turns: [clone({ ...firstTurn, sk: 'T#0001' })] });
      return meta;
    },
    async getInterviewMeta(interviewId) { const e = store.get(interviewId); return e ? clone(e.meta) : null; },
    async getInterviewTurns(interviewId) { const e = store.get(interviewId); return e ? clone(e.turns) : []; },
    async appendTurns({ interviewId, expectedTurnCount, turns, metaUpdates }) {
      const e = store.get(interviewId);
      if (!e || e.meta.turnCount !== expectedTurnCount || e.meta.status !== 'in_progress') throw new Error('conflict');
      turns.forEach((turn, i) => e.turns.push(clone({ ...turn, sk: `T#${String(expectedTurnCount + i + 1).padStart(4, '0')}` })));
      Object.assign(e.meta, clone(metaUpdates), { turnCount: expectedTurnCount + turns.length });
    },
    async finishPrepare(interviewId, { metaUpdates, firstTurnUpdates = {} }) {
      const e = store.get(interviewId);
      if (!e || e.meta.status !== 'in_progress' || e.meta.prepareStatus !== 'preparing') return false;
      Object.assign(e.meta, clone(metaUpdates));
      Object.assign(e.turns[0], clone(firstTurnUpdates));
      return true;
    },
    async skipPrepare(interviewId) { const e = store.get(interviewId); if (!e || e.meta.prepareStatus !== 'preparing') return false; e.meta.prepareStatus = 'skipped'; return true; },
    async startInterviewClock(interviewId, { startedAt, deadline }) { const e = store.get(interviewId); if (!e || e.meta.deadline) return false; Object.assign(e.meta, { startedAt, deadline }); return true; },
    async endInterview(interviewId, { status, endReason, now }) {
      const e = store.get(interviewId);
      if (!e || e.meta.status !== 'in_progress') return false;
      Object.assign(e.meta, { status, endReason, endedAt: new Date(now).toISOString() });
      return true;
    },
    async getInterviewBySubmission() { return null; },
    async listInterviewsBySubmission() { return []; },
  };
  return api;
}

module.exports = { makeMemoryInterviews };
