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

const angular = () => loadStack('angular');
const DIR = join(STACKS_DIR, 'angular');
const STACK_ITEMS = loadModel().items.filter((i) => i.provider === 'stack').map((i) => i.id);
const CI = '.github/workflows/ci.yml';
const STARTER = ['.gitattributes', '.gitignore', '.nvmrc', '.prettierignore', '.prettierrc', 'angular.json',
  'eslint.config.js', 'package-lock.json', 'package.json', 'public/.htaccess', 'src/app/app.spec.ts', 'src/app/app.ts',
  'src/index.html', 'src/main.ts', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.spec.json'];
const PIPELINE = ['.github/workflows/ci.yml', '.github/workflows/deployment.yml', '.github/dependabot.yml',
  '.pre-commit-config.yaml', '.dockerignore', 'Dockerfile', 'nginx.conf'];

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
const starterFile = (path) => angular().starter.find((f) => f.path === path).content;

test('the angular module satisfies the stack-module interface', () => {
  const stack = angular();
  assert.ok(stack, 'standard/stacks/angular loads');
  assert.deepEqual(stack.codeql, { language: 'javascript-typescript', buildMode: 'none' });
  assert.deepEqual(stack.dependabot, [{ ecosystem: 'npm', directory: '/' }]);
  assert.deepEqual(stack.jobs, ['lint', 'test', 'build', 'audit']);
  assert.deepEqual(stack.docker.map((f) => f.path), ['.dockerignore', 'Dockerfile', 'nginx.conf']);
  assert.deepEqual(stack.starter.map((f) => f.path), STARTER);
  assert.deepEqual(Object.keys(stack.provides).sort(), [...STACK_ITEMS].sort());
  // Each pattern recognises the module's own CI jobs, so a repo set up by buildorder reports them as present.
  for (const [id, pattern] of Object.entries(stack.provides)) assert.match(stack.ci, new RegExp(pattern), id);
});

test('angular pipeline: the stack jobs gate the image and ci-ok, the core commands run from the lockfile', () => {
  const ci = render({ stack: angular(), deploy: 'container', skip: new Set() }).find((f) => f.path === CI).content;
  assert.deepEqual(needsOf(ci, 'image'), ['lint', 'test', 'build', 'audit']);
  for (const id of ['lint', 'test', 'build', 'audit', 'image']) assert.ok(needsOf(ci, 'ci-ok').includes(id), id);
  for (const id of ['lint', 'test', 'build']) assert.match(jobText(ci, id), /^ {8}run: npm ci$/m, id);
  assert.match(jobText(ci, 'lint'), /npm run lint\n[\s\S]*npm run format:check/);
  assert.match(jobText(ci, 'test'), /npm run test:ci/);
  assert.match(jobText(ci, 'build'), /npm run build/);
  assert.match(jobText(ci, 'audit'), /npm audit --audit-level=high/);
  // Node comes from the starter's .nvmrc, the one place the version is pinned for CI and the image.
  assert.equal([...ci.matchAll(/node-version-file: \.nvmrc/g)].length, 4);
  assert.doesNotMatch(ci, /node-version: /);
});

test('angular image: Node builder and unprivileged Nginx pinned by digest, same Node as CI, non-root', () => {
  const stack = angular();
  const dockerfile = stack.docker.find((f) => f.path === 'Dockerfile').content;
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2, 'multi-stage: builder and runtime');
  assert.match(froms[0], /^node:\d+\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64}$/);
  assert.match(froms[1], /^nginxinc\/nginx-unprivileged:\d+\.\d+\.\d+-alpine[\d.]*@sha256:[0-9a-f]{64}$/);
  assert.equal(froms[0].match(/^node:(\d+\.\d+\.\d+)-/)[1], starterFile('.nvmrc').trim(), 'builder Node = .nvmrc');
  assert.equal(starterFile('.nvmrc'), loadStack('react').starter.find((f) => f.path === '.nvmrc').content, 'same Node as the react module');
  assert.match(dockerfile, /^RUN npm ci$/m);
  assert.match(dockerfile, /^COPY --from=build \/app\/dist\/app\/browser \/usr\/share\/nginx\/html$/m);
  assert.match(dockerfile, /^COPY nginx\.conf \/etc\/nginx\/conf\.d\/default\.conf$/m);
  const runtime = dockerfile.split(/^FROM /m)[2];
  assert.match(runtime, /apk upgrade --no-cache/);
  assert.match(runtime, /^USER 101$/m);
  assert.ok(runtime.indexOf('apk upgrade') < runtime.indexOf('USER 101'), 'root work happens before USER');
  assert.match(runtime, /^EXPOSE 8080$/m);
  const ignore = stack.docker.find((f) => f.path === '.dockerignore').content;
  for (const line of ['.git', 'node_modules', 'dist', '.angular']) assert.match(ignore, new RegExp(`^${line}$`, 'm'), line);
  const nginx = stack.docker.find((f) => f.path === 'nginx.conf').content;
  assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html;/, 'single-page fallback');
  assert.match(nginx, /listen 8080;/);
  assert.match(nginx, /location \^~ \/\.well-known\/ \{/, 'dotfile deny keeps /.well-known/ reachable');
  assert.match(nginx, /location ~ \/\\. \{\n\s+deny all;/);
});

test('angular starter: every dependency is pinned exactly and the lockfile exists', () => {
  const pkg = JSON.parse(starterFile('package.json'));
  const lock = JSON.parse(starterFile('package-lock.json'));
  const direct = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(Object.keys(direct).length >= 10, 'has dependencies');
  for (const [name, version] of Object.entries(direct)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name}: ${version}`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} is locked at ${version}`);
  }
  assert.ok(lock.lockfileVersion >= 3);
  assert.match(pkg.engines.node, /^>=\d+\.\d+\.\d+$/);
  assert.match(starterFile('.nvmrc'), /^\d+\.\d+\.\d+\n$/);
  // The test runner is Vitest on jsdom: it needs no browser on the CI runner.
  assert.ok(direct.vitest && direct.jsdom && direct['@vitest/coverage-v8']);
});

test('angular starter: .gitattributes forces LF', () => {
  assert.match(starterFile('.gitattributes'), /^\* text=auto eol=lf$/m);
  assert.match(starterFile('.prettierrc'), /"endOfLine": "lf"/);
  // The pipeline files that buildorder writes next to the app are not the app's formatting concern.
  assert.match(starterFile('.prettierignore'), /^\/\.github$/m);
});

test('angular starter: .gitignore keeps .env files out of git', () => {
  const ignore = starterFile('.gitignore');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.env\.\*$/m);
});

test('angular module and starter files trip no secret pattern of the secret guard', () => {
  let lines = 0;
  for (const rel of walk(DIR)) {
    for (const [i, text] of readFileSync(join(DIR, ...rel.split('/')), 'utf8').split('\n').entries()) {
      lines++;
      assert.equal(scanLine(text), null, `${rel}:${i + 1}`);
    }
  }
  assert.ok(lines > 100, `scanned ${lines} lines`);
});

test('an angular repo without CI: the plan lists the stack items as missing and leaves the repo unchanged (AK-3)', () => {
  const dir = codeRepo('angular existing', {
    'angular.json': '{}',
    'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.2.4' } }),
    'src/main.ts': 'console.log(1);\n',
  });
  const before = snapshot(dir);
  const out = standard(dir);
  assert.deepEqual(out.stack, { id: 'angular', module: true });
  assert.deepEqual(out.modules, ['angular', 'docker-cicd']);
  for (const id of STACK_ITEMS) {
    const item = out.items.find((i) => i.id === id);
    assert.equal(item.state, 'missing', id);
    assert.match(item.reason, /^no workflow matches '/, `${id}: names what was looked for`);
  }
  assert.ok(out.files.some((f) => f.path === 'Dockerfile' && f.state === 'create'));
  assert.deepEqual(snapshot(dir), before);
});

test('an angular repo with part of the CI: the gap list names only what is missing (AK-3)', () => {
  const dir = codeRepo('angular partial', {
    'angular.json': '{}',
    '.github/workflows/test.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n'
      + '      - run: npx ng lint && npx ng test --coverage\n',
  });
  const before = snapshot(dir);
  const state = stateOf(standard(dir));
  assert.equal(state.lint, 'present');
  assert.equal(state['tests-coverage'], 'present');
  assert.equal(state.build, 'missing');
  assert.equal(state['dependency-audit'], 'missing');
  assert.deepEqual(snapshot(dir), before);
});

test('--apply --starter --stack angular in an empty repo writes the starter and the pipeline in one commit (AK-2)', () => {
  const dir = localGit(gitInit(tmp('angular starter')));
  const out = standard(dir, '--stack', 'angular', '--deploy', 'container', '--starter', '--apply');
  assert.deepEqual(out.created, [...STARTER, ...PIPELINE]);
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(gitIn(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...out.created].sort());
  assert.match(gitIn(dir, 'log', '-1', '--format=%s'), /^feat: add the angular starter and the CI\/CD files/);
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  for (const id of [...STACK_ITEMS, 'container-image', 'deploy']) assert.equal(stateOf(out)[id], 'present', id);
  assert.deepEqual(jobIds(readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8')).slice(-7),
    ['lint', 'test', 'build', 'audit', 'image', 'deploy', 'ci-ok']);
  // The written project is an Angular project for detect as well.
  assert.deepEqual(standard(dir).stack, { id: 'angular', module: true });
});

test('the webspace target deploys the site from the image: index.html and .htaccess reach the build output (AK-2)', () => {
  const dir = localGit(gitInit(tmp('angular webspace')));
  const out = standard(dir, '--stack', 'angular', '--deploy', 'webspace', '--starter', '--apply');
  assert.ok(out.created.includes('.github/workflows/deployment-webspace.yml'));
  assert.match(readFileSync(join(dir, 'Dockerfile'), 'utf8'), /\/usr\/share\/nginx\/html$/m);
  assert.match(readFileSync(join(dir, 'angular.json'), 'utf8'), /"glob": "\*\*\/\*", "input": "public"/);
  const htaccess = readFileSync(join(dir, 'public', '.htaccess'), 'utf8');
  for (const header of ['Strict-Transport-Security', 'Content-Security-Policy', 'X-Content-Type-Options']) {
    assert.match(htaccess, new RegExp(header), header);
  }
});

test('the angular fixture job in the repo CI runs the core commands of the module on the starter (AK-2)', () => {
  const own = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = jobText(own, 'angular-fixture');
  assert.ok(job, 'job angular-fixture in .github/workflows/ci.yml');
  assert.ok(needsOf(own, 'ci-ok').includes('angular-fixture'), 'ci-ok needs the fixture job');
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m, 'Linux only (K3)');
  assert.match(job, /standard "\$dir" --stack angular --deploy container --starter --apply/);
  assert.match(job, /docker build /);
  assert.match(job, /aquasecurity\/trivy-action@[0-9a-f]{40}/);

  // Same commands and Node source as the module's ci.yml, so the fixture proves what users get.
  const stack = angular();
  const fixture = new Set(runLines(job).map((l) => l.trim()));
  const core = [...new Set(runLines(stack.ci).map((l) => l.trim()).filter(Boolean))];
  assert.ok(core.length >= 6, core.join('\n'));
  for (const line of core) assert.ok(fixture.has(line), `fixture job runs: ${line}`);
  assert.ok(job.includes('node-version-file: ${{ runner.temp }}/angular app/.nvmrc'), 'Node from the written .nvmrc');
});
