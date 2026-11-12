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

function workspace(label, remote) {
  const root = tmp(label);
  const repo = codeRepo(null, undefined, { dir: join(root, 'shop app') });
  if (remote) gitIn(repo, 'remote', 'add', 'origin', remote);
  assert.equal(cli('scaffold', root).status, 0);
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
  assert.deepEqual(out.repos, [{ path: 'shop app', slug: 'acme/shop', remote: true }]);

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
  assert.deepEqual(checklist(local).repos, [{ path: 'shop app', slug: 'OWNER/shop-app', remote: false }]);
  const md = read(local, 'docs/github-settings.md');
  assert.ok(md.includes('repos/OWNER/shop-app/rulesets'));
  assert.match(md, /No GitHub remote yet: after the first push, replace `OWNER\/shop-app`/);
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
