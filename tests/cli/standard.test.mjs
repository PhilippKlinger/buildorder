import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, gitIn, gitInit, tmp, write } from '../helpers/cli.mjs';

after(cleanup);

const CORE_FILES = ['.github/workflows/ci.yml', '.github/dependabot.yml', '.pre-commit-config.yaml'];
const STACK_ITEMS = ['lint', 'tests-coverage', 'build', 'dependency-audit'];

function localGit(dir) {
  gitIn(dir, 'config', 'user.name', 'test');
  gitIn(dir, 'config', 'user.email', ['test', 'localhost'].join('@'));
  gitIn(dir, 'config', 'commit.gpgsign', 'false');
  gitIn(dir, 'config', 'core.hooksPath', join(dir, '.git', 'no-hooks'));
  return dir;
}

const snapshot = (dir) => ({
  head: gitIn(dir, 'rev-parse', 'HEAD'),
  status: gitIn(dir, 'status', '--porcelain', '--untracked-files=all'),
});

function standard(...args) {
  const r = cli('standard', ...args);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.json;
}

test('an unsupported stack gets only the stack-independent parts and says the stack part is missing', () => {
  const dir = codeRepo('standard vue', { 'package.json': JSON.stringify({ dependencies: { vue: '^3' } }) });
  const before = snapshot(dir);
  const out = standard(dir);
  assert.deepEqual(out.stack, { id: 'vue', module: false });
  assert.deepEqual(out.modules, []);
  for (const id of STACK_ITEMS) {
    const item = out.items.find((i) => i.id === id);
    assert.equal(item.state, 'missing', id);
    assert.equal(item.reason, "no stack module for 'vue'", id);
  }
  assert.match(out.items.find((i) => i.id === 'container-image').reason, /needs a stack module/);
  assert.deepEqual(out.files.map((f) => f.path), CORE_FILES);
  assert.ok(out.notes.some((n) => /no stack module for 'vue'.*lint, tests with coverage, build and dependency audit/.test(n)));
  assert.deepEqual(snapshot(dir), before, 'the plan is read-only');
});

test('no stack: --apply writes the core files in one commit', () => {
  const dir = localGit(codeRepo('standard bare', { 'README.md': '# notes\n' }));
  const out = standard(dir, '--apply', '--deploy', 'none');
  assert.deepEqual(out.stack, { id: null, module: false });
  assert.ok(out.notes.some((n) => /no stack detected/.test(n)));
  assert.deepEqual(out.created, CORE_FILES);
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('the deploy target defaults to the detected one, and to none without evidence', () => {
  const plain = codeRepo('standard deploy none', { 'README.md': '# x\n' });
  assert.equal(standard(plain).deploy, 'none');
  const paas = codeRepo('standard deploy paas', { 'README.md': '# x\n', 'netlify.toml': '' });
  assert.equal(standard(paas).deploy, 'paas');
});

test('--starter without a stack module that has a starter is an error and changes nothing', () => {
  const dir = codeRepo('standard starter vue', { 'package.json': JSON.stringify({ dependencies: { vue: '^3' } }) });
  const before = snapshot(dir);
  for (const [args, message] of [
    [[], /^buildorder: --starter needs a stack module with a starter; 'vue' has none\n$/],
  ]) {
    const r = cli('standard', dir, '--starter', '--apply', ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(snapshot(dir), before);
});

test('invalid options and folders fail with one message and change nothing', () => {
  const dir = codeRepo('standard errors', { 'README.md': '# x\n' });
  const before = snapshot(dir);
  const cases = [
    [['--without', 'codeql=too slow'], /^buildorder: 'codeql' is mandatory and cannot be deselected\n$/],
    [['--without', 'container-image'], /^buildorder: deselecting 'container-image' needs a reason/],
    [['--deploy', 'ftp'], /^buildorder: --deploy must be one of container, webspace, paas, none\n$/],
    [['--visibility', 'internal'], /^buildorder: --visibility must be one of public, private\n$/],
    [['--stack', '../x'], /^buildorder: invalid --stack '\.\.\/x'/],
    [['--bogus'], /^buildorder: Unknown option '--bogus'/],
  ];
  for (const [args, message] of cases) {
    const r = cli('standard', dir, '--apply', ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(snapshot(dir), before);

  const notRepo = cli('standard', tmp('standard not repo'));
  assert.equal(notRepo.status, 1);
  assert.match(notRepo.stderr, /^buildorder: not a git repo: /);
});

test('the plan for a repo folder that does not exist yet lists every file to create and creates nothing', () => {
  const dir = join(tmp('standard planned'), 'new app');
  const out = standard(dir, '--stack', 'django', '--deploy', 'container', '--starter');
  assert.equal(out.applied, false);
  assert.equal(out.repo, dir);
  assert.deepEqual(out.modules, ['django', 'docker-cicd']);
  assert.ok(out.files.length > CORE_FILES.length);
  for (const path of [...CORE_FILES, 'manage.py', 'Dockerfile']) {
    assert.deepEqual(out.files.find((f) => f.path === path), { path, state: 'create' }, path);
  }
  assert.ok(out.items.every((i) => i.state === 'missing'));
  assert.equal(existsSync(dir), false, 'a plan creates nothing');

  const apply = cli('standard', dir, '--stack', 'django', '--deploy', 'container', '--starter', '--apply');
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /^buildorder: not a folder: /, '--apply still needs the git repo');
  assert.equal(existsSync(dir), false);
});

test('--apply without a git identity fails before writing anything', () => {
  const dir = gitInit(tmp('standard no identity'));
  // The fake home has no global config; this makes git use only configured identities, as on a fresh machine.
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' };
  const r = cli('standard', dir, '--stack', 'django', '--deploy', 'none', '--starter', '--apply', { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^buildorder: git has no user\.name and user\.email for .+; set them \(git config\), then run again\n$/);
  assert.equal(r.stdout, '');
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '', 'nothing written');
});

test('--apply reports a failed commit with ok false and keeps the files; a rerun commits them', () => {
  const dir = localGit(codeRepo('standard commit fails', { 'README.md': '# notes\n' }));
  // A real pre-commit hook that refuses, in the hooks folder localGit points core.hooksPath to.
  const hooks = join(dir, '.git', 'no-hooks');
  write(hooks, { 'pre-commit': '#!/bin/sh\necho "refused by hook" >&2\nexit 1\n' });
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const failed = cli('standard', dir, '--apply', '--deploy', 'none');
  assert.equal(failed.status, 1);
  assert.equal(failed.json?.ok, false, failed.stdout);
  assert.match(failed.json.reason, /^git commit failed: refused by hook$/);
  assert.equal(failed.json.commit, null);
  assert.deepEqual(failed.json.created, CORE_FILES);
  for (const f of CORE_FILES) assert.ok(existsSync(join(dir, ...f.split('/'))), `${f} stays in place`);
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '1');

  rmSync(join(hooks, 'pre-commit'));
  const rerun = standard(dir, '--apply', '--deploy', 'none');
  assert.equal(rerun.ok, true);
  assert.deepEqual(rerun.created, []);
  assert.deepEqual(rerun.committed, CORE_FILES);
  assert.equal(rerun.commit, gitIn(dir, 'rev-parse', 'HEAD'));
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('--apply never commits a file of the user that only shares a path with the plan', () => {
  const dir = localGit(codeRepo('standard own file', { 'README.md': '# notes\n' }));
  write(dir, { '.pre-commit-config.yaml': 'repos: []\n' });
  const out = standard(dir, '--apply', '--deploy', 'none');
  assert.deepEqual(out.skipped, ['.pre-commit-config.yaml']);
  assert.deepEqual(out.committed, CORE_FILES.filter((f) => f !== '.pre-commit-config.yaml'));
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '?? .pre-commit-config.yaml');
});

const gapRows = (text) => text.split('\n').filter((l) => l.startsWith('| STD-'));

test('--gaps prints every missing item as a backlog task, mandatory P0 and standard P1, and changes nothing (AK-3)', () => {
  const ws = tmp('standard gaps');
  write(ws, { '.claude/workspace.json': JSON.stringify({ schemaVersion: 1, name: 'demo', repos: [{ path: 'shop app' }] }) });
  const dir = codeRepo(null, {
    'requirements.txt': 'Django==5.2.1\n',
    'manage.py': '',
    '.github/workflows/old.yml': 'on: push\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gitleaks git .\n',
  }, { dir: join(ws, 'shop app') });
  const before = snapshot(dir);
  const missing = standard(dir, '--deploy', 'container').items.filter((i) => i.state === 'missing');

  const r = cli('standard', dir, '--deploy', 'container', '--gaps');
  assert.equal(r.status, 0, r.stderr);
  const rows = gapRows(r.stdout);
  assert.equal(rows.length, missing.length);
  missing.forEach((item, i) => {
    const id = `STD-${String(i + 1).padStart(2, '0')}`;
    const prio = item.class === 'mandatory' ? 'P0' : 'P1';
    assert.ok(rows[i].startsWith(`| ${id} | ${prio} | Add to \`shop app\`: `), `${item.id}: ${rows[i]}`);
    assert.ok(rows[i].endsWith(' | STD |'), rows[i]);
    assert.ok(r.stdout.includes(`\n- [ ] **${id}** (${prio}) Add to \`shop app\`: `), item.id);
    assert.ok(r.stdout.includes(`Done: \`standard\` lists \`${item.id}\` as present`), item.id);
  });
  assert.ok(!rows.some((l) => l.includes('Secret scan')), 'secret-scan is present, so it is no gap');
  assert.match(r.stdout, /^## STD — /m);
  assert.deepEqual(snapshot(dir), before);
});

test('--gaps leaves out deliberate skips, says when there is no gap and refuses --apply', () => {
  const dir = codeRepo('standard gaps none', { 'README.md': '# x\n' });
  const gitConfig = ['user.name=test', `user.email=${['test', 'localhost'].join('@')}`, 'commit.gpgsign=false'];
  for (const kv of gitConfig) gitIn(dir, 'config', ...kv.split('='));
  const priv = cli('standard', dir, '--stack', 'django', '--deploy', 'none', '--visibility', 'private', '--gaps');
  assert.ok(!gapRows(priv.stdout).some((l) => /CodeQL|Dependency Review/.test(l)), 'paid items skipped on private repos');

  standard(dir, '--stack', 'django', '--deploy', 'none', '--apply');
  const none = cli('standard', dir, '--stack', 'django', '--deploy', 'none', '--gaps');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, 'No gaps: every repo item of the standard is present or deliberately skipped.\n');

  const both = cli('standard', dir, '--gaps', '--apply');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /^buildorder: --gaps lists the plan and cannot be combined with --apply\n$/);
});

test('a repo with two supported stacks gets the second one named as not covered in the plan', () => {
  const dir = localGit(codeRepo('standard two stacks', {
    'backend/manage.py': '',
    'backend/requirements.txt': 'Django==5.2.1\n',
    'frontend/package.json': JSON.stringify({ dependencies: { react: '19.0.0' }, devDependencies: { vite: '7.0.0' } }),
  }));
  const before = snapshot(dir);
  const out = standard(dir, '--deploy', 'none');
  const chosen = out.stack.id;
  const other = chosen === 'django' ? 'react' : 'django';
  assert.ok(['django', 'react'].includes(chosen), chosen);
  const named = (notes, id) => notes.some((n) => n.startsWith(`'${id}' is also detected but not covered`));
  assert.ok(named(out.notes, other), out.notes.join(' | '));
  assert.ok(!named(out.notes, chosen), 'the chosen stack is not named as uncovered');
  // The other way round with an explicit choice.
  const flipped = standard(dir, '--stack', other, '--deploy', 'none');
  assert.ok(named(flipped.notes, chosen));
  assert.deepEqual(snapshot(dir), before, 'the plan is read-only');
});

test('plan prints the read-only plan of standard and refuses --apply', () => {
  const dir = localGit(codeRepo('standard plan', { 'README.md': '# x\n' }));
  const before = snapshot(dir);
  const r = cli('plan', dir, '--visibility', 'private');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json, standard(dir, '--visibility', 'private'));
  assert.equal(r.json.applied, false);
  const refused = cli('plan', dir, '--apply');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^buildorder: .*--apply/);
  assert.deepEqual(snapshot(dir), before, 'plan writes nothing, also when --apply is passed');
});

test('plan --gaps prints the same gap list as standard --gaps; plan refuses --starter', () => {
  const dir = localGit(codeRepo('standard plan gaps', { 'README.md': '# x\n' }));
  const before = snapshot(dir);
  const r = cli('plan', dir, '--deploy', 'none', '--gaps');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(gapRows(r.stdout).length > 0);
  assert.equal(r.stdout, cli('standard', dir, '--deploy', 'none', '--gaps').stdout);
  const starter = cli('plan', dir, '--starter');
  assert.equal(starter.status, 1);
  assert.match(starter.stderr, /^buildorder: .*--starter/);
  assert.deepEqual(snapshot(dir), before);
});
