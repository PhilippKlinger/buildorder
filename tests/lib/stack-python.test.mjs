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

const python = () => loadStack('python');
const DIR = join(STACKS_DIR, 'python');
const STACK_ITEMS = loadModel().items.filter((i) => i.provider === 'stack').map((i) => i.id);
const CI = '.github/workflows/ci.yml';
const STARTER = ['.gitattributes', '.gitignore', 'pyproject.toml', 'requirements-dev.txt',
  'src/example_package/__init__.py', 'tests/test_greet.py'];
// A library gets no image: the plan skips container-image and, with it, the deploy.
const LIBRARY_PIPELINE = ['.github/workflows/ci.yml', '.github/dependabot.yml', '.pre-commit-config.yaml'];

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
const SERVICE = '[project]\nname = "api"\nversion = "1.0.0"\ndependencies = ["uvicorn==0.99.0"]\n';

test('the python module satisfies the stack-module interface', () => {
  const stack = python();
  assert.ok(stack, 'standard/stacks/python loads');
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

test('python pipeline: the stack jobs gate the image and ci-ok', () => {
  const ci = render({ stack: python(), deploy: 'container', skip: new Set() }).find((f) => f.path === CI).content;
  assert.deepEqual(needsOf(ci, 'image'), ['lint', 'test', 'build', 'audit']);
  for (const id of ['lint', 'test', 'build', 'audit', 'image']) assert.ok(needsOf(ci, 'ci-ok').includes(id), id);
  assert.match(jobText(ci, 'lint'), /ruff check \.\n[\s\S]*ruff format --check \./);
  assert.match(jobText(ci, 'test'), /pytest --cov/);
  assert.match(jobText(ci, 'build'), /python -m build/);
  assert.match(jobText(ci, 'audit'), /pip-audit --requirement requirements-dev\.txt[\s\S]*pip-audit \.$/m);
  // Without an image (library) the stack jobs still gate ci-ok.
  const lib = render({ stack: python(), deploy: 'none', skip: new Set(['container-image']) }).find((f) => f.path === CI).content;
  assert.deepEqual(jobIds(lib).slice(-5), ['lint', 'test', 'build', 'audit', 'ci-ok']);
});

test('python image: slim Python base pinned by digest, same Python as CI, non-root, no pip at runtime', () => {
  const stack = python();
  const dockerfile = stack.docker.find((f) => f.path === 'Dockerfile').content;
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.ok(froms.length >= 2, 'multi-stage');
  for (const ref of froms) assert.match(ref, /^python:\d+\.\d+\.\d+-slim-[a-z]+@sha256:[0-9a-f]{64}$/, ref);
  const version = froms[0].match(/^python:(\d+\.\d+\.\d+)-/)[1];
  const ciVersions = [...stack.ci.matchAll(/python-version: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ciVersions.length > 0 && ciVersions.every((v) => v === version), `CI ${ciVersions} vs image ${version}`);
  assert.match(dockerfile, /^USER app$/m);
  const [build, runtime] = dockerfile.split(/^FROM /m).slice(1);
  assert.match(build, /python -m venv --without-pip \/venv/);
  assert.doesNotMatch(build, /\/venv\/bin\/pip/);
  assert.match(runtime, /apt-get upgrade -y --no-install-recommends/);
  assert.match(runtime, /python -m pip uninstall -y pip/);
  assert.ok(runtime.indexOf('pip uninstall') < runtime.indexOf('USER app'), 'root work happens before USER app');
  assert.match(stack.docker.find((f) => f.path === '.dockerignore').content, /^\.git$/m);
});

test('python starter: every dependency is pinned exactly and the lockfile exists', () => {
  const starter = Object.fromEntries(python().starter.map((f) => [f.path, f.content]));
  // Python pins in requirements files (the lockfile of this stack): exact versions only.
  const lines = starter['requirements-dev.txt'].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.length >= 5, 'dev tools are listed');
  for (const line of lines) assert.match(line, /^[A-Za-z0-9_.-]+(\[[\w,-]+\])?==\d+(\.\d+)+$/, line);
  // The build backend is pinned too; the library has no runtime dependency to range.
  assert.match(starter['pyproject.toml'], /^requires = \["hatchling==\d+(\.\d+)+"\]$/m);
  assert.match(starter['pyproject.toml'], /^dependencies = \[\]$/m);
});

test('python starter: .gitattributes forces LF', () => {
  const file = python().starter.find((f) => f.path === '.gitattributes');
  assert.match(file.content, /^\* text=auto eol=lf$/m);
});

test('python module and starter files trip no secret pattern of the secret guard', () => {
  let lines = 0;
  for (const rel of walk(DIR)) {
    for (const [i, text] of readFileSync(join(DIR, ...rel.split('/')), 'utf8').split('\n').entries()) {
      lines++;
      assert.equal(scanLine(text), null, `${rel}:${i + 1}`);
    }
  }
  assert.ok(lines > 100, `scanned ${lines} lines`);
});

test('a python repo without CI: the plan lists the stack items as missing and leaves the repo unchanged (AK-3)', () => {
  const dir = codeRepo('python existing', {
    'pyproject.toml': SERVICE,
    'api/main.py': 'def app():\n    pass\n',
  });
  const before = snapshot(dir);
  const out = standard(dir);
  assert.deepEqual(out.stack, { id: 'python', module: true });
  assert.deepEqual(out.modules, ['python', 'docker-cicd']);
  for (const id of STACK_ITEMS) {
    const item = out.items.find((i) => i.id === id);
    assert.equal(item.state, 'missing', id);
    assert.equal(item.reason, undefined, `${id}: the module writes it`);
  }
  assert.ok(out.files.some((f) => f.path === 'Dockerfile' && f.state === 'create'));
  assert.deepEqual(out.deviations, []);
  assert.deepEqual(snapshot(dir), before);
});

test('a python library (no entry point, no server dependency) gets the deviation "no Docker" proposed in the plan', () => {
  const dir = codeRepo('python library', {
    'pyproject.toml': '[project]\nname = "lib"\nversion = "1.0.0"\ndependencies = ["requests==2.32.0"]\n',
    'src/lib/__init__.py': 'X = 1\n',
  });
  const before = snapshot(dir);
  const out = standard(dir);
  assert.deepEqual(out.modules, ['python']);
  assert.equal(stateOf(out)['container-image'], 'skipped');
  assert.equal(stateOf(out).deploy, 'skipped');
  assert.deepEqual(out.deviations.map((d) => d.id), ['container-image']);
  assert.match(out.deviations[0].reason, /library/);
  assert.ok(!out.files.some((f) => f.path === 'Dockerfile'), 'no Dockerfile in the plan');
  assert.deepEqual(snapshot(dir), before);
});

test('python library or service: an entry point, a server dependency or a Dockerfile make it a service', () => {
  const cases = {
    'entry point': { 'pyproject.toml': '[project]\nname = "x"\n\n[project.scripts]\nx = "x:main"\n' },
    'server dependency': { 'requirements.txt': 'Flask==3.1.0\n' },
    'server dependency in pyproject': { 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["gunicorn>=22"]\n' },
    Dockerfile: { 'pyproject.toml': '[project]\nname = "x"\n', Dockerfile: 'FROM scratch\n' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const out = standard(codeRepo(`python service ${name}`, { 'app.py': 'x = 1\n', ...files }), '--stack', 'python');
    assert.deepEqual(out.deviations, [], name);
    assert.notEqual(stateOf(out)['container-image'], 'skipped', name);
  }
  // A library that names flask only in its description stays a library.
  const lib = codeRepo('python lib text', {
    'pyproject.toml': '[project]\nname = "x"\ndescription = "helpers for flask apps"\n',
    'x.py': 'x = 1\n',
  });
  assert.equal(stateOf(standard(lib, '--stack', 'python'))['container-image'], 'skipped');
});

test('a python repo with part of the CI: the gap list names only what is missing (AK-3)', () => {
  const dir = codeRepo('python partial', {
    'pyproject.toml': SERVICE,
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

test('--apply --starter --stack python in an empty repo writes the starter and the pipeline in one commit (AK-2)', () => {
  const dir = localGit(gitInit(tmp('python starter')));
  const out = standard(dir, '--stack', 'python', '--deploy', 'none', '--starter', '--apply');
  assert.deepEqual(out.created, [...STARTER, ...LIBRARY_PIPELINE]);
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(gitIn(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...out.created].sort());
  assert.match(gitIn(dir, 'log', '-1', '--format=%s'), /^feat: add the python starter and the CI\/CD files/);
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  for (const id of STACK_ITEMS) assert.equal(stateOf(out)[id], 'present', id);
  assert.deepEqual(out.deviations.map((d) => d.id), ['container-image']);
  assert.deepEqual(jobIds(readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8')).slice(-5),
    ['lint', 'test', 'build', 'audit', 'ci-ok']);
  assert.deepEqual(standard(dir).stack, { id: 'python', module: true });
});

test('the python fixture job in the repo CI runs the core commands of the module on the starter (AK-2)', () => {
  const own = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = jobText(own, 'python-fixture');
  assert.ok(job, 'job python-fixture in .github/workflows/ci.yml');
  assert.ok(needsOf(own, 'ci-ok').includes('python-fixture'), 'ci-ok needs the fixture job');
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m, 'Linux only (K3)');
  assert.match(job, /standard "\$dir" --stack python --deploy none --starter --apply/);
  assert.match(job, /docker build /);
  assert.match(job, /trivy-action/);

  // Same commands and Python as the module's ci.yml, so the fixture proves what users get.
  const stack = python();
  const fixture = new Set(runLines(job).map((l) => l.trim()));
  const core = runLines(stack.ci).map((l) => l.trim()).filter((l) => l && !/pip install/.test(l));
  assert.ok(core.length >= 5, core.join('\n'));
  for (const line of core) assert.ok(fixture.has(line), `fixture job runs: ${line}`);
  assert.ok(job.includes(stack.ci.match(/python-version: "[^"]+"/)[0]));
});
