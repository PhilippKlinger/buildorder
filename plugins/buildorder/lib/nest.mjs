// nest: turns a folder that is itself a code repo into a workspace in place. The folder's whole
// content (`.git` and dotfiles included) moves one level down into <dir>/<name>/; the folder
// itself stays where it is, so a session running inside it keeps working.
import { mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detect, validName } from './detect.mjs';
import { gitResult } from './git.mjs';

// Default file systems on Windows and macOS ignore case, so `SRC` would land on `src` there.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
// Windows refuses to rename a file another process holds open (antivirus, search indexer, editor)
// with EPERM, EBUSY or EACCES. Such locks are usually released within moments, so each rename is
// tried three times in all, with short pauses, before nest gives up and rolls back.
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [100, 250];
const DUBIOUS = /dubious ownership|safe\.directory/i;

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function retrying(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!LOCKED.has(err?.code) || attempt >= RETRY_DELAYS_MS.length) throw err;
      pause(RETRY_DELAYS_MS[attempt]);
    }
  }
}

const firstLine = (text) => (text || 'git failed').split('\n')[0];

/**
 * HEAD and the full status of a repo, or git's first error line. Without optional locks, status
 * does not rewrite the index, so reading the state changes nothing. `safeDirectory` adds a
 * one-off `-c safe.directory=<path>`.
 */
function repoState(cwd, safeDirectory) {
  const opts = safeDirectory ? { safeDirectory } : {};
  const status = gitResult(cwd, ['--no-optional-locks', 'status', '--porcelain', '--ignored', '-z'], opts);
  if (!status.ok) return { error: firstLine(status.stderr) };
  // On a branch without commits, `--verify -q` exits 1 without a message: HEAD is then null.
  const head = gitResult(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], opts);
  if (!head.ok && head.stderr) return { error: firstLine(head.stderr) };
  return { head: head.ok ? head.stdout : null, status: status.stdout };
}

/**
 * Moves the content of `dir` into `<dir>/<repoPath>/` (default: detect's in-place proposal).
 * Only for a folder that detect calls `repo-root`. Every refusal and failure comes back as
 * `ok: false` with a reason; on a failed move the original layout is restored.
 *
 * The move goes through a staging folder inside `dir`, renamed to the final name at the end,
 * so the final name never half-exists and a name equal to an entry of the repo (`src`) cannot
 * clash with it. Afterwards HEAD and `git status --ignored` must match the state before.
 *
 * `options.rename` is a test-only seam (same signature as fs.renameSync) for simulating a
 * locked file; callers never pass it.
 */
export function nest(dir, repoPath, { rename = renameSync } = {}) {
  const root = resolve(dir);
  const d = detect(root);
  let name = repoPath ?? null;
  const refuse = (reason) => ({
    ok: false, reason, dir: root, repoPath: name, moved: 0, headUnchanged: null, statusUnchanged: null,
  });

  if (d.suggestion !== 'repo-root') {
    return refuse(`nest only applies to a folder that is itself a code repo (detect: ${d.suggestion})`);
  }
  const { blockers, repoPath: proposed } = d.workspaceProposal.inPlace;
  name = repoPath ?? proposed;
  if (blockers.length) return refuse(`cannot nest: ${blockers.join('; ')}`);
  // Windows drops a trailing space or dot from a name, so the folder would be named differently.
  if (!validName(name) || /[ .]$/.test(name)) {
    return refuse(`invalid folder name '${name}': one name of letters, digits, space and ._-, `
      + 'at most 63 characters, not ending in a space or dot');
  }
  const entries = readdirSync(root).sort(); // a fixed order makes failures reproducible
  const fold = (s) => (CASE_INSENSITIVE ? s.toLowerCase() : s);
  if (entries.some((e) => fold(e) === fold(name))) return refuse(`'${name}' already exists in the folder; pass another name`);
  // Without a readable repo before the move, the comparison afterwards proves nothing.
  const before = repoState(root);
  if (before.error) return refuse(`git cannot read the repo, nothing moved: ${before.error}`);

  const staging = join(root, `.buildorder-nest-${process.pid}`);
  try {
    mkdirSync(staging);
  } catch (err) {
    return refuse(`cannot create the staging folder ${staging} (${err.code ?? err.message}), nothing moved`);
  }
  const move = (from, to) => retrying(() => rename(from, to));
  const moved = [];
  try {
    for (const e of entries) {
      move(join(root, e), join(staging, e));
      moved.push(e);
    }
    move(staging, join(root, name));
  } catch (err) {
    const at = moved.length < entries.length ? entries[moved.length] : name;
    const code = err?.code ?? err?.message;
    const stuck = [];
    for (const e of [...moved].reverse()) {
      try {
        move(join(staging, e), join(root, e));
      } catch {
        stuck.push(e);
      }
    }
    if (stuck.length) {
      return refuse(`moving '${at}' failed (${code}) and the rollback is incomplete; `
        + `still in ${staging}: ${stuck.reverse().join(', ')}. Move them back into ${root} by hand.`);
    }
    try {
      retrying(() => rmdirSync(staging));
    } catch { /* an empty folder is left behind; the repo is complete */ }
    return refuse(`moving '${at}' failed (${code}); rolled back, nothing changed. `
      + 'Close programs that use files in the folder (dev server, editor, terminal), then retry.');
  }

  const repoDir = join(root, name);
  // A safe.directory entry names the old path, so a foreign-owned repo is "dubious" at the new one.
  // nest checks with a one-off entry for the new path and leaves the global config to the user.
  let after = repoState(repoDir);
  let safeDirectory;
  if (after.error && DUBIOUS.test(after.error)) {
    const path = repoDir.replaceAll('\\', '/');
    const retried = repoState(repoDir, path);
    if (!retried.error) {
      after = retried;
      safeDirectory = { path, command: `git config --global --add safe.directory "${path}"` };
    }
  }
  const headUnchanged = after.error ? null : after.head === before.head;
  const statusUnchanged = after.error ? null : after.status === before.status;
  const ok = headUnchanged === true && statusUnchanged === true;
  const reason = ok ? null
    : after.error ? `moved, but git cannot read the moved repo: ${after.error}`
      : [!headUnchanged && 'HEAD differs after the move', !statusUnchanged && 'git status differs after the move']
        .filter(Boolean).join('; ');
  return {
    ok,
    ...(reason && { reason }),
    dir: root,
    repoPath: name,
    moved: entries.length,
    headUnchanged,
    statusUnchanged,
    ...(safeDirectory && { safeDirectory }),
  };
}
