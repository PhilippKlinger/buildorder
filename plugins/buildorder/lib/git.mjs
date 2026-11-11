// Thin git wrapper: no shell, no output leaks to the terminal.
import { spawnSync } from 'node:child_process';

// Variables that would redirect git away from `cwd` (e.g. when running inside a git hook).
// The CLI always operates on the folder it is given, so they are removed for every call.
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra, LC_ALL: 'C' }; // stable, English messages
  for (const k of REDIRECTING) delete env[k];
  return env;
}

/**
 * Runs git and reports the outcome. `opts.safeDirectory` adds a one-off
 * `-c safe.directory=<path>` before the subcommand (nothing is persisted).
 * `opts.env` adds environment variables (e.g. GIT_CEILING_DIRECTORIES).
 */
export function gitResult(cwd, args, opts = {}) {
  const full = opts.safeDirectory ? ['-c', `safe.directory=${opts.safeDirectory}`, ...args] : args;
  const r = spawnSync('git', full, {
    cwd,
    env: childEnv(opts.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: !r.error && r.status === 0,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

/** Trimmed stdout, or '' on any failure. */
export function git(cwd, args, opts = {}) {
  const r = gitResult(cwd, args, opts);
  return r.ok ? r.stdout : '';
}
