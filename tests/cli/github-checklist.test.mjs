// github-checklist: the GitHub settings as a checklist with ready commands in the workspace (AK-6, K5).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, gitIn, tmp } from '../helpers/cli.mjs';

after(cleanup);

// An scp-style remote, assembled so no address-like literal is tracked.
const SSH_REMOTE = ['git', 'github.com:acme/shop.git'].join('@');
const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');

// A ci.yml with the ci-ok job, as the standard writes it.
const CI_OK = { '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  ci-ok:\n    runs-on: ubuntu-latest\n' };

/** A workspace with one repo `shop app`; `ciOk`: the repo has the ci-ok job; `visibility` goes to scaffold. */
function workspace(label, remote, { ciOk = true, visibility } = {}) {
  const root = tmp(label);
  const repo = codeRepo(null, { 'src/main.ts': 'console.log(1);\n', ...(ciOk ? CI_OK : {}) }, { dir: join(root, 'shop app') });
  if (remote) gitIn(repo, 'remote', 'add', 'origin', remote);
  assert.equal(cli('scaffold', root, ...(visibility ? ['--visibility', visibility] : [])).status, 0);
  return root;
}

function checklist(dir) {
  const r = cli('github-checklist', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.json;
}

test('writes the checklist and the ruleset into the workspace, with the repo slug from the remote', () => {
  const root = workspace('github remote', SSH_REMOTE);
  const out = checklist(root);
  assert.equal(out.ok, true);
  assert.equal(out.dir, root);
  assert.deepEqual(out.files, [
    { path: 'docs/github-settings.md', state: 'created' },
    { path: 'docs/github-ruleset.json', state: 'created' },
  ]);
  assert.deepEqual(out.repos, [{ path: 'shop app', slug: 'acme/shop', remote: true, ciOk: true, visibility: null }]);

  const md = read(root, 'docs/github-settings.md');
  assert.match(md, /^## shop app \(`acme\/shop`\)$/m);
  assert.ok(md.includes('gh api --method POST repos/acme/shop/rulesets --input docs/github-ruleset.json'));
  assert.ok(md.includes('gh api --method PATCH repos/acme/shop -f "security_and_analysis[secret_scanning][status]=enabled"'
    + ' -f "security_and_analysis[secret_scanning_push_protection][status]=enabled"'));
  assert.ok(md.includes('gh api --method PUT repos/acme/shop/vulnerability-alerts'));
  assert.match(md, /never creates a repo, pushes or calls the GitHub API/);
  assert.doesNotMatch(md, /OWNER/);

  const ruleset = JSON.parse(read(root, 'docs/github-ruleset.json'));
  assert.equal(ruleset.target, 'branch');
  assert.equal(ruleset.enforcement, 'active');
  assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  const rules = Object.fromEntries(ruleset.rules.map((r) => [r.type, r.parameters ?? {}]));
  assert.deepEqual(Object.keys(rules).sort(), ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
  assert.deepEqual(rules.required_status_checks.required_status_checks, [{ context: 'ci-ok' }]);
  assert.equal(rules.pull_request.required_approving_review_count, 0, 'a solo developer can merge after ci-ok');
});

test('an https remote gives the slug without its credentials; without a remote the slug is a placeholder', () => {
  const token = ['tok', 'en'].join('');
  const https = workspace('github https', `https://someone:${token}@github.com/acme/shop.git`);
  assert.equal(checklist(https).repos[0].slug, 'acme/shop');
  assert.doesNotMatch(read(https, 'docs/github-settings.md'), new RegExp(`someone|${token}`));

  const local = workspace('github no remote');
  assert.deepEqual(checklist(local).repos,
    [{ path: 'shop app', slug: 'OWNER/shop-app', remote: false, ciOk: true, visibility: null }]);
  const md = read(local, 'docs/github-settings.md');
  assert.ok(md.includes('repos/OWNER/shop-app/rulesets'));
  assert.match(md, /No GitHub remote yet: after the first push, replace `OWNER\/shop-app`/);
});

const LOOSE = 'docs/github-ruleset-without-checks.json';

test('a repo without the ci-ok job gets a ruleset without required checks and a step to add ci-ok later', () => {
  const root = workspace('github no ci-ok', SSH_REMOTE, { ciOk: false });
  const out = checklist(root);
  assert.equal(out.repos[0].ciOk, false);
  assert.deepEqual(out.files.map((f) => f.path), ['docs/github-settings.md', 'docs/github-ruleset.json', LOOSE]);
  const md = read(root, 'docs/github-settings.md');
  assert.ok(md.includes(`gh api --method POST repos/acme/shop/rulesets --input ${LOOSE}`));
  assert.ok(!md.includes('--method POST repos/acme/shop/rulesets --input docs/github-ruleset.json'), 'not up front');
  assert.match(md, /Once `ci\.yml` with the `ci-ok` job is on `main`/);
  assert.ok(md.includes('gh api --method PUT repos/acme/shop/rulesets/RULESET_ID --input docs/github-ruleset.json'));
  const loose = JSON.parse(read(root, LOOSE));
  assert.deepEqual(loose.rules.map((r) => r.type), ['deletion', 'non_fast_forward', 'pull_request']);
});

test('a private repo gets no secret scanning commands, and the reason instead', () => {
  const root = workspace('github private', SSH_REMOTE, { visibility: 'private' });
  assert.equal(checklist(root).repos[0].visibility, 'private');
  const md = read(root, 'docs/github-settings.md');
  assert.doesNotMatch(md, /secret_scanning/);
  assert.match(md, /Secret scanning and push protection: left out, a private repo needs GitHub Advanced Security/);
  assert.ok(md.includes('gh api --method PUT repos/acme/shop/vulnerability-alerts'), 'Dependabot alerts stay');
  assert.ok(md.includes('--method POST repos/acme/shop/rulesets --input docs/github-ruleset.json'));
});

test('a second run keeps both files as they are', () => {
  const root = workspace('github rerun', SSH_REMOTE);
  checklist(root);
  const before = read(root, 'docs/github-settings.md');
  const again = checklist(root);
  assert.deepEqual(again.files.map((f) => f.state), ['exists', 'exists']);
  assert.equal(read(root, 'docs/github-settings.md'), before);
});

test('outside a workspace it fails with one line and writes nothing', () => {
  const dir = tmp('github outside');
  const r = cli('github-checklist', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^buildorder: not inside a Buildorder workspace: .+\n$/);
});
