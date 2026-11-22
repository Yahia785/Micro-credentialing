/**
 * The version to import: the commit with the latest COMMITTER date that is before the deadline (a commit made exactly at the deadline is
 * too late). Commits are { hash, committedAt (epoch seconds), committedAtIso }; their order does not matter, so a commit whose date was
 * set back or forward still cannot pull in a later version. Known limit: commit dates come from git and a student can edit them.
 * Returns the commit, or null when there is none (no_version_before_deadline).
 */
function pickCommit(commits, deadlineEpochSeconds) {
  let best = null;
  for (const commit of commits || []) {
    if (!Number.isFinite(commit.committedAt) || commit.committedAt >= deadlineEpochSeconds) continue;
    if (!best || commit.committedAt > best.committedAt) best = commit; // on a tie the first listed (newest in the history) stays
  }
  return best;
}

/** A deadline given as an ISO date-time; returns epoch seconds, or null when it is not a date. */
function parseDeadline(text) {
  const ms = Date.parse(String(text || ''));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

module.exports = { pickCommit, parseDeadline };
