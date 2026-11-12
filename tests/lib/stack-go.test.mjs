import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../../plugins/buildorder/lib/fsx.mjs';
import { scanLine } from '../../plugins/buildorder/lib/secrets.mjs';
import { STACKS_DIR, loadModel, loadStack, render } from '../../plugins/buildorder/lib/standard.mjs';
import { cleanup, cli, codeRepo, gitIn, gitInit, tmp } from '../helpers/cli.mjs';
import { repoRoot } from '../helpers/repo.mjs';
import { jobIds, jobText, needsOf, runLines, usesLines } from '../helpers/standard.mjs';

after(cleanup);

const go = () => loadStack('go');
const DIR = join(STACKS_DIR, 'go');
const STACK_ITEMS = loadModel().items.filter((i) => i.provider === 'stack').map((i) => i.id);
const CI = '.github/workflows/ci.yml';
const STARTER = ['.gitattributes', '.gitignore', '.golangci.yml', 'go.mod', 'main.go', 'server.go', 'server_test.go'];
const PIPELINE = ['.github/workflows/ci.yml', '.github/workflows/deployment.yml', '.github/dependabot.yml',
  '.pre-commit-config.yaml', '.dockerignore', 'Dockerfile'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

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

test('the go module satisfies the stack-module interface', () => {
  const stack = go();
  assert.ok(stack, 'standard/stacks/go loads');
  assert.deepEqual(stack.codeql, { language: 'go', buildMode: 'autobuild' });
  assert.deepEqual(stack.dependabot, [{ ecosystem: 'gomod', directory: '/' }]);
  assert.deepEqual(stack.jobs, ['lint', 'test', 'build', 'audit']);
  assert.deepEqual(stack.docker.map((f) => f.path), ['.dockerignore', 'Dockerfile']);
  assert.deepEqual(stack.starter.map((f) => f.path), STARTER);
  assert.deepEqual(Object.keys(stack.provides).sort(), [...STACK_ITEMS].sort());
  // Each pattern recognises the module's own CI jobs, so a repo set up by buildorder reports them as present.
  for (const [id, pattern] of Object.entries(stack.provides)) assert.match(stack.ci, new RegExp(pattern), id);
  assert.match(stack.preCommit, /- id: golangci-lint\n {4}- id: golangci-lint-fmt/);
});

test('go pipeline: the stack jobs gate the image and ci-ok', () => {
  const ci = render({ stack: go(), deploy: 'container', skip: new Set() }).find((f) => f.path === CI).content;
  assert.deepEqual(needsOf(ci, 'image'), ['lint', 'test', 'build', 'audit']);
  for (const id of ['lint', 'test', 'build', 'audit', 'image']) assert.ok(needsOf(ci, 'ci-ok').includes(id), id);
  const lint = jobText(ci, 'lint');
  assert.match(lint, /uses: golangci\/golangci-lint-action@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  assert.match(lint, /version: v\d+\.\d+\.\d+$/m, 'golangci-lint version pinned');
  assert.match(jobText(ci, 'test'),
    /go test -race -covermode=atomic -coverprofile=coverage\.out \.\/\.\.\.\n[\s\S]*go tool cover -func=coverage\.out/);
  assert.match(jobText(ci, 'build'), /go mod verify\n[\s\S]*go build \.\/\.\.\./);
  assert.match(jobText(ci, 'audit'), /go run golang\.org\/x\/vuln\/cmd\/govulncheck@v\d+\.\d+\.\d+ \.\/\.\.\./);
});

test('go image: builder and distroless base pinned by digest, same Go as CI, non-root', () => {
  const stack = go();
  const dockerfile = stack.docker.find((f) => f.path === 'Dockerfile').content;
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2, 'multi-stage');
  assert.match(froms[0], /^golang:\d+\.\d+\.\d+-[a-z0-9.]+@sha256:[0-9a-f]{64}$/, froms[0]);
  assert.match(froms[1], /^gcr\.io\/distroless\/static-debian\d+:nonroot@sha256:[0-9a-f]{64}$/, froms[1]);
  const version = froms[0].match(/^golang:(\d+\.\d+\.\d+)-/)[1];
  const ciVersions = [...stack.ci.matchAll(/go-version: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ciVersions.length > 0 && ciVersions.every((v) => v === version), `CI ${ciVersions} vs image ${version}`);
  const starter = Object.fromEntries(stack.starter.map((f) => [f.path, f.content]));
  assert.match(starter['go.mod'], new RegExp(`^go ${escapeRe(version)}$`, 'm'), 'go.mod matches the image');
  assert.match(dockerfile, /^USER nonroot:nonroot$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["\/app"\]$/m);
  assert.match(dockerfile, /CGO_ENABLED=0 go build/);
  assert.match(stack.docker.find((f) => f.path === '.dockerignore').content, /^\.git$/m);
});

test('go starter: every dependency is pinned exactly and the lockfile exists', () => {
  const starter = Object.fromEntries(go().starter.map((f) => [f.path, f.content]));
  const mod = starter['go.mod'];
  assert.match(mod, /^module \S+$/m);
  assert.match(mod, /^go \d+\.\d+\.\d+$/m, 'exact Go version');
  // Requirements in single-line or block form. The minimal service uses the standard library only.
  const requires = [...mod.matchAll(/^(?:require\s+|\t)(\S+\.\S+\/\S+) (\S+)/gm)];
  for (const [, name, version] of requires) {
    assert.match(version, /^v\d+\.\d+\.\d+$/, `${name} ${version}`);
    assert.match(starter['go.sum'] ?? '', new RegExp(`^${escapeRe(name)} ${escapeRe(version)} h1:`, 'm'), `go.sum: ${name}`);
  }
  if (requires.length) assert.ok(starter['go.sum'], 'go.sum exists when there are dependencies');
  else assert.equal('go.sum' in starter, false, 'no dependency: no empty go.sum');
  assert.doesNotMatch(mod, /^replace\b/m);
});

test('go starter: .gitattributes forces LF', () => {
  const file = go().starter.find((f) => f.path === '.gitattributes');
  assert.match(file.content, /^\* text=auto eol=lf$/m);
});

test('go starter: one /healthz endpoint with a test, and the formatter and linter configured', () => {
  const starter = Object.fromEntries(go().starter.map((f) => [f.path, f.content]));
  assert.match(starter['server.go'], /"GET \/healthz"/);
  assert.match(starter['server_test.go'], /func TestHealthz\(t \*testing\.T\)/);
  assert.match(starter['main.go'], /ReadHeaderTimeout/, 'server timeout against slow clients');
  assert.match(starter['.golangci.yml'], /^version: "2"$/m);
  assert.match(starter['.golangci.yml'], /- gofmt/);
});

test('go module and starter files trip no secret pattern of the secret guard', () => {
  let lines = 0;
  for (const rel of walk(DIR)) {
    for (const [i, text] of readFileSync(join(DIR, ...rel.split('/')), 'utf8').split('\n').entries()) {
      lines++;
      assert.equal(scanLine(text), null, `${rel}:${i + 1}`);
    }
  }
  assert.ok(lines > 100, `scanned ${lines} lines`);
});

test('a Go repo without CI: the plan lists the stack items as missing and leaves the repo unchanged (AK-3)', () => {
  const dir = codeRepo('go existing', {
    'go.mod': 'module example.com/shop\n\ngo 1.27.4\n',
    'main.go': 'package main\n\nfunc main() {}\n',
  });
  const before = snapshot(dir);
  const out = standard(dir);
  assert.deepEqual(out.stack, { id: 'go', module: true });
  assert.deepEqual(out.modules, ['go', 'docker-cicd']);
  for (const id of STACK_ITEMS) {
    const item = out.items.find((i) => i.id === id);
    assert.equal(item.state, 'missing', id);
    assert.equal(item.reason, undefined, `${id}: the module writes it`);
  }
  assert.ok(out.files.some((f) => f.path === 'Dockerfile' && f.state === 'create'));
  assert.deepEqual(snapshot(dir), before);
});

test('--apply --starter --stack go in an empty repo writes the starter and the pipeline in one commit (AK-2)', () => {
  const dir = localGit(gitInit(tmp('go starter')));
  const out = standard(dir, '--stack', 'go', '--deploy', 'container', '--starter', '--apply');
  assert.deepEqual(out.created, [...STARTER, ...PIPELINE]);
  assert.equal(gitIn(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(gitIn(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...out.created].sort());
  assert.match(gitIn(dir, 'log', '-1', '--format=%s'), /^feat: add the go starter and the CI\/CD files/);
  assert.equal(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), '');
  for (const id of [...STACK_ITEMS, 'container-image', 'deploy']) assert.equal(stateOf(out)[id], 'present', id);
  assert.deepEqual(jobIds(readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8')).slice(-7),
    ['lint', 'test', 'build', 'audit', 'image', 'deploy', 'ci-ok']);
  // The written project is a Go project for detect as well.
  assert.deepEqual(standard(dir).stack, { id: 'go', module: true });
});

test('the go fixture job in the repo CI runs the core commands of the module on the starter (AK-2)', () => {
  const own = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = jobText(own, 'go-fixture');
  assert.ok(job, 'job go-fixture in .github/workflows/ci.yml');
  assert.ok(needsOf(own, 'ci-ok').includes('go-fixture'), 'ci-ok needs the fixture job');
  assert.match(job, /^ {4}runs-on: ubuntu-latest$/m, 'Linux only (K3)');
  assert.match(job, /standard "\$dir" --stack go --deploy container --starter --apply/);
  assert.match(job, /docker build /);

  // Same commands, linter action and Go version as the module's ci.yml, so the fixture proves what users get.
  const stack = go();
  const fixture = new Set(runLines(job).map((l) => l.trim()));
  const core = runLines(stack.ci).map((l) => l.trim()).filter(Boolean);
  assert.ok(core.length >= 5, core.join('\n'));
  for (const line of core) assert.ok(fixture.has(line), `fixture job runs: ${line}`);
  for (const use of usesLines(stack.ci).filter((u) => u.startsWith('golangci/'))) {
    assert.ok(usesLines(job).includes(use), `fixture job uses: ${use}`);
  }
  for (const pattern of [/go-version: "[^"]+"/, /^ +version: v\d+\.\d+\.\d+$/m]) {
    assert.ok(job.includes(stack.ci.match(pattern)[0].trim()), String(pattern));
  }
});

test('go tests-coverage counts only with the race detector and coverage together', () => {
  const stateWith = (label, testCommand) => {
    const dir = codeRepo(label, {
      'go.mod': 'module example.com/shop\n\ngo 1.27.4\n',
      'main.go': 'package main\n\nfunc main() {}\n',
      '.github/workflows/ci.yml': `name: ci\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${testCommand}\n`,
    });
    return stateOf(standard(dir))['tests-coverage'];
  };
  assert.equal(stateWith('go no race', 'go test -coverprofile=coverage.out ./...'), 'missing');
  assert.equal(stateWith('go no cover', 'go test -race ./...'), 'missing');
  assert.equal(stateWith('go race cover', 'go test -race -covermode=atomic -coverprofile=coverage.out ./...'), 'present');
  assert.equal(stateWith('go cover race', 'go test -coverprofile=coverage.out -race ./...'), 'present');
});
