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

const react = () => loadStack('react');
const DIR = join(STACKS_DIR, 'react');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const STACK_ITEMS = loadModel().items.filter((i) => i.provider === 'stack').map((i) => i.id);
const CI = '.github/workflows/ci.yml';
const STARTER = ['.gitattributes', '.gitignore', '.nvmrc', '.prettierignore', '.prettierrc.json', 'eslint.config.js',
  'index.html', 'package-lock.json', 'package.json', 'public/.htaccess', 'src/App.test.tsx', 'src/App.tsx',
  'src/main.tsx', 'src/setupTests.ts', 'src/vite-env.d.ts', 'tsconfig.json', 'vite.config.ts'];
const PIPELINE = ['.github/workflows/ci.yml', '.github/workflows/deployment-webspace.yml', '.github/dependabot.yml',
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
const starterFile = (path) => react().starter.find((f) => f.path === path).content;

test('the react module satisfies the stack-module interface', () => {
  const stack = react();
  assert.ok(stack, 'standard/stacks/react loads');
  assert.deepEqual(stack.codeql, { language: 'javascript-typescript', buildMode: 'none' });
  assert.deepEqual(stack.dependabot, [{ ecosystem: 'npm', directory: '/' }]);
  assert.deepEqual(stack.jobs, ['lint', 'test', 'build', 'audit']);
  assert.deepEqual(stack.docker.map((f) => f.path), ['.dockerignore', 'Dockerfile']);
  assert.deepEqual(stack.starter.map((f) => f.path), STARTER);
  assert.deepEqual(Object.keys(stack.provides).sort(), [...STACK_ITEMS].sort());
  // Each pattern recognises the module's own CI jobs, so a repo set up by buildorder reports them as present.
  for (const [id, pattern] of Object.entries(stack.provides)) assert.match(stack.ci, new RegExp(pattern), id);
  assert.match(stack.preCommit, /repo: https:\/\/github\.com\/rbubley\/mirrors-prettier/);
});

test('react pipeline: the stack jobs gate the image and ci-ok', () => {
  const ci = render({ stack: react(), deploy: 'container', skip: new Set() }).find((f) => f.path === CI).content;
  assert.deepEqual(needsOf(ci, 'image'), ['lint', 'test', 'build', 'audit']);
  for (const id of ['lint', 'test', 'build', 'audit', 'image']) assert.ok(needsOf(ci, 'ci-ok').includes(id), id);
  assert.match(jobText(ci, 'lint'), /npm ci\n[\s\S]*npx eslint \.\n[\s\S]*npx prettier --check \./);
  assert.match(jobText(ci, 'lint'), /npx tsc --noEmit/);
  assert.match(jobText(ci, 'test'), /npx vitest run --coverage/);
  assert.match(jobText(ci, 'build'), /npx vite build/);
  assert.match(jobText(ci, 'audit'), /npm audit --audit-level=high/);
  // Node is pinned the same way everywhere: the CI jobs, .nvmrc, the engines field and the image builder.
  const node = starterFile('.nvmrc').trim();
  assert.match(node, /^\d+\.\d+\.\d+$/);
  const versions = [...ci.matchAll(/node-version: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(versions.length, 4);
  assert.ok(versions.every((v) => v === node), `CI ${versions} vs .nvmrc ${node}`);
  assert.equal(JSON.parse(starterFile('package.json')).engines.node, node);
});

test('react image: Nginx unprivileged pinned by digest, Node builder pinned, non-root, serves dist/', () => {
  const stack = react();
  const dockerfile = stack.docker.find((f) => f.path === 'Dockerfile').content;
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2, 'multi-stage');
  const node = starterFile('.nvmrc').trim();
  assert.match(froms[0], new RegExp(`^node:${escapeRe(node)}-alpine[\\d.]+@sha256:[0-9a-f]{64}$`), froms[0]);
  assert.match(froms[1], /^nginxinc\/nginx-unprivileged:\d+\.\d+\.\d+-alpine[\d.]+@sha256:[0-9a-f]{64}$/, froms[1]);
  assert.match(dockerfile, /^RUN npm ci$/m);
  assert.match(dockerfile, /^COPY --from=build \/app\/dist \/usr\/share\/nginx\/html$/m);
  assert.match(dockerfile, /^USER nginx$/m);
  assert.match(dockerfile, /listen 8080;/);
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  const runtime = dockerfile.split(/^FROM /m)[2];
  assert.ok(runtime.indexOf('apk upgrade') < runtime.lastIndexOf('USER nginx'), 'root work happens before USER nginx');
  for (const header of ['Content-Security-Policy', 'X-Content-Type-Options', 'Strict-Transport-Security']) {
    assert.match(dockerfile, new RegExp(`add_header ${header} `), header);
  }
  assert.match(stack.docker.find((f) => f.path === '.dockerignore').content, /^node_modules$/m);
  // The webspace deploy takes the site out of the image and needs the .htaccess that Vite copies from public/.
  assert.match(starterFile('public/.htaccess'), /Content-Security-Policy/);
});

test('react starter: prettier ignores the pipeline files that buildorder writes next to the app', () => {
  assert.match(starterFile('.prettierignore'), /^\/\.github$/m);
});

test('react starter: every dependency is pinned exactly and the lockfile exists', () => {
  const pkg = JSON.parse(starterFile('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(Object.keys(deps).length >= 15, 'dependencies present');
  for (const [name, version] of Object.entries(deps)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name}: ${version}`);
  for (const name of ['react', 'react-dom', 'vite', 'typescript', 'vitest', 'eslint', 'prettier']) assert.ok(deps[name], name);
  assert.equal(pkg.private, true);
  const lock = JSON.parse(starterFile('package-lock.json'));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  for (const [name, version] of Object.entries(deps)) assert.equal(lock.packages[`node_modules/${name}`]?.version, version, name);
});

test('react starter: .gitattributes forces LF', () => {
  assert.match(starterFile('.gitattributes'), /^\* text=auto eol=lf$/m);
});

test('react module and starter files trip no secret pattern of the secret guard', () => {
  let lines = 0;
  for (const rel of walk(DIR)) {
    for (const [i, text] of readFileSync(join(DIR, ...rel.split('/')), 'utf8').split('\n').entries()) {
      lines++;
      assert.equal(scanLine(text), null, `${rel}:${i + 1}`);
    }
  }
  assert.ok(lines > 100, `scanned ${lines} lines`);
});

test('a React repo without CI: the plan lists the stack items as missing and leaves the repo unchanged (AK-3)', () => {
  const dir = codeRepo('react existing', {
    'package.json': JSON.stringify({ dependencies: { react: '19.3.1' }, devDependencies: { vite: '8.3.5' } }),
    'src/App.tsx': 'export const App = () => null;\n',
  });
  const before = snapshot(dir);
  const out = standard(dir);
  assert.deepEqual(out.stack, { id: 'react', module: true });
  assert.deepEqual(out.modules, ['react', 'docker-cicd']);
  for (const id of STACK_ITEMS) {
    const item = out.items.find((i) => i.id === id);
    assert.equal(item.state, 'missing', id);
    assert.equal(item.reason, undefined, `${id}: the module writes it`);
  }
  assert.ok(out.files.some((f) => f.path === 'Dockerfile' && f.state === 'create'));
  assert.deepEqual(snapshot(dir), before);
});

test('--apply --starter --stack react in an empty repo writes the starter and the pipeline in one commit (AK-2)', () => {
  const dir = localGit(gitInit(tmp('react starter')));
  const out = standard(dir, '--stack', 'react', '--deploy', 'webspace', '--starter', '--apply');
  assert.deepEqual(out.created, [...STARTER, ...PIPELINE]);
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(gitIn(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...out.created].sort());
  assert.match(gitIn(dir, 'log', '-1', '--format=%s'), /^feat: add the react starter and the CI\/CD files/);
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  for (const id of [...STACK_ITEMS, 'container-image', 'deploy']) assert.equal(stateOf(out)[id], 'present', id);
  assert.deepEqual(jobIds(readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8')).slice(-7),
    ['lint', 'test', 'build', 'audit', 'image', 'deploy', 'ci-ok']);
  // The written project is a React project for detect as well.
  assert.deepEqual(standard(dir).stack, { id: 'react', module: true });
});

test('the react fixture job in the repo CI runs the core commands of the module on the starter (AK-2)', () => {
  const own = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = jobText(own, 'react-fixture');
  assert.ok(job, 'job react-fixture in .github/workflows/ci.yml');
  assert.ok(needsOf(own, 'ci-ok').includes('react-fixture'), 'ci-ok needs the fixture job');
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m, 'Linux only (K3)');
  assert.match(job, /standard "\$dir" --stack react --deploy container --starter --apply/);
  assert.match(job, /docker build /);
  assert.match(job, /aquasecurity\/trivy-action/);

  // Same commands and Node version as the module's ci.yml, so the fixture proves what users get.
  const stack = react();
  const fixture = new Set(runLines(job).map((l) => l.trim()));
  const core = runLines(stack.ci).map((l) => l.trim()).filter((l) => l && l !== 'npm ci');
  assert.ok(core.length >= 5, core.join('\n'));
  for (const line of core) assert.ok(fixture.has(line), `fixture job runs: ${line}`);
  assert.ok(fixture.has('npm ci'));
  assert.ok(job.includes(stack.ci.match(/node-version: "[^"]+"/)[0]));
});
