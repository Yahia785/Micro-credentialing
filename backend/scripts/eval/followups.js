/**
 * A readable list of follow-ups for the end of summary.md: up to 30 random follow-ups per arm (fixed seed), each with the
 * student answer that came right before it, so a person can judge the questions without opening the transcripts.
 */
const { seededRandom } = require('./rubric');

const PER_ARM = 30;

function armOf(t) { return t.arm || t.promptVersion; }

/** Every follow-up the Host asked in a transcript, with the student answer before it. */
function followUpsOf(transcript) {
  const out = [];
  transcript.turns.forEach((turn, i) => {
    if (turn.role !== 'host' || turn.kind !== 'follow_up') return;
    const before = transcript.turns.slice(0, i).reverse().find((t) => t.role === 'student');
    out.push({
      caseId: transcript.caseId, profile: transcript.profile, repeat: transcript.repeat,
      question: turn.text, target: turn.target || null, isHint: !!turn.isHint,
      answerBefore: before ? before.text : '',
    });
  });
  return out;
}

/** { [arm]: [{ question, target, isHint, answerBefore, caseId, profile }] }, up to `perArm` random ones for every arm that asked any. */
function sampleFollowUps(transcripts, { perArm = PER_ARM, seed = 1 } = {}) {
  const arms = [...new Set(transcripts.map(armOf))].sort();
  const out = {};
  for (const arm of arms) {
    if (arm === 'fixed') continue; // the fixed baseline asks the same question every time
    const all = transcripts.filter((t) => armOf(t) === arm).flatMap(followUpsOf);
    if (!all.length) continue;
    const random = seededRandom(`${seed}|followups|${arm}`);
    const copy = [...all];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    out[arm] = { total: all.length, items: copy.slice(0, perArm) };
  }
  return out;
}

/** Plain text, one block per follow-up, for the end of summary.md. */
function followUpLines(sample) {
  const arms = Object.keys(sample);
  if (!arms.length) return [];
  const out = ['## Follow-ups to read', '', 'Up to 30 random follow-ups per arm (fixed seed), in plain text, with the student answer before each one. The fixed baseline is left out.', ''];
  for (const arm of arms) {
    const { total, items } = sample[arm];
    out.push(`### ${arm} (${items.length} of ${total})`, '');
    items.forEach((item, i) => {
      out.push('```text');
      out.push(`${i + 1}. [${item.caseId}, ${item.profile}]`);
      out.push(`Student: ${item.answerBefore}`);
      out.push(`Follow-up${item.isHint ? ' (hint)' : ''}${item.target ? ` aimed at ${item.target}` : ''}: ${item.question}`);
      out.push('```');
    });
    out.push('');
  }
  return out;
}

module.exports = { PER_ARM, followUpsOf, sampleFollowUps, followUpLines };
