// status: the live git state of a workspace (docs root and every repo) for the workflow skills.
// Read-only and local: no network, no index refresh. A place that cannot be read gets a state, never an error.
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git, gitResult } from './git.mjs';
import { normalizePath } from './paths.mjs';
import { findWorkspaceRoot, loadWorkspace } from './workspace.mjs';

/** The normalised real path, or null when it cannot be resolved (e.g. an MSYS-style path from git). */
function real(p) {
  try {
    return normalizePath(realpathSync.native(p));
  } catch {
    return null;
  }
}

/**
 * Git state of one folder: state 'ok' with branch, changes and upstream, or 'missing' / 'not-a-repo' / 'unreadable'.
 * `exclude`: subfolders (relative, `/`-separated) whose content is no change of this folder (nested repos).
 */
function describe(label, path, dir, exclude = []) {
  if (!existsSync(dir)) return { label, path, state: 'missing' };
  const top = gitResult(dir, ['rev-parse', '--show-toplevel']);
  const here = real(dir);
  const topReal = top.ok ? real(top.stdout) : null;
  if (here === null || (top.ok && topReal === null)) return { label, path, state: 'unreadable' };
  // A folder inside another repo (e.g. the docs repo) must not report that repo's state.
  if (topReal !== here) {
    const state = existsSync(join(dir, '.git')) ? 'unreadable' : 'not-a-repo';
    return { label, path, state };
  }
  const pathspec = exclude.length ? ['--', '.', ...exclude.map((p) => `:(exclude,literal)${p}`)] : [];
  const changed = git(dir, ['--no-optional-locks', 'status', '--porcelain', ...pathspec])
    .split('\n').filter(Boolean).length;
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
  const repos = [];
  const seen = new Set([real(root) ?? normalizePath(root)]);
  for (const repo of Array.isArray(ws.repos) ? ws.repos : []) {
    if (typeof repo?.path !== 'string') continue;
    const abs = resolve(root, repo.path);
    const key = real(abs) ?? normalizePath(abs);
    if (seen.has(key)) continue; // the root itself or a duplicate entry
    seen.add(key);
    repos.push({ path: repo.path, abs });
  }
  // Repos inside the root appear there as untracked folders unless a .gitignore lists them: no doc changes.
  const nested = repos
    .map((r) => relative(root, r.abs))
    .filter((rel) => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    .map((rel) => rel.split(sep).join('/'));
  const places = [describe('docs', '.', root, nested), ...repos.map((r) => describe(r.path, r.path, r.abs))];
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
