// github-checklist: the GitHub settings of the standard (rulesets, secret scanning, push protection,
// Dependabot alerts) as a checklist with ready `gh` commands in the workspace. It never calls the API:
// the person runs the commands once the repo exists on GitHub (AK-6, K5).
// github-plan: the same steps (create, push, settings) as argument arrays, read-only, for Init to run
// after consent (C2).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { PLUGIN_ROOT, maskRemote } from './detect.mjs';
import { writeJson } from './fsx.mjs';
import { git, gitResult } from './git.mjs';
import { relativeTo } from './paths.mjs';
import { WORKSPACE_JSON, textHash } from './scaffold.mjs';
import { VISIBILITIES } from './standard.mjs';
import { findWorkspaceRoot, loadWorkspace } from './workspace.mjs';

const CHECKLIST = 'docs/github-settings.md';
const RULESET = 'docs/github-ruleset.json';
const REQUIRED_CHECK = 'ci-ok'; // the job every generated ci.yml ends with
const STEPS = ['create', 'push', 'settings'];
// What `--done` can tick: the three steps, or one settings command on its own (`settings` means all of them).
const SETTINGS_PARTS = ['alerts', 'secrets', 'ruleset'];
const DONE_STEPS = [...STEPS, ...SETTINGS_PARTS.map((n) => `settings:${n}`)];

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

// A GitHub origin: `github.com` is the host, right after the scheme and the user (`https://github.com/o/x`, the scp
// form `<user>@github.com:o/x`, `ssh://<user>@github.com:22/o/x`), never `github.com` further down another host's path.
const GITHUB_REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/:]+@)?github\.com(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** The origin of the repo at `abs`: `{ url, github }`, `url` masked (null without origin), `github` the GitHub match or null. */
function originOf(abs) {
  const raw = git(abs, ['remote', 'get-url', 'origin']);
  const url = raw ? maskRemote(raw) : null;
  return { url, github: url ? url.match(GITHUB_REMOTE) : null };
}

const originMatch = (abs) => originOf(abs).github;

/**
 * `{ slug, remote }`: `owner/name` from a GitHub origin, else the `given` one (from the interview), else
 * the placeholder `OWNER/<folder>`. `remote` is false only for the placeholder.
 */
function slugOf(abs, given) {
  const m = originMatch(abs);
  if (m) return { slug: `${m[1]}/${m[2]}`, remote: true };
  if (given) return { slug: given, remote: true };
  return { slug: `OWNER/${placeholderName(abs)}`, remote: false };
}

/** The folder name as a repo name: blanks and other characters GitHub refuses become a hyphen. */
const placeholderName = (abs) => basename(abs).replace(/[^\w.-]+/g, '-');

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
  // An origin on another host: Buildorder sets nothing up there.
  if (slug === null) return [`## ${path}`, '', ...lines(tx.nonGithub), ''];
  const cmds = settingsCommands(slug, repo);
  const t = (key) => lines(fill(tx[key], { slug, check: REQUIRED_CHECK, ruleset: RULESET_BODY.name, date }));
  const block = (cmd) => ['  ```', `  ${shellLine(cmd)}`, '  ```'];
  // A settings command ticked on its own (`settings:<name>`) shows as done; requiring ci-ok later stays open.
  const ticked = (name) => done.has(`settings:${name}`);
  const later = repo.ciOk ? [] : [...t('requireLater'), ...block(cmds.requireLater)];
  let ruleset;
  if (ticked('ruleset')) ruleset = [...t('rulesetDone'), ...later];
  else if (repo.ciOk) ruleset = [...t('ruleset'), ...block(cmds.ruleset)];
  else ruleset = [...t('looseRuleset'), ...block(cmds.ruleset), ...later];
  let secrets = t('privateSecrets');
  if (cmds.secrets) secrets = ticked('secrets') ? t('secretsDone') : [...t('secrets'), ...block(cmds.secrets)];
  const alerts = ticked('alerts') ? t('alertsDone') : [...t('alerts'), ...block(cmds.alerts)];
  const settings = [...ruleset, ...secrets, ...alerts, ...t('verify')];
  // Only with --done: the create and push steps, ticked with the date or still open with their command.
  const createOpen = remote ? [] : [...t('createOpen'), ...(visibility ? block(createCommand(slug, visibility, path)) : [])];
  const stepLines = !stepsMode ? (repo.named ? createOpen : []) : [
    ...(done.has('create') ? t('createDone') : createOpen),
    ...(done.has('push') ? t('pushDone') : [...t('pushOpen'), ...block(pushCommand(path))]),
  ];
  return [
    `## ${path} (\`${slug}\`)`,
    '',
    ...(remote || repo.named ? [] : [...t('noRemote'), '']),
    ...stepLines,
    ...(done.has('settings') ? t('settingsDone') : settings),
    '',
  ];
}

/** The docs repo (`.`), only once `--done .=create` ticked it: one line, no push and no settings (spec C4). */
const docsSection = ({ slug, date }, tx) => [`## . (\`${slug}\`)`, '', ...lines(fill(tx.docsCreateDone, { date })), ''];

function markdown(repos, lang, stepsMode, docs = null) {
  const tx = loadTexts(lang);
  return [
    ...lines(tx.title),
    '',
    ...tx.intro,
    '',
    ...(repos.length ? repos.flatMap((r) => section(r, tx, stepsMode)) : [tx.noRepos, '']),
    ...(docs ? docsSection(docs, tx) : []),
    ...tx.outro,
    '',
  ].join('\n');
}

/** `owner/name` as GitHub allows it: owner up to 39 chars of letters, digits, hyphens; name not `.`/`..`, no leading `-`. */
function validSlug(slug) {
  const m = typeof slug === 'string' ? slug.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)$/) : null;
  return Boolean(m) && m[2] !== '.' && m[2] !== '..' && !m[2].startsWith('-');
}

/** The normalized workspace-relative path of `p` ('' for the root, null outside): the key every path comparison uses. */
const keyOf = (root, p) => relativeTo(resolve(root, p), root);

/**
 * `{ repo, abs, key, path }` for every registered repo that is a git repo inside the workspace: `key` is the
 * normalized path (lower case on Windows) for comparisons, `path` the recorded path with `/` for the output.
 */
function workspaceRepos(root, ws) {
  const found = [];
  const seen = new Set();
  for (const repo of Array.isArray(ws.repos) ? ws.repos : []) {
    if (typeof repo?.path !== 'string') continue;
    const abs = resolve(root, repo.path);
    const key = relativeTo(abs, root);
    if (!key || seen.has(key) || !existsSync(join(abs, '.git'))) continue;
    seen.add(key);
    found.push({ repo, abs, key, path: relative(root, abs).split(sep).join('/') });
  }
  return found;
}

const isRecord = (r) => r !== null && typeof r === 'object' && !Array.isArray(r);

const slashes = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

/** `<path>=<value>` as `[path, value]`; throws naming `flag` when it has no `=` or an empty side. */
function splitPair(v, flag, what) {
  const i = typeof v === 'string' ? v.indexOf('=') : -1;
  if (i < 1 || i === v.length - 1) throw new Error(`${flag} must look like <path>=<${what}>`);
  return [slashes(v.slice(0, i)), v.slice(i + 1)];
}

const OWNER_ERROR = '--owner must be a GitHub login (letters, digits, hyphens)';

/**
 * The --owner and --name <path>=<name> values both commands take, validated before anything is written:
 * Map<normalized path, name> (the docs repo is the empty key, accepted when `docs` is set). The owner may be missing
 * only when `optional` is set and no name is given. Throws on a bad owner, a malformed or unknown path and a bad name.
 */
function repoNames(root, found, { owner, name = [], docs = false, optional = false }) {
  if (owner === undefined && optional) {
    if (name.length) throw new Error('--name needs --owner');
  } else if (typeof owner !== 'string' || !validSlug(`${owner}/x`)) {
    throw new Error(OWNER_ERROR);
  }
  const keys = new Set(found.map((f) => f.key));
  const names = new Map();
  for (const entry of name) {
    const [path, value] = splitPair(entry, '--name', 'name');
    const key = keyOf(root, path);
    if (!(key === '' ? docs : keys.has(key))) throw new Error(`--name: unknown repo path '${path}'`);
    if (!validSlug(`${owner}/${value}`)) throw new Error(`--name: '${value}' is not a valid repo name`);
    names.set(key, value);
  }
  return names;
}

/** The default name of the docs repo: workspace name plus -docs. */
const docsNameOf = (ws, root) => `${ws.name ?? basename(root)}-docs`.replace(/[^\w.-]+/g, '-');

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
 * `done` (`<path>=<step>` entries: `create`, `push`, `settings` for all settings commands, or one of
 * `settings:alerts`, `settings:secrets`, `settings:ruleset`; the docs repo `.` has `create` only) ticks those steps
 * with today's date and lists the create and push steps of every repo; without it the checklist is the plain
 * settings list. Paths compare in normalized form; the output keeps the recorded path.
 * Every write of the checklist records its hash in workspace.json (`templateHashes['docs/github-settings.md'].file`,
 * sha256 with LF, as scaffold and sync record their files). With `done` an existing checklist is rewritten from the
 * current state (state `updated`) only while its hash equals that record, else it stays (state `changed`).
 * Throws outside a Buildorder workspace, for a malformed `repo` and for an unknown `done` path or step (before any write).
 */
export function githubChecklist(dir, { repo: given, done = [], owner, name = [] } = {}) {
  if (given !== undefined && !validSlug(given)) throw new Error('--repo must look like owner/name (a GitHub owner and repo name)');
  const root = findWorkspaceRoot(dir);
  const ws = root ? loadWorkspace(root) : null;
  if (!ws) throw new Error(`not inside a Buildorder workspace: ${resolve(dir)}`);
  // The docs language of the workspace; anything but `de` (missing, unknown) keeps the English text.
  const lang = ws.language?.docs === 'de' ? 'de' : 'en';
  const found = workspaceRepos(root, ws);
  const names = repoNames(root, found, { owner, name, docs: true, optional: true });
  const doneBy = new Map(found.map((f) => [f.key, new Set()]));
  let docsDone = false;
  for (const entry of done) {
    const [path, step] = splitPair(entry, '--done', 'step');
    const key = keyOf(root, path);
    if (key === '') {
      if (step !== 'create') throw new Error('--done: the docs repo has only the step create');
      docsDone = true;
      continue;
    }
    if (!doneBy.has(key)) throw new Error(`--done: unknown repo path '${path}'`);
    if (!DONE_STEPS.includes(step)) {
      throw new Error(`--done: unknown step '${step}' (create, push, settings or settings:<${SETTINGS_PARTS.join('|')}>)`);
    }
    doneBy.get(key).add(step);
  }
  // `--repo` names one repo; with several candidates (or none) it could name the wrong one.
  if (given !== undefined && found.filter((f) => !originMatch(f.abs)).length !== 1) {
    throw new Error('--repo only works when the workspace has exactly one repo without a GitHub origin; set the origin instead');
  }
  // A repo whose origin is on another host takes no name and no step: refuse before anything is written.
  for (const { abs, path, key } of found) {
    const { url, github } = originOf(abs);
    if (!url || github) continue;
    if (names.has(key)) throw new Error(`--name: '${path}' has an origin that is not on GitHub`);
    if (doneBy.get(key).size > 0) throw new Error(`--done: '${path}' has an origin that is not on GitHub`);
  }
  const repos = [];
  const named = [];
  const foreign = [];
  for (const { repo, abs, path, key } of found) {
    const visibility = VISIBILITIES.includes(repo.visibility) ? repo.visibility : null;
    let place = slugOf(abs, given);
    // The owner and name of the interview replace the placeholder; an origin or --repo still wins.
    const isNamed = owner !== undefined && !place.remote;
    if (isNamed) place = { slug: `${owner}/${names.get(key) ?? placeholderName(abs)}`, remote: false };
    // An origin on another host: no slug, one sentence instead of commands.
    const { url, github } = originOf(abs);
    const other = Boolean(url) && !github;
    if (other) place = { slug: null, remote: false };
    named.push(isNamed && !other);
    foreign.push(other);
    repos.push({ path, ...place, ciOk: hasCiOk(abs), visibility });
  }
  const date = today();
  const view = repos.map((r, i) => ({ ...r, done: doneBy.get(found[i].key), date, named: named[i] }));
  const docsSlug = owner === undefined || originMatch(root)
    ? slugOf(root).slug
    : `${owner}/${names.get('') ?? docsNameOf(ws, root)}`;
  const docs = docsDone ? { slug: docsSlug, date } : null;
  const content = {
    [CHECKLIST]: markdown(view, lang, done.length > 0, docs),
    [RULESET]: JSON.stringify(RULESET_BODY, null, 2) + '\n',
    ...(repos.some((r, i) => !r.ciOk && !foreign[i]) ? { [LOOSE_RULESET]: JSON.stringify(LOOSE_BODY, null, 2) + '\n' } : {}),
  };
  // The hash of the checklist as github-checklist last wrote it: the origins (and so the slugs) change once init
  // created a repo, so only this record tells an untouched checklist from one the person edited.
  const hashes = isRecord(ws.templateHashes) ? ws.templateHashes : {};
  const recorded = isRecord(hashes[CHECKLIST]) ? hashes[CHECKLIST].file : null;
  let written = null;
  const files = Object.entries(content).map(([path, text]) => {
    const abs = join(root, ...path.split('/'));
    if (existsSync(abs)) {
      if (done.length === 0 || path !== CHECKLIST) return { path, state: 'exists' };
      // With --done: rewrite only while the file is what github-checklist wrote, else leave the person's edits.
      if (typeof recorded !== 'string' || textHash(readFileSync(abs, 'utf8')) !== recorded) return { path, state: 'changed' };
      writeFileSync(abs, text);
      written = text;
      return { path, state: 'updated' };
    }
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(abs, text, { flag: 'wx' });
    if (path === CHECKLIST) written = text;
    return { path, state: 'created' };
  });
  if (written !== null) {
    writeJson(join(root, ...WORKSPACE_JSON.split('/')), { ...ws, templateHashes: { ...hashes, [CHECKLIST]: { file: textHash(written) } } });
  }
  return { ok: true, dir: root, files, repos };
}

// The settings commands in the order Init runs them, each with the `--done` step that ticks it. They are
// independent: alerts first (they work on every plan), the ruleset last (it needs GitHub Pro on a private repo).
const SETTINGS_ORDER = ['alerts', 'secrets', 'ruleset'];

const skipAll = (reason) => STEPS.map((kind) => ({ kind, skipped: reason }));

/**
 * The GitHub step per repo as data, read-only (no `gh`, no network, no file written):
 * `{ ok, repos: [{ path, slug, visibility, exists, steps }], docs }`. `exists` is true when the repo has an origin
 * on GitHub (only then may Init offer "settings only"). A step is `{ kind, commands: [string[]] }` or
 * `{ kind, skipped }`: `origin exists`, `no visibility` or `invalid name` for create; `no main` or `dirty` for
 * push; `no origin` for push and settings when there is nothing to push to; `duplicate name` for create (then push and
 * settings are `no origin`) when another repo or the docs repo gets the same `owner/name`; `non-GitHub origin` for all three
 * when the origin is on another host (slug null). A public repo has two settings steps (alerts and secret scanning before push, the ruleset after it). A settings step lists `ticks`: the `--done` step of each
 * command (`settings:alerts`, `settings:secrets`, `settings:ruleset`). `docs` is null unless `docs` is set:
 * then the workspace root gets one private `create` step.
 * `owner` is required; `name` lists `<path>=<name>` (`.` names the docs repo); the default name is the folder name,
 * the docs repo's `<workspace name>-docs`. Paths compare in normalized form (any case on Windows); the output keeps
 * the recorded path. Throws outside a Buildorder workspace and for a bad owner, name or path.
 */
export function githubPlan(dir, { owner, name = [], docs = false } = {}) {
  const root = findWorkspaceRoot(dir);
  const ws = root ? loadWorkspace(root) : null;
  if (!ws) throw new Error(`not inside a Buildorder workspace: ${resolve(dir)}`);
  const found = workspaceRepos(root, ws);
  const names = repoNames(root, found, { owner, name, docs });
  const repos = found.map(({ repo, abs, key, path }) => {
    const visibility = VISIBILITIES.includes(repo.visibility) ? repo.visibility : null;
    const { url, github } = originOf(abs);
    // Another host's origin is an existing remote too: nothing is created, pushed or configured on GitHub.
    if (url && !github) return { path, slug: null, visibility, exists: false, steps: skipAll('non-GitHub origin') };
    const slug = github ? `${github[1]}/${github[2]}` : `${owner}/${names.get(key) ?? basename(abs)}`;
    const steps = [];
    if (github) steps.push({ kind: 'create', skipped: 'origin exists' });
    else if (!visibility) steps.push({ kind: 'create', skipped: 'no visibility' });
    // The folder name as the default name: GitHub refuses or renames blanks and other characters; Init asks for --name.
    else if (!validSlug(slug)) steps.push({ kind: 'create', skipped: 'invalid name' });
    else steps.push({ kind: 'create', commands: [createCommand(slug, visibility, path)] });
    // Without an origin and without a create step there is nothing to push to or to configure.
    if (!github && !steps[0].commands) {
      steps.push({ kind: 'push', skipped: 'no origin' }, { kind: 'settings', skipped: 'no origin' });
      return { path, slug, visibility, exists: false, steps };
    }
    const cmds = settingsCommands(slug, { ciOk: hasCiOk(abs), visibility });
    const parts = SETTINGS_ORDER.filter((n) => cmds[n]);
    const settingsStep = (names) => ({ kind: 'settings', commands: names.map((n) => cmds[n]), ticks: names.map((n) => `settings:${n}`) });
    // A public repo gets alerts and secret scanning with push protection before the first push; the ruleset follows it.
    const early = visibility === 'public' ? parts.filter((n) => n !== 'ruleset') : [];
    if (early.length) steps.push(settingsStep(early));
    const hasMain = gitResult(abs, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).ok;
    // Without optional locks, status does not refresh and rewrite the index: the plan stays read-only.
    const clean = gitResult(abs, ['--no-optional-locks', 'status', '--porcelain']);
    if (!hasMain) steps.push({ kind: 'push', skipped: 'no main' });
    else if (!clean.ok || clean.stdout !== '') steps.push({ kind: 'push', skipped: 'dirty' });
    else steps.push({ kind: 'push', commands: [pushCommand(path)] });
    steps.push(settingsStep(parts.filter((n) => !early.includes(n))));
    return { path, slug, visibility, exists: Boolean(github), steps };
  });
  let docsPlan = null;
  if (docs) {
    const docsName = names.get('') ?? docsNameOf(ws, root);
    const { url, github } = originOf(root);
    const slug = github ? `${github[1]}/${github[2]}` : url ? null : `${owner}/${docsName}`;
    let step;
    if (github) step = { kind: 'create', skipped: 'origin exists' };
    else if (url) step = { kind: 'create', skipped: 'non-GitHub origin' };
    else if (!validSlug(slug)) step = { kind: 'create', skipped: 'invalid name' };
    else step = { kind: 'create', commands: [createCommand(slug, 'private', '.')] };
    docsPlan = { path: '.', slug, visibility: 'private', exists: Boolean(github), steps: [step] };
  }
  flagDuplicates([...repos, ...(docsPlan ? [docsPlan] : [])]);
  return { ok: true, repos, docs: docsPlan };
}

/**
 * Two repos that would be created under the same `owner/name` (GitHub compares them in any case): every
 * one of them without an origin gets `create` skipped as `duplicate name` and no push or settings, so Init
 * asks for another name. A repo whose slug comes from an origin is never flagged, but its name is taken.
 * Changes the plans in place. The reason the create step already had stays beside it (`duplicate name; no
 * visibility`), and so does a push reason (`no origin; dirty`), so the rename does not hide it.
 */
function flagDuplicates(plans) {
  const groups = new Map();
  for (const p of plans) {
    // A non-GitHub origin has no slug; a name GitHub refuses is reported as invalid on its own.
    if (p.slug === null || (!p.exists && !validSlug(p.slug))) continue;
    const key = p.slug.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const p of group.filter((r) => !r.exists)) {
      const create = p.steps[0];
      const push = p.steps.find((x) => x.kind === 'push');
      const beside = (own, base) => (own?.skipped && own.skipped !== 'no origin' ? `${base}; ${own.skipped}` : base);
      p.steps = [
        { kind: 'create', skipped: beside(create, 'duplicate name') },
        ...(p.steps.length > 1 ? [{ kind: 'push', skipped: beside(push, 'no origin') }, { kind: 'settings', skipped: 'no origin' }] : []),
      ];
    }
  }
}
