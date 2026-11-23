#!/usr/bin/env node
// A scripted local run of the interview-only flow (host.a2) on one imported student's plan: no AWS, no model. The database is in memory
// (the same stand-in the tests use), the code runner is a local g++ (GXX=...), and the model is a fake (a checker that says yes when the answer
// holds the value or the key, and a writer with canned questions). It plays two interviews, one with every answer correct and one with every
// answer wrong, and prints each transcript and the per-question log.
//
//   GXX=D:/raylib/w64devkit/bin/g++.exe node scripts/a2-scripted-run.js [--user fakeuser03] [--base D:/a2-pilot-test]
//
// Reads the dry-run record, the plan and the local fake repository from outside the repo (the repo is public: nothing of a student is kept here).
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const USER = opt('--user', 'fakeuser03');
const BASE = opt('--base', 'D:/a2-pilot-test');

const SHARED = path.join(__dirname, '..', 'shared', 'nodejs');
const { makeMemoryInterviews } = require(path.join(SHARED, '__tests__', 'helpers', 'a2-memory'));
const { fakeModel } = require(path.join(SHARED, '__tests__', 'helpers', 'a2-fakes'));
const { findCompiler, makeLocalRunBatch } = require('./eval/a2/local-runner');
const git = require('./a2-import/lib/git');

// The interview service is loaded with an in-memory interviews table, one milestone, the imported record read from disk and a quiet logger.
function inject(relative, exportsValue) {
  const file = require.resolve(path.join(SHARED, relative));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsValue };
}

function loadInputs() {
  const records = fs.readdirSync(`${BASE}/out`).filter((f) => f.endsWith('.json')).map((f) => { const p = JSON.parse(fs.readFileSync(`${BASE}/out/${f}`, 'utf8')); return p.record || p; });
  const record = records.find((r) => r.githubUsername === USER);
  if (!record) throw new Error(`no record for ${USER} in ${BASE}/out`);
  const plan = JSON.parse(fs.readFileSync(`${BASE}/plans/${record.importId}.json`, 'utf8'));
  const gitDir = path.join(`${BASE}/repos`, `assignment-02-${USER}`);
  const code = git.showFile(gitDir, record.commitHash, 'functions.cpp');
  const header = git.showFile(gitDir, record.commitHash, 'functions.h');
  if (code === null) throw new Error('the code could not be read');
  return { record: { ...record, plan }, code, header };
}

const MILESTONE = { milestoneId: 'milestone_scripted', title: 'Code Interview', language: 'cpp', timeLimit: 5000, memoryLimit: 256000, interview: { enabled: true, interviewOnly: true, source: 'a2-pilot', timeLimitMinutes: 20, maxFollowUpsPerMainQuestion: 1, promptVersion: 'host.a2', themes: [] } };

async function play({ label, inputs, memory, service, runBatch, answers }) {
  const importedStore = require(path.join(SHARED, 'a2', 'imported-store'));
  void importedStore;
  const NOW = Date.parse('2026-02-01T10:00:00Z');
  const started = await service.startPracticeInterview({ userId: 'admin-1', importId: inputs.record.importId, milestoneId: MILESTONE.milestoneId, now: NOW, invokePrepare: async () => {} });
  const prepared = await service.prepareInterview({ interviewId: started.interviewId, runBatch, countRun: async () => {}, now: NOW });
  const model = fakeModel({
    write: () => 'Walk me through the first pass of your code on this input, line by line.',
  });
  console.log(`\n==================== ${label} (prepare: ${prepared.prepareStatus}) ====================`);
  let at = NOW;
  let result = { question: started.question };
  console.log(`[host]    ${started.question}`);
  for (let step = 0; step < 20 && !result.ended; step += 1) {
    const meta = memory.store.get(started.interviewId).meta;
    const text = answers({ meta, last: result.question });
    console.log(`[student] ${text}`);
    at += 1000;
    result = await service.submitAnswer({ userId: 'admin-1', interviewId: started.interviewId, answer: text, now: at, converseFn: model, clock: () => 0 });
    if (result.question) console.log(`[host]    ${result.question}`);
    else console.log(`(interview ${result.status})`);
  }
  const { meta } = memory.store.get(started.interviewId);
  console.log('\n--- log per question ---');
  meta.a2Log.forEach((e) => {
    const flag = e.mismatch ? `  MISMATCH ${e.mismatch.kind}` : '';
    const follow = e.followUp ? `${e.followUp.source || 'none'}${e.followUp.check ? ` -> ${e.followUp.check.verdict}` : ''}${e.followUp.skipped ? ` (skipped: ${e.followUp.skipped})` : ''}` : '-';
    console.log(`Q${e.index} ${e.type} ${e.function}  input="${e.input}"${e.k ? ` K=${e.k} line=${e.line}` : ''} targeted=${e.targeted}  code="${e.answerFromCode}" spec="${e.specAnswer}"  student="${e.studentAnswer}"  check=${e.check ? e.check.verdict : '-'} (${e.check ? e.check.method : '-'})  follow-up: ${follow}${flag}`);
  });
  console.log(`status: ${meta.status}; the record holds the username: ${JSON.stringify(memory.store.get(started.interviewId)).includes(USER)}`);
}

async function main() {
  const compiler = findCompiler();
  if (!compiler) throw new Error('no g++ found: set GXX');
  const inputs = loadInputs();
  const memory = makeMemoryInterviews();
  inject('db/interviews.js', memory);
  inject('db/milestones.js', { getMilestone: async () => MILESTONE });
  inject('utils/logger.js', { info() {}, warn() {}, error() {}, debug() {} });
  inject('a2/imported-store.js', { getRecord: async () => inputs.record, getCode: async () => ({ code: inputs.code, header: inputs.header }), listRecords: async () => [] });
  const service = require(path.join(SHARED, 'services', 'interview-service'));
  const { runBatch } = makeLocalRunBatch({ gxx: compiler.gxx });

  const asked = inputs.record.plan.questions.filter((q) => q.kind !== 'unaskable');
  let index = 0;
  const correct = ({ meta }) => {
    const entry = meta.a2Log[meta.mainIndex];
    const q = asked[meta.mainIndex];
    if (meta.followUpCount > 0) return q.fixedFollowUp ? q.fixedFollowUp.answerKey : 'It stays the same.';
    index += 1;
    if (q.kind === 'predict') return String(entry.answerFromCode);
    if (q.kind === 'tracing') return String(entry.answerFromCode).split(', ').map((p) => p.slice(p.indexOf('=') + 1)).join(', ').replace(/"/g, '');
    return String(q.answerKey);
  };
  const wrong = ({ meta }) => (meta.followUpCount > 0 ? 'I do not know.' : '42');
  await play({ label: `${USER}: every answer correct`, inputs, memory, service, runBatch, answers: correct });
  memory.reset();
  await play({ label: `${USER}: every answer wrong`, inputs, memory, service, runBatch, answers: wrong });
  void index;
}

main().catch((error) => { console.error(error.message); process.exit(1); });
