// sync: lifts an existing workspace to the installed buildorder version. Only workspace files that
// buildorder wrote and nobody changed since are updated; everything else is reported, never overwritten.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../../plugins/buildorder/lib/fsx.mjs';
import { cleanup, cli, codeRepo, gitIn, tmp, write } from '../helpers/cli.mjs';
import { repoRoot } from '../helpers/repo.mjs';

after(cleanup);

const VERSION = JSON.parse(readFileSync(join(repoRoot, 'plugins', 'buildorder', '.claude-plugin', 'plugin.json'), 'utf8')).version;
const TEMPLATES = join(repoRoot, 'plugins', 'buildorder', 'templates', 'workspace');

const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');
const wsOf = (dir) => JSON.parse(read(dir, '.claude/workspace.json'));
const setWs = (dir, ws) => writeFileSync(join(dir, '.claude', 'workspace.json'), JSON.stringify(ws, null, 2) + '\n');
// The recorded hash: sha256 of the text with LF line endings, so a CRLF checkout still counts as unchanged.
const sha = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const byPath = (changes) => Object.fromEntries(changes.map((c) => [c.path, c.action]));
const snapshot = (dir) => Object.fromEntries(walk(dir, Infinity, new Set(['.git'])).map((f) => [f, read(dir, f)]));

function scaffold(dir, ...args) {
  const r = cli('scaffold', dir, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
}

function sync(dir, ...args) {
  const r = cli('sync', dir, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
}

/**
 * Makes `rel` look as if an older buildorder had written it from an older template: the file holds `text`,
 * the record says buildorder wrote exactly that text from a template that is not the current one.
 */
function fromOlderTemplate(dir, rel, text) {
  write(dir, { [rel]: text });
  const ws = wsOf(dir);
  ws.buildorderVersion = '0.1.0';
  ws.templateHashes[rel] = { file: sha(text), template: sha('older template') };
  setWs(dir, ws);
}

test('sync without --apply lists the template changes and writes nothing', () => {
  const dir = tmp('sync plan');
  scaffold(dir, '--name', 'demo');
  fromOlderTemplate(dir, 'CLAUDE.md', '# CLAUDE.md — demo\n\nolder text\n');
  rmSync(join(dir, 'HANDOFF.md'));
  const before = snapshot(dir);

  const out = sync(dir);
  assert.equal(out.ok, true);
  assert.equal(out.applied, false);
  assert.equal(out.from, '0.1.0');
  assert.equal(out.to, VERSION);
  assert.deepEqual(byPath(out.changes), { 'CLAUDE.md': 'update', 'HANDOFF.md': 'add' });
  assert.deepEqual(snapshot(dir), before, 'a sync without --apply writes nothing');
});

test('sync --apply updates untouched workspace files to the current templates', () => {
  const dir = tmp('sync apply');
  scaffold(dir, '--name', 'demo');
  fromOlderTemplate(dir, 'CLAUDE.md', '# CLAUDE.md — demo\n\nolder text\n');
  rmSync(join(dir, 'HANDOFF.md'));

  const out = sync(dir, '--apply');
  assert.equal(out.applied, true);
  assert.deepEqual(byPath(out.changes), { 'CLAUDE.md': 'update', 'HANDOFF.md': 'add' });
  const current = readFileSync(join(TEMPLATES, 'en', 'CLAUDE.md'), 'utf8').replace('{{name}}', 'demo');
  assert.equal(read(dir, 'CLAUDE.md'), current);
  assert.match(read(dir, 'HANDOFF.md'), /^# Handoff — \d{4}-\d{2}-\d{2}\n/);

  const ws = wsOf(dir);
  assert.equal(ws.buildorderVersion, VERSION);
  assert.equal(ws.templateHashes['CLAUDE.md'].file, sha(current));
  assert.equal(ws.templateHashes['HANDOFF.md'].file, sha(read(dir, 'HANDOFF.md')));

  const again = sync(dir);
  assert.deepEqual(again.changes, [], 'a second sync finds nothing to do');
  assert.equal(again.from, VERSION);
});

test('sync never overwrites a file the user changed; it reports skip-modified', () => {
  const dir = tmp('sync modified');
  scaffold(dir, '--name', 'demo');
  fromOlderTemplate(dir, 'CLAUDE.md', '# CLAUDE.md — demo\n\nolder text\n');
  write(dir, { 'CLAUDE.md': '# CLAUDE.md — demo\n\nfilled in by the user\n' });

  const out = sync(dir, '--apply');
  assert.deepEqual(byPath(out.changes), { 'CLAUDE.md': 'skip-modified' });
  assert.equal(read(dir, 'CLAUDE.md'), '# CLAUDE.md — demo\n\nfilled in by the user\n');
  // Reported once per template change: the next sync stays quiet until the template changes again.
  assert.deepEqual(sync(dir).changes, []);
  assert.equal(read(dir, 'CLAUDE.md'), '# CLAUDE.md — demo\n\nfilled in by the user\n');

  // A workspace from before sync has no record: a file that differs from the current template counts as changed.
  const old = tmp('sync pre-record');
  scaffold(old, '--name', 'demo');
  const ws = wsOf(old);
  delete ws.buildorderVersion;
  delete ws.templateHashes;
  setWs(old, ws);
  write(old, { 'SPRINT.md': '# Sprint — demo\n\nmy own sprint\n' });
  rmSync(join(old, 'BACKLOG.md'));

  const plan = sync(old);
  assert.equal(plan.from, null);
  assert.equal(byPath(plan.changes)['SPRINT.md'], 'skip-modified');
  assert.equal(byPath(plan.changes)['BACKLOG.md'], 'add');
  assert.equal(byPath(plan.changes)['CLAUDE.md'], undefined, 'equal to the current template: nothing to do');
  assert.ok(plan.notes.some((n) => /no record/.test(n)), 'the output says why changed files stay');
  sync(old, '--apply');
  assert.equal(read(old, 'SPRINT.md'), '# Sprint — demo\n\nmy own sprint\n');
  assert.equal(wsOf(old).buildorderVersion, VERSION);
});

test('sync touches no file inside a code repo', () => {
  const dir = tmp('sync repo');
  const app = join(dir, 'app');
  codeRepo(null, { 'package.json': '{}\n', 'HANDOFF.md': '# app handoff\n', 'CLAUDE.md': '# app rules\n' }, { dir: app });
  scaffold(dir, '--name', 'demo');
  write(dir, { '.claude/settings.local.json': '{ "permissions": {} }\n' });
  // A hand-edited doc-map that points into the code repo, plus a record that would allow the write.
  const ws = wsOf(dir);
  ws.docs.handoff = 'app/HANDOFF.md';
  ws.templateHashes['app/HANDOFF.md'] = { file: sha('# app handoff\n'), template: sha('older template') };
  // A repo added after init and not yet in workspace.json counts as well.
  const lib = join(dir, 'lib');
  codeRepo(null, { 'README.md': '# lib\n' }, { dir: lib });
  ws.docs.backlog = 'lib/docs/BACKLOG.md';
  setWs(dir, ws);
  const appBefore = snapshot(app);
  const libBefore = snapshot(lib);

  const out = sync(dir, '--apply');
  assert.ok(out.changes.every((c) => !/^(app|lib)\//.test(c.path)), JSON.stringify(out.changes));
  assert.ok(out.notes.some((n) => n.includes('app/HANDOFF.md')), 'the skipped path is named');
  assert.ok(out.notes.some((n) => n.includes('lib/docs/BACKLOG.md')), 'the skipped path is named');
  assert.deepEqual(snapshot(app), appBefore, 'the code repo is unchanged');
  assert.deepEqual(snapshot(lib), libBefore, 'the unrecorded repo is unchanged');
  assert.equal(gitIn(app, 'status', '--porcelain'), '');
  assert.equal(gitIn(lib, 'status', '--porcelain'), '');
  assert.equal(read(dir, '.claude/settings.local.json'), '{ "permissions": {} }\n');
});

test('sync leaves .claude and .git locations alone whatever their letter case', () => {
  const dir = tmp('sync case');
  scaffold(dir, '--name', 'demo');
  const ws = wsOf(dir);
  ws.docs.handoff = '.CLAUDE/HANDOFF.md';
  ws.docs.backlog = 'docs/.Git/BACKLOG.md';
  setWs(dir, ws);
  const out = sync(dir, '--apply');
  assert.ok(out.changes.every((c) => !/\.(claude|git)\//i.test(c.path)), JSON.stringify(out.changes));
  assert.ok(out.notes.some((n) => n.includes('.CLAUDE/HANDOFF.md')), JSON.stringify(out.notes));
  assert.ok(out.notes.some((n) => n.includes('docs/.Git/BACKLOG.md')), JSON.stringify(out.notes));
});

test('sync refuses a doc-map target that leaves the workspace through a symlink', (t) => {
  const dir = tmp('sync link');
  const outside = tmp('sync link outside');
  scaffold(dir, '--name', 'demo');
  try {
    // A junction needs no privilege on Windows; on other systems this is a plain symlink.
    symlinkSync(outside, join(dir, 'escape'), 'junction');
  } catch (err) {
    t.skip(`cannot create a link here: ${err.code}`);
    return;
  }
  const ws = wsOf(dir);
  ws.docs.handoff = 'escape/HANDOFF.md';
  setWs(dir, ws);
  const out = sync(dir, '--apply');
  assert.ok(out.changes.every((c) => c.path !== 'escape/HANDOFF.md'), JSON.stringify(out.changes));
  assert.ok(out.notes.some((n) => n.includes('escape/HANDOFF.md')), JSON.stringify(out.notes));
  assert.deepEqual(readdirSync(outside), [], 'nothing written outside the workspace');
});

test('sync in a folder without workspace.json refuses with a friendly message', () => {
  const dir = tmp('sync none');
  const r = cli('sync', dir, '--apply');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^buildorder: no buildorder workspace here[^\n]*\/buildorder:init[^\n]*\n$/);
  assert.deepEqual(readdirSync(dir), []);

  // A workspace from a newer buildorder: update the plugin first instead of moving the workspace backwards.
  const newer = tmp('sync newer');
  scaffold(newer, '--name', 'demo');
  const ws = wsOf(newer);
  ws.buildorderVersion = '99.0.0';
  setWs(newer, ws);
  rmSync(join(newer, 'HANDOFF.md'));
  const n = cli('sync', newer, '--apply');
  assert.equal(n.status, 1);
  assert.match(n.stderr, /^buildorder: [^\n]*99\.0\.0[^\n]*update the buildorder plugin[^\n]*\n$/);
  assert.equal(existsSync(join(newer, 'HANDOFF.md')), false);
});
