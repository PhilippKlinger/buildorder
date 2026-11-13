// github-checklist: the GitHub settings of the standard (rulesets, secret scanning, push protection,
// Dependabot alerts) as a checklist with ready `gh` commands in the workspace. It never calls the API:
// the person runs the commands once the repo exists on GitHub (AK-6, K5).
// github-plan: the same steps (create, push, settings) as argument arrays, read-only, for Init to run
// after consent (C2).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { PLUGIN_ROOT, maskRemote } from './detect.mjs';
import { git, gitResult } from './git.mjs';
import { relativeTo } from './paths.mjs';
import { VISIBILITIES } from './standard.mjs';
import { findWorkspaceRoot, loadWorkspace } from './workspace.mjs';

const CHECKLIST = 'docs/github-settings.md';
const RULESET = 'docs/github-ruleset.json';
const REQUIRED_CHECK = 'ci-ok'; // the job every generated ci.yml ends with
const STEPS = ['create', 'push', 'settings'];

/** The ruleset for the default branch: pull requests only, no force push, no deletion, `ci-ok` required. */
export const RULESET_BODY = {
  name: 'main',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        // 0 approvals: a solo developer merges their own pull request once the checks pass.
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
    {
      type: 'required_status_checks',
      parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: REQUIRED_CHECK }] },
    },
  ],
};

const GITHUB_REMOTE = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/**
 * `{ slug, remote }`: `owner/name` from a GitHub origin, else the `given` one (from the interview), else
 * the placeholder `OWNER/<folder>`. `remote` is false only for the placeholder.
 */
function originMatch(abs) {
  const url = git(abs, ['remote', 'get-url', 'origin']);
  return url ? maskRemote(url).match(GITHUB_REMOTE) : null;
}

function slugOf(abs, given) {
  const m = originMatch(abs);
  if (m) return { slug: `${m[1]}/${m[2]}`, remote: true };
  if (given) return { slug: given, remote: true };
  return { slug: `OWNER/${basename(abs).replace(/[^\w.-]+/g, '-')}`, remote: false };
}

// A ruleset without required checks, for a repo whose CI has no `ci-ok` job yet: requiring it would hold every PR.
const LOOSE_RULESET = 'docs/github-ruleset-without-checks.json';
const LOOSE_BODY = { ...RULESET_BODY, rules: RULESET_BODY.rules.filter((r) => r.type !== 'required_status_checks') };

/** Whether a workflow of the repo defines the `ci-ok` job. */
function hasCiOk(abs) {
  const dir = join(abs, '.github', 'workflows');
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  } catch { /* no workflows */ }
  const job = new RegExp(`^\\s+${REQUIRED_CHECK}:\\s*$`, 'm');
  return names.some((n) => {
    try {
      return job.test(readFileSync(join(dir, n), 'utf8'));
    } catch {
      return false;
    }
  });
}

// The checklist text per docs language (`language.docs` of the workspace): templates/github/<lang>/checklist.json,
// a string or a list of lines per key. `{{slug}}`, `{{check}}`, `{{ruleset}}` and `{{date}}` are filled in; the
// commands are the same in every language.
const loadTexts = (lang) => JSON.parse(readFileSync(join(PLUGIN_ROOT, 'templates', 'github', lang, 'checklist.json'), 'utf8'));
const fill = (v, vals) => (Array.isArray(v) ? v.map((s) => fill(s, vals)) : v.replace(/\{\{(\w+)\}\}/g, (m, key) => vals[key] ?? m));
const lines = (v) => (Array.isArray(v) ? v : [v]);

/** The settings commands of the standard as argument arrays: the one source of the checklist and the plan. */
function settingsCommands(slug, { ciOk, visibility }) {
  const api = (method, path, ...rest) => ['gh', 'api', '--method', method, path, ...rest];
  return {
    ruleset: api('POST', `repos/${slug}/rulesets`, '--input', ciOk ? RULESET : LOOSE_RULESET),
    // Needs the ruleset id from GitHub, so only the checklist shows it; the plan leaves it out.
    requireLater: ciOk ? null : api('PUT', `repos/${slug}/rulesets/RULESET_ID`, '--input', RULESET),
    secrets: visibility === 'private' ? null : api('PATCH', `repos/${slug}`,
      '-f', 'security_and_analysis[secret_scanning][status]=enabled',
      '-f', 'security_and_analysis[secret_scanning_push_protection][status]=enabled'),
    alerts: api('PUT', `repos/${slug}/vulnerability-alerts`),
  };
}

const createCommand = (slug, visibility, path) => ['gh', 'repo', 'create', slug, `--${visibility}`, '--source', path, '--remote', 'origin'];
const pushCommand = (path) => ['git', '-C', path, 'push', '-u', 'origin', 'main'];
// A command as one shell line: arguments with brackets or blanks get double quotes.
const shellLine = (cmd) => cmd.map((a) => (/^[\w./=:@%+-]+$/.test(a) ? a : `"${a}"`)).join(' ');

function section(repo, tx, stepsMode) {
  const { path, slug, remote, visibility, done, date } = repo;
  const cmds = settingsCommands(slug, repo);
  const t = (key) => lines(fill(tx[key], { slug, check: REQUIRED_CHECK, ruleset: RULESET_BODY.name, date }));
  const block = (cmd) => ['  ```', `  ${shellLine(cmd)}`, '  ```'];
  const ruleset = repo.ciOk
    ? [...t('ruleset'), ...block(cmds.ruleset)]
    : [...t('looseRuleset'), ...block(cmds.ruleset), ...t('requireLater'), ...block(cmds.requireLater)];
  const secrets = cmds.secrets ? [...t('secrets'), ...block(cmds.secrets)] : t('privateSecrets');
  const settings = [...ruleset, ...secrets, ...t('alerts'), ...block(cmds.alerts), ...t('verify')];
  // Only with --done: the create and push steps, ticked with the date or still open with their command.
  const createOpen = remote ? [] : [...t('createOpen'), ...(visibility ? block(createCommand(slug, visibility, path)) : [])];
  const stepLines = !stepsMode ? [] : [
    ...(done.has('create') ? t('createDone') : createOpen),
    ...(done.has('push') ? t('pushDone') : [...t('pushOpen'), ...block(pushCommand(path))]),
  ];
  return [
    `## ${path} (\`${slug}\`)`,
    '',
    ...(remote ? [] : [...t('noRemote'), '']),
    ...stepLines,
    ...(done.has('settings') ? t('settingsDone') : settings),
    '',
  ];
}

function markdown(repos, lang, stepsMode) {
  const tx = loadTexts(lang);
  return [
    ...lines(tx.title),
    '',
    ...tx.intro,
    '',
    ...(repos.length ? repos.flatMap((r) => section(r, tx, stepsMode)) : [tx.noRepos, '']),
    ...tx.outro,
    '',
  ].join('\n');
}

/** `owner/name` as GitHub allows it: owner up to 39 chars of letters, digits, hyphens; name not `.`/`..`, no leading `-`. */
function validSlug(slug) {
  const m = typeof slug === 'string' ? slug.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)$/) : null;
  return Boolean(m) && m[2] !== '.' && m[2] !== '..' && !m[2].startsWith('-');
}

/** `{ repo, abs, rel }` for every registered repo that is a git repo inside the workspace. */
function workspaceRepos(root, ws) {
  const found = [];
  for (const repo of Array.isArray(ws.repos) ? ws.repos : []) {
    if (typeof repo?.path !== 'string') continue;
    const abs = resolve(root, repo.path);
    const rel = relativeTo(abs, root);
    if (!rel || !existsSync(join(abs, '.git'))) continue;
    found.push({ repo, abs, rel });
  }
  return found;
}

const lf = (text) => text.replace(/\r\n/g, '\n');

const slashes = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

/** `<path>=<value>` as `[path, value]`; throws naming `flag` when it has no `=` or an empty side. */
function splitPair(v, flag, what) {
  const i = typeof v === 'string' ? v.indexOf('=') : -1;
  if (i < 1 || i === v.length - 1) throw new Error(`${flag} must look like <path>=<${what}>`);
  return [slashes(v.slice(0, i)), v.slice(i + 1)];
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Writes the checklist (in the workspace's `language.docs`, `de` or else English) and the ruleset body (plus one without required checks when a repo has no `ci-ok`
 * job yet) into the workspace that encloses `dir`, never overwriting:
 * `{ ok, dir, files: [{ path, state: created | exists }], repos: [{ path, slug, remote, ciOk, visibility }] }`.
 * `visibility` comes from the repo entry (null when unknown); a private repo gets no secret scanning commands.
 * `repo` (`owner/name`, from the interview) names the repo when it has no GitHub origin yet; a local origin wins.
 * `done` (`<path>=<create|push|settings>` entries) ticks those steps with today's date and lists the create and push
 * steps of every repo; without it the checklist is the plain settings list. With `done` an existing checklist is
 * ticked in place (state `updated`) only if it equals the plain text byte for byte (CRLF as LF), else it stays
 * (state `changed`).
 * Throws outside a Buildorder workspace, for a malformed `repo` and for an unknown `done` path or step (before any write).
 */
export function githubChecklist(dir, { repo: given, done = [] } = {}) {
  if (given !== undefined && !validSlug(given)) throw new Error('--repo must look like owner/name (a GitHub owner and repo name)');
  const root = findWorkspaceRoot(dir);
  const ws = root ? loadWorkspace(root) : null;
  if (!ws) throw new Error(`not inside a Buildorder workspace: ${resolve(dir)}`);
  // The docs language of the workspace; anything but `de` (missing, unknown) keeps the English text.
  const lang = ws.language?.docs === 'de' ? 'de' : 'en';
  const found = workspaceRepos(root, ws);
  const doneBy = new Map(found.map((f) => [slashes(f.rel), new Set()]));
  for (const entry of done) {
    const [path, step] = splitPair(entry, '--done', 'create|push|settings');
    if (!doneBy.has(path)) throw new Error(`--done: unknown repo path '${path}'`);
    if (!STEPS.includes(step)) throw new Error(`--done: unknown step '${step}' (create, push or settings)`);
    doneBy.get(path).add(step);
  }
  // `--repo` names one repo; with several candidates (or none) it could name the wrong one.
  if (given !== undefined && found.filter((f) => !originMatch(f.abs)).length !== 1) {
    throw new Error('--repo only works when the workspace has exactly one repo without a GitHub origin; set the origin instead');
  }
  const repos = [];
  for (const { repo, abs, rel } of found) {
    const visibility = VISIBILITIES.includes(repo.visibility) ? repo.visibility : null;
    repos.push({ path: rel, ...slugOf(abs, given), ciOk: hasCiOk(abs), visibility });
  }
  const date = today();
  const view = repos.map((r) => ({ ...r, done: doneBy.get(slashes(r.path)), date }));
  const content = {
    [CHECKLIST]: markdown(view, lang, done.length > 0),
    [RULESET]: JSON.stringify(RULESET_BODY, null, 2) + '\n',
    ...(repos.some((r) => !r.ciOk) ? { [LOOSE_RULESET]: JSON.stringify(LOOSE_BODY, null, 2) + '\n' } : {}),
  };
  const files = Object.entries(content).map(([path, text]) => {
    const abs = join(root, ...path.split('/'));
    if (existsSync(abs)) {
      if (done.length === 0) return { path, state: 'exists' };
      // With --done: tick in place only when the file is still exactly the plain checklist, else leave the person's edits.
      if (path !== CHECKLIST) return { path, state: 'exists' };
      const plain = markdown(view, lang, false);
      if (lf(readFileSync(abs, 'utf8')) !== lf(plain)) return { path, state: 'changed' };
      writeFileSync(abs, text);
      return { path, state: 'updated' };
    }
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(abs, text, { flag: 'wx' });
    return { path, state: 'created' };
  });
  return { ok: true, dir: root, files, repos };
}

/**
 * The GitHub step per repo as data, read-only (no `gh`, no network, no file written):
 * `{ ok, repos: [{ path, slug, visibility, steps }], docs }`. A step is `{ kind, commands: [string[]] }` or
 * `{ kind, skipped }` (`origin exists` or `no visibility` for create; `no main` or `dirty` for push). `docs` is null
 * unless `docs` is set: then the workspace root gets one private `create` step.
 * `owner` is required; `name` lists `<path>=<name>` (`.` names the docs repo); the default name is the folder name,
 * the docs repo's `<workspace name>-docs`. Throws outside a Buildorder workspace and for a bad owner, name or path.
 */
export function githubPlan(dir, { owner, name = [], docs = false } = {}) {
  if (typeof owner !== 'string' || !validSlug(`${owner}/x`)) throw new Error('--owner must be a GitHub login (letters, digits, hyphens)');
  const root = findWorkspaceRoot(dir);
  const ws = root ? loadWorkspace(root) : null;
  if (!ws) throw new Error(`not inside a Buildorder workspace: ${resolve(dir)}`);
  const found = workspaceRepos(root, ws);
  const names = new Map();
  for (const entry of name) {
    const [path, value] = splitPair(entry, '--name', 'name');
    if (!found.some((f) => slashes(f.rel) === path) && !(docs && path === '.')) throw new Error(`--name: unknown repo path '${path}'`);
    if (!validSlug(`${owner}/${value}`)) throw new Error(`--name: '${value}' is not a valid repo name`);
    names.set(path, value);
  }
  const repos = found.map(({ repo, abs, rel }) => {
    const path = slashes(rel);
    const visibility = VISIBILITIES.includes(repo.visibility) ? repo.visibility : null;
    const origin = originMatch(abs);
    const slug = origin ? `${origin[1]}/${origin[2]}` : `${owner}/${names.get(path) ?? basename(abs)}`;
    const steps = [];
    if (origin) steps.push({ kind: 'create', skipped: 'origin exists' });
    else if (!visibility) steps.push({ kind: 'create', skipped: 'no visibility' });
    else steps.push({ kind: 'create', commands: [createCommand(slug, visibility, path)] });
    // Without an origin and without a create step there is nothing to push to or to configure.
    if (!origin && !steps[0].commands) {
      steps.push({ kind: 'push', skipped: 'no origin' }, { kind: 'settings', skipped: 'no origin' });
      return { path, slug, visibility, steps };
    }
    const hasMain = gitResult(abs, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).ok;
    const clean = gitResult(abs, ['status', '--porcelain']);
    if (!hasMain) steps.push({ kind: 'push', skipped: 'no main' });
    else if (!clean.ok || clean.stdout !== '') steps.push({ kind: 'push', skipped: 'dirty' });
    else steps.push({ kind: 'push', commands: [pushCommand(path)] });
    const { requireLater, ...runnable } = settingsCommands(slug, { ciOk: hasCiOk(abs), visibility });
    steps.push({ kind: 'settings', commands: Object.values(runnable).filter(Boolean) });
    return { path, slug, visibility, steps };
  });
  let docsPlan = null;
  if (docs) {
    const docsName = names.get('.') ?? `${ws.name ?? basename(root)}-docs`.replace(/[^\w.-]+/g, '-');
    const slug = `${owner}/${docsName}`;
    const step = originMatch(root)
      ? { kind: 'create', skipped: 'origin exists' }
      : { kind: 'create', commands: [createCommand(slug, 'private', '.')] };
    docsPlan = { path: '.', slug, visibility: 'private', steps: [step] };
  }
  return { ok: true, repos, docs: docsPlan };
}
