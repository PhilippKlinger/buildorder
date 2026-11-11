import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tests/helpers/ -> repo root, independent of process.cwd()
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Tracked files (repo-relative, forward slashes) via `git ls-files -z`. */
export function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}
