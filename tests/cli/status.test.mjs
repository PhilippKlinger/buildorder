import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { cleanup, cli, codeRepo, commitAll, gitIn, gitInit, tempDir, tmp, write } from '../helpers/cli.mjs';
import { multiRepoWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

/** A workspace folder (path with spaces) with a valid workspace.json listing `repos`. */
function workspace(label, repos) {
  const root = tmp(label);
  write(root, {
    '.claude/workspace.json': JSON.stringify({
      schemaVersion: 1,
      name: 'demo',
      docs: { handoff: 'HANDOFF.md', sprint: 'SPRINT.md' },
      repos: repos.map((path) => ({ path })),
    }),
  });
  return root;
}

/** Pushes `dir` to a fresh bare remote and sets the upstream of `main`. */
function withUpstream(dir) {
  const remote = join(tempDir('remote'), 'origin repo.git');
  mkdirSync(remote, { recursive: true });
  gitIn(remote, 'init', '-q', '--bare');
  gitIn(dir, 'remote', 'add', 'origin', remote);
  gitIn(dir, 'push', '-q', '-u', 'origin', 'main');
}

/** `status ...args --json`; a trailing options object goes to `cli` (e.g. `{ cwd }`). */
function status(...args) {
  const opts = typeof args.at(-1) === 'object' ? [args.pop()] : [];
  const r = cli('status', ...args, '--json', ...opts);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json, r.stdout);
  return r.json;
}

const place = (out, path) => out.places.find((p) => p.path === path);

test('reports a clean repo, a dirty repo and a repo without upstream', () => {
  const root = workspace('status repos', ['clean app', 'dirty app']);
  codeRepo(null, undefined, { dir: join(root, 'clean app') });
  withUpstream(join(root, 'clean app'));
  codeRepo(null, undefined, { dir: join(root, 'dirty app') });
  write(join(root, 'dirty app'), { 'src/main.ts': 'console.log(2);\n', 'new file.txt': 'x' });

  const out = status(root);
  assert.equal(out.root, root);
  assert.equal(out.name, 'demo');
  assert.deepEqual(place(out, 'clean app'), {
    label: 'clean app', path: 'clean app', state: 'ok', branch: 'main', changed: 0,
    upstream: 'origin/main', ahead: 0, behind: 0,
  });
  assert.deepEqual(place(out, 'dirty app'), {
    label: 'dirty app', path: 'dirty app', state: 'ok', branch: 'main', changed: 2,
    upstream: null, ahead: null, behind: null,
  });
});

test('counts commits ahead of and behind the upstream', () => {
  const root = workspace('status ahead', ['app']);
  const app = codeRepo(null, undefined, { dir: join(root, 'app') });
  write(app, { 'b.txt': 'b' });
  commitAll(app, 'second');
  withUpstream(app);
  gitIn(app, 'reset', '-q', '--hard', 'HEAD~1');
  write(app, { 'c.txt': 'c' });
  commitAll(app, 'third');
  write(app, { 'd.txt': 'd' });
  commitAll(app, 'fourth');

  const app2 = place(status(root), 'app');
  assert.equal(app2.ahead, 2);
  assert.equal(app2.behind, 1);
});

test('the workspace root is the docs place, whether or not it is a git repo', () => {
  const root = workspace('status docs', ['app']);
  codeRepo(null, undefined, { dir: join(root, 'app') });
  assert.deepEqual(place(status(root), '.'), { label: 'docs', path: '.', state: 'not-a-repo' });

  gitInit(root);
  write(root, { '.gitignore': 'app/\n' });
  commitAll(root, 'docs');
  const docs = place(status(root), '.');
  assert.equal(docs.state, 'ok');
  assert.equal(docs.branch, 'main');
  assert.equal(docs.changed, 0);
});

test('repos nested in the docs repo are not changes of the docs root', () => {
  const root = workspace('status nested', ['my app']);
  gitInit(root);
  commitAll(root, 'docs');
  // Created after the docs commit and not in a .gitignore: the root sees `?? my app/`.
  codeRepo(null, undefined, { dir: join(root, 'my app') });
  assert.match(gitIn(root, 'status', '--porcelain'), /my app/);
  assert.equal(place(status(root), '.').changed, 0);

  write(root, { 'HANDOFF.md': 'x' });
  assert.equal(place(status(root), '.').changed, 1);
});

// A stand-in `git` that answers --show-toplevel with an MSYS-style path Node cannot resolve.
// POSIX only: Windows spawns `git.exe` and would not pick up a shell script.
test('a toplevel path that cannot be resolved makes the repo unreadable, not the command fail', {
  skip: process.platform === 'win32' && 'needs a shell-script git stand-in (POSIX)',
}, () => {
  const root = workspace('status msys', ['app']);
  codeRepo(null, undefined, { dir: join(root, 'app') });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = tempDir('fake git');
  write(bin, {
    git: `#!/bin/sh\ncase "$*" in *show-toplevel*) echo "/c/no such/msys path"; exit 0;; esac\nexec "${realGit}" "$@"\n`,
  });
  chmodSync(join(bin, 'git'), 0o755);
  const r = cli('status', root, '--json', { env: { PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(place(r.json, 'app').state, 'unreadable');
});

test('a missing folder and a folder without its own repo get a short state, not a failure', () => {
  const root = workspace('status broken', ['gone', 'plain']);
  gitInit(root);
  mkdirSync(join(root, 'plain'));
  const out = status(root);
  assert.equal(place(out, 'gone').state, 'missing');
  // `plain` lies inside the docs repo; its state must not be the docs repo's.
  assert.equal(place(out, 'plain').state, 'not-a-repo');
});

test('finds the workspace from a folder inside a repo', () => {
  const root = workspace('status inside', ['app']);
  const app = codeRepo(null, undefined, { dir: join(root, 'app') });
  assert.equal(status(join(app, 'src')).root, root);
  // From the cwd the root comes from process.cwd(), which resolves symlinks (macOS: /private/var).
  assert.equal(realpathSync(status({ cwd: join(app, 'src') }).root), realpathSync(root));
});

test('outside a workspace: says so with exit 0', () => {
  const dir = tmp('status outside');
  assert.deepEqual(status(dir), { root: null });
  const r = cli('status', dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Not inside a Buildorder workspace/);
});

test('plain text by default: one line per place', () => {
  const root = workspace('status text', ['clean app', 'dirty app', 'gone']);
  codeRepo(null, undefined, { dir: join(root, 'clean app') });
  withUpstream(join(root, 'clean app'));
  codeRepo(null, undefined, { dir: join(root, 'dirty app') });
  write(join(root, 'dirty app'), { 'x.txt': 'x' });

  const r = cli('status', root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json, null);
  assert.deepEqual(r.stdout.trimEnd().split(/\r?\n/), [
    `Buildorder workspace "demo" at ${root}`,
    '- docs (.): not a git repo',
    '- clean app: main, clean, origin/main: 0 ahead, 0 behind',
    '- dirty app: main, 1 changed, no upstream',
    '- gone: folder missing',
  ]);
});

test('status warns about a code repo that is not in workspace.json', () => {
  const root = multiRepoWorkspace({ registered: true });
  codeRepo(null, null, { dir: join(root.root, 'extra', 'tool') });
  const out = status(root.root);
  assert.deepEqual(out.warnings, [{ kind: 'unregistered-repo', path: 'extra/tool' }]);
  const r = cli('status', root.root);
  assert.match(r.stdout, /extra\/tool is a code repo that is not set up in this workspace/);
});

test('status has no such warning when every repo is registered', () => {
  const root = multiRepoWorkspace({ registered: true });
  assert.deepEqual(status(root.root).warnings, []);
});

test('the unregistered-repo warning says the repo stays without the standard (review 1.3 M9, spec A7)', () => {
  const root = multiRepoWorkspace({ registered: true });
  codeRepo(null, null, { dir: join(root.root, 'extra', 'tool') });
  assert.match(cli('status', root.root).stdout, /extra\/tool is a code repo that is not set up in this workspace; .*until then it stays without the standard/);
});

test('a repo recorded in another case is registered on Windows (review 1.3 C1)', { skip: process.platform !== 'win32' }, () => {
  const { root } = multiRepoWorkspace({ registered: true, names: ['Shop/Api', 'Shop/Web'] });
  const file = join(root, '.claude', 'workspace.json');
  const ws = JSON.parse(readFileSync(file, 'utf8'));
  ws.repos = ws.repos.map((r) => ({ ...r, path: r.path.toLowerCase() }));
  writeFileSync(file, JSON.stringify(ws, null, 2) + '\n');
  assert.deepEqual(status(root).warnings, []);
});
