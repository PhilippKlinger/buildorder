// nest: turns a folder that is itself a code repo into a workspace in place. The folder's whole
// content (`.git` and dotfiles included) moves one level down into <dir>/<name>/; the folder
// itself stays where it is, so a session running inside it keeps working.
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detect, validName } from './detect.mjs';
import { gitResult } from './git.mjs';

const IS_WINDOWS = process.platform === 'win32';
// Default file systems on Windows and macOS ignore case, so `SRC` would land on `src` there.
const CASE_INSENSITIVE = IS_WINDOWS || process.platform === 'darwin';
// Windows refuses to rename a file another process holds open (antivirus, search indexer, editor)
// with EPERM, EBUSY or EACCES. Such locks are usually released within moments, so each rename is
// tried three times in all, with short pauses, before nest gives up and rolls back.
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [100, 250];
const DUBIOUS = /dubious ownership|safe\.directory/i;
const STAGING_PREFIX = '.buildorder-nest-';
const STAGING = /^\.buildorder-nest-\d+$/;
// Names Windows reserves for devices, with or without an extension; refused on every OS so the
// workspace stays portable.
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

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

/** Whether anything (file, folder, broken link) is at `p`. */
function exists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const listOf = (p) => {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
};

/** A path as git config writes it: forward slashes on Windows; on POSIX a backslash is a name character. */
const gitPath = (p) => (IS_WINDOWS ? p.replaceAll('\\', '/') : p);

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
 * Puts every entry back from the staging folder after a failed move and reports what the
 * folder looks like afterwards. An entry whose original place is taken again (recreated by an
 * editor or dev server meanwhile) is never overwritten. A rename may fail after it moved the
 * entry, so the outcome is read from the disk, not from which renames threw.
 */
function rollBack({ root, name, staging, entries, move }) {
  // Normally everything waits in staging; a final rename that failed after it succeeded left it under the final name.
  const holder = !exists(staging) && exists(join(root, name)) ? join(root, name) : staging;
  const taken = new Set();
  for (const e of [...entries].reverse()) {
    const from = join(holder, e);
    if (!exists(from)) continue; // never moved
    if (exists(join(root, e))) {
      taken.add(e);
      continue;
    }
    try {
      move(from, join(root, e));
    } catch { /* the check below finds where it is */ }
  }
  const left = listOf(holder);
  const missing = entries.filter((e) => !exists(join(root, e)) && !left.includes(e));
  if (left.length || missing.length) {
    const where = left.map((e) => (taken.has(e) ? `${e} (both versions exist: ${join(root, e)} and ${join(holder, e)})` : e));
    return {
      complete: false,
      moved: left.length + missing.length,
      detail: [
        left.length && `still in ${holder}: ${where.join(', ')}`,
        missing.length && `not found: ${missing.join(', ')}`,
      ].filter(Boolean).join('; '),
      holder,
    };
  }
  try {
    retrying(() => rmdirSync(holder));
  } catch {
    return { complete: false, moved: 0, detail: `every entry is back, but the empty folder ${holder} is left; remove it`, holder };
  }
  return { complete: true, moved: 0 };
}

/**
 * Moves the content of `dir` into `<dir>/<repoPath>/` (default: detect's in-place proposal).
 * Only for a folder that detect calls `repo-root`. Every refusal and failure comes back as
 * `ok: false` with a reason; on a failed move the original layout is restored, and the reason
 * says "nothing changed" only when a check of the disk proves it.
 *
 * The move goes through a staging folder inside `dir`, renamed to the final name at the end,
 * so the final name never half-exists and a name equal to an entry of the repo (`src`) cannot
 * clash with it. Afterwards HEAD and `git status --ignored` must match the state before. A
 * mismatch leaves the files moved (undoing a finished move would be a second risky move).
 *
 * `options.rename` is a test-only seam (same signature as fs.renameSync) for simulating a
 * locked file; callers never pass it.
 */
export function nest(dir, repoPath, { rename = renameSync } = {}) {
  const root = resolve(dir);
  let name = repoPath ?? null;
  const refuse = (reason, moved = 0) => ({
    ok: false, reason, dir: root, repoPath: name, moved, headUnchanged: null, statusUnchanged: null,
  });
  // First of all: in an interrupted run the .git sits inside the staging folder, so detect would give a wrong reason.
  // A staging folder left by a killed or failed run holds repo files; moving it would bury them.
  let top = [];
  try {
    top = readdirSync(root);
  } catch { /* not a readable folder: detect reports that */ }
  const leftover = top.find((e) => STAGING.test(e));
  if (leftover) {
    return refuse(`an earlier nest left ${join(root, leftover)}; move its contents back into ${root} `
      + 'and remove it, then retry');
  }
  const d = detect(root);

  if (d.suggestion !== 'repo-root') {
    return refuse(`nest only applies to a folder that is itself a code repo (detect: ${d.suggestion})`);
  }
  const { blockers, repoPath: proposed } = d.workspaceProposal.inPlace;
  name = repoPath ?? proposed;
  if (blockers.length) return refuse(`cannot nest: ${blockers.join('; ')}`);
  const entries = readdirSync(root).sort(); // a fixed order makes failures reproducible
  // Windows drops a trailing space or dot from a name, so the folder would be named differently.
  if (!validName(name) || /[ .]$/.test(name)) {
    return refuse(`invalid folder name '${name}': one name of letters, digits, space and ._-, `
      + 'at most 63 characters, not ending in a space or dot');
  }
  if (DEVICE.test(name)) return refuse(`invalid folder name '${name}': a reserved device name on Windows`);
  const fold = (s) => (CASE_INSENSITIVE ? s.toLowerCase() : s);
  if (entries.some((e) => fold(e) === fold(name))) return refuse(`'${name}' already exists in the folder; pass another name`);
  // Without a readable repo before the move, the comparison afterwards proves nothing.
  const before = repoState(root);
  if (before.error) return refuse(`git cannot read the repo, nothing moved: ${before.error}`);

  const staging = join(root, `${STAGING_PREFIX}${process.pid}`);
  try {
    mkdirSync(staging);
  } catch (err) {
    return refuse(`cannot create the staging folder ${staging} (${err.code ?? err.message}), nothing moved`);
  }
  const move = (from, to) => retrying(() => rename(from, to));
  const repoDir = join(root, name);
  let at = null;
  try {
    for (const e of entries) {
      at = e;
      move(join(root, e), join(staging, e));
    }
    at = name;
    // A POSIX rename replaces an empty folder silently; one that appeared meanwhile is not ours to replace.
    if (exists(repoDir)) throw Object.assign(new Error(`${name} appeared during the move`), { code: 'EEXIST' });
    move(staging, repoDir);
  } catch (err) {
    const code = err?.code ?? err?.message;
    const back = rollBack({ root, name, staging, entries, move });
    if (!back.complete) {
      return refuse(`moving '${at}' failed (${code}) and the rollback is incomplete; ${back.detail}. `
        + `Move these back into ${root} by hand.`, back.moved);
    }
    return refuse(`moving '${at}' failed (${code}); rolled back, nothing changed. `
      + 'Close programs that use files in the folder (dev server, editor, terminal), then retry.');
  }

  // A safe.directory entry names the old path, so a foreign-owned repo is "dubious" at the new one.
  // nest checks with a one-off entry for the new path and leaves the global config to the user.
  let after = repoState(repoDir);
  let safeDirectory;
  if (after.error && DUBIOUS.test(after.error)) {
    // git compares real paths (macOS /private/var, long Windows names, drive letter case).
    let real = repoDir;
    try {
      real = realpathSync.native(repoDir);
    } catch { /* keep the resolved path */ }
    const path = gitPath(real);
    const retried = repoState(repoDir, path);
    if (!retried.error) {
      after = retried;
      // Single quotes keep `$`, backticks and `!` literal in bash and PowerShell. A path with a
      // single quote cannot be quoted the same way for both, so only the path is reported then.
      safeDirectory = { path, ...(!path.includes("'") && { command: `git config --global --add safe.directory '${path}'` }) };
    }
  }
  const headUnchanged = after.error ? null : after.head === before.head;
  const statusUnchanged = after.error ? null : after.status === before.status;
  const ok = headUnchanged === true && statusUnchanged === true;
  const moved = `the files now live in ${repoDir} and nothing was undone`;
  const reason = ok ? null
    : after.error ? `${moved}, but git cannot read the moved repo: ${after.error}`
      : `${moved}: ${[!headUnchanged && 'HEAD differs after the move', !statusUnchanged && 'git status differs after the move']
        .filter(Boolean).join('; ')}`;
  // An entry created in the folder while the move ran stays outside the repo. The repo itself is
  // complete and verified, so this is a warning, not a failure.
  const stray = listOf(root).filter((e) => e !== name);
  const warnings = stray.length
    ? [`${stray.join(', ')} appeared in ${root} during the move and stayed outside ${repoDir}; move it into the repo if it belongs there`]
    : [];
  return {
    ok,
    ...(reason && { reason }),
    dir: root,
    repoPath: name,
    moved: entries.length,
    headUnchanged,
    statusUnchanged,
    ...(safeDirectory && { safeDirectory }),
    ...(warnings.length && { warnings }),
  };
}
