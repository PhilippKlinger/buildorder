// github-checklist: the GitHub settings of the standard (rulesets, secret scanning, push protection,
// Dependabot alerts) as a checklist with ready `gh` commands in the workspace. It never calls the API:
// the person runs the commands once the repo exists on GitHub (AK-6, K5).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { maskRemote } from './detect.mjs';
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

/** `{ slug, remote }`: `owner/name` from a GitHub origin, else the placeholder `OWNER/<folder>`. */
function slugOf(abs) {
  const url = git(abs, ['remote', 'get-url', 'origin']);
  const m = url ? maskRemote(url).match(GITHUB_REMOTE) : null;
  if (m) return { slug: `${m[1]}/${m[2]}`, remote: true };
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

// The checklist text per docs language (`language.docs` of the workspace); the commands are the same in both.
const TEXT = {
  en: {
    title: '# GitHub settings',
    intro: [
      '> Written by Buildorder, which never creates a repo, pushes or calls the GitHub API. Run these commands yourself',
      '> from the workspace root, once the repo exists on GitHub and `main` is pushed. They need the GitHub CLI, logged in',
      '> with admin rights on the repo (`gh auth status`).',
    ],
    noRemote: (slug) => `No GitHub remote yet: after the first push, replace \`${slug}\` with the repo's owner and name.`,
    ruleset: `- [ ] Ruleset on the default branch: pull requests only, no force push, no deletion, required check \`${REQUIRED_CHECK}\``,
    looseRuleset: [
      '- [ ] Ruleset on the default branch: pull requests only, no force push, no deletion (no required check yet:',
      `  the repo's CI has no \`${REQUIRED_CHECK}\` job)`,
    ],
    requireLater: (slug) => `- [ ] Once \`ci.yml\` with the \`${REQUIRED_CHECK}\` job is on \`main\` (the gap task of the standard), require it:`
      + ` take the ruleset id from \`gh api repos/${slug}/rulesets\`, then`,
    privateSecrets: [
      '- Secret scanning and push protection: left out, a private repo needs GitHub Advanced Security (Secret',
      '  Protection) for them; the gitleaks job in CI is the protection.',
    ],
    secrets: '- [ ] Secret scanning and push protection',
    alerts: '- [ ] Dependabot alerts',
    check: (slug) => `- [ ] Check: \`gh api repos/${slug}/rulesets\` lists the ruleset \`${RULESET_BODY.name}\`.`,
    noRepos: 'No repo is listed in `.claude/workspace.json`.',
    outro: [
      'Private repos: rulesets need GitHub Pro or higher, secret scanning and push protection need GitHub Secret',
      'Protection. Without them, the gitleaks job in CI is the protection.',
    ],
  },
  de: {
    title: '# GitHub-Einstellungen',
    intro: [
      '> Von Buildorder geschrieben; Buildorder legt nie ein Repo an, pusht nicht und ruft die GitHub-API nicht auf. Führe diese',
      '> Befehle selbst im Workspace-Root aus, sobald das Repo auf GitHub existiert und `main` gepusht ist. Du brauchst die',
      '> GitHub CLI, angemeldet mit Admin-Rechten auf dem Repo (`gh auth status`).',
    ],
    noRemote: (slug) => `Noch kein GitHub-Remote: ersetze \`${slug}\` nach dem ersten Push durch Besitzer und Namen des Repos.`,
    ruleset: `- [ ] Ruleset für den Standard-Branch: nur Pull Requests, kein Force-Push, kein Löschen, Pflicht-Check \`${REQUIRED_CHECK}\``,
    looseRuleset: [
      '- [ ] Ruleset für den Standard-Branch: nur Pull Requests, kein Force-Push, kein Löschen (noch kein Pflicht-Check:',
      `  die CI des Repos hat noch keinen Job \`${REQUIRED_CHECK}\`)`,
    ],
    requireLater: (slug) => `- [ ] Sobald \`ci.yml\` mit dem Job \`${REQUIRED_CHECK}\` auf \`main\` liegt (die Lückenaufgabe des Standards), mach ihn zur Pflicht:`
      + ` hole die Ruleset-ID aus \`gh api repos/${slug}/rulesets\`, dann`,
    privateSecrets: [
      '- Secret Scanning und Push Protection: ausgelassen, ein privates Repo braucht dafür GitHub Advanced Security (Secret',
      '  Protection); der gitleaks-Job in der CI ist der Schutz.',
    ],
    secrets: '- [ ] Secret Scanning und Push Protection',
    alerts: '- [ ] Dependabot-Warnungen',
    check: (slug) => `- [ ] Prüfen: \`gh api repos/${slug}/rulesets\` listet das Ruleset \`${RULESET_BODY.name}\`.`,
    noRepos: 'In `.claude/workspace.json` ist kein Repo eingetragen.',
    outro: [
      'Private Repos: Rulesets brauchen GitHub Pro oder höher, Secret Scanning und Push Protection brauchen GitHub Secret',
      'Protection. Ohne sie ist der gitleaks-Job in der CI der Schutz.',
    ],
  },
};

function rulesetSteps({ slug, ciOk }, block, tx) {
  if (ciOk) return [tx.ruleset, ...block(`gh api --method POST repos/${slug}/rulesets --input ${RULESET}`)];
  return [
    ...tx.looseRuleset,
    ...block(`gh api --method POST repos/${slug}/rulesets --input ${LOOSE_RULESET}`),
    tx.requireLater(slug),
    ...block(`gh api --method PUT repos/${slug}/rulesets/RULESET_ID --input ${RULESET}`),
  ];
}

function section(repo, tx) {
  const { path, slug, remote, visibility } = repo;
  const block = (cmd) => ['  ```', `  ${cmd}`, '  ```'];
  const secrets = visibility === 'private'
    ? tx.privateSecrets
    : [tx.secrets,
      ...block(`gh api --method PATCH repos/${slug} -f "security_and_analysis[secret_scanning][status]=enabled"`
        + ' -f "security_and_analysis[secret_scanning_push_protection][status]=enabled"')];
  return [
    `## ${path} (\`${slug}\`)`,
    '',
    ...(remote ? [] : [tx.noRemote(slug), '']),
    ...rulesetSteps(repo, block, tx),
    ...secrets,
    tx.alerts,
    ...block(`gh api --method PUT repos/${slug}/vulnerability-alerts`),
    tx.check(slug),
    '',
  ];
}

function markdown(repos, lang) {
  const tx = TEXT[lang];
  return [
    tx.title,
    '',
    ...tx.intro,
    '',
    ...(repos.length ? repos.flatMap((r) => section(r, tx)) : [tx.noRepos, '']),
    ...tx.outro,
    '',
  ].join('\n');
}

/**
 * Writes the checklist (in the workspace's `language.docs`, `de` or else English) and the ruleset body (plus one without required checks when a repo has no `ci-ok`
 * job yet) into the workspace that encloses `dir`, never overwriting:
 * `{ ok, dir, files: [{ path, state: created | exists }], repos: [{ path, slug, remote, ciOk, visibility }] }`.
 * `visibility` comes from the repo entry (null when unknown); a private repo gets no secret scanning commands.
 * Throws outside a Buildorder workspace.
 */
export function githubChecklist(dir) {
  const root = findWorkspaceRoot(dir);
  const ws = root ? loadWorkspace(root) : null;
  if (!ws) throw new Error(`not inside a Buildorder workspace: ${resolve(dir)}`);
  // The docs language of the workspace; anything but `de` (missing, unknown) keeps the English text.
  const lang = ws.language?.docs === 'de' ? 'de' : 'en';
  const repos = [];
  for (const repo of Array.isArray(ws.repos) ? ws.repos : []) {
    if (typeof repo?.path !== 'string') continue;
    const abs = resolve(root, repo.path);
    const rel = relativeTo(abs, root);
    if (!rel || !existsSync(join(abs, '.git'))) continue;
    const visibility = VISIBILITIES.includes(repo.visibility) ? repo.visibility : null;
    repos.push({ path: rel, ...slugOf(abs), ciOk: hasCiOk(abs), visibility });
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
