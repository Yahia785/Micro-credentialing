// Reading a student's repository with git only. Student files are never checked out: `git show <commit>:<path>` prints them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function git(gitDir, args, options = {}) {
  const r = spawnSync('git', ['-C', gitDir, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  return { ok: !r.error && r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}

/** Commits reachable from HEAD, newest first: [{ hash, committedAt (epoch seconds), committedAtIso }]. Dates are the COMMITTER dates. */
function listCommits(gitDir) {
  const r = git(gitDir, ['log', 'HEAD', '--format=%H%x09%ct%x09%cI']);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [hash, ct, iso] = line.split('\t');
    return { hash, committedAt: Number(ct), committedAtIso: iso };
  });
}

/** The text of a file at a commit, or null when the file does not exist there. */
function showFile(gitDir, hash, file) {
  const r = git(gitDir, ['show', `${hash}:${file}`]);
  return r.ok ? r.out : null;
}

const isGitDir = (dir) => fs.existsSync(path.join(dir, '.git')) || (fs.existsSync(path.join(dir, 'HEAD')) && fs.existsSync(path.join(dir, 'objects')));
const looksLikeUrl = (text) => /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(text);

/** Bare clone of a URL into a new temporary folder; cleanup() deletes it. Cloning real repositories comes later. */
function cloneBare(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-clone-'));
  const r = spawnSync('git', ['clone', '--bare', '--quiet', url, dir], { encoding: 'utf8' });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) { cleanup(); return { ok: false, reason: `clone failed: ${(r.stderr || '').trim().split('\n')[0]}` }; }
  return { ok: true, gitDir: dir, cleanup };
}

/**
 * The repositories to import from --repos: a folder that holds repository folders, a single repository folder, a comma separated list
 * of clone URLs, or a text file with one folder or URL per line. Returns [{ name, gitDir?, url? }].
 */
function resolveRepos(spec) {
  const items = [];
  const parts = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (looksLikeUrl(part)) { items.push({ name: part.replace(/\.git$/, '').split('/').pop(), url: part }); continue; }
    if (!fs.existsSync(part)) continue;
    if (fs.statSync(part).isFile()) {
      fs.readFileSync(part, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).forEach((l) => items.push(...resolveRepos(l)));
    } else if (isGitDir(part)) {
      items.push({ name: path.basename(part), gitDir: part });
    } else {
      fs.readdirSync(part).sort().forEach((child) => { const full = path.join(part, child); if (fs.statSync(full).isDirectory() && isGitDir(full)) items.push({ name: child, gitDir: full }); });
    }
  }
  return items;
}

/** GitHub Classroom names repositories <assignment>-<username>. */
const usernameFromRepoName = (name) => { const m = /^assignment-02-(.+)$/i.exec(name); return m ? m[1] : name; };

module.exports = { listCommits, showFile, cloneBare, resolveRepos, usernameFromRepoName, isGitDir, looksLikeUrl };
