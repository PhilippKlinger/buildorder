import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadModel, standard } from '../../plugins/buildorder/lib/standard.mjs';
import { cleanup, codeRepo, gitIn, tempDir, write } from '../helpers/cli.mjs';
import { FAKE_STACKS, jobIds } from '../helpers/standard.mjs';

after(cleanup);

const REPO_ITEMS = loadModel().items.filter((i) => i.where === 'repo').map((i) => i.id);
const ALL_FILES = ['.github/workflows/ci.yml', '.github/workflows/deployment.yml', '.github/dependabot.yml',
  '.pre-commit-config.yaml', 'Dockerfile'];

/** Repo-local identity and no hooks, so the commit of --apply works on any machine. */
function localGit(dir) {
  gitIn(dir, 'config', 'user.name', 'test');
  gitIn(dir, 'config', 'user.email', ['test', 'localhost'].join('@'));
  gitIn(dir, 'config', 'commit.gpgsign', 'false');
  gitIn(dir, 'config', 'core.hooksPath', join(dir, '.git', 'no-hooks'));
  return dir;
}

const repo = (label, files = { 'README.md': '# app\n' }, opts) => localGit(codeRepo(label, files, opts));
const run = (dir, opts = {}) => standard(dir, { stack: 'fake', deploy: 'container', ...opts }, { stacksDir: FAKE_STACKS });
const snapshot = (dir) => ({
  head: gitIn(dir, 'rev-parse', 'HEAD'),
  status: gitIn(dir, 'status', '--porcelain', '--untracked-files=all'),
});
const stateOf = (out) => Object.fromEntries(out.items.map((i) => [i.id, i.state]));
const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');

test('plan for an empty repo: every item missing, every file to create, repo unchanged', () => {
  const dir = repo('standard empty');
  const before = snapshot(dir);
  const out = run(dir);
  assert.equal(out.ok, true);
  assert.equal(out.applied, false);
  assert.equal(out.repo, dir);
  assert.deepEqual(out.stack, { id: 'fake', module: true });
  assert.deepEqual(out.modules, ['fake', 'docker-cicd']);
  assert.equal(out.deploy, 'container');
  assert.equal(out.visibility, 'public');
  assert.deepEqual(out.items.map((i) => i.id), REPO_ITEMS);
  for (const item of out.items) {
    assert.equal(item.state, 'missing', item.id);
    assert.ok(['mandatory', 'standard'].includes(item.class), item.id);
    assert.ok(item.provider, item.id);
  }
  assert.deepEqual(out.files, ALL_FILES.map((path) => ({ path, state: 'create' })));
  assert.deepEqual(out.deviations, []);
  assert.deepEqual(snapshot(dir), before);
});

test('plan for a repo with some files: state per item, files kept, repo unchanged (AK-3)', () => {
  const dir = repo('standard some', {
    '.pre-commit-config.yaml': 'repos: []\n',
    '.github/dependabot.yml': 'version: 2\nupdates: []\n',
    '.github/workflows/old.yml': [
      'on: push',
      'jobs:',
      '  scan:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: gitleaks git . && fake-lint',
      '',
    ].join('\n'),
  });
  const before = snapshot(dir);
  const out = run(dir);
  const state = stateOf(out);
  assert.equal(state['secret-scan'], 'present');
  assert.equal(state.dependabot, 'present');
  assert.equal(state.lint, 'present');
  assert.equal(state['pre-commit'], 'missing', 'the config alone is not enough: CI must run the hooks');
  assert.equal(state['action-pins'], 'missing', 'checkout@v4 is not pinned');
  assert.equal(state.codeql, 'missing');
  assert.equal(state['tests-coverage'], 'missing');
  const files = Object.fromEntries(out.files.map((f) => [f.path, f.state]));
  assert.equal(files['.pre-commit-config.yaml'], 'exists');
  assert.equal(files['.github/dependabot.yml'], 'exists');
  assert.equal(files['.github/workflows/ci.yml'], 'create');
  assert.deepEqual(snapshot(dir), before);
});

test('--apply writes the missing files, keeps existing ones, makes one commit and records the standards', () => {
  const ws = tempDir('standard ws');
  write(ws, { '.claude/workspace.json': JSON.stringify({ schemaVersion: 1, name: 'demo', repos: [{ path: 'app' }] }) });
  const dir = repo(null, { 'README.md': '# app\n', '.pre-commit-config.yaml': 'mine\n' }, { dir: join(ws, 'app') });
  const head = gitIn(dir, 'rev-parse', 'HEAD');

  const out = run(dir, { apply: true, without: ['deploy=deployed by hand for now'] });
  assert.equal(out.applied, true);
  const created = ['.github/workflows/ci.yml', '.github/dependabot.yml', 'Dockerfile'];
  assert.deepEqual(out.created, created);
  assert.deepEqual(out.skipped, ['.pre-commit-config.yaml']);
  assert.equal(read(dir, '.pre-commit-config.yaml'), 'mine\n');
  assert.equal(existsSync(join(dir, '.github', 'workflows', 'deployment.yml')), false);

  // One commit on top of the old HEAD, holding exactly the created files; nothing left over.
  assert.equal(gitIn(dir, 'rev-parse', 'HEAD~1'), head);
  assert.equal(out.commit, gitIn(dir, 'rev-parse', 'HEAD'));
  assert.deepEqual(gitIn(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...created].sort());
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');

  const state = stateOf(out);
  for (const id of ['secret-scan', 'workflow-lint', 'codeql', 'dependency-review', 'dependabot', 'action-pins', 'lint',
    'tests-coverage', 'build', 'dependency-audit', 'container-image']) {
    assert.equal(state[id], 'present', id);
  }
  assert.equal(state['pre-commit'], 'present', 'own config kept, CI job added');
  assert.equal(state.deploy, 'skipped');

  assert.deepEqual(out.workspace, { dir: ws, recorded: true });
  const saved = JSON.parse(read(ws, '.claude/workspace.json'));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.name, 'demo');
  assert.deepEqual(saved.repos, [{
    path: 'app',
    standards: {
      modules: ['fake', 'docker-cicd'],
      deviations: [{ id: 'deploy', class: 'standard', reason: 'deployed by hand for now' }],
    },
  }]);

  // A second run writes nothing and makes no commit.
  const again = run(dir, { apply: true, without: ['deploy=deployed by hand for now'] });
  assert.deepEqual(again.created, []);
  assert.equal(again.commit, null);
  assert.equal(gitIn(dir, 'rev-parse', 'HEAD'), out.commit);
});

test('--apply outside a workspace commits and records nothing else', () => {
  const dir = repo('standard no ws');
  const out = run(dir, { apply: true, deploy: 'none' });
  assert.equal(out.workspace, null);
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '2');
  assert.match(gitIn(dir, 'log', '-1', '--format=%s'), /^ci: /);
});

test('--visibility private skips CodeQL and Dependency Review with the reason', () => {
  const dir = repo('standard private');
  const out = run(dir, { visibility: 'private', apply: true });
  for (const id of ['codeql', 'dependency-review']) {
    const item = out.items.find((i) => i.id === id);
    assert.equal(item.state, 'skipped', id);
    assert.match(item.reason, /private repo: needs a paid GitHub product/, id);
  }
  assert.deepEqual(out.deviations.map((d) => [d.id, d.class]), [['dependency-review', 'mandatory'], ['codeql', 'mandatory']]);
  const jobs = jobIds(read(dir, '.github/workflows/ci.yml'));
  assert.ok(!jobs.includes('codeql') && !jobs.includes('dependency-review'), jobs.join(' '));
  assert.ok(out.notes.some((n) => /attestation/.test(n)));
});

test('deselecting the container image drops the image, the Dockerfile and the deploy', () => {
  const dir = repo('standard no image');
  const out = run(dir, { without: ['container-image=library, nothing to run'] });
  const items = Object.fromEntries(out.items.map((i) => [i.id, i]));
  assert.equal(items['container-image'].state, 'skipped');
  assert.equal(items['container-image'].reason, 'library, nothing to run');
  assert.equal(items.deploy.state, 'skipped');
  assert.match(items.deploy.reason, /container-image/);
  assert.deepEqual(out.deviations, [{ id: 'container-image', class: 'standard', reason: 'library, nothing to run' }]);
  assert.deepEqual(out.modules, ['fake']);
  assert.deepEqual(out.files.map((f) => f.path), ['.github/workflows/ci.yml', '.github/dependabot.yml', '.pre-commit-config.yaml']);
});

test('CD variants: webspace writes its workflow, paas is a hint, none writes nothing', () => {
  const dir = repo('standard cd');
  const paths = (out) => out.files.map((f) => f.path);
  assert.ok(paths(run(dir, { deploy: 'webspace' })).includes('.github/workflows/deployment-webspace.yml'));

  const paas = run(dir, { deploy: 'paas' });
  assert.ok(!paths(paas).some((p) => /deployment/.test(p)));
  assert.equal(paas.items.find((i) => i.id === 'deploy').state, 'skipped');
  assert.ok(paas.notes.some((n) => /paas/.test(n)));
  assert.deepEqual(paas.deviations, []);

  const none = run(dir, { deploy: 'none' });
  assert.ok(!paths(none).some((p) => /deployment/.test(p)));
  assert.match(none.items.find((i) => i.id === 'deploy').reason, /none/);

  // Nothing was written: the plan stays read-only.
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
});
