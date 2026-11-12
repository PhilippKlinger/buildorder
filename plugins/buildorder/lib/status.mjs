// status: the live git state of a workspace (docs root and every repo) for the workflow skills.
// Read-only and local: no network, no index refresh. A place that cannot be read gets a state, never an error.
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, gitResult } from './git.mjs';
import { normalizePath } from './paths.mjs';
import { findWorkspaceRoot, loadWorkspace } from './workspace.mjs';

const real = (p) => normalizePath(realpathSync.native(p));

/** Git state of one folder: state 'ok' with branch, changes and upstream, or 'missing' / 'not-a-repo' / 'unreadable'. */
function describe(label, path, dir) {
  if (!existsSync(dir)) return { label, path, state: 'missing' };
  const top = gitResult(dir, ['rev-parse', '--show-toplevel']);
  // A folder inside another repo (e.g. the docs repo) must not report that repo's state.
  if (!top.ok || real(top.stdout) !== real(dir)) {
    const state = existsSync(join(dir, '.git')) ? 'unreadable' : 'not-a-repo';
    return { label, path, state };
  }
  const changed = git(dir, ['--no-optional-locks', 'status', '--porcelain']).split('\n').filter(Boolean).length;
  const upstream = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || null;
  let ahead = null;
  let behind = null;
  if (upstream) {
    // Left side: commits only in the upstream (behind); right side: only in HEAD (ahead).
    const [left, right] = git(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).split(/\s+/).map(Number);
    behind = left || 0;
    ahead = right || 0;
  }
  const branch = git(dir, ['branch', '--show-current']) || '(detached)';
  return { label, path, state: 'ok', branch, changed, upstream, ahead, behind };
}

/**
 * The state of the workspace that encloses `dir`: `{ root, name, places }`, where `places[0]` is the
 * docs root (`path: '.'`) followed by each repo of `workspace.json`. Outside a workspace: `{ root: null }`.
 */
export function status(dir) {
  const root = findWorkspaceRoot(dir);
  const ws = root && loadWorkspace(root);
  if (!ws) return { root: null };
  const places = [describe('docs', '.', root)];
  const seen = new Set([real(root)]);
  for (const repo of Array.isArray(ws.repos) ? ws.repos : []) {
    if (typeof repo?.path !== 'string') continue;
    const abs = resolve(root, repo.path);
    const key = existsSync(abs) ? real(abs) : normalizePath(abs);
    if (seen.has(key)) continue; // the root itself or a duplicate entry
    seen.add(key);
    places.push(describe(repo.path, repo.path, abs));
  }
  return { root, name: typeof ws.name === 'string' ? ws.name : '', places };
}

const STATE_TEXT = { missing: 'folder missing', 'not-a-repo': 'not a git repo', unreadable: 'git state unreadable' };

/** The status as plain text for skill injection: a header and one line per place. */
export function formatStatus(result) {
  if (!result.root) {
    return 'Not inside a Buildorder workspace (no valid .claude/workspace.json in this folder or above).\n';
  }
  const lines = [`Buildorder workspace "${result.name}" at ${result.root}`];
  for (const p of result.places) {
    const label = p.path === '.' ? 'docs (.)' : p.label;
    if (p.state !== 'ok') {
      lines.push(`- ${label}: ${STATE_TEXT[p.state]}`);
      continue;
    }
    const parts = [p.branch, p.changed ? `${p.changed} changed` : 'clean'];
    parts.push(p.upstream ? `${p.upstream}: ${p.ahead} ahead, ${p.behind} behind` : 'no upstream');
    lines.push(`- ${label}: ${parts.join(', ')}`);
  }
  return lines.join('\n') + '\n';
}
