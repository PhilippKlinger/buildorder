import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { nest } from '../../plugins/buildorder/lib/nest.mjs';
import { repoRoot } from '../helpers/repo.mjs';
import { cleanup, cli, codeRepo, fakeHome, gitIn, tempDir, tmp, write } from '../helpers/cli.mjs';

after(cleanup);

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const angular = JSON.stringify({ dependencies: { '@angular/core': '^20' } });
const sorted = (dir) => readdirSync(dir).sort();
const status = (cwd) => gitIn(cwd, '--no-optional-locks', 'status', '--porcelain', '--ignored');
// A backslash separates paths only on Windows; on POSIX it is a valid name character.
const gitPath = (p) => (process.platform === 'win32' ? p.replaceAll('\\', '/') : p);

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
  const devices = ['CON', 'nul.txt', 'Com1', 'lpt9.log', 'aux'];
  for (const name of ['src', '../escape', 'a/b', '..', '', 'ends with dot.', 'ends with space ', ...devices]) {
    const out = runNest(dir, name);
    assert.equal(out.ok, false, `'${name}' is refused`);
    assert.ok(out.reason, name);
    assert.equal(out.moved, 0);
    assert.deepEqual(sorted(dir), entries, `nothing moved for '${name}'`);
  }
  assert.match(runNest(dir, 'src').reason, /exists/);
  if (CASE_INSENSITIVE) assert.match(runNest(dir, 'SRC').reason, /exists/);
  for (const name of devices) assert.match(runNest(dir, name).reason, /reserved device name/, name);

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

test('refuses while a staging folder from an earlier run exists', () => {
  const dir = codeRepo('leftover');
  write(dir, { '.buildorder-nest-123/x.txt': 'from a killed run\n' });
  // An interrupted run has already moved .git into the staging folder.
  renameSync(join(dir, '.git'), join(dir, '.buildorder-nest-123', '.git'));
  const entries = sorted(dir);
  const out = runNest(dir);
  assert.equal(out.ok, false);
  assert.ok(out.reason.includes(join(dir, '.buildorder-nest-123')), out.reason);
  assert.match(out.reason, /move its contents back/);
  assert.equal(out.moved, 0);
  assert.deepEqual(sorted(dir), entries);
  assert.ok(existsSync(join(dir, '.buildorder-nest-123', '.git')) && existsSync(join(dir, '.buildorder-nest-123', 'x.txt')));
});

// git's own test switch makes every repo look foreign-owned, so dubious ownership needs no second account.
// GIT_CONFIG_GLOBAL points the global config at a file the test controls.
// GIT_CONFIG_NOSYSTEM keeps a machine-wide safe.directory entry (such as `*`) out of the test.
const foreignOwner = (globalConfig) => ({
  GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1',
});

/** A code repo in a folder named `name`, released through safe.directory for its current real path only. */
function foreignRepo(label, name) {
  const dir = codeRepo(null, undefined, { dir: join(tempDir(label), name) });
  const cfg = join(dirname(dir), 'global.gitconfig');
  // git compares its real path (macOS /private/var, long Windows names), so the entry uses it too.
  const entry = `[safe]\n\tdirectory = ${gitPath(realpathSync.native(dir))}\n`;
  writeFileSync(cfg, entry);
  return { dir, cfg, entry };
}

test('retries with safe.directory and reports the command', () => {
  // `$` in the path: the command must not let a shell expand it.
  const { dir, cfg, entry } = foreignRepo('foreign owner', `price ${'$'}HOME`);
  const r = cli('nest', dir, 'app', { env: foreignOwner(cfg) });
  assert.equal(r.status, 0, r.stderr);
  const out = r.json;
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.headUnchanged, true);
  assert.equal(out.statusUnchanged, true);
  const repo = gitPath(realpathSync.native(join(dir, 'app')));
  assert.deepEqual(out.safeDirectory, { path: repo, command: `git config --global --add safe.directory '${repo}'` });
  assert.equal(readFileSync(cfg, 'utf8'), entry, 'nest never writes the global config');

  // Without a one-off entry git really refuses the moved repo, so the retry was needed.
  const env = { ...process.env, ...foreignOwner(cfg), LC_ALL: 'C' };
  for (const k of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(k.toUpperCase())) delete env[k];
  const plain = spawnSync('git', ['status'], { cwd: join(dir, 'app'), env, encoding: 'utf8' });
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /dubious ownership/);

  // A single quote cannot be quoted the same way for every shell: the path is reported, the command left out.
  const quoted = foreignRepo('foreign quote', "it's here");
  const q = cli('nest', quoted.dir, 'app', { env: foreignOwner(quoted.cfg) });
  assert.equal(q.status, 0, q.stderr);
  assert.equal(q.json.ok, true, q.json.reason);
  assert.deepEqual(q.json.safeDirectory, { path: gitPath(realpathSync.native(join(quoted.dir, 'app'))) });
});

test('refuses when git cannot read the repo', () => {
  const { dir, cfg } = foreignRepo('no safe entry', 'target dir');
  writeFileSync(cfg, '');
  const entries = sorted(dir);
  const r = cli('nest', dir, { env: foreignOwner(cfg) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /git cannot read the repo, nothing moved: .*dubious ownership/);
  assert.equal(r.json.moved, 0);
  assert.deepEqual(sorted(dir), entries);
});

test('refuses while a marker file from an earlier run exists and names its target', () => {
  const dir = codeRepo('leftover marker');
  write(dir, { '.buildorder-nest-456': 'app' });
  const entries = sorted(dir);
  const out = runNest(dir);
  assert.equal(out.ok, false);
  assert.ok(out.reason.includes(join(dir, '.buildorder-nest-456')), out.reason);
  assert.ok(out.reason.includes(join(dir, 'app')), out.reason);
  assert.equal(out.moved, 0);
  assert.deepEqual(sorted(dir), entries);
});

test('never reads a marker that is a link or holds more than a folder name', (t) => {
  const dir = codeRepo('marker link');
  write(dir, { 'secret.txt': 'SECRET-CONTENT-12345\n' });
  try {
    symlinkSync('secret.txt', join(dir, '.buildorder-nest-789'));
  } catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return t.skip('symlinks are not permitted here');
    throw err;
  }
  const out = runNest(dir);
  assert.equal(out.ok, false);
  assert.ok(out.reason.includes('.buildorder-nest-789'), out.reason);
  assert.ok(!out.reason.includes('SECRET-CONTENT'), out.reason);

  const odd = codeRepo('marker odd content');
  write(odd, { '.buildorder-nest-790': 'not a folder name/../etc\n' });
  const r = runNest(odd);
  assert.equal(r.ok, false);
  assert.ok(!r.reason.includes('etc'), r.reason);
});

test('moves while a watcher holds .claude open (Windows EPERM on a folder rename)', () => {
  const dir = codeRepo('watched');
  write(dir, { '.claude/settings.local.json': '{}\n' });
  const head = gitIn(dir, 'rev-parse', 'HEAD');
  const before = status(dir);
  // Claude Code watches .claude/; on Windows such a handle blocks renaming a folder that holds it.
  const watcher = watch(join(dir, '.claude'), () => {});
  try {
    const out = nest(dir, 'app');
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.headUnchanged, true);
    assert.equal(out.statusUnchanged, true);
    assert.ok(existsSync(join(dir, 'app', '.claude', 'settings.local.json')));
    assert.equal(gitIn(join(dir, 'app'), 'rev-parse', 'HEAD'), head);
    assert.equal(status(join(dir, 'app')), before);
    assert.deepEqual(readdirSync(dir), ['app'], 'no marker left behind');
  } finally {
    watcher.close();
  }
});

// The rename seam is test-only: it lets a test fail chosen renames the way a locked file would.
const locked = (code) => Object.assign(new Error(`${code}: simulated lock`), { code });
// Entries move to <dir>/<name>/<entry> and back to <dir>/<entry>.
const inRepo = (dir, p) => dirname(dirname(p)) === dir;

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

  // The very first move fails: the empty target folder and the marker are removed again.
  const first = nest(dir, 'app', {
    rename: (from, to) => (basename(from) === '.git' ? (() => { throw locked('EBUSY'); })() : renameSync(from, to)),
  });
  assert.equal(first.ok, false);
  assert.match(first.reason, /moving '\.git' failed \(EBUSY\); rolled back, nothing changed/);
  restored('first move');

  // A lock released after a moment is retried and the move goes through.
  let locks = 1;
  const brief = nest(dir, 'app', {
    rename: (from, to) => (basename(from) === '.git' && locks-- > 0 ? (() => { throw locked('EBUSY'); })() : renameSync(from, to)),
  });
  assert.equal(brief.ok, true, brief.reason);
  assert.deepEqual(readdirSync(dir), ['app']);
  assert.equal(status(join(dir, 'app')), before);
});

test('a rename that fails after it moved the entry is still rolled back', () => {
  // Forward: `notes.txt` reaches the repo folder, then the rename reports a lock; the retry finds no source.
  const dir = codeRepo('throws after move');
  write(dir, { 'notes.txt': '' });
  const entries = sorted(dir);
  const before = status(dir);
  const forward = nest(dir, undefined, {
    rename: (from, to) => {
      renameSync(from, to);
      if (basename(from) === 'notes.txt' && inRepo(dir, to)) throw locked('EBUSY');
    },
  });
  assert.equal(forward.ok, false);
  assert.match(forward.reason, /moving 'notes.txt' failed \(ENOENT\); rolled back, nothing changed/);
  assert.deepEqual(sorted(dir), entries);
  assert.equal(status(dir), before);

  // Back: `package.json` returns, then the rename reports a lock; the check finds it in place, not stuck.
  const back = nest(dir, undefined, {
    rename: (from, to) => {
      if (basename(from) === 'src' && inRepo(dir, to)) throw locked('EPERM');
      renameSync(from, to);
      if (basename(from) === 'package.json' && inRepo(dir, from)) throw locked('EPERM');
    },
  });
  assert.equal(back.ok, false);
  assert.match(back.reason, /rolled back, nothing changed/);
  assert.equal(back.moved, 0);
  assert.deepEqual(sorted(dir), entries);
  assert.equal(status(dir), before);
});

test('reports entries left in the repo folder when the rollback fails too', () => {
  const dir = codeRepo('stuck');
  const out = nest(dir, undefined, {
    rename: (from, to) => {
      if (basename(from) === 'src') throw locked('EPERM');
      if (basename(from) === 'package.json' && inRepo(dir, from)) throw locked('EPERM');
      return renameSync(from, to);
    },
  });
  assert.equal(out.ok, false);
  const target = join(dir, 'target dir');
  assert.match(out.reason, /rollback is incomplete/);
  assert.ok(out.reason.includes(target), out.reason);
  assert.match(out.reason, /package\.json/);
  assert.ok(out.reason.includes(`.buildorder-nest-${process.pid}`), 'the reason names the marker');
  assert.equal(out.moved, 1, 'one entry is not back in place');
  assert.ok(existsSync(join(target, 'package.json')), 'the stuck entry is where the reason says');
  assert.ok(existsSync(join(dir, '.git')), 'the other entries returned');
  assert.ok(existsSync(join(dir, `.buildorder-nest-${process.pid}`)), 'the marker stays after an incomplete rollback');
});

test('never overwrites an entry that appeared during the move', () => {
  // `package.json` is recreated in the folder while the move runs: the rollback keeps both versions.
  const dir = codeRepo('recreated');
  const original = readFileSync(join(dir, 'package.json'), 'utf8');
  const out = nest(dir, undefined, {
    rename: (from, to) => {
      if (basename(from) === 'src' && inRepo(dir, to)) {
        writeFileSync(join(dir, 'package.json'), 'newer\n');
        throw locked('EPERM');
      }
      return renameSync(from, to);
    },
  });
  const staging = join(dir, 'target dir');
  assert.equal(out.ok, false);
  assert.match(out.reason, /rollback is incomplete/);
  const both = `both versions exist: ${join(dir, 'package.json')} and ${join(staging, 'package.json')}`;
  assert.ok(out.reason.includes(both), out.reason);
  assert.equal(out.moved, 1);
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), 'newer\n', 'the newer file is kept');
  assert.equal(readFileSync(join(staging, 'package.json'), 'utf8'), original, 'the repo file is kept');
});

test('a status that differs after the move leaves the files moved and says so', () => {
  const dir = codeRepo('late write');
  const out = nest(dir, 'app', {
    rename: (from, to) => {
      renameSync(from, to);
      if (basename(from) === 'src' && inRepo(dir, to)) writeFileSync(join(dir, 'app', 'late.txt'), ''); // e.g. a dev server writing
    },
  });
  const repo = join(dir, 'app');
  assert.equal(out.ok, false);
  assert.equal(out.headUnchanged, true);
  assert.equal(out.statusUnchanged, false);
  assert.ok(out.reason.includes(`the files now live in ${repo} and nothing was undone`), out.reason);
  assert.match(out.reason, /git status differs after the move/);
  assert.deepEqual(readdirSync(dir), ['app']);
  assert.ok(existsSync(join(repo, '.git')));
});

test('does not claim nothing changed when the marker file cannot be removed', () => {
  const stuck = () => { throw locked('EPERM'); };
  const marker = (dir) => join(dir, `.buildorder-nest-${process.pid}`);

  // Complete rollback, marker stays.
  const dir = codeRepo('marker stuck rollback');
  const entries = sorted(dir);
  const failed = nest(dir, 'app', {
    rename: (from, to) => (basename(from) === 'src' ? stuck() : renameSync(from, to)),
    unlink: stuck,
  });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.reason, /nothing changed/);
  assert.ok(failed.reason.includes(marker(dir)), failed.reason);
  assert.deepEqual(sorted(dir), [...entries, basename(marker(dir))].sort());

  // Successful move, marker stays: a warning, the move itself is fine.
  const done = codeRepo('marker stuck success');
  const out = nest(done, 'app', { unlink: stuck });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.warnings.length, 1);
  assert.ok(out.warnings[0].includes(marker(done)), out.warnings[0]);
  assert.deepEqual(sorted(done), ['app', basename(marker(done))].sort());
});

test('warns about an entry that appeared outside the repo during the move', () => {
  const dir = codeRepo('stray');
  const out = nest(dir, 'app', {
    rename: (from, to) => {
      renameSync(from, to);
      if (basename(from) === 'src' && inRepo(dir, to)) writeFileSync(join(dir, 'stray.log'), '');
    },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.statusUnchanged, true);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /stray\.log/);
  assert.ok(out.warnings[0].includes(join(dir, 'app')), out.warnings[0]);
  assert.deepEqual(sorted(dir), ['app', 'stray.log']);
});
