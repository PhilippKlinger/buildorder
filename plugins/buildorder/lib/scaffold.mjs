// scaffold: writes a workspace into a folder: the doc-map, CLAUDE.md and .claude/workspace.json.
// It never overwrites: an existing file is reported as skipped, so a second run changes nothing.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { BUILDORDER_VERSION, PLUGIN_ROOT, detect, safeName, validName } from './detect.mjs';
import { readJson, writeJson } from './fsx.mjs';
import { gitResult } from './git.mjs';
import { normalizePath, relativeTo } from './paths.mjs';
import { VISIBILITIES, loadModel, optionModules, standard } from './standard.mjs';
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
export const WORKSPACE_JSON = '.claude/workspace.json';
// The rule of the web-quality option module: one language-free template, scoped to the chosen repo.
const WEB_QUALITY_RULE = '.claude/rules/web-quality.md';
/** The workspace files rendered from a template (file name = template name). */
export const TEMPLATE_FILES = ['CLAUDE.md', ...Object.values(DOC_MAP)];

const pad = (n) => String(n).padStart(2, '0');

/** Today in local time as YYYY-MM-DD. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const fill = (text, vals) => text.replace(/\{\{(\w+)\}\}/g, (m, key) => vals[key] ?? m);

/** sha256 of `text` with LF line endings: a CRLF checkout of an untouched file keeps its hash. */
export const textHash = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

/** The placeholder values of a workspace named `name`, dated today. */
export function templateValues(name) {
  const date = today();
  return { name, date, month: date.slice(0, 7) };
}

/**
 * The template `file` (one of TEMPLATE_FILES) in `lang`, filled with `vals`: `text` to write and `record`,
 * the templateHashes entry sync compares against later (`file`: hash of the written text, `template`:
 * hash of the template it came from).
 */
export function renderTemplate(lang, file, vals) {
  const source = readFileSync(join(TEMPLATES, lang, file), 'utf8');
  const text = fill(source, vals);
  return { text, record: { file: textHash(text), template: textHash(source) } };
}

/** The web-quality rule: one file, `paths` for every repo in `paths`. */
function webQualityRule(paths) {
  const source = readFileSync(join(TEMPLATES, 'rules', 'web-quality.md'), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\npaths:\n([\s\S]*?)---\n/.exec(source);
  const lines = m[1].split('\n').filter(Boolean);
  const block = paths.flatMap((p) => lines.map((l) => fill(l, { repo: p }))).join('\n');
  return `---\npaths:\n${block}\n---\n${source.slice(m[0].length)}`;
}

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

/**
 * The standards to record for a repo with option modules: the modules of its read-only plan (stack module,
 * docker-cicd when an image is planned), then the options, without duplicates; the plan's deviations.
 * No repo file is written. A repo that cannot be planned (no code, no git) records the options only.
 */
function recorded(root, repo, options) {
  let plan = { modules: [], deviations: [] };
  if (repo.isCode) {
    try {
      plan = standard(resolve(root, repo.path));
    } catch { /* not plannable: options only */ }
  }
  return { modules: [...new Set([...plan.modules, ...options])], deviations: plan.deviations };
}

/**
 * Per-repo values of a repeatable option: a value without `=` is the default for every path in `paths`
 * that `defaults` accepts (all by default), `<path>=<value>` sets it for that one repo of `paths`. Returns
 * Map<path, value> (paths without a value are absent). With `many`, the value of a path is the list of its
 * values (default values first).
 * Throws on an unknown path, a path given twice (unless `many`) and a value outside `allowed` (when given).
 */
export function perRepo(values, paths, allowed = null, { many = false, option = 'value', defaults: takesDefault = () => true } = {}) {
  const known = new Map(paths.map((p) => [normalizePath(p), p]));
  const defaults = [];
  const own = new Map();
  for (const raw of values ?? []) {
    const text = String(raw);
    const eq = text.indexOf('=');
    const value = (eq < 0 ? text : text.slice(eq + 1)).trim();
    if (allowed && !allowed.includes(value)) throw new Error(`${option} must be one of ${allowed.join(', ')}`);
    if (eq < 0) {
      defaults.push(value);
      continue;
    }
    const given = text.slice(0, eq).trim();
    const path = known.get(normalizePath(given));
    if (path === undefined) throw new Error(`unknown repo '${given}'`);
    if (own.has(path) && !many) throw new Error(`'${given}' given twice`);
    own.set(path, [...(own.get(path) ?? []), value]);
  }
  const result = new Map();
  for (const path of paths) {
    const base = takesDefault(path) ? defaults : [];
    const list = many ? [...base, ...(own.get(path) ?? [])] : own.get(path) ?? (base.length ? [base.at(-1)] : []);
    if (list.length) result.set(path, many ? list : list[0]);
  }
  return result;
}

/** The repo of `found` (detect's list) that `wanted` names, compared in normalized form; throws when there is none. */
function foundRepo(root, found, wanted) {
  const rel = relativeTo(resolve(root, wanted), root);
  const repo = rel ? found.find((r) => normalizePath(r.path) === rel) : undefined;
  if (!repo) throw new Error(`--repo '${wanted}' is not a git repo that detect found in ${root}`);
  return repo;
}

/**
 * The repos to record: all that detect found, or those named in `--repo` (each must be one of them).
 * `visibility`: Map<path, value>; `modules`: Map<path, option module ids>. Paths are compared in normalized
 * form (lower case on Windows), and each entry keeps detect's path as it is on disk.
 */
function pickRepos(root, found, wanted, visibility = new Map(), modules = new Map()) {
  const byPath = (m) => new Map([...m].map(([k, v]) => [normalizePath(k), v]));
  const vis = byPath(visibility);
  const mods = byPath(modules);
  const entry = (r) => {
    const key = normalizePath(r.path);
    return {
      path: r.path,
      isCode: r.isCode,
      stacks: r.stacks,
      ...(vis.has(key) ? { visibility: vis.get(key) } : {}),
      ...(mods.get(key)?.length ? { standards: recorded(root, r, mods.get(key)) } : {}),
    };
  };
  if (!wanted?.length) return found.map(entry);
  const picked = new Map();
  for (const w of wanted) {
    const repo = foundRepo(root, found, w);
    picked.set(normalizePath(repo.path), entry(repo));
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
 * (repo paths to record; default: every repo detect finds), `visibility` (public|private, or `<path>=<value>`; a value
 * without a path is recorded on each code repo entry; /buildorder:secure reads it), `newRepo` (a folder name:
 * create the new project's code repo there with `git init` on main and record it), `with` (option module ids, or
 * `<path>=<id>`: each code repo gets the plan modules of the repo plus these as `standards`, a repo without code
 * only through its own `<path>=`; validated before anything is written). Without `lang` and `name`, a rerun keeps
 * those of the existing workspace.json (resume after an abort); a first run uses en and the folder name.
 * The root becomes a git repo without a commit (`rootRepo`: created | existing), and its .gitignore lists
 * every repo folder plus Claude Code's local settings (`ignored`: the lines added).
 * Throws before writing anything when an option is invalid or the folder is no place for a workspace.
 */
export function scaffold(dir, { lang, name, repo, visibility, newRepo, with: withIds } = {}) {
  const model = loadModel();
  optionModules(model, (withIds ?? []).map((v) => String(v).slice(String(v).indexOf('=') + 1)), null);
  if (lang !== undefined && !LANGUAGES.includes(lang)) throw new Error(`--lang must be one of ${LANGUAGES.join(', ')}`);
  if (newRepo !== undefined && !validName(newRepo)) {
    throw new Error(`invalid --new-repo '${newRepo}': one folder name of letters, digits, space and ._-`);
  }
  const visValues = visibility === undefined ? [] : [].concat(visibility);
  for (const v of visValues) {
    const value = v.slice(v.indexOf('=') + 1).trim();
    if (!VISIBILITIES.includes(value)) throw new Error(`--visibility must be one of ${VISIBILITIES.join(', ')}`);
  }
  if (name !== undefined && !validName(name)) {
    throw new Error(`invalid name '${name}': letters, digits, space and ._-, at most 63 characters`);
  }
  let d = detect(dir);
  const root = d.dir;
  const why = refusal(d);
  if (why) throw new Error(why);
  // Per-repo values are checked against the repos to record, before anything is written. `--repo` values
  // resolve to detect's paths (as they are on disk), so the values stay with their repo on a case-insensitive disk.
  const isNew = (w) => newRepo !== undefined && normalizePath(w) === normalizePath(newRepo);
  const chosen = (repo?.length ? repo.filter((w) => !isNew(w)).map((w) => foundRepo(root, d.repos, w).path) : d.repos.map((r) => r.path))
    .concat(newRepo === undefined ? [] : [newRepo]);
  // A value without a path is the default for the code repos (and the new project's repo) only: a repo without
  // code gets a value through its own `<path>=` (spec A1: registered without a standard).
  const codePaths = new Set(d.repos.filter((r) => r.isCode).map((r) => normalizePath(r.path)));
  const takesDefault = (p) => codePaths.has(normalizePath(p)) || isNew(p);
  const visByRepo = perRepo(visValues, chosen, VISIBILITIES, { option: '--visibility', defaults: takesDefault });
  const withByRepo = perRepo(withIds, chosen, null, { many: true, defaults: takesDefault });
  for (const list of withByRepo.values()) optionModules(model, list, null);
  if (newRepo !== undefined) {
    initRepo(root, newRepo);
    d = detect(root);
  }
  const existing = d.workspace ? loadWorkspace(root) : null;
  const docsLang = lang ?? (LANGUAGES.includes(existing?.language?.docs) ? existing.language.docs : 'en');
  const keptName = typeof existing?.name === 'string' && validName(existing.name) ? existing.name : null;
  const wsName = name ?? keptName ?? safeName(basename(root));
  const wanted = newRepo === undefined ? repo : [...(repo ?? []), newRepo];
  const repos = pickRepos(root, d.repos, wanted, visByRepo, new Map([...withByRepo].map(([p, ids]) => [p, optionModules(model, ids, null)])));
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

  // The template files to create, with the record sync needs to tell them from the user's own text later.
  const vals = templateValues(wsName);
  const rendered = TEMPLATE_FILES.map((file) => ({ file, fresh: !existsSync(join(root, file)), ...renderTemplate(docsLang, file, vals) }));
  const records = Object.fromEntries(rendered.filter((r) => r.fresh).map((r) => [r.file, r.record]));

  // workspace.json first: once it exists, a rerun is a resume and not blocked by its own CLAUDE.md.
  const ws = {
    schemaVersion: 1,
    name: wsName,
    buildorderVersion: BUILDORDER_VERSION,
    language: { docs: docsLang },
    initPhase: 'scaffolded',
    docs: { ...DOC_MAP },
    repos,
    guards: { docsOnlyNames: Object.values(DOC_MAP), protectedPaths: [] },
    templateHashes: records,
  };
  put(WORKSPACE_JSON, JSON.stringify(ws, null, 2) + '\n');
  const resumed = skipped.includes(WORKSPACE_JSON);

  for (const { file, text } of rendered) put(file, text);
  const webRepos = repos.filter((r) => r.standards?.modules.includes('web-quality'));
  if (webRepos.length) put(WEB_QUALITY_RULE, webQualityRule(webRepos.map((r) => r.path)));
  // A resume keeps its workspace.json and only adds the records of the files it created now.
  if (resumed && Object.keys(records).length) {
    const file = join(root, ...WORKSPACE_JSON.split('/'));
    const kept = readJson(file);
    writeJson(file, { ...kept, templateHashes: { ...kept?.templateHashes, ...records } });
  }
  // Every repo folder: those on record (a kept workspace.json included) and the unrecorded ones detect found.
  // Deduplicated by the normalized path and written as the path is on disk, so a clone on a case-sensitive disk matches too.
  const byKey = new Map();
  for (const r of [...(Array.isArray(existing?.repos) ? existing.repos : []), ...repos, ...d.repos]) {
    if (typeof r?.path !== 'string') continue;
    const abs = resolve(root, r.path);
    const key = relativeTo(abs, root);
    if (key !== null && !byKey.has(key)) byKey.set(key, key === '' ? '' : relative(root, abs).split(sep).join('/'));
  }
  const folders = [...byKey.values()].sort();
  const ignored = ignoreRepos(root, folders, put, skipped);
  return { ok: true, dir: root, rootRepo, created, skipped, ignored };
}
