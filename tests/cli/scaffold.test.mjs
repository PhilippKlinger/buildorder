import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, commitAll, gitIn, gitInit, tmp, write } from '../helpers/cli.mjs';

after(cleanup);

const DOC_FILES = ['HANDOFF.md', 'SPRINT.md', 'BACKLOG.md', 'BACKLOG_ARCHIVE.md', 'DECISIONS.md', 'assumptions.md'];
// .gitignore keeps the machine-local Claude settings (and every repo folder) out of the docs repo.
const ALL_FILES = ['.claude/workspace.json', 'CLAUDE.md', ...DOC_FILES, '.gitignore'];
const LOCAL = '/.claude/settings.local.json';
const DOCS = {
  handoff: 'HANDOFF.md',
  sprint: 'SPRINT.md',
  backlog: 'BACKLOG.md',
  archive: 'BACKLOG_ARCHIVE.md',
  decisions: 'DECISIONS.md',
  assumptions: 'assumptions.md',
};

const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');
const wsOf = (dir) => JSON.parse(read(dir, '.claude/workspace.json'));
const sorted = (a) => [...a].sort();

function scaffold(dir, ...args) {
  const r = cli('scaffold', dir, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
}

test('empty folder gets the English doc-map, CLAUDE.md and workspace.json', () => {
  const dir = tmp('scaffold empty');
  const out = scaffold(dir);
  assert.equal(out.ok, true);
  assert.equal(out.dir, dir);
  assert.deepEqual(sorted(out.created), sorted(ALL_FILES));
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(wsOf(dir), {
    schemaVersion: 1,
    name: 'target dir',
    language: { docs: 'en' },
    initPhase: 'scaffolded',
    docs: DOCS,
    repos: [],
    guards: { docsOnlyNames: DOC_FILES, protectedPaths: [] },
  });
  assert.match(read(dir, 'CLAUDE.md'), /^# CLAUDE\.md — target dir\n/);
  assert.match(read(dir, 'HANDOFF.md'), /^# Handoff — \d{4}-\d{2}-\d{2}\n/);
  for (const f of ALL_FILES) assert.doesNotMatch(read(dir, f), /\{\{/, `${f} has no open placeholder`);
});

test('--lang de and --name write German docs under that name', () => {
  const dir = tmp('scaffold de');
  scaffold(dir, '--lang', 'de', '--name', 'demo');
  const ws = wsOf(dir);
  assert.equal(ws.name, 'demo');
  assert.deepEqual(ws.language, { docs: 'de' });
  assert.match(read(dir, 'HANDOFF.md'), /^# \u00dcbergabe — /);
  assert.match(read(dir, 'SPRINT.md'), /^# Sprint — demo\n/);
  assert.match(read(dir, 'CLAUDE.md'), /Fachbegriffe bleiben englisch/);
});

test('existing files are kept and a second run changes nothing', () => {
  const dir = tmp('scaffold keep');
  write(dir, { 'SPRINT.md': 'mine\n' });
  const first = scaffold(dir);
  assert.deepEqual(first.skipped, ['SPRINT.md']);
  assert.equal(read(dir, 'SPRINT.md'), 'mine\n');

  const before = Object.fromEntries(ALL_FILES.map((f) => [f, read(dir, f)]));
  const second = scaffold(dir, '--lang', 'de', '--name', 'other');
  assert.deepEqual(second.created, []);
  assert.deepEqual(sorted(second.skipped), sorted(ALL_FILES));
  for (const f of ALL_FILES) assert.equal(read(dir, f), before[f], `${f} unchanged`);
});

test('Claude Code local settings in .claude do not block, stay as they are and stay out of the docs repo', () => {
  const dir = tmp('scaffold local settings');
  write(dir, { '.claude/settings.local.json': '{ "permissions": {} }\n' });
  const out = scaffold(dir);
  assert.deepEqual(sorted(out.created), sorted(ALL_FILES));
  assert.equal(read(dir, '.claude/settings.local.json'), '{ "permissions": {} }\n');
  assert.equal(read(dir, '.gitignore'), `${LOCAL}\n`);
  assert.deepEqual(out.ignored, [LOCAL]);
  assert.equal(gitIn(dir, 'check-ignore', '.claude/settings.local.json'), '.claude/settings.local.json');
  assert.doesNotMatch(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), /settings\.local\.json/,
    'never part of the first docs commit');
});

test('a rerun without --lang and --name keeps those of the workspace', () => {
  const dir = tmp('scaffold resume');
  scaffold(dir, '--lang', 'de', '--name', 'demo');
  rmSync(join(dir, 'HANDOFF.md'));
  rmSync(join(dir, 'SPRINT.md'));
  const out = scaffold(dir);
  assert.deepEqual(sorted(out.created), ['HANDOFF.md', 'SPRINT.md']);
  assert.match(read(dir, 'HANDOFF.md'), /^# \u00dcbergabe — /);
  assert.match(read(dir, 'SPRINT.md'), /^# Sprint — demo\n\n\*\*Stand:\*\*/);
});

test('repos come from detect; --repo selects among them', () => {
  const dir = tmp('scaffold repos');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  codeRepo(null, { 'README.md': '# notes\n' }, { dir: join(dir, 'notes') });
  scaffold(dir);
  assert.deepEqual(wsOf(dir).repos, [
    { path: 'app', isCode: true, stacks: ['angular'] },
    { path: 'notes', isCode: false, stacks: [] },
  ]);

  const picked = tmp('scaffold pick');
  codeRepo(null, undefined, { dir: join(picked, 'app') });
  codeRepo(null, { 'README.md': '# notes\n' }, { dir: join(picked, 'notes') });
  scaffold(picked, '--repo', './app/');
  assert.deepEqual(wsOf(picked).repos.map((r) => r.path), ['app']);
});

test('--visibility records the visibility on each repo entry, for /buildorder:secure', () => {
  const dir = tmp('scaffold visibility');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  scaffold(dir, '--visibility', 'private');
  assert.deepEqual(wsOf(dir).repos, [{ path: 'app', isCode: true, stacks: ['angular'], visibility: 'private' }]);
});

test('--new-repo creates the code repo with git init on main and records only it; a rerun keeps it', () => {
  const dir = tmp('scaffold new repo');
  const out = scaffold(dir, '--new-repo', 'shop app', '--visibility', 'public');
  assert.equal(out.ok, true);
  const repo = join(dir, 'shop app');
  assert.ok(existsSync(join(repo, '.git')));
  assert.equal(gitIn(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.deepEqual(wsOf(dir).repos, [{ path: 'shop app', isCode: false, stacks: [], visibility: 'public' }]);

  const again = scaffold(dir, '--new-repo', 'shop app');
  assert.deepEqual(again.created, []);
  assert.equal(gitIn(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
});

test('--new-repo refuses a bad name and a folder that exists without git, and writes nothing', () => {
  const bad = tmp('scaffold new repo bad');
  for (const name of ['a/b', '..', '../out']) {
    const r = cli('scaffold', bad, '--new-repo', name);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /^buildorder: invalid --new-repo /, name);
  }
  assert.deepEqual(readdirSync(bad), []);

  const taken = tmp('scaffold new repo taken');
  write(taken, { 'app/notes.txt': 'mine\n' });
  const r = cli('scaffold', taken, '--new-repo', 'app');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^buildorder: --new-repo 'app' exists and is not a git repo/);
  assert.deepEqual(readdirSync(taken), ['app']);
  assert.deepEqual(readdirSync(join(taken, 'app')), ['notes.txt']);
});

test('refuses folders that are no place for a workspace, and writes nothing', () => {
  const repo = codeRepo('scaffold repo root');
  const r = cli('scaffold', repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^buildorder: .*code repo.*nest/);
  assert.equal(existsSync(join(repo, 'CLAUDE.md')), false);

  const agent = tmp('scaffold agent');
  write(agent, { 'CLAUDE.md': 'own\n' });
  const a = cli('scaffold', agent);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /^buildorder: .*CLAUDE\.md/);
  assert.deepEqual(readdirSync(agent), ['CLAUDE.md']);

  const unknown = tmp('scaffold unknown repo');
  const u = cli('scaffold', unknown, '--repo', 'missing');
  assert.equal(u.status, 1);
  assert.match(u.stderr, /^buildorder: .*missing/);
  assert.deepEqual(readdirSync(unknown), []);
});

test('invalid options fail with one line', () => {
  const dir = tmp('scaffold options');
  for (const args of [['--lang', 'fr'], ['--name', 'a/b'], ['--visibility', 'internal'], ['--nope']]) {
    const r = cli('scaffold', dir, ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^buildorder: [^\n]+\n$/, args.join(' '));
  }
  assert.deepEqual(readdirSync(dir), []);
});

// The workspace root is the private docs repo (spec "Zwei Orte"): git init without a commit, repos gitignored.
const topOf = (dir) => realpathSync.native(gitIn(dir, 'rev-parse', '--show-toplevel'));

test('a new workspace root becomes a git repo on main without a commit, and every repo is gitignored', () => {
  const dir = tmp('scaffold root repo');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  const out = scaffold(dir, '--new-repo', 'shop app');
  assert.equal(out.rootRepo, 'created');
  assert.equal(topOf(dir), realpathSync.native(dir));
  assert.equal(gitIn(dir, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(gitIn(dir, 'rev-list', '--all', '--count'), '0', 'scaffold makes no commit');
  assert.ok(out.created.includes('.gitignore'));
  assert.equal(read(dir, '.gitignore'), `${LOCAL}\n/app/\n/shop app/\n`);
  assert.deepEqual(out.ignored, [LOCAL, '/app/', '/shop app/']);
  const untracked = gitIn(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.slice(3));
  assert.deepEqual(sorted(untracked), sorted(ALL_FILES), 'the nested repos are never added');

  const again = scaffold(dir);
  assert.equal(again.rootRepo, 'existing');
  assert.deepEqual(again.ignored, []);
  assert.ok(again.skipped.includes('.gitignore'));
  assert.equal(read(dir, '.gitignore'), `${LOCAL}\n/app/\n/shop app/\n`);
});

test('a root that is a repo or lies inside one is left alone; an existing .gitignore only gets the missing entries', () => {
  const own = tmp('scaffold own repo');
  gitInit(own);
  write(own, { 'notes.md': '# mine\n', '.gitignore': 'node_modules/\n/app/' });
  commitAll(own, 'mine');
  codeRepo(null, undefined, { dir: join(own, 'app') });
  codeRepo(null, { 'README.md': '# lib\n' }, { dir: join(own, 'lib') });
  const head = gitIn(own, 'rev-parse', 'HEAD');
  const out = scaffold(own);
  assert.equal(out.rootRepo, 'existing');
  assert.equal(gitIn(own, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(read(own, '.gitignore'), `node_modules/\n/app/\n${LOCAL}\n/lib/\n`);
  assert.deepEqual(out.ignored, [LOCAL, '/lib/']);
  assert.ok(!out.created.includes('.gitignore') && !out.skipped.includes('.gitignore'));

  const parent = tmp('scaffold parent repo');
  gitInit(parent);
  write(parent, { 'README.md': '# parent\n' });
  commitAll(parent, 'parent');
  const inner = join(parent, 'work space');
  codeRepo(null, undefined, { dir: join(inner, 'app') });
  const nested = scaffold(inner);
  assert.equal(nested.rootRepo, 'existing');
  assert.equal(existsSync(join(inner, '.git')), false, 'no repo inside the parent repo');
  assert.equal(read(inner, '.gitignore'), `${LOCAL}\n/app/\n`);
  // A line the user already has in another spelling counts as present.
  write(inner, { '.gitignore': '.claude/settings.local.json\n' });
  const kept = scaffold(inner);
  assert.equal(kept.rootRepo, 'existing');
  assert.equal(existsSync(join(inner, '.git')), false, 'no repo inside the parent repo');
  assert.equal(read(inner, '.gitignore'), '.claude/settings.local.json\n/app/\n');
  assert.deepEqual(kept.ignored, ['/app/']);
});
