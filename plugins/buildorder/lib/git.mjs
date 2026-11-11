// Thin git wrapper: no shell, no output leaks to the terminal.
import { spawnSync } from 'node:child_process';

// Variables that would redirect git away from `cwd` (e.g. when running inside a git hook).
// The CLI always operates on the folder it is given, so they are removed for every call.
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Windows environment names are case-insensitive.
    if (!REDIRECTING.includes(k.toUpperCase())) env[k] = v;
  }
  env.LC_ALL = 'C'; // stable, English messages
  return { ...env, ...extra }; // an explicit caller choice wins
}

/**
 * Runs git and reports the outcome. `opts.safeDirectory` adds a one-off
 * `-c safe.directory=<path>` before the subcommand (nothing is persisted).
 * `opts.env` is merged last and wins over the defaults (inherited GIT_DIR, GIT_WORK_TREE and
 * GIT_INDEX_FILE are removed and LC_ALL=C is set before it is applied). stdout is trimmed unless
 * `opts.trim` is false (for `-z` listings, whose names may start or end with blanks).
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
    stdout: opts.trim === false ? (r.stdout ?? '') : (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

/** Trimmed stdout, or '' on any failure. */
export function git(cwd, args, opts = {}) {
  const r = gitResult(cwd, args, opts);
  return r.ok ? r.stdout : '';
}
