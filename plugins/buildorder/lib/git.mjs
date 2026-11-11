// Thin git wrapper: no shell, no output leaks to the terminal.
import { spawnSync } from 'node:child_process';

/**
 * Runs git and reports the outcome. `opts.safeDirectory` adds a one-off
 * `-c safe.directory=<path>` before the subcommand (nothing is persisted).
 */
export function gitResult(cwd, args, opts = {}) {
  const full = opts.safeDirectory ? ['-c', `safe.directory=${opts.safeDirectory}`, ...args] : args;
  const r = spawnSync('git', full, {
    cwd,
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
