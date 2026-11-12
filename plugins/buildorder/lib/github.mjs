// github-checklist: the GitHub settings of the standard (rulesets, secret scanning, push protection,
// Dependabot alerts) as a checklist with ready `gh` commands in the workspace. It never calls the API:
// the person runs the commands once the repo exists on GitHub (AK-6, K5).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { PLUGIN_ROOT, maskRemote } from './detect.mjs';
import { git } from './git.mjs';
import { relativeTo } from './paths.mjs';
import { VISIBILITIES } from './standard.mjs';
import { findWorkspaceRoot, loadWorkspace } from './workspace.mjs';

const CHECKLIST = 'docs/github-settings.md';
const RULESET = 'docs/github-ruleset.json';
const REQUIRED_CHECK = 'ci-ok'; // the job every generated ci.yml ends with

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
// a string or a list of lines per key. `{{slug}}`, `{{check}}` and `{{ruleset}}` are filled in; the `gh` commands
// are the same in every language.
const loadTexts = (lang) => JSON.parse(readFileSync(join(PLUGIN_ROOT, 'templates', 'github', lang, 'checklist.json'), 'utf8'));
const fill = (v, vals) => (Array.isArray(v) ? v.map((s) => fill(s, vals)) : v.replace(/\{\{(\w+)\}\}/g, (m, key) => vals[key] ?? m));
const lines = (v) => (Array.isArray(v) ? v : [v]);

function section(repo, tx) {
  const { path, slug, remote, visibility, ciOk } = repo;
  const t = (key) => lines(fill(tx[key], { slug, check: REQUIRED_CHECK, ruleset: RULESET_BODY.name }));
  const block = (cmd) => ['  ```', `  ${cmd}`, '  ```'];
  const ruleset = ciOk
    ? [...t('ruleset'), ...block(`gh api --method POST repos/${slug}/rulesets --input ${RULESET}`)]
    : [
      ...t('looseRuleset'),
      ...block(`gh api --method POST repos/${slug}/rulesets --input ${LOOSE_RULESET}`),
      ...t('requireLater'),
      ...block(`gh api --method PUT repos/${slug}/rulesets/RULESET_ID --input ${RULESET}`),
    ];
  const secrets = visibility === 'private'
    ? t('privateSecrets')
    : [...t('secrets'),
      ...block(`gh api --method PATCH repos/${slug} -f "security_and_analysis[secret_scanning][status]=enabled"`
        + ' -f "security_and_analysis[secret_scanning_push_protection][status]=enabled"')];
  return [
    `## ${path} (\`${slug}\`)`,
    '',
    ...(remote ? [] : [...t('noRemote'), '']),
    ...ruleset,
    ...secrets,
    ...t('alerts'),
    ...block(`gh api --method PUT repos/${slug}/vulnerability-alerts`),
    ...t('verify'),
    '',
  ];
}

function markdown(repos, lang) {
  const tx = loadTexts(lang);
  return [
    ...lines(tx.title),
    '',
    ...tx.intro,
    '',
    ...(repos.length ? repos.flatMap((r) => section(r, tx)) : [tx.noRepos, '']),
    ...tx.outro,
    '',
  ].join('\n');
}

/** `owner/name` as GitHub allows it: owner up to 39 chars of letters, digits, hyphens; name not `.`/`..`, no leading `-`. */
function validSlug(slug) {
  const m = typeof slug === 'string' ? slug.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)$/) : null;
  return Boolean(m) && m[2] !== '.' && m[2] !== '..' && !m[2].startsWith('-');
}

/**
 * Writes the checklist (in the workspace's `language.docs`, `de` or else English) and the ruleset body (plus one without required checks when a repo has no `ci-ok`
 * job yet) into the workspace that encloses `dir`, never overwriting:
 * `{ ok, dir, files: [{ path, state: created | exists }], repos: [{ path, slug, remote, ciOk, visibility }] }`.
 * `visibility` comes from the repo entry (null when unknown); a private repo gets no secret scanning commands.
 * `repo` (`owner/name`, from the interview) names the repo when it has no GitHub origin yet; a local origin wins.
 * Throws outside a Buildorder workspace or for a malformed `repo`.
 */
export function githubChecklist(dir, { repo: given } = {}) {
  if (given !== undefined && !validSlug(given)) throw new Error('--repo must look like owner/name (a GitHub owner and repo name)');
  const root = findWorkspaceRoot(dir);
  const ws = root ? loadWorkspace(root) : null;
  if (!ws) throw new Error(`not inside a Buildorder workspace: ${resolve(dir)}`);
  // The docs language of the workspace; anything but `de` (missing, unknown) keeps the English text.
  const lang = ws.language?.docs === 'de' ? 'de' : 'en';
  const found = [];
  for (const repo of Array.isArray(ws.repos) ? ws.repos : []) {
    if (typeof repo?.path !== 'string') continue;
    const abs = resolve(root, repo.path);
    const rel = relativeTo(abs, root);
    if (!rel || !existsSync(join(abs, '.git'))) continue;
    found.push({ repo, abs, rel });
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
  const content = {
    [CHECKLIST]: markdown(repos, lang),
    [RULESET]: JSON.stringify(RULESET_BODY, null, 2) + '\n',
    ...(repos.some((r) => !r.ciOk) ? { [LOOSE_RULESET]: JSON.stringify(LOOSE_BODY, null, 2) + '\n' } : {}),
  };
  const files = Object.entries(content).map(([path, text]) => {
    const abs = join(root, ...path.split('/'));
    if (existsSync(abs)) return { path, state: 'exists' };
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(abs, text, { flag: 'wx' });
    return { path, state: 'created' };
  });
  return { ok: true, dir: root, files, repos };
}
