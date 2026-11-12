// standard: the standard model (mandatory / standard / option) and the repo files that set it up.
// Without --apply everything here only reads; --apply writes missing files and makes one commit.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { detectDeploy } from './deploy.mjs';
import { PLUGIN_ROOT, repoCode } from './detect.mjs';
import { SKIP_DIRS, readJson, walk, writeJson } from './fsx.mjs';
import { gitResult } from './git.mjs';
import { relativeTo } from './paths.mjs';
import { detectStacks, pyprojectDeps } from './stack.mjs';
import { findWorkspaceRoot, loadWorkspace } from './workspace.mjs';

export const STANDARD_DIR = join(PLUGIN_ROOT, 'standard');
/** Where the stack modules live (`<id>/stack.json`, `ci.yml`, ...); see standard/README.md. */
export const STACKS_DIR = join(STANDARD_DIR, 'stacks');
const TEMPLATES = join(PLUGIN_ROOT, 'templates', 'repo');
const STACK_ID = /^[a-z][a-z0-9-]{0,31}$/;
// Detected stacks that a stack module can cover (docker, postgres and github-actions are no stacks of their own).
const STACK_IDS = ['angular', 'react', 'django', 'python', 'go'];
export const DEPLOY_TARGETS = ['container', 'webspace', 'paas', 'none'];
export const VISIBILITIES = ['public', 'private'];
const PRIVATE_REASON = 'private repo: needs a paid GitHub product (GitHub Code Security); free replacement after 1.0';
const COMMIT_MESSAGE = 'ci: add CI/CD files of the buildorder standard';
const starterMessage = (id) => `feat: add the ${id} starter and the CI/CD files of the buildorder standard`;

// CD variants of docker-cicd that write files: the deploy job for ci.yml and the workflow it calls.
const CD = {
  container: { job: 'deploy-container.yml', workflow: 'deployment.yml' },
  webspace: { job: 'deploy-webspace.yml', workflow: 'deployment-webspace.yml' },
};

/** The standard model: `{ classes, items: [{ id, class, provider, where, summary, check?, paidOnPrivate? }] }`. */
export function loadModel() {
  const model = readJson(join(STANDARD_DIR, 'model.json'));
  if (!Array.isArray(model?.items)) throw new Error('standard/model.json is missing or invalid');
  return model;
}

/**
 * `--without <id>=<reason>` values as a Map id -> reason. Throws when an id is unknown, mandatory,
 * or has no reason: a mandatory item cannot be deselected, a standard item only with a reason.
 */
export function deselections(model, without = []) {
  const out = new Map();
  for (const raw of without ?? []) {
    const eq = raw.indexOf('=');
    const id = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    const reason = eq < 0 ? '' : raw.slice(eq + 1).trim();
    const item = model.items.find((i) => i.id === id);
    if (!item) throw new Error(`unknown standard item '${id}'`);
    if (item.class === 'mandatory') throw new Error(`'${id}' is mandatory and cannot be deselected`);
    if (!reason) throw new Error(`deselecting '${id}' needs a reason: --without ${id}=<reason>`);
    out.set(id, reason);
  }
  return out;
}

/** A text file with LF line endings, or null when it cannot be read. */
function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

const template = (rel) => {
  const text = readText(join(TEMPLATES, ...rel.split('/')));
  if (text === null) throw new Error(`template missing: templates/repo/${rel}`);
  return text;
};

/** Top-level keys of a YAML fragment (the job ids of a CI fragment). */
const topKeys = (text) => text.split('\n').map((l) => l.match(/^([\w-]+):\s*$/)?.[1]).filter(Boolean);

const indent = (text, n) => text.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

/**
 * The stack module `id` from `stacksDir`, or null when there is none:
 * `{ id, codeql, dependabot, provides, ci, jobs, preCommit, docker, starter }`; `docker` and `starter`
 * are `[{ path, content }]` (the starter is empty when the module has none).
 */
export function loadStack(id, stacksDir = STACKS_DIR) {
  if (typeof id !== 'string' || !STACK_ID.test(id)) return null;
  const dir = join(stacksDir, id);
  const meta = readJson(join(dir, 'stack.json'));
  const ci = readText(join(dir, 'ci.yml'));
  if (!meta || ci === null) return null;
  const jobs = topKeys(ci);
  if (!jobs.length) throw new Error(`stack module '${id}': ci.yml defines no job`);
  const files = (sub) => walk(sub, Infinity, SKIP_DIRS).sort()
    .map((path) => ({ path, content: readText(join(sub, ...path.split('/'))) }));
  return {
    id,
    codeql: meta.codeql ?? null,
    dependabot: meta.dependabot ?? [],
    provides: meta.provides ?? {},
    ci,
    jobs,
    preCommit: readText(join(dir, 'pre-commit.yml')) ?? '',
    docker: files(join(dir, 'docker')),
    starter: files(join(dir, 'starter')),
  };
}

const hasDockerfile = (stack) => Boolean(stack?.docker.some((f) => f.path === 'Dockerfile'));

/** Whether the selection builds an image, and the CD variant that writes files (or null). */
export function parts({ stack, deploy, skip }) {
  // The image is built from the stack module's Dockerfile; without one there is nothing to build.
  const image = hasDockerfile(stack) && !skip.has('container-image');
  const cd = image && !skip.has('deploy') ? CD[deploy] ?? null : null;
  return { image, cd };
}

function ciWorkflow({ stack, skip }, { image, cd }) {
  const jobs = [template('ci/gitleaks.yml'), template('ci/zizmor.yml'), template('ci/pre-commit.yml')];
  if (!skip.has('dependency-review')) jobs.push(template('ci/dependency-review.yml'));
  if (!skip.has('codeql')) {
    const langs = [{ language: 'actions', buildMode: 'none' }, ...(stack?.codeql ? [stack.codeql] : [])];
    const matrix = `[${langs.map((l) => `{ language: ${l.language}, build-mode: ${l.buildMode} }`).join(', ')}]`;
    jobs.push(template('ci/codeql.yml').replace('__CODEQL_MATRIX__', matrix));
  }
  if (stack) jobs.push(stack.ci);
  if (image) jobs.push(template('docker-cicd/ci/image.yml').replace('__STACK_JOBS__', stack.jobs.join(', ')));
  // ci-ok needs every job that runs on a pull request; the deploy job runs on main only.
  const needs = jobs.flatMap(topKeys);
  if (cd) jobs.push(template(`docker-cicd/ci/${cd.job}`));
  jobs.push(template('ci/ci-ok.yml').replace('__NEEDS__', needs.join(', ')));
  return template('ci/header.yml') + jobs.map((j) => indent(j.trimEnd(), 2)).join('\n\n') + '\n';
}

function dependabot(stack, image) {
  const ecosystems = [
    { ecosystem: 'github-actions', directory: '/' },
    { ecosystem: 'pre-commit', directory: '/' },
    ...(stack?.dependabot ?? []),
    ...(image ? [{ ecosystem: 'docker', directory: '/' }] : []),
  ];
  const entry = ({ ecosystem, directory }) => [
    `  - package-ecosystem: "${ecosystem}"`,
    `    directory: "${directory}"`,
    '    schedule:',
    '      interval: "weekly"',
    '    cooldown:',
    '      default-days: 14',
    '    groups:',
    `      ${ecosystem}:`,
    '        patterns:',
    '          - "*"',
  ].join('\n');
  return `version: 2\nupdates:\n${ecosystems.map(entry).join('\n')}\n`;
}

function preCommit(stack) {
  const hooks = stack?.preCommit.trim() ? `\n${indent(stack.preCommit.trimEnd(), 2)}` : '';
  return template('pre-commit-config.yaml').trimEnd() + hooks + '\n';
}

/**
 * The repo files of the standard for a selection, as `[{ path, content }]` in write order.
 * `stack`: a loaded stack module or null (then only the stack-independent parts are written);
 * `deploy`: container | webspace | paas | none; `skip`: Set of item ids that are left out.
 */
export function render({ stack, deploy, skip }) {
  const sel = parts({ stack, deploy, skip });
  const files = [{ path: '.github/workflows/ci.yml', content: ciWorkflow({ stack, skip }, sel) }];
  if (sel.cd) {
    const path = `.github/workflows/${sel.cd.workflow}`;
    files.push({ path, content: template(`docker-cicd/github/workflows/${sel.cd.workflow}`) });
  }
  files.push({ path: '.github/dependabot.yml', content: dependabot(stack, sel.image) });
  files.push({ path: '.pre-commit-config.yaml', content: preCommit(stack) });
  if (sel.image) files.push(...stack.docker);
  return files;
}

// --- plan and apply -----------------------------------------------------------------------------

/** The repo root; a plan (`apply` false) may name a folder that does not exist yet (a new project). */
function repoFolder(dir, { apply } = {}) {
  const root = resolve(dir);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    if (!apply && !existsSync(root)) return root; // planned like an empty repo; nothing is read or written
  }
  if (!isDir) throw new Error(`not a folder: ${root}`);
  if (!existsSync(join(root, '.git'))) throw new Error(`not a git repo: ${root}`);
  return root;
}

/** The first detected stack a module could cover, else the first unsupported one, else null. */
function defaultStack(root) {
  const { supported, unsupported } = detectStacks(root);
  return supported.find((s) => STACK_IDS.includes(s)) ?? unsupported[0] ?? null;
}

/** The detected deploy target; without evidence nothing is deployed ('none'). */
function defaultDeploy(root) {
  const { target } = detectDeploy(root);
  return DEPLOY_TARGETS.includes(target) ? target : 'none';
}

/**
 * What the options select: the stack module, the deploy target and the skipped items with their
 * reason. `deviations` are the skips a person decided (deselection, private repo); a deploy that
 * falls away with the image or by its target is a consequence, not a deviation.
 */
function selection(root, model, { stack, deploy, visibility = 'public', without, starter }, stacksDir) {
  if (deploy !== undefined && !DEPLOY_TARGETS.includes(deploy)) {
    throw new Error(`--deploy must be one of ${DEPLOY_TARGETS.join(', ')}`);
  }
  if (!VISIBILITIES.includes(visibility)) throw new Error(`--visibility must be one of ${VISIBILITIES.join(', ')}`);
  if (stack !== undefined && !STACK_ID.test(stack)) {
    throw new Error(`invalid --stack '${stack}': lowercase letters, digits and -, starting with a letter`);
  }
  const deselected = deselections(model, without);
  const stackId = stack ?? defaultStack(root);
  const module = stackId ? loadStack(stackId, stacksDir) : null;
  const target = deploy ?? defaultDeploy(root);
  if (starter && !module?.starter.length) {
    throw new Error('--starter needs a stack module with a starter; '
      + (stackId ? `'${stackId}' has none` : 'no stack detected (choose one with --stack)'));
  }

  const skips = new Map();
  const deviations = [];
  for (const item of model.items.filter((i) => i.where === 'repo')) {
    let reason = deselected.get(item.id);
    if (!reason && visibility === 'private' && item.paidOnPrivate) reason = PRIVATE_REASON;
    if (!reason) continue;
    skips.set(item.id, reason);
    deviations.push({ id: item.id, class: item.class, reason });
  }
  if (module && !hasDockerfile(module) && !skips.has('container-image')) {
    skips.set('container-image', 'the stack module provides no Dockerfile');
  }
  // A Python library is not deployed as a container: Buildorder proposes the deviation "no Docker".
  if (module?.id === 'python' && hasDockerfile(module) && !skips.has('container-image') && isPythonLibrary(root)) {
    const reason = 'library (no entry point, no server dependency): no container image';
    skips.set('container-image', reason);
    deviations.push({ id: 'container-image', class: 'standard', reason });
  }
  if (!skips.has('deploy')) {
    if (skips.has('container-image')) skips.set('deploy', 'needs container-image, which is skipped');
    else if (target === 'none') skips.set('deploy', 'deploy target none');
    else if (target === 'paas') skips.set('deploy', 'deploy target paas: the provider deploys, no CD file');
  }
  return {
    stackId,
    stack: module,
    starter: Boolean(starter),
    deploy: target,
    visibility,
    skips,
    skip: new Set(skips.keys()),
    deviations,
  };
}

// Packages that serve requests: a repo depending on one is a service, whatever its framework.
const SERVER_PACKAGES = ['gunicorn', 'uvicorn', 'hypercorn', 'waitress', 'daphne', 'granian', 'fastapi', 'flask',
  'starlette', 'aiohttp', 'sanic', 'tornado', 'litestar', 'bottle'];
const SERVER_DEP = new RegExp(`^(?:${SERVER_PACKAGES.join('|')})(?![a-z0-9_.-])`);

/**
 * Whether a Python repo is a library: no entry point (`[project.scripts]`), no server dependency
 * (pyproject.toml, requirements*.txt) and no Dockerfile of its own. Evidence of a service wins, so a
 * repo without any manifest counts as a library.
 */
function isPythonLibrary(root) {
  if (existsSync(join(root, 'Dockerfile'))) return false;
  const pyproject = readText(join(root, 'pyproject.toml')) ?? '';
  if (/^\[(project|tool\.poetry)\.scripts\]/m.test(pyproject)) return false;
  if (!existsSync(root)) return true;
  const requirements = readdirSync(root).filter((n) => /^requirements.*\.txt$/.test(n))
    .flatMap((n) => (readText(join(root, n)) ?? '').split('\n'));
  const deps = [...pyprojectDeps(pyproject), ...requirements.map((l) => l.replace(/#.*/, ''))];
  return !deps.some((d) => SERVER_DEP.test(d.trim().toLowerCase()));
}

/** All workflow files of the repo as one text ('' without any). */
function workflowText(root) {
  const dir = join(root, '.github', 'workflows');
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch { /* no workflows */ }
  return names.map((n) => readText(join(dir, n)) ?? '').join('\n');
}

const USES = /^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/gm;

/** Workflows exist and every remote `uses:` is pinned to a full commit SHA. */
function allPinned(text) {
  const refs = [...text.matchAll(USES)].map((m) => m[1]).filter((u) => !/^(\.\/|\$\/|docker:\/\/)/.test(u));
  return text.trim() !== '' && refs.every((u) => /@[0-9a-f]{40}$/.test(u));
}

function passes(root, check, workflows) {
  if (!check) return false;
  if (check.files && !check.files.some((f) => existsSync(join(root, ...f.split('/'))))) return false;
  if (check.workflow && !check.workflow.every((p) => new RegExp(p).test(workflows))) return false;
  if (check.pins && !allPinned(workflows)) return false;
  return true;
}

/** How an item is checked: the model's check, the stack module's pattern, or the CD workflow file. */
function checkFor(item, sel) {
  if (item.provider === 'stack') {
    const pattern = sel.stack?.provides?.[item.id];
    return pattern ? { workflow: [pattern] } : null;
  }
  if (item.id === 'deploy') {
    const cd = CD[sel.deploy];
    return cd ? { files: [`.github/workflows/${cd.workflow}`] } : null;
  }
  return item.check ?? null;
}

const stackGap = (sel) => (sel.stackId ? `no stack module for '${sel.stackId}'` : 'no stack detected');

/** Why a missing item cannot be written here, or null when the standard writes it. */
function missingReason(item, sel) {
  if (sel.stack) return null;
  if (item.provider === 'stack') return stackGap(sel);
  if (item.provider === 'docker-cicd') return 'needs a stack module (Dockerfile)';
  return null;
}

function itemsOf(root, model, sel) {
  const workflows = workflowText(root);
  return model.items.filter((i) => i.where === 'repo').map((item) => {
    const base = { id: item.id, class: item.class, provider: item.provider };
    if (sel.skips.has(item.id)) return { ...base, state: 'skipped', reason: sel.skips.get(item.id) };
    if (passes(root, checkFor(item, sel), workflows)) return { ...base, state: 'present' };
    const reason = missingReason(item, sel);
    return reason ? { ...base, state: 'missing', reason } : { ...base, state: 'missing' };
  });
}

/** Supported stacks the repo shows besides the one the standard is built for (a module covers one stack). */
function uncoveredStacks(root, sel) {
  const { supported } = detectStacks(root);
  return supported.filter((s) => STACK_IDS.includes(s) && s !== sel.stackId);
}

function notesOf(root, sel, { image, cd }) {
  const notes = [];
  // Without a stack module there is no "covered" stack to compare with; the gap note below says it.
  for (const id of sel.stack ? uncoveredStacks(root, sel) : []) {
    notes.push(`'${id}' is also detected but not covered: the stack module '${sel.stackId}' sets up lint, tests with `
      + `coverage, build and dependency audit for '${sel.stackId}' only; add the checks for '${id}' to ci.yml by hand`);
  }
  if (!sel.stack) {
    notes.push(`${stackGap(sel)}: lint, tests with coverage, build and dependency audit are not set up; `
      + 'add them to ci.yml by hand');
  }
  if (cd?.workflow === 'deployment.yml') {
    notes.push('deploy target container: add docker-compose.prod.yaml (it reads APP_IMAGE), then set the variable '
      + 'DEPLOY_ENABLED=true and the secrets listed in .github/workflows/deployment.yml');
  }
  if (cd?.workflow === 'deployment-webspace.yml') {
    notes.push('deploy target webspace: the image holds the site in /usr/share/nginx/html with an .htaccess; then set '
      + 'the variable DEPLOY_ENABLED=true and the secrets listed in .github/workflows/deployment-webspace.yml');
  }
  if (sel.deploy === 'paas' && image && !sel.deviations.some((d) => d.id === 'deploy')) {
    notes.push("deploy target paas: connect the repo in the provider's dashboard; it builds and deploys from main, "
      + 'so no CD file is written');
  }
  if (sel.visibility === 'private' && image) {
    notes.push('private repo: the build-provenance attestation step runs only in public repos '
      + '(private ones need GitHub Enterprise Cloud)');
  }
  notes.push('pre-commit hooks locally, once per clone: pipx install pre-commit && pre-commit install');
  return notes;
}

/** What --apply writes: the starter files (with --starter), then the standard's repo files. */
const filesOf = (sel) => [...(sel.starter ? sel.stack.starter : []), ...render(sel)];

function report(root, model, sel) {
  const { image, cd } = parts(sel);
  return {
    stack: { id: sel.stackId, module: Boolean(sel.stack) },
    deploy: sel.deploy,
    visibility: sel.visibility,
    modules: [...(sel.stack ? [sel.stack.id] : []), ...(image ? ['docker-cicd'] : [])],
    items: itemsOf(root, model, sel),
    files: filesOf(sel).map(({ path }) => ({ path, state: existsSync(join(root, ...path.split('/'))) ? 'exists' : 'create' })),
    deviations: sel.deviations,
    notes: notesOf(root, sel, { image, cd }),
  };
}

// git's own warnings and hints (e.g. LF will be replaced by CRLF) come before the cause, so they are passed over.
const firstLine = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.find((l) => !/^(warning|hint): /.test(l)) ?? lines[0] ?? 'unknown error';
};

/** Throws when git could not commit in `root` for lack of an identity; checked before anything is written. */
function requireIdentity(root) {
  const known = ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].every((v) => gitResult(root, ['var', v]).ok);
  if (!known) throw new Error(`git has no user.name and user.email for ${root}; set them (git config), then run again`);
}

/**
 * Stages and commits exactly `files` (other staged changes stay staged): `{ head }`, or `{ error }` when
 * git refused (signing, a hook, core.safecrlf). The files stay in place either way.
 */
function commitFiles(root, files, message) {
  const add = gitResult(root, ['add', '--', ...files]);
  if (!add.ok) return { error: `git add failed: ${firstLine(add.stderr)}` };
  const commit = gitResult(root, ['commit', '-q', '-m', message, '--', ...files]);
  if (!commit.ok) return { error: `git commit failed: ${firstLine(commit.stderr)}` };
  return { head: gitResult(root, ['rev-parse', 'HEAD']).stdout };
}

/**
 * The plan's files that a run before wrote but could not commit: present with exactly the planned content,
 * yet not in HEAD. A file of the user's own at a planned path differs in content and is never taken.
 */
function uncommitted(root, files) {
  const present = files.filter(({ path, content }) => {
    const abs = join(root, ...path.split('/'));
    try {
      return statSync(abs).isFile() && readFileSync(abs).equals(Buffer.from(content));
    } catch {
      return false;
    }
  });
  if (!present.length) return [];
  // Before the first commit there is no HEAD: nothing is committed yet.
  const tree = gitResult(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...present.map((f) => f.path)],
    { trim: false });
  const inHead = new Set(tree.ok ? tree.stdout.split('\0').filter(Boolean) : []);
  return present.map((f) => f.path).filter((p) => !inHead.has(p));
}

/**
 * Records `standards` on the repo's entry in the enclosing workspace.json, and refreshes its `isCode` and `stacks`
 * from this repo's own files (never the whole workspace): the entry was written when the repo was still empty.
 * `{ dir, recorded }`, plus a `reason` when there is no entry to record on; null outside a workspace.
 */
function record(root, standards) {
  const wsRoot = findWorkspaceRoot(root);
  const ws = wsRoot ? loadWorkspace(wsRoot) : null;
  if (!ws) return null;
  const rel = relativeTo(root, wsRoot);
  const entry = (Array.isArray(ws.repos) ? ws.repos : [])
    .find((r) => typeof r?.path === 'string' && relativeTo(resolve(wsRoot, r.path), wsRoot) === rel);
  if (!entry) return { dir: wsRoot, recorded: false, reason: `no entry for '${rel}' in workspace.json` };
  entry.standards = standards;
  Object.assign(entry, repoCode(root));
  writeJson(join(wsRoot, '.claude', 'workspace.json'), ws);
  return { dir: wsRoot, recorded: true };
}

/**
 * The standard for the code repo `dir`. Options: `stack` (default: detected), `deploy`
 * (container | webspace | paas | none; default: detected, else none), `visibility` (public | private;
 * default public), `without` (['<id>=<reason>']), `starter` (also write the stack module's starter
 * project, for an empty repo; an error without a module that has one), `apply`. `stacksDir` replaces
 * the stack modules folder.
 *
 * Without `apply` it only reads and returns the plan: items with class and state (present | missing |
 * skipped), the files to write (create | exists), deviations and notes. For an existing project
 * this plan is the gap list; a folder that does not exist yet is planned as an empty repo (the confirmation
 * of a new project, before `git init`). With `apply` it writes the missing files (never overwrites), commits
 * them in one commit (no push), records `standards` in the enclosing workspace.json and returns the
 * plan's files with `created`, `skipped`, `committed`, `commit` and `workspace`; `items` show the state afterwards.
 * When git refuses the commit, the result is `ok: false` with `reason`; the written files stay, and a rerun
 * commits them (written files with the planned content that are not in HEAD yet).
 * Throws before writing anything when an option is invalid, `dir` is no git repo, or (with files to write)
 * git has no identity to commit with.
 */
export function standard(dir, opts = {}, { stacksDir = STACKS_DIR } = {}) {
  if (opts.gaps && opts.apply) throw new Error('--gaps lists the plan and cannot be combined with --apply');
  const root = repoFolder(dir, opts);
  const model = loadModel();
  const sel = selection(root, model, opts, stacksDir);
  const plan = report(root, model, sel);
  if (!opts.apply) return { ok: true, repo: root, applied: false, ...plan };

  const files = filesOf(sel);
  // A rerun after a failed commit finds its files written but not committed, and commits them now.
  const pending = uncommitted(root, files);
  if (pending.length || plan.files.some((f) => f.state === 'create')) requireIdentity(root);
  const created = [];
  const skipped = [];
  for (const { path, content } of files) {
    const abs = join(root, ...path.split('/'));
    if (existsSync(abs)) {
      skipped.push(path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, { flag: 'wx' });
    created.push(path);
  }
  const message = sel.starter ? starterMessage(sel.stack.id) : COMMIT_MESSAGE;
  const committed = files.map((f) => f.path).filter((p) => created.includes(p) || pending.includes(p));
  const done = committed.length ? commitFiles(root, committed, message) : { head: null };
  if (done.error) {
    // Not ok: init must not report the commit as made. The files stay; a rerun commits them.
    const after = report(root, model, sel);
    return {
      ok: false, repo: root, applied: true, reason: done.error, ...after,
      files: plan.files, created, skipped, committed: [], commit: null, workspace: null,
    };
  }
  const workspace = record(root, { modules: plan.modules, deviations: sel.deviations });
  const after = report(root, model, sel);
  return {
    ok: true, repo: root, applied: true, ...after, files: plan.files, created, skipped, committed, commit: done.head, workspace,
  };
}

// --- gap list as backlog tasks -------------------------------------------------------------------

const GAP_PREFIX = 'STD';
const NO_GAPS = 'No gaps: every repo item of the standard is present or deliberately skipped.\n';

/** The repo as the backlog names it: its path in the enclosing workspace, else its folder name. */
function repoLabel(root) {
  const wsRoot = findWorkspaceRoot(root);
  const rel = wsRoot ? relativeTo(root, wsRoot) : null;
  return rel || basename(root);
}

/**
 * A plan's missing items as backlog markdown: short-list rows (`| ID | Prio | Task | Epic |`), then
 * one detail block. Mandatory gaps are P0, standard gaps P1; skipped items are deviations, no gaps.
 */
export function gapList(plan) {
  const summaries = new Map(loadModel().items.map((i) => [i.id, i.summary]));
  const repo = repoLabel(plan.repo);
  const gaps = plan.items.filter((i) => i.state === 'missing').map((item, n) => ({
    id: `${GAP_PREFIX}-${String(n + 1).padStart(2, '0')}`,
    prio: item.class === 'mandatory' ? 'P0' : 'P1',
    task: `Add to \`${repo}\`: ${summaries.get(item.id) ?? item.id}${item.reason ? ` (${item.reason})` : ''}`,
    item: item.id,
  }));
  if (!gaps.length) return NO_GAPS;
  const rows = gaps.map((g) => `| ${g.id} | ${g.prio} | ${g.task} | ${GAP_PREFIX} |`);
  const tasks = gaps.map((g) => [
    `- [ ] **${g.id}** (${g.prio}) ${g.task}`,
    `  Goal: the repo meets the standard item \`${g.item}\` · Boundaries: a branch and a pull request of its own, `
      + `no other changes · Done: \`standard\` lists \`${g.item}\` as present`,
  ].join('\n'));
  return [
    ...rows,
    '',
    `## ${GAP_PREFIX} — Gaps to the Buildorder standard`,
    '',
    `> Source: the gap list of \`buildorder.mjs standard\` for \`${repo}\`. Mandatory gaps are P0, standard gaps P1.`,
    '',
    ...tasks,
    '',
  ].join('\n');
}
