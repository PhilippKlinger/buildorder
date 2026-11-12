// sync: lifts an existing workspace to the installed buildorder version. Updates come with the plugin;
// sync only reconciles the workspace files that buildorder renders from its templates (CLAUDE.md and the
// doc-map). A file is replaced only while it is exactly what buildorder wrote (its hash in
// `templateHashes` of workspace.json); anything else is reported as skip-modified and never overwritten.
// It writes nothing inside a code repo and never Claude Code's settings.local.json.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BUILDORDER_VERSION } from './detect.mjs';
import { readJson, writeJson } from './fsx.mjs';
import { relativeTo } from './paths.mjs';
import { DOC_MAP, LANGUAGES, WORKSPACE_JSON, renderTemplate, templateValues, textHash } from './scaffold.mjs';
import { isWorkspace, repoFor } from './workspace.mjs';

const NO_RECORD = 'this workspace has no record of the files buildorder wrote (set up before sync existed): '
  + 'a file that differs from the current template counts as changed and stays as it is';

const semver = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
/** True when version `a` is newer than `b` (major.minor.patch, numeric). */
function newer(a, b) {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The workspace root and its workspace.json, or an error that names the next step. */
function openWorkspace(dir) {
  const root = resolve(dir);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch { /* missing */ }
  if (!isDir) throw new Error(`not a folder: ${root}`);
  const ws = readJson(join(root, ...WORKSPACE_JSON.split('/')));
  if (!isWorkspace(ws)) {
    throw new Error(`no buildorder workspace here (${WORKSPACE_JSON} is missing or not buildorder's); `
      + 'set one up with /buildorder:init, sync changes nothing');
  }
  if (typeof ws.buildorderVersion === 'string' && BUILDORDER_VERSION && newer(ws.buildorderVersion, BUILDORDER_VERSION)) {
    throw new Error(`this workspace is on buildorder ${ws.buildorderVersion}, the installed plugin is ${BUILDORDER_VERSION}; `
      + 'update the buildorder plugin first, sync changes nothing');
  }
  return { root, ws };
}

/** True when the nearest existing parent of `abs` resolves (through links) to a place outside `root`. */
function escapesRoot(root, abs) {
  let near = dirname(abs);
  while (!existsSync(near) && dirname(near) !== near) near = dirname(near);
  try {
    return relativeTo(realpathSync(near), realpathSync(root)) === null;
  } catch {
    return true; // cannot resolve it: do not write there
  }
}

/**
 * The files sync may write: CLAUDE.md and the doc-map files named in `ws.docs` (default names when unset),
 * each with its template. A path outside the root, inside a repo of the workspace, in .claude/ (workspace.json,
 * Claude Code's settings and settings.local.json) or in a .git folder is left out with a note.
 */
function targets(root, ws, notes) {
  const name = (key) => (typeof ws.docs?.[key] === 'string' && ws.docs[key] !== '' ? ws.docs[key] : DOC_MAP[key]);
  const list = [{ path: 'CLAUDE.md', template: 'CLAUDE.md' }];
  for (const key of Object.keys(DOC_MAP)) list.push({ path: name(key).replace(/\\/g, '/'), template: DOC_MAP[key] });
  const seen = new Set();
  return list.filter(({ path }) => {
    const abs = resolve(root, path);
    const rel = relativeTo(abs, root);
    if (rel === null || rel === '') {
      notes.push(`${path}: lies outside the workspace root; sync leaves it alone`);
      return false;
    }
    const parts = rel.split('/');
    // A recorded repo, or a git repo below the root that workspace.json does not list (yet).
    const repo = repoFor(ws, root, abs)?.path
      || parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')).find((p) => existsSync(join(root, p, '.git')));
    if (repo) {
      notes.push(`${path}: lies inside the repo ${repo}; sync writes no file in a repo`);
      return false;
    }
    // .claude/ holds workspace.json and Claude Code's settings (settings.local.json included), .git/ the repo itself.
    // Compared case-insensitively on every platform: on a case-insensitive disk `.Claude` is the same folder.
    const lower = parts.map((p) => p.toLowerCase());
    if (lower[0] === '.claude' || lower.includes('.git')) {
      notes.push(`${path}: not a doc-map location (.claude/ or .git/); sync leaves it alone`);
      return false;
    }
    if (escapesRoot(root, abs)) {
      notes.push(`${path}: resolves outside the workspace (a link); sync leaves it alone`);
      return false;
    }
    if (seen.has(rel)) return false;
    seen.add(rel);
    return true;
  });
}

const isRecord = (r) => r !== null && typeof r === 'object' && !Array.isArray(r);

/**
 * Compares the workspace files with the current templates. Actions: `add` (file missing), `update`
 * (untouched since buildorder wrote it, and the template changed), `skip-modified` (the user changed it, or
 * it has no record and differs from the current template; it stays as it is). Files with nothing to do are
 * not listed. With `apply` the adds and updates are written, workspace.json gets the installed
 * `buildorderVersion` and the new records; a skip-modified file keeps the user's text and is recorded as
 * seen for this template, so the next sync reports it again only after the template changes again.
 * Throws before writing anything outside a buildorder workspace or on a workspace from a newer buildorder.
 */
export function sync(wsRoot, { apply = false } = {}) {
  const { root, ws } = openWorkspace(wsRoot);
  const notes = [];
  const recorded = isRecord(ws.templateHashes) ? ws.templateHashes : null;
  if (!recorded) notes.push(NO_RECORD);
  const lang = LANGUAGES.includes(ws.language?.docs) ? ws.language.docs : 'en';
  const vals = templateValues(typeof ws.name === 'string' ? ws.name : '');

  const changes = [];
  const writes = [];
  const records = {};
  for (const { path, template } of targets(root, ws, notes)) {
    const abs = join(root, ...path.split('/'));
    const { text, record } = renderTemplate(lang, template, vals);
    if (!existsSync(abs)) {
      changes.push({ path, action: 'add' });
      writes.push({ abs, text });
      records[path] = record;
      continue;
    }
    const have = textHash(readFileSync(abs, 'utf8'));
    const entry = isRecord(recorded?.[path]) ? recorded[path] : null;
    if (!entry) {
      // No record: only a file equal to the current template is buildorder's; record it so later syncs can update it.
      if (have === record.file) records[path] = record;
      else {
        changes.push({ path, action: 'skip-modified' });
        records[path] = { file: null, template: record.template };
      }
      continue;
    }
    if (entry.template === record.template) continue; // template unchanged: nothing to do
    if (entry.file === have) {
      changes.push({ path, action: 'update' });
      writes.push({ abs, text });
      records[path] = record;
    } else {
      changes.push({ path, action: 'skip-modified' });
      records[path] = { file: entry.file ?? null, template: record.template };
    }
  }

  if (apply) {
    for (const { abs, text } of writes) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    const next = { ...ws, buildorderVersion: BUILDORDER_VERSION, templateHashes: { ...recorded, ...records } };
    if (JSON.stringify(next) !== JSON.stringify(ws)) writeJson(join(root, ...WORKSPACE_JSON.split('/')), next);
  }
  return {
    ok: true,
    dir: root,
    from: typeof ws.buildorderVersion === 'string' ? ws.buildorderVersion : null,
    to: BUILDORDER_VERSION,
    changes,
    applied: apply,
    notes,
  };
}
