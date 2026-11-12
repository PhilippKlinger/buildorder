// github-checklist: the GitHub settings of the standard (rulesets, secret scanning, push protection,
// Dependabot alerts) as a checklist with ready `gh` commands in the workspace. It never calls the API:
// the person runs the commands once the repo exists on GitHub (AK-6, K5).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { maskRemote } from './detect.mjs';
import { git } from './git.mjs';
import { relativeTo } from './paths.mjs';
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

/** `{ slug, remote }`: `owner/name` from a GitHub origin, else the placeholder `OWNER/<folder>`. */
function slugOf(abs) {
  const url = git(abs, ['remote', 'get-url', 'origin']);
  const m = url ? maskRemote(url).match(GITHUB_REMOTE) : null;
  if (m) return { slug: `${m[1]}/${m[2]}`, remote: true };
  return { slug: `OWNER/${basename(abs).replace(/[^\w.-]+/g, '-')}`, remote: false };
}

function section({ path, slug, remote }) {
  const block = (cmd) => ['  ```', `  ${cmd}`, '  ```'];
  return [
    `## ${path} (\`${slug}\`)`,
    '',
    ...(remote ? [] : [`No GitHub remote yet: after the first push, replace \`${slug}\` with the repo's owner and name.`, '']),
    `- [ ] Ruleset on the default branch: pull requests only, no force push, no deletion, required check \`${REQUIRED_CHECK}\``,
    ...block(`gh api --method POST repos/${slug}/rulesets --input ${RULESET}`),
    '- [ ] Secret scanning and push protection',
    ...block(`gh api --method PATCH repos/${slug} -f "security_and_analysis[secret_scanning][status]=enabled"`
      + ' -f "security_and_analysis[secret_scanning_push_protection][status]=enabled"'),
    '- [ ] Dependabot alerts',
    ...block(`gh api --method PUT repos/${slug}/vulnerability-alerts`),
    `- [ ] Check: \`gh api repos/${slug}/rulesets\` lists the ruleset \`${RULESET_BODY.name}\`.`,
    '',
  ];
}

function markdown(repos) {
  return [
    '# GitHub settings',
    '',
    '> Written by Buildorder, which never creates a repo, pushes or calls the GitHub API. Run these commands yourself',
    '> from the workspace root, once the repo exists on GitHub and `main` is pushed. They need the GitHub CLI, logged in',
    '> with admin rights on the repo (`gh auth status`).',
    '',
    ...(repos.length ? repos.flatMap(section) : ['No repo is listed in `.claude/workspace.json`.', '']),
    'Private repos: rulesets need GitHub Pro or higher, secret scanning and push protection need GitHub Secret',
    'Protection. Without them, the gitleaks job in CI is the protection.',
    '',
  ].join('\n');
}

/**
 * Writes the checklist and the ruleset body into the workspace that encloses `dir` (never overwriting):
 * `{ ok, dir, files: [{ path, state: created | exists }], repos: [{ path, slug, remote }] }`.
 * Throws outside a Buildorder workspace.
 */
export function githubChecklist(dir) {
  const root = findWorkspaceRoot(dir);
  const ws = root ? loadWorkspace(root) : null;
  if (!ws) throw new Error(`not inside a Buildorder workspace: ${resolve(dir)}`);
  const repos = [];
  for (const repo of Array.isArray(ws.repos) ? ws.repos : []) {
    if (typeof repo?.path !== 'string') continue;
    const abs = resolve(root, repo.path);
    const rel = relativeTo(abs, root);
    if (!rel || !existsSync(join(abs, '.git'))) continue;
    repos.push({ path: rel, ...slugOf(abs) });
  }
  const content = {
    [CHECKLIST]: markdown(repos),
    [RULESET]: JSON.stringify(RULESET_BODY, null, 2) + '\n',
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
