import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../../plugins/buildorder/lib/fsx.mjs';
import { scanLine } from '../../plugins/buildorder/lib/secrets.mjs';
import { STACKS_DIR, loadModel, loadStack, render } from '../../plugins/buildorder/lib/standard.mjs';
import { cleanup, cli, codeRepo, gitIn, gitInit, tmp } from '../helpers/cli.mjs';
import { repoRoot } from '../helpers/repo.mjs';
import { jobIds, jobText, needsOf, runLines } from '../helpers/standard.mjs';

after(cleanup);

const django = () => loadStack('django');
const DIR = join(STACKS_DIR, 'django');
const STACK_ITEMS = loadModel().items.filter((i) => i.provider === 'stack').map((i) => i.id);
const CI = '.github/workflows/ci.yml';
const STARTER = ['.gitignore', 'config/__init__.py', 'config/settings.py', 'config/urls.py', 'config/wsgi.py',
  'health/__init__.py', 'health/tests.py', 'health/views.py', 'manage.py', 'pyproject.toml', 'requirements-dev.txt',
  'requirements.txt'];
const PIPELINE = ['.github/workflows/ci.yml', '.github/workflows/deployment.yml', '.github/dependabot.yml',
  '.pre-commit-config.yaml', '.dockerignore', 'Dockerfile'];

const localGit = (dir) => {
  gitIn(dir, 'config', 'user.name', 'test');
  gitIn(dir, 'config', 'user.email', ['test', 'localhost'].join('@'));
  gitIn(dir, 'config', 'commit.gpgsign', 'false');
  gitIn(dir, 'config', 'core.hooksPath', join(dir, '.git', 'no-hooks'));
  return dir;
};
const snapshot = (dir) => ({
  head: gitIn(dir, 'rev-parse', 'HEAD'),
  status: gitIn(dir, 'status', '--porcelain', '--untracked-files=all'),
});
const standard = (...args) => {
  const r = cli('standard', ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
};
const stateOf = (out) => Object.fromEntries(out.items.map((i) => [i.id, i.state]));

test('the django module satisfies the stack-module interface', () => {
  const stack = django();
  assert.ok(stack, 'standard/stacks/django loads');
  assert.deepEqual(stack.codeql, { language: 'python', buildMode: 'none' });
  assert.deepEqual(stack.dependabot, [{ ecosystem: 'pip', directory: '/' }]);
  assert.deepEqual(stack.jobs, ['lint', 'test', 'build', 'audit']);
  assert.deepEqual(stack.docker.map((f) => f.path), ['.dockerignore', 'Dockerfile']);
  assert.deepEqual(stack.starter.map((f) => f.path), STARTER);
  assert.deepEqual(Object.keys(stack.provides).sort(), [...STACK_ITEMS].sort());
  // Each pattern recognises the module's own CI jobs, so a repo set up by buildorder reports them as present.
  for (const [id, pattern] of Object.entries(stack.provides)) assert.match(stack.ci, new RegExp(pattern), id);
  assert.match(stack.preCommit, /- id: ruff-check\n {4}- id: ruff-format/);
});

test('django pipeline: the stack jobs gate the image and ci-ok, PostgreSQL runs as a service pinned by digest', () => {
  const ci = render({ stack: django(), deploy: 'container', skip: new Set() }).find((f) => f.path === CI).content;
  assert.deepEqual(needsOf(ci, 'image'), ['lint', 'test', 'build', 'audit']);
  for (const id of ['lint', 'test', 'build', 'audit', 'image']) assert.ok(needsOf(ci, 'ci-ok').includes(id), id);
  const testJob = jobText(ci, 'test');
  assert.match(testJob, /^ {8}image: postgres:[\w.-]+@sha256:[0-9a-f]{64}$/m);
  assert.match(testJob, /pytest --cov/);
  assert.match(jobText(ci, 'lint'), /ruff check \.\n[\s\S]*ruff format --check \./);
  assert.match(jobText(ci, 'build'), /manage\.py check --deploy --fail-level WARNING[\s\S]*manage\.py collectstatic --noinput/);
  assert.match(jobText(ci, 'audit'), /pip-audit --requirement requirements\.txt --requirement requirements-dev\.txt/);
  // The SECRET_KEY is generated at runtime; no key or password literal reaches a settings value.
  assert.match(ci, /secrets\.token_urlsafe\(50\)/);
  assert.doesNotMatch(ci, /DJANGO_SECRET_KEY:/);
});

test('django image: slim Python base pinned by digest, same Python as CI, non-root, gunicorn', () => {
  const stack = django();
  const dockerfile = stack.docker.find((f) => f.path === 'Dockerfile').content;
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.ok(froms.length >= 2, 'multi-stage');
  for (const ref of froms) assert.match(ref, /^python:\d+\.\d+\.\d+-slim-[a-z]+@sha256:[0-9a-f]{64}$/, ref);
  const python = froms[0].match(/^python:(\d+\.\d+\.\d+)-/)[1];
  const ciVersions = [...stack.ci.matchAll(/python-version: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ciVersions.length > 0 && ciVersions.every((v) => v === python), `CI ${ciVersions} vs image ${python}`);
  assert.match(dockerfile, /^USER app$/m);
  assert.match(dockerfile, /^CMD \["gunicorn", "config\.wsgi:application"/m);
  assert.match(stack.docker.find((f) => f.path === '.dockerignore').content, /^\.git$/m);
});

test('django image: no pip in the final image, Debian security updates applied in the runtime stage', () => {
  const dockerfile = django().docker.find((f) => f.path === 'Dockerfile').content;
  const [build, runtime] = dockerfile.split(/^FROM /m).slice(1);
  assert.match(build, /python -m venv --without-pip \/venv/);
  assert.match(build, /pip --python \/venv\/bin\/python install --requirement/);
  assert.doesNotMatch(build, /\/venv\/bin\/pip/);
  assert.match(runtime, /apt-get update/);
  assert.match(runtime, /apt-get upgrade -y --no-install-recommends/);
  assert.match(runtime, /rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.match(runtime, /python -m pip uninstall -y pip/);
  assert.ok(runtime.indexOf('pip uninstall') < runtime.indexOf('USER app'), 'root work happens before USER app');
  assert.ok(runtime.indexOf('apt-get upgrade') < runtime.indexOf('USER app'), 'root work happens before USER app');
});

test('django starter: every requirement is pinned exactly', () => {
  const starter = Object.fromEntries(django().starter.map((f) => [f.path, f.content]));
  for (const file of ['requirements.txt', 'requirements-dev.txt']) {
    const lines = starter[file].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.ok(lines.length > 0, file);
    for (const line of lines) {
      if (line === '-r requirements.txt') continue;
      assert.match(line, /^[A-Za-z0-9_.-]+(\[[\w,-]+\])?==\d+(\.\d+)+$/, `${file}: ${line}`);
    }
  }
  assert.match(starter['requirements.txt'], /^Django==5\.2\.\d+$/m, 'Django LTS');
});

test('the root Dependabot config keeps the django image on its Python minor', () => {
  const yml = readFileSync(join(repoRoot, '.github', 'dependabot.yml'), 'utf8').replace(/\r\n/g, '\n');
  const entry = yml.split(/\n(?=  - package-ecosystem:)/).find((e) => e.includes('/plugins/buildorder/standard/stacks/django/docker'));
  assert.ok(entry, 'docker entry for the django image');
  assert.match(entry, /ignore:\n(\s*#.*\n)*\s*- dependency-name: "python"\n\s*update-types: \["version-update:semver-minor"\]/);
});

test('django module and starter files trip no secret pattern of the secret guard', () => {
  let lines = 0;
  for (const rel of walk(DIR)) {
    for (const [i, text] of readFileSync(join(DIR, ...rel.split('/')), 'utf8').split('\n').entries()) {
      lines++;
      assert.equal(scanLine(text), null, `${rel}:${i + 1}`);
    }
  }
  assert.ok(lines > 100, `scanned ${lines} lines`);
});

test('a Django repo without CI: the plan lists the stack items as missing and leaves the repo unchanged (AK-3)', () => {
  const dir = codeRepo('django existing', {
    'manage.py': 'import django\n',
    'requirements.txt': 'Django==5.2.19\n',
    'shop/views.py': 'def index(request):\n    pass\n',
  });
  const before = snapshot(dir);
  const out = standard(dir);
  assert.deepEqual(out.stack, { id: 'django', module: true });
  assert.deepEqual(out.modules, ['django', 'docker-cicd']);
  for (const id of STACK_ITEMS) {
    const item = out.items.find((i) => i.id === id);
    assert.equal(item.state, 'missing', id);
    assert.match(item.reason, /^no workflow matches '/, `${id}: names what was looked for`);
  }
  assert.ok(out.files.some((f) => f.path === 'Dockerfile' && f.state === 'create'));
  assert.deepEqual(snapshot(dir), before);
});

test('a Django repo with part of the CI: the gap list names only what is missing (AK-3)', () => {
  const dir = codeRepo('django partial', {
    'manage.py': 'import django\n',
    '.github/workflows/test.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n'
      + '      - run: ruff check . && pytest --cov\n',
  });
  const before = snapshot(dir);
  const state = stateOf(standard(dir));
  assert.equal(state.lint, 'present');
  assert.equal(state['tests-coverage'], 'present');
  assert.equal(state.build, 'missing');
  assert.equal(state['dependency-audit'], 'missing');
  assert.deepEqual(snapshot(dir), before);
});

test('--apply --starter --stack django in an empty repo writes the starter and the pipeline in one commit (AK-2)', () => {
  const dir = localGit(gitInit(tmp('django starter')));
  const out = standard(dir, '--stack', 'django', '--deploy', 'container', '--starter', '--apply');
  assert.deepEqual(out.created, [...STARTER, ...PIPELINE]);
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(gitIn(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...out.created].sort());
  assert.match(gitIn(dir, 'log', '-1', '--format=%s'), /^feat: add the django starter and the CI\/CD files/);
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  for (const id of [...STACK_ITEMS, 'container-image', 'deploy']) assert.equal(stateOf(out)[id], 'present', id);
  assert.deepEqual(jobIds(readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8')).slice(-7),
    ['lint', 'test', 'build', 'audit', 'image', 'deploy', 'ci-ok']);
  // The written project is a Django project for detect as well.
  assert.deepEqual(standard(dir).stack, { id: 'django', module: true });
});

test('the django fixture job in the repo CI runs the core commands of the module on the starter (AK-2)', () => {
  const own = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = jobText(own, 'django-fixture');
  assert.ok(job, 'job django-fixture in .github/workflows/ci.yml');
  assert.ok(needsOf(own, 'ci-ok').includes('django-fixture'), 'ci-ok needs the fixture job');
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m, 'Linux only: service containers (K3)');
  assert.match(job, /standard "\$dir" --stack django --deploy container --starter --apply/);
  assert.match(job, /docker build /);

  // Same commands, PostgreSQL image and Python as the module's ci.yml, so the fixture proves what users get.
  const stack = django();
  const fixture = new Set(runLines(job).map((l) => l.trim()));
  const core = runLines(stack.ci).map((l) => l.trim()).filter((l) => l && !/pip install/.test(l));
  assert.ok(core.length >= 8, core.join('\n'));
  for (const line of core) assert.ok(fixture.has(line), `fixture job runs: ${line}`);
  for (const pattern of [/image: postgres:\S+/, /python-version: "[^"]+"/, /DATABASE_URL: \S+/]) {
    assert.ok(job.includes(stack.ci.match(pattern)[0]), String(pattern));
  }
});
