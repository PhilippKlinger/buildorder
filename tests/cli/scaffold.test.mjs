import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, tmp, write } from '../helpers/cli.mjs';

after(cleanup);

const DOC_FILES = ['HANDOFF.md', 'SPRINT.md', 'BACKLOG.md', 'BACKLOG_ARCHIVE.md', 'DECISIONS.md', 'assumptions.md'];
const ALL_FILES = ['.claude/workspace.json', 'CLAUDE.md', ...DOC_FILES];
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

test('Claude Code local settings in .claude do not block and stay as they are', () => {
  const dir = tmp('scaffold local settings');
  write(dir, { '.claude/settings.local.json': '{ "permissions": {} }\n' });
  const out = scaffold(dir);
  assert.deepEqual(sorted(out.created), sorted(ALL_FILES));
  assert.equal(read(dir, '.claude/settings.local.json'), '{ "permissions": {} }\n');
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
  for (const args of [['--lang', 'fr'], ['--name', 'a/b'], ['--nope']]) {
    const r = cli('scaffold', dir, ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^buildorder: [^\n]+\n$/, args.join(' '));
  }
  assert.deepEqual(readdirSync(dir), []);
});
