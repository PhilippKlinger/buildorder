// scaffold: writes a workspace into a folder: the doc-map, CLAUDE.md and .claude/workspace.json.
// It never overwrites: an existing file is reported as skipped, so a second run changes nothing.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PLUGIN_ROOT, detect, safeName, validName } from './detect.mjs';
import { gitResult } from './git.mjs';
import { normalizePath, relativeTo } from './paths.mjs';
import { VISIBILITIES } from './standard.mjs';
import { loadWorkspace } from './workspace.mjs';

/** The doc-map: `docs` key in workspace.json -> file in the workspace root. */
export const DOC_MAP = {
  handoff: 'HANDOFF.md',
  sprint: 'SPRINT.md',
  backlog: 'BACKLOG.md',
  archive: 'BACKLOG_ARCHIVE.md',
  decisions: 'DECISIONS.md',
  assumptions: 'assumptions.md',
};
export const LANGUAGES = ['en', 'de'];

// One template folder per language; the workspace.json is built here, not from a template.
const TEMPLATES = join(PLUGIN_ROOT, 'templates', 'workspace');
const WORKSPACE_JSON = '.claude/workspace.json';

const pad = (n) => String(n).padStart(2, '0');

/** Today in local time as YYYY-MM-DD. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const fill = (text, vals) => text.replace(/\{\{(\w+)\}\}/g, (m, key) => vals[key] ?? m);

/** Why detect's suggestion rules out a workspace here, or null. */
function refusal(d) {
  if (d.suggestion === 'repo-root') {
    return 'the folder is itself a code repo; nest it first (buildorder.mjs nest) or set up the workspace next to it';
  }
  if (d.blockedReason === 'foreign-workspace') return 'the folder has a .claude/workspace.json that is not buildorder\'s';
  if (d.blockedReason === 'agent-setup') {
    return `the folder already has an agent setup (${d.existingSetup.join(', ')}); nothing is overwritten`;
  }
  return null;
}

/** The repos to record: all that detect found, or those named in `--repo` (each must be one of them). */
function pickRepos(root, found, wanted, visibility) {
  const entry = (r) => ({ path: r.path, isCode: r.isCode, stacks: r.stacks, ...(visibility ? { visibility } : {}) });
  if (!wanted?.length) return found.map(entry);
  const byKey = new Map(found.map((r) => [normalizePath(r.path), r]));
  const picked = new Map();
  for (const w of wanted) {
    const rel = relativeTo(resolve(root, w), root);
    const repo = rel ? byKey.get(rel) : undefined;
    if (!repo) throw new Error(`--repo '${w}' is not a git repo that detect found in ${root}`);
    picked.set(repo.path, entry(repo));
  }
  return [...picked.values()];
}

/**
 * The new project's code repo `<root>/<name>`: `git init` on main with fixed arguments (no template, no
 * separate git dir), so skills need no `git init` permission. An existing git repo there is kept as it is.
 */
function initRepo(root, name) {
  const abs = join(root, name);
  if (existsSync(join(abs, '.git'))) return;
  if (existsSync(abs) && readdirSync(abs).length) throw new Error(`--new-repo '${name}' exists and is not a git repo`);
  const r = gitResult(root, ['init', '-q', '-b', 'main', '--', name]);
  if (!r.ok) throw new Error(`git init failed: ${r.stderr.split('\n')[0] || 'unknown error'}`);
}

/**
 * The workspace root as the private docs repo (spec "Zwei Orte"): `git init` on main with fixed arguments,
 * unless the root already is a repo or lies inside one (e.g. the user's own docs repo), which is left alone.
 * No commit: the first docs commit is the user's, or comes from /buildorder:handoff.
 */
function initRoot(root) {
  if (existsSync(join(root, '.git'))) return 'existing';
  if (gitResult(root, ['rev-parse', '--is-inside-work-tree']).stdout === 'true') return 'existing';
  const r = gitResult(root, ['init', '-q', '-b', 'main']);
  if (!r.ok) throw new Error(`git init of the workspace root failed: ${r.stderr.split('\n')[0] || 'unknown error'}`);
  return 'created';
}

/** A root-anchored .gitignore line for the repo folder `path`; glob characters match literally. */
const ignoreLine = (path) => `/${path.replace(/[\\*?[]/g, '\\$&')}/`;
// Claude Code's machine-local settings (permission answers): never part of the docs repo.
const LOCAL_SETTINGS = '/.claude/settings.local.json';
// `app`, `app/`, `/app` and `/app/` all name the top-level app; compared without the slashes.
const bare = (line) => line.replace(/^\//, '').replace(/\/$/, '');

/**
 * The root's .gitignore: Claude Code's local settings and every repo folder (relative paths, '' is the
 * root), so the docs repo never adds a nested repo or machine-local file. A new file goes through `put`;
 * an existing one is never rewritten: the missing lines are appended, and without any it counts as
 * skipped. Returns the lines added.
 */
function ignoreRepos(root, paths, put, skipped) {
  const lines = [...new Set([LOCAL_SETTINGS, ...paths.filter((p) => p !== '').map(ignoreLine)])];
  const file = join(root, '.gitignore');
  if (!existsSync(file)) {
    put('.gitignore', lines.map((l) => `${l}\n`).join(''));
    return lines;
  }
  const text = readFileSync(file, 'utf8');
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(bare));
  const missing = lines.filter((l) => !have.has(bare(l)));
  if (!missing.length) {
    skipped.push('.gitignore');
    return [];
  }
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  appendFileSync(file, sep + missing.map((l) => `${l}\n`).join(''));
  return missing;
}

/**
 * Writes the workspace files into `dir` (an existing folder). Options: `lang` (en|de), `name`, `repo`
 * (repo paths to record; default: every repo detect finds), `visibility` (public|private, recorded on each
 * repo entry; /buildorder:secure reads it), `newRepo` (a folder name: create the new project's code repo
 * there with `git init` on main and record it). Without `lang` and `name`, a rerun keeps
 * those of the existing workspace.json (resume after an abort); a first run uses en and the folder name.
 * The root becomes a git repo without a commit (`rootRepo`: created | existing), and its .gitignore lists
 * every repo folder plus Claude Code's local settings (`ignored`: the lines added).
 * Throws before writing anything when an option is invalid or the folder is no place for a workspace.
 */
export function scaffold(dir, { lang, name, repo, visibility, newRepo } = {}) {
  if (lang !== undefined && !LANGUAGES.includes(lang)) throw new Error(`--lang must be one of ${LANGUAGES.join(', ')}`);
  if (newRepo !== undefined && !validName(newRepo)) {
    throw new Error(`invalid --new-repo '${newRepo}': one folder name of letters, digits, space and ._-`);
  }
  if (visibility !== undefined && !VISIBILITIES.includes(visibility)) {
    throw new Error(`--visibility must be one of ${VISIBILITIES.join(', ')}`);
  }
  if (name !== undefined && !validName(name)) {
    throw new Error(`invalid name '${name}': letters, digits, space and ._-, at most 63 characters`);
  }
  let d = detect(dir);
  const root = d.dir;
  const why = refusal(d);
  if (why) throw new Error(why);
  if (newRepo !== undefined) {
    initRepo(root, newRepo);
    d = detect(root);
  }
  const existing = d.workspace ? loadWorkspace(root) : null;
  const docsLang = lang ?? (LANGUAGES.includes(existing?.language?.docs) ? existing.language.docs : 'en');
  const keptName = typeof existing?.name === 'string' && validName(existing.name) ? existing.name : null;
  const wsName = name ?? keptName ?? safeName(basename(root));
  const wanted = newRepo === undefined ? repo : [...(repo ?? []), newRepo];
  const repos = pickRepos(root, d.repos, wanted, visibility);
  const rootRepo = initRoot(root);

  const created = [];
  const skipped = [];
  const put = (rel, content) => {
    const abs = join(root, ...rel.split('/'));
    if (existsSync(abs)) {
      skipped.push(rel);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, { flag: 'wx' });
    created.push(rel);
  };

  // workspace.json first: once it exists, a rerun is a resume and not blocked by its own CLAUDE.md.
  const ws = {
    schemaVersion: 1,
    name: wsName,
    language: { docs: docsLang },
    initPhase: 'scaffolded',
    docs: { ...DOC_MAP },
    repos,
    guards: { docsOnlyNames: Object.values(DOC_MAP), protectedPaths: [] },
  };
  put(WORKSPACE_JSON, JSON.stringify(ws, null, 2) + '\n');

  const date = today();
  const vals = { name: wsName, date, month: date.slice(0, 7) };
  for (const file of ['CLAUDE.md', ...Object.values(DOC_MAP)]) {
    put(file, fill(readFileSync(join(TEMPLATES, docsLang, file), 'utf8'), vals));
  }
  // Every repo folder: those on record (a kept workspace.json included) and the unrecorded ones detect found.
  const folders = [...(Array.isArray(existing?.repos) ? existing.repos : []), ...repos, ...d.repos]
    .map((r) => (typeof r?.path === 'string' ? relativeTo(resolve(root, r.path), root) : null))
    .filter((p) => p !== null)
    .sort();
  const ignored = ignoreRepos(root, folders, put, skipped);
  return { ok: true, dir: root, rootRepo, created, skipped, ignored };
}
