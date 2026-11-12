import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadModel, standard } from '../../plugins/buildorder/lib/standard.mjs';
import { cleanup, codeRepo, gitIn, gitInit, tempDir, tmp, write } from '../helpers/cli.mjs';
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
  // isCode and stacks are refreshed from detect, so the entry matches the repo as it is after the commit.
  assert.deepEqual(saved.repos, [{
    path: 'app',
    isCode: true,
    stacks: ['docker', 'github-actions'],
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

test('a stack module without a Dockerfile gets no image job, and the image is skipped with the reason', () => {
  const stacksDir = tempDir('standard stacks');
  cpSync(join(FAKE_STACKS, 'fake'), join(stacksDir, 'fake'), { recursive: true });
  rmSync(join(stacksDir, 'fake', 'docker'), { recursive: true });
  const dir = repo('standard no dockerfile');
  const out = standard(dir, { stack: 'fake', deploy: 'container', apply: true }, { stacksDir });
  const items = Object.fromEntries(out.items.map((i) => [i.id, i]));
  assert.equal(items['container-image'].state, 'skipped');
  assert.equal(items['container-image'].reason, 'the stack module provides no Dockerfile');
  assert.equal(items.deploy.state, 'skipped');
  assert.deepEqual(out.deviations, [], 'no decision of a person, so no deviation');
  assert.deepEqual(out.modules, ['fake']);
  assert.deepEqual(out.created, ['.github/workflows/ci.yml', '.github/dependabot.yml', '.pre-commit-config.yaml']);
  const jobs = jobIds(read(dir, '.github/workflows/ci.yml'));
  assert.ok(!jobs.includes('image') && !jobs.includes('deploy'), jobs.join(' '));
});

const STARTER = ['README.md', 'src/main.fake'];

test('--starter in an empty repo: the plan lists the starter files, --apply writes them with the pipeline in one commit', () => {
  const dir = localGit(gitInit(tmp('standard starter')));
  const plan = run(dir, { starter: true });
  assert.deepEqual(plan.files.map((f) => f.path), [...STARTER, ...ALL_FILES]);
  assert.ok(plan.files.every((f) => f.state === 'create'));
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '', 'the plan writes nothing');

  const out = run(dir, { starter: true, apply: true });
  assert.deepEqual(out.created, [...STARTER, ...ALL_FILES]);
  assert.equal(read(dir, 'src/main.fake'), read(join(FAKE_STACKS, 'fake', 'starter'), 'src/main.fake'));
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(gitIn(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...out.created].sort());
  assert.match(gitIn(dir, 'log', '-1', '--format=%s'), /^feat: add the fake starter and the CI\/CD files/);
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('--starter never overwrites a file the repo already has', () => {
  const dir = repo('standard starter keep', { 'README.md': '# mine\n' });
  const out = run(dir, { starter: true, apply: true, deploy: 'none' });
  assert.ok(out.skipped.includes('README.md'));
  assert.ok(out.created.includes('src/main.fake'));
  assert.equal(read(dir, 'README.md'), '# mine\n');
});

test('--starter without a stack module that has a starter fails before writing anything', () => {
  const stacksDir = tempDir('standard no starter');
  cpSync(join(FAKE_STACKS, 'fake'), join(stacksDir, 'fake'), { recursive: true });
  rmSync(join(stacksDir, 'fake', 'starter'), { recursive: true });
  const dir = localGit(gitInit(tmp('standard starter missing')));
  assert.throws(() => standard(dir, { stack: 'fake', starter: true, apply: true }, { stacksDir }),
    /^Error: --starter needs a stack module with a starter; 'fake' has none$/);
  assert.throws(() => standard(dir, { starter: true, apply: true }, { stacksDir }),
    /^Error: --starter needs a stack module with a starter; no stack detected \(choose one with --stack\)$/);
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
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

test('--apply refreshes isCode and stacks of its own repo only, also deep in the tree, and says when the entry is missing', () => {
  const ws = tempDir('standard ws own');
  const other = { path: 'other', isCode: false, stacks: ['stale'] };
  write(ws, {
    '.claude/workspace.json': JSON.stringify({
      schemaVersion: 1, name: 'demo', repos: [{ path: 'one/two/three/app', isCode: false, stacks: [] }, other],
    }),
  });
  // Deeper than detect looks for repos: a workspace-wide detect would not find it and skip silently.
  const dir = repo(null, { 'README.md': '# app\n' }, { dir: join(ws, 'one', 'two', 'three', 'app') });
  const out = run(dir, { apply: true, deploy: 'none' });
  assert.deepEqual(out.workspace, { dir: ws, recorded: true });
  const saved = JSON.parse(read(ws, '.claude/workspace.json'));
  assert.equal(saved.repos[0].isCode, true);
  assert.deepEqual(saved.repos[0].stacks, ['docker', 'github-actions']);
  assert.deepEqual(saved.repos[1], other, 'the other repo entry stays as it was');

  const unlisted = tempDir('standard ws unlisted');
  write(unlisted, { '.claude/workspace.json': JSON.stringify({ schemaVersion: 1, name: 'demo', repos: [] }) });
  const lone = repo(null, { 'README.md': '# app\n' }, { dir: join(unlisted, 'app') });
  const res = run(lone, { apply: true, deploy: 'none' });
  assert.equal(res.workspace.recorded, false);
  assert.match(res.workspace.reason, /no entry for 'app'/);
});
