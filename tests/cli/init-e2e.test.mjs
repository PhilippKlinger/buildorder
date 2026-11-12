// End to end: the write path of /buildorder:init, command by command as the skill runs it,
// for a new django project in an empty folder and for an existing repo (AK-2, AK-3, AK-6).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, gitIn, gitInit, tmp } from '../helpers/cli.mjs';

after(cleanup);

function ok(...args) {
  const r = cli(...args);
  assert.equal(r.status, 0, `${args[0]}: ${r.stderr}${r.stdout}`);
  assert.equal(r.stderr, '', args[0]);
  return r;
}
const json = (...args) => ok(...args).json;
const wsOf = (root) => JSON.parse(readFileSync(join(root, '.claude', 'workspace.json'), 'utf8'));
const snapshot = (dir) => ({
  head: gitIn(dir, 'rev-parse', 'HEAD'),
  status: gitIn(dir, 'status', '--porcelain', '--untracked-files=all'),
});

test('new django project in an empty folder: plan, git init, scaffold, starter commit, verify, finalize, checklist', () => {
  const root = tmp('init new');
  assert.equal(json('detect', root).suggestion, 'new');
  const repo = join(root, 'shop app');
  const options = ['--stack', 'django', '--deploy', 'container', '--visibility', 'public', '--starter'];

  // Step 2: the confirmation shows the plan before anything exists.
  const plan = json('standard', repo, ...options);
  assert.ok(plan.files.every((f) => f.state === 'create'));
  assert.equal(existsSync(repo), false);

  // Step 3: git init (as the skill does, on main), scaffold, standard --apply.
  gitInit(repo);
  for (const [k, v] of [['user.name', 'test'], ['user.email', ['test', 'localhost'].join('@')], ['commit.gpgsign', 'false']]) {
    gitIn(repo, 'config', k, v);
  }
  json('scaffold', root, '--lang', 'en', '--repo', 'shop app', '--visibility', 'public');
  const applied = json('standard', repo, ...options, '--apply');
  assert.deepEqual(applied.created, plan.files.map((f) => f.path));
  assert.deepEqual(applied.workspace, { dir: root, recorded: true });
  assert.equal(ok('standard', repo, ...options, '--gaps').stdout,
    'No gaps: every repo item of the standard is present or deliberately skipped.\n');

  // Step 5: verify, finalize, GitHub checklist.
  assert.deepEqual(json('verify', root), { ok: true, dir: root, problems: [], warnings: [] });
  assert.equal(json('finalize', root).initPhase, 'done');
  const checklist = json('github-checklist', root);
  assert.deepEqual(checklist.repos, [{ path: 'shop app', slug: 'OWNER/shop-app', remote: false }]);

  const ws = wsOf(root);
  assert.equal(ws.initPhase, 'done');
  assert.equal(ws.repos[0].visibility, 'public');
  assert.deepEqual(ws.repos[0].standards.modules, ['django', 'docker-cicd']);

  // The repo: one commit with the starter and the pipeline, clean, nothing pushed.
  assert.equal(gitIn(repo, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(gitIn(repo, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(gitIn(repo, 'remote'), '', 'no remote, so nothing can have been pushed');
  assert.ok(existsSync(join(repo, 'manage.py')));
});

test('existing repo: scaffold, gap list as backlog tasks, verify, finalize; the repo stays unchanged (AK-3)', () => {
  const root = tmp('init existing');
  const repo = codeRepo(null, {
    'requirements.txt': 'Django==5.2.1\n',
    'manage.py': '',
    '.github/workflows/old.yml': 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
  }, { dir: join(root, 'legacy app') });
  const before = snapshot(repo);
  const found = json('detect', root);
  assert.equal(found.suggestion, 'existing');
  assert.deepEqual(found.repos.map((r) => [r.path, r.isCode, r.stacks]), [['legacy app', true, ['django', 'github-actions']]]);

  json('scaffold', root, '--lang', 'de', '--repo', 'legacy app', '--visibility', 'private');
  const options = ['--deploy', 'container', '--visibility', 'private'];
  const plan = json('standard', repo, ...options);
  const missing = plan.items.filter((i) => i.state === 'missing');
  assert.ok(missing.length > 0, 'the plan lists gaps');
  const rows = ok('standard', repo, ...options, '--gaps').stdout.split('\n').filter((l) => l.startsWith('| STD-'));
  assert.equal(rows.length, missing.length, 'every gap is a backlog task');
  assert.ok(!rows.some((l) => /CodeQL|Dependency Review/.test(l)), 'paid items on a private repo are deviations, not gaps');

  assert.equal(json('verify', root).ok, true);
  assert.equal(json('finalize', root).initPhase, 'done');
  json('github-checklist', root);
  assert.equal(wsOf(root).repos[0].visibility, 'private');
  assert.deepEqual(snapshot(repo), before, 'HEAD and git status unchanged');
});
