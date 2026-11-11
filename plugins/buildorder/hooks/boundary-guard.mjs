// PreToolUse (Write|Edit): keeps workspace control files out of code repos and blocks writes
// to protected paths. run.mjs hands over the absolute target as `startPath`.
import { basename } from 'node:path';
import { repoFor } from '../lib/workspace.mjs';
import { matchesAny, normalizePath, relativeTo } from '../lib/paths.mjs';

/** @returns {{ deny: string } | null} */
export default function boundaryGuard(_input, { root, ws, startPath }) {
  const rel = relativeTo(startPath, root);
  if (rel === null) return null;
  const guards = ws.guards ?? {};

  if (matchesAny(rel, guards.protectedPaths)) {
    return { deny: `${rel} is in a protected area (guards.protectedPaths in .claude/workspace.json) and is not modified.` };
  }

  const name = basename(startPath);
  const docsOnly = (guards.docsOnlyNames ?? []).filter((n) => typeof n === 'string').map(normalizePath);
  if (!docsOnly.includes(normalizePath(name))) return null;
  const repo = repoFor(ws, root, startPath);
  // A repo at the workspace root ('') is the docs home itself, so nothing is misplaced there.
  if (repo === null || repo.path === '') return null;

  // Control files land at the repo root or in its docs/ folder; deeper files with the same
  // name (e.g. templates) are content, not control files.
  const inRepo = rel.slice(repo.path.length + 1);
  const key = normalizePath(name);
  if (inRepo === key || inRepo === `docs/${key}`) {
    return { deny: `${name} is a workspace control file and belongs in the workspace root, not in the code repo ${repo.path}.` };
  }
  return null;
}
