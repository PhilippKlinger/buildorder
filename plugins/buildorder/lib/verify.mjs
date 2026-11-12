// verify and finalize: check that a scaffolded workspace is complete and consistent, then mark
// the init as done. Pure reads, except finalize's write of `initPhase`.
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, writeJson } from './fsx.mjs';
import { relativeTo } from './paths.mjs';
import { DOC_MAP } from './scaffold.mjs';

const WS_REL = '.claude/workspace.json';

function folder(dir) {
  const root = resolve(dir);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch { /* missing */ }
  if (!isDir) throw new Error(`not a folder: ${root}`);
  return root;
}

/** The parsed workspace.json, or the one problem that stops every further check. */
function readWorkspace(root) {
  const file = join(root, '.claude', 'workspace.json');
  if (!existsSync(file)) return { problem: `no ${WS_REL}` };
  const ws = readJson(file);
  if (ws === null || typeof ws !== 'object' || Array.isArray(ws)) return { problem: `${WS_REL} is not valid JSON` };
  if (ws.schemaVersion !== 1) return { problem: `${WS_REL}: schemaVersion must be 1` };
  return { ws };
}

const isName = (v) => typeof v === 'string' && v !== '';

function problemsOf(root, ws) {
  const problems = [];
  // Doc-map: every file is named and exists in the workspace root.
  const docFiles = [];
  for (const key of Object.keys(DOC_MAP)) {
    const file = ws.docs?.[key];
    if (!isName(file)) problems.push(`docs.${key} is not set`);
    else docFiles.push(file);
  }
  for (const file of docFiles) if (!existsSync(join(root, file))) problems.push(`${file} is missing`);

  // Repos: each exists, is a git repo and holds no control file where boundary-guard would block one.
  const repos = ws.repos ?? [];
  if (!Array.isArray(repos)) problems.push('repos must be a list');
  for (const repo of Array.isArray(repos) ? repos : []) {
    const path = repo?.path;
    if (typeof path !== 'string') {
      problems.push('a repo has no path');
      continue;
    }
    const abs = resolve(root, path);
    const rel = relativeTo(abs, root);
    if (rel === null) {
      problems.push(`repo ${path} lies outside the workspace`);
      continue;
    }
    if (!existsSync(abs)) {
      problems.push(`repo ${path} does not exist`);
      continue;
    }
    if (!existsSync(join(abs, '.git'))) problems.push(`repo ${path} is not a git repo`);
    if (rel === '') continue; // a repo at the root is the docs home itself
    for (const where of ['', 'docs/']) {
      for (const file of docFiles) {
        if (existsSync(join(abs, where, file))) problems.push(`${path}/${where}${file} is a doc-map control file inside a code repo`);
      }
    }
  }

  const names = ws.guards?.docsOnlyNames;
  if (!Array.isArray(names) || !names.some(isName)) problems.push('guards.docsOnlyNames is not set');
  return problems;
}

function check(dir) {
  const root = folder(dir);
  const { ws, problem } = readWorkspace(root);
  return { root, ws, problems: problem ? [problem] : problemsOf(root, ws) };
}

/** `{ ok, dir, problems }`: ok when the workspace in `dir` is complete and consistent. */
export function verify(dir) {
  const { root, problems } = check(dir);
  return { ok: problems.length === 0, dir: root, problems };
}

/**
 * Sets `initPhase: "done"` when verify is ok; otherwise reports the problems and leaves the phase.
 * `initPhase` in the result is the phase afterwards (null without a readable workspace.json).
 */
export function finalize(dir) {
  const { root, ws, problems } = check(dir);
  const ok = problems.length === 0;
  if (ok && ws.initPhase !== 'done') writeJson(join(root, '.claude', 'workspace.json'), { ...ws, initPhase: 'done' });
  return { ok, dir: root, initPhase: ok ? 'done' : (ws?.initPhase ?? null), problems };
}
