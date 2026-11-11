import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { nest } from '../../plugins/buildorder/lib/nest.mjs';
import { repoRoot } from '../helpers/repo.mjs';
import { cleanup, cli, codeRepo, fakeHome, gitIn, tmp, write } from '../helpers/cli.mjs';

after(cleanup);

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const angular = JSON.stringify({ dependencies: { '@angular/core': '^20' } });
const sorted = (dir) => readdirSync(dir).sort();
const status = (cwd) => gitIn(cwd, '--no-optional-locks', 'status', '--porcelain', '--ignored');
const gitPath = (p) => p.replaceAll('\\', '/');

/** `nest` through the CLI; every outcome, refusals included, exits 0 with JSON. */
function runNest(...args) {
  const r = cli('nest', ...args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json, r.stdout);
  return r.json;
}

test('proposes a folder name and avoids clashes', () => {
  const dir = codeRepo('propose');
  // Clashes count case-insensitively, so the proposal works on every file system.
  write(dir, { 'target dir/x.txt': '', 'TARGET DIR-REPO/y.txt': '' });
  assert.equal(cli('detect', dir).json.workspaceProposal.inPlace.repoPath, 'target dir-repo-2');
  const out = runNest(dir);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.repoPath, 'target dir-repo-2');
  assert.deepEqual(readdirSync(dir), ['target dir-repo-2']);
  assert.ok(existsSync(join(dir, 'target dir-repo-2', 'target dir', 'x.txt')));
});

test('moves everything and keeps HEAD and status', () => {
  const dir = codeRepo('move');
  write(dir, {
    '.gitignore': '.env\n',
    '.env': 'KEY=x\n',
    '.hidden/a.txt': '',
    'notes.txt': 'untracked\n',
    'src/main.ts': 'console.log(2);\n', // a change to a tracked file
  });
  const head = gitIn(dir, 'rev-parse', 'HEAD');
  const before = status(dir);
  const entries = sorted(dir);
  assert.ok(entries.includes('.git'));

  const out = runNest(dir);
  assert.deepEqual(out, {
    ok: true, dir, repoPath: 'target dir', moved: entries.length, headUnchanged: true, statusUnchanged: true,
  });
  const repo = join(dir, 'target dir');
  assert.deepEqual(readdirSync(dir), ['target dir']);
  assert.deepEqual(sorted(repo), entries);
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(status(repo), before);
  assert.equal(readFileSync(join(repo, '.env'), 'utf8'), 'KEY=x\n');
  assert.equal(cli('detect', dir).json.suggestion, 'existing', 'the folder now holds the repo');
});

test('custom name, refuses an existing one', () => {
  const dir = codeRepo('named');
  const entries = sorted(dir);
  for (const name of ['src', '../escape', 'a/b', '..', '', 'ends with dot.', 'ends with space ']) {
    const out = runNest(dir, name);
    assert.equal(out.ok, false, `'${name}' is refused`);
    assert.ok(out.reason, name);
    assert.equal(out.moved, 0);
    assert.deepEqual(sorted(dir), entries, `nothing moved for '${name}'`);
  }
  assert.match(runNest(dir, 'src').reason, /exists/);
  if (CASE_INSENSITIVE) assert.match(runNest(dir, 'SRC').reason, /exists/);

  const out = runNest(dir, 'portfolio');
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.repoPath, 'portfolio');
  assert.deepEqual(readdirSync(dir), ['portfolio']);
  assert.ok(existsSync(join(dir, 'portfolio', 'src', 'main.ts')));
});

test('repo name from origin', () => {
  const dir = codeRepo('origin');
  gitIn(dir, 'remote', 'add', 'origin', ['git', 'example.com:team/my-app.git'].join('@')); // built at runtime: reads like an address
  const out = runNest(dir);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.repoPath, 'my-app');
  assert.ok(existsSync(join(dir, 'my-app', '.git')));
});

test('refuses its own plugin folder', () => {
  const dir = codeRepo('self');
  const copy = join(dir, 'plugins', 'buildorder');
  cpSync(join(repoRoot, 'plugins', 'buildorder'), copy, { recursive: true });
  const script = join(copy, 'scripts', 'buildorder.mjs');
  const entries = sorted(dir);
  const home = fakeHome();
  const r = spawnSync(process.execPath, [script, 'nest', dir], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.reason, /plugin runs from inside this folder/);
  assert.deepEqual(sorted(dir), entries);
  assert.ok(existsSync(script), 'the running script stays where it is');
});

test('refuses non-repos and broken git paths', () => {
  const plain = tmp('plain');
  write(plain, { 'notes.md': '# notes\n' });
  const notRepo = runNest(plain);
  assert.equal(notRepo.ok, false);
  assert.match(notRepo.reason, /only applies to a folder that is itself a code repo \(detect: new\)/);
  assert.deepEqual(readdirSync(plain), ['notes.md']);

  const missing = cli('nest', join(plain, 'missing'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^buildorder: not a folder/);

  const wt = codeRepo('worktree');
  gitIn(wt, 'worktree', 'add', '-q', '-b', 'wt', join(dirname(wt), 'wt'));
  const wtEntries = sorted(wt);
  const linked = runNest(wt);
  assert.equal(linked.ok, false);
  assert.match(linked.reason, /linked worktrees/);
  assert.deepEqual(sorted(wt), wtEntries);

  const gitFile = tmp('git file');
  write(gitFile, { '.git': 'gitdir: ../elsewhere/.git\n', 'package.json': angular, 'angular.json': '{}' });
  const broken = runNest(gitFile);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /\.git is a file/);
  assert.deepEqual(sorted(gitFile), ['.git', 'angular.json', 'package.json']);
});

// git's own test switch makes every repo look foreign-owned, so dubious ownership needs no second account.
// GIT_CONFIG_GLOBAL points the global config at a file the test controls.
const foreignOwner = (globalConfig) => ({ GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: globalConfig });

test('retries with safe.directory and reports the command', () => {
  const dir = codeRepo('foreign owner');
  const cfg = join(dirname(dir), 'global.gitconfig');
  const entry = `[safe]\n\tdirectory = ${gitPath(dir)}\n`; // released for the old path only
  writeFileSync(cfg, entry);
  const r = cli('nest', dir, { env: foreignOwner(cfg) });
  assert.equal(r.status, 0, r.stderr);
  const out = r.json;
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.headUnchanged, true);
  assert.equal(out.statusUnchanged, true);
  const repo = gitPath(join(dir, 'target dir'));
  assert.deepEqual(out.safeDirectory, { path: repo, command: `git config --global --add safe.directory "${repo}"` });
  assert.equal(readFileSync(cfg, 'utf8'), entry, 'nest never writes the global config');

  // Without a one-off entry git really refuses the moved repo, so the retry was needed.
  const env = { ...process.env, ...foreignOwner(cfg), LC_ALL: 'C' };
  for (const k of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(k.toUpperCase())) delete env[k];
  const plain = spawnSync('git', ['status'], { cwd: join(dir, 'target dir'), env, encoding: 'utf8' });
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /dubious ownership/);
});

test('refuses when git cannot read the repo', () => {
  const dir = codeRepo('no safe entry');
  const cfg = join(dirname(dir), 'global.gitconfig');
  writeFileSync(cfg, '');
  const entries = sorted(dir);
  const r = cli('nest', dir, { env: foreignOwner(cfg) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /git cannot read the repo, nothing moved: .*dubious ownership/);
  assert.equal(r.json.moved, 0);
  assert.deepEqual(sorted(dir), entries);
});

// The rename seam is test-only: it lets a test fail chosen renames the way a locked file would.
const locked = (code) => Object.assign(new Error(`${code}: simulated lock`), { code });
const inStaging = (p) => basename(dirname(p)).startsWith('.buildorder-nest-');

test('rolls back every move when one fails, and retries a brief lock', () => {
  const dir = codeRepo('rollback');
  write(dir, { '.env': 'KEY=x\n', 'notes.txt': '' });
  const entries = sorted(dir);
  const before = status(dir);
  const restored = (label) => {
    assert.deepEqual(sorted(dir), entries, `${label}: original layout`);
    assert.equal(status(dir), before, `${label}: original status`);
  };

  // A lock that does not go away: entries are sorted, so `src` moves last and everything before it returns.
  const midway = nest(dir, undefined, {
    rename: (from, to) => (basename(from) === 'src' ? (() => { throw locked('EPERM'); })() : renameSync(from, to)),
  });
  assert.equal(midway.ok, false);
  assert.match(midway.reason, /moving 'src' failed \(EPERM\); rolled back, nothing changed/);
  assert.equal(midway.moved, 0);
  restored('midway');

  // The final rename (staging -> name) fails: all entries return from the staging folder.
  const last = nest(dir, 'app', {
    rename: (from, to) => (basename(to) === 'app' ? (() => { throw locked('EBUSY'); })() : renameSync(from, to)),
  });
  assert.equal(last.ok, false);
  assert.match(last.reason, /moving 'app' failed \(EBUSY\); rolled back/);
  restored('final rename');

  // A lock released after a moment is retried and the move goes through.
  let locks = 1;
  const brief = nest(dir, 'app', {
    rename: (from, to) => (basename(from) === '.git' && locks-- > 0 ? (() => { throw locked('EBUSY'); })() : renameSync(from, to)),
  });
  assert.equal(brief.ok, true, brief.reason);
  assert.deepEqual(readdirSync(dir), ['app']);
  assert.equal(status(join(dir, 'app')), before);
});

test('reports entries left in the staging folder when the rollback fails too', () => {
  const dir = codeRepo('stuck');
  const out = nest(dir, undefined, {
    rename: (from, to) => {
      if (basename(from) === 'src') throw locked('EPERM');
      if (basename(from) === 'package.json' && inStaging(from)) throw locked('EPERM');
      return renameSync(from, to);
    },
  });
  assert.equal(out.ok, false);
  const staging = join(dir, `.buildorder-nest-${process.pid}`);
  assert.match(out.reason, /rollback is incomplete/);
  assert.ok(out.reason.includes(staging), out.reason);
  assert.match(out.reason, /package\.json/);
  assert.ok(existsSync(join(staging, 'package.json')), 'the stuck entry is where the reason says');
  assert.ok(existsSync(join(dir, '.git')), 'the other entries returned');
});
