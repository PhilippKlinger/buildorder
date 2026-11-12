import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../../plugins/buildorder/lib/fsx.mjs';
import { loadStack, render } from '../../plugins/buildorder/lib/standard.mjs';
import { cleanup, tempDir } from '../helpers/cli.mjs';
import { repoRoot } from '../helpers/repo.mjs';
import { FAKE_STACKS, jobIds, jobText, needsOf, runLines, usesLines } from '../helpers/standard.mjs';

after(cleanup);

const fake = () => loadStack('fake', FAKE_STACKS);
const files = (opts) => Object.fromEntries(render(opts).map((f) => [f.path, f.content]));
const CI = '.github/workflows/ci.yml';
const CORE_JOBS = ['gitleaks', 'zizmor', 'pre-commit', 'dependency-review', 'codeql'];
const PIN = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

test('loadStack reads a stack module and returns null without one', () => {
  const stack = fake();
  assert.equal(stack.id, 'fake');
  assert.deepEqual(stack.codeql, { language: 'python', buildMode: 'none' });
  assert.deepEqual(stack.jobs, ['lint', 'test']);
  assert.deepEqual(stack.docker.map((f) => f.path), ['Dockerfile']);
  assert.equal(loadStack('vue', FAKE_STACKS), null);
  assert.equal(loadStack('fake', join(FAKE_STACKS, 'missing')), null);
});

test('fake stack with container deploy: core, stack and docker-cicd files', () => {
  const out = files({ stack: fake(), deploy: 'container', skip: new Set() });
  assert.deepEqual(Object.keys(out), [CI, '.github/workflows/deployment.yml', '.github/dependabot.yml',
    '.pre-commit-config.yaml', 'Dockerfile']);
  const ci = out[CI];
  assert.deepEqual(jobIds(ci), [...CORE_JOBS, 'lint', 'test', 'image', 'deploy', 'ci-ok']);
  // ci-ok is the required check: it needs every job that runs on a pull request.
  assert.deepEqual(needsOf(ci, 'ci-ok'), [...CORE_JOBS, 'lint', 'test', 'image']);
  assert.deepEqual(needsOf(ci, 'image'), ['lint', 'test']);
  assert.match(jobText(ci, 'deploy'), /uses: \$\/\.github\/workflows\/deployment\.yml/);
  assert.match(ci, /include: \[\{ language: actions, build-mode: none \}, \{ language: python, build-mode: none \}\]/);
  for (const step of ['trivy-action', 'sbom-action', 'attest-build-provenance', 'docker push']) {
    assert.match(jobText(ci, 'image'), new RegExp(step), step);
  }
  assert.equal(out.Dockerfile, readFileSync(join(FAKE_STACKS, 'fake', 'docker', 'Dockerfile'), 'utf8'));
  for (const [path, text] of Object.entries(out)) {
    assert.doesNotMatch(text, /__[A-Z_]+__/, `${path}: no open placeholder`);
    assert.ok(text.endsWith('\n') && !text.includes('\r'), `${path}: LF and a final newline`);
  }
});

test('CD variants by deploy target', () => {
  const web = files({ stack: fake(), deploy: 'webspace', skip: new Set() });
  assert.ok(web['.github/workflows/deployment-webspace.yml']);
  assert.equal(web['.github/workflows/deployment.yml'], undefined);
  assert.match(jobText(web[CI], 'deploy'), /uses: \$\/\.github\/workflows\/deployment-webspace\.yml/);

  for (const deploy of ['paas', 'none']) {
    const out = files({ stack: fake(), deploy, skip: new Set() });
    assert.deepEqual(Object.keys(out), [CI, '.github/dependabot.yml', '.pre-commit-config.yaml', 'Dockerfile'], deploy);
    assert.ok(!jobIds(out[CI]).includes('deploy'), deploy);
    assert.ok(jobIds(out[CI]).includes('image'), deploy);
  }

  // Without the image there is nothing to deploy.
  const noImage = files({ stack: fake(), deploy: 'container', skip: new Set(['container-image']) });
  assert.deepEqual(Object.keys(noImage), [CI, '.github/dependabot.yml', '.pre-commit-config.yaml']);
  assert.deepEqual(jobIds(noImage[CI]), [...CORE_JOBS, 'lint', 'test', 'ci-ok']);
});

test('skipped core items leave their jobs out of ci.yml and ci-ok', () => {
  const ci = files({ stack: fake(), deploy: 'none', skip: new Set(['codeql', 'dependency-review']) })[CI];
  assert.deepEqual(jobIds(ci), ['gitleaks', 'zizmor', 'pre-commit', 'lint', 'test', 'image', 'ci-ok']);
  assert.deepEqual(needsOf(ci, 'ci-ok'), ['gitleaks', 'zizmor', 'pre-commit', 'lint', 'test', 'image']);
});

test('without a stack module only the stack-independent parts are written', () => {
  const out = files({ stack: null, deploy: 'container', skip: new Set() });
  assert.deepEqual(Object.keys(out), [CI, '.github/dependabot.yml', '.pre-commit-config.yaml']);
  assert.deepEqual(jobIds(out[CI]), [...CORE_JOBS, 'ci-ok']);
  assert.match(out[CI], /include: \[\{ language: actions, build-mode: none \}\]/);
  assert.deepEqual([...out['.github/dependabot.yml'].matchAll(/package-ecosystem: "([\w-]+)"/g)].map((m) => m[1]),
    ['github-actions', 'pre-commit']);
});

test('dependabot: actions, pre-commit, the stack and docker, weekly, grouped, with cooldown', () => {
  const text = files({ stack: fake(), deploy: 'none', skip: new Set() })['.github/dependabot.yml'];
  const ecosystems = [...text.matchAll(/package-ecosystem: "([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ecosystems, ['github-actions', 'pre-commit', 'pip', 'docker']);
  assert.match(text, /^version: 2\nupdates:\n/);
  for (const eco of ecosystems) {
    const block = text.split('  - package-ecosystem: ').find((b) => b.startsWith(`"${eco}"`));
    assert.match(block, /directory: "\/"\n {4}schedule:\n {6}interval: "weekly"\n {4}cooldown:\n {6}default-days: 14\n/, eco);
    assert.match(block, new RegExp(`groups:\\n {6}${eco}:\\n {8}patterns:\\n {10}- "\\*"`), eco);
  }
});

test('pre-commit: gitleaks, YAML, line endings, end of file, and the stack hooks', () => {
  const text = files({ stack: fake(), deploy: 'none', skip: new Set() })['.pre-commit-config.yaml'];
  for (const id of ['check-yaml', 'end-of-file-fixer', 'mixed-line-ending', 'gitleaks', 'fake-format']) {
    assert.match(text, new RegExp(`- id: ${id}\\b`), id);
  }
  assert.match(text, /^repos:\n {2}- repo: https:\/\/github\.com\/pre-commit\/pre-commit-hooks$/m);
  assert.match(text, /^ {2}- repo: local\n {4}hooks:\n {6}- id: fake-format$/m);
  assert.equal(files({ stack: null, deploy: 'none', skip: new Set() })['.pre-commit-config.yaml'].includes('fake'), false);
});

test('every template and generated uses: is pinned to a commit SHA with a version comment', () => {
  const own = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const ownPins = new Map(usesLines(own).map((u) => [u.split('@')[0], u]));
  const sources = [
    ...walk(join(repoRoot, 'plugins', 'buildorder', 'templates', 'repo')).map((f) => join('plugins', 'buildorder', 'templates', 'repo', f)),
    ...walk(FAKE_STACKS).map((f) => join('tests', 'fixtures', 'stacks', f)),
  ].filter((f) => /\.ya?ml$/.test(f));
  const texts = sources.map((f) => [f, readFileSync(join(repoRoot, f), 'utf8')]);
  for (const deploy of ['container', 'webspace']) {
    for (const f of render({ stack: fake(), deploy, skip: new Set() })) texts.push([`${deploy}:${f.path}`, f.content]);
  }
  let count = 0;
  for (const [name, text] of texts) {
    for (const u of usesLines(text)) {
      if (u.startsWith('$/')) continue; // a workflow of the same repo
      count++;
      assert.match(u, PIN, `${name}: ${u}`);
      const same = ownPins.get(u.split('@')[0]);
      if (same) assert.equal(u, same, `${name}: same pin as the repo's own ci.yml`);
    }
  }
  assert.ok(count > 10, `found ${count} uses: lines`);
});

test('the CI sample helper writes both CD variants for the zizmor step', () => {
  const out = tempDir('standard sample');
  execFileSync(process.execPath, [join(repoRoot, 'tests', 'helpers', 'standard-sample.mjs'), out], { stdio: 'pipe' });
  for (const deploy of ['container', 'webspace']) {
    for (const { path, content } of render({ stack: fake(), deploy, skip: new Set() })) {
      assert.equal(readFileSync(join(out, deploy, ...path.split('/')), 'utf8'), content, `${deploy}: ${path}`);
    }
  }
});

test('generated workflows: least privilege, no persisted credentials, no expressions in run', () => {
  for (const deploy of ['container', 'webspace']) {
    for (const { path, content } of render({ stack: fake(), deploy, skip: new Set() })) {
      if (!path.startsWith('.github/workflows/')) continue;
      assert.match(content, /^permissions: \{\}$/m, `${path}: no workflow-wide token`);
      for (const id of jobIds(content)) assert.match(jobText(content, id), /^ {4}permissions:/m, `${path}: ${id} sets permissions`);
      const checkouts = content.split('actions/checkout@').length - 1;
      assert.equal(content.split('persist-credentials: false').length - 1, checkouts, `${path}: every checkout`);
      for (const line of runLines(content)) assert.doesNotMatch(line, /\$\{\{/, `${path}: ${line}`);
    }
  }
});
