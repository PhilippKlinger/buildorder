// scaffold: writes a workspace into a folder: the doc-map, CLAUDE.md and .claude/workspace.json.
// It never overwrites: an existing file is reported as skipped, so a second run changes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PLUGIN_ROOT, detect, safeName, validName } from './detect.mjs';
import { normalizePath, relativeTo } from './paths.mjs';

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
function pickRepos(root, found, wanted) {
  const entry = (r) => ({ path: r.path, isCode: r.isCode, stacks: r.stacks });
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
 * Writes the workspace files into `dir` (an existing folder). Options: `lang` (en|de, default en),
 * `name` (default: the folder name), `repo` (repo paths to record; default: every repo detect finds).
 * Throws before writing anything when an option is invalid or the folder is no place for a workspace.
 */
export function scaffold(dir, { lang = 'en', name, repo } = {}) {
  if (!LANGUAGES.includes(lang)) throw new Error(`--lang must be one of ${LANGUAGES.join(', ')}`);
  if (name !== undefined && !validName(name)) {
    throw new Error(`invalid name '${name}': letters, digits, space and ._-, at most 63 characters`);
  }
  const d = detect(dir);
  const root = d.dir;
  const why = refusal(d);
  if (why) throw new Error(why);
  const wsName = name ?? safeName(basename(root));
  const repos = pickRepos(root, d.repos, repo);

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
    language: { docs: lang },
    initPhase: 'scaffolded',
    docs: { ...DOC_MAP },
    repos,
    guards: { docsOnlyNames: Object.values(DOC_MAP), protectedPaths: [] },
  };
  put(WORKSPACE_JSON, JSON.stringify(ws, null, 2) + '\n');

  const date = today();
  const vals = { name: wsName, date, month: date.slice(0, 7) };
  for (const file of ['CLAUDE.md', ...Object.values(DOC_MAP)]) {
    put(file, fill(readFileSync(join(TEMPLATES, lang, file), 'utf8'), vals));
  }
  return { ok: true, dir: root, created, skipped };
}
