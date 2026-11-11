// Workspace detection for hooks. No dependencies.
// Hooks call findWorkspaceRoot first and stay silent when it returns null.
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readJson } from './fsx.mjs';
import { normalizePath, relativeTo } from './paths.mjs';

function isWorkspace(ws) {
  return ws !== null && typeof ws === 'object' && !Array.isArray(ws) && ws.schemaVersion === 1;
}

/**
 * The workspace root for `startPath` (file or folder, which need not exist), or null.
 *
 * Walks up to the filesystem root (drive roots and UNC shares included: `dirname` returns
 * its input there). The first folder holding `.claude/workspace.json` decides: valid JSON
 * with `schemaVersion === 1` returns that folder, anything else (invalid JSON, older kit,
 * foreign schema) returns null at once, because a workspace further up is a different context.
 *
 * `startPath` is resolved against the current directory when relative (hooks pass absolute
 * paths) and symlinks are not resolved with realpath.
 *
 * Cost: one `stat` per level on the way up (a missing entry is cheap and is not an
 * exception), plus one file read at the level that has a workspace.json. No spawned processes.
 */
export function findWorkspaceRoot(startPath) {
  let dir = resolve(startPath);
  for (;;) {
    const file = join(dir, '.claude', 'workspace.json');
    let found = false;
    try {
      found = statSync(file, { throwIfNoEntry: false }) !== undefined;
    } catch {
      // ENOTDIR (a file on the way) or no permission: treat as absent and keep walking.
    }
    if (found) return isWorkspace(readJson(file)) ? dir : null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The parsed `.claude/workspace.json` of `root`, or null when missing, invalid or not schemaVersion 1. */
export function loadWorkspace(root) {
  const ws = readJson(join(root, '.claude', 'workspace.json'));
  return isWorkspace(ws) ? ws : null;
}

/**
 * The repo of `ws.repos` that contains `absPath` as `{ path, abs }`, or null (outside every repo).
 * Each `repo.path` is canonicalised against `root` first, so `./app`, `app/../app`, `.` (the root
 * itself) and absolute paths all work; entries outside the root are skipped. The most specific
 * (longest) matching repo wins. `path` is the normalised path relative to `root` ('' for the root).
 */
export function repoFor(ws, root, absPath) {
  const rel = relativeTo(absPath, root);
  if (rel === null) return null;
  let best = null;
  for (const repo of ws?.repos ?? []) {
    if (typeof repo?.path !== 'string') continue;
    const abs = resolve(root, repo.path);
    const p = relativeTo(abs, root);
    if (p === null) continue;
    const hit = p === '' || rel === p || rel.startsWith(p + '/');
    if (hit && (best === null || p.length > best.path.length)) best = { path: p, abs };
  }
  return best;
}
