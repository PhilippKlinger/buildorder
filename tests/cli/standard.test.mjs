import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, gitIn, tmp } from '../helpers/cli.mjs';

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
    [['--stack', 'go'], /^buildorder: --starter needs a stack module with a starter; 'go' has none\n$/],
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
