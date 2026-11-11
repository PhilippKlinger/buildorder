import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { findWorkspaceRoot, loadWorkspace, repoFor } from '../../plugins/buildorder/lib/workspace.mjs';
import { cleanup, tempDir, write } from '../helpers/cli.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

const same = (a, b) => assert.equal(a.replace(/\\/g, '/').toLowerCase(), b.replace(/\\/g, '/').toLowerCase());

test('finds the root from a nested repo file', () => {
  const root = makeWorkspace();
  write(root, { 'app/src/deep/main.ts': 'x\n' });
  same(findWorkspaceRoot(join(root, 'app', 'src', 'deep', 'main.ts')), root);
  same(findWorkspaceRoot(join(root, 'app', 'src')), root);
  same(findWorkspaceRoot(root), root);
});

test('finds the root from a path that does not exist yet', () => {
  const root = makeWorkspace();
  same(findWorkspaceRoot(join(root, 'app', 'new', 'folder', 'file.ts')), root);
});

test('ignores a workspace.json without schemaVersion 1', () => {
  const root = tempDir('legacy');
  write(root, { '.claude/workspace.json': JSON.stringify({ kitVersion: '0.5.0' }), 'a/b.txt': '' });
  assert.equal(findWorkspaceRoot(join(root, 'a', 'b.txt')), null);
  write(root, { '.claude/workspace.json': JSON.stringify({ schemaVersion: 2 }) });
  assert.equal(findWorkspaceRoot(join(root, 'a')), null);
});

test('stops at invalid JSON instead of searching further up', () => {
  const outer = makeWorkspace();
  const inner = join(outer, 'nested');
  write(inner, { '.claude/workspace.json': '{ not json', 'x.txt': '' });
  assert.equal(findWorkspaceRoot(join(inner, 'x.txt')), null);
});

test('returns null outside any workspace', () => {
  assert.equal(findWorkspaceRoot(join(tempDir('none'), 'a', 'b.txt')), null);
});

test('reads a workspace.json with a BOM', () => {
  const root = tempDir('bom');
  write(root, { '.claude/workspace.json': String.fromCharCode(0xfeff) + '{"schemaVersion":1}' });
  same(findWorkspaceRoot(root), root);
});

test('loadWorkspace returns the parsed file only for schemaVersion 1', () => {
  const root = makeWorkspace({ name: 'demo-x' });
  assert.equal(loadWorkspace(root).name, 'demo-x');
  const bad = tempDir('bad');
  write(bad, { '.claude/workspace.json': '[1]' });
  assert.equal(loadWorkspace(bad), null);
  assert.equal(loadWorkspace(join(bad, 'missing')), null);
});

test('repoFor maps a path to its repo and rejects outside paths', () => {
  const root = makeWorkspace();
  const ws = loadWorkspace(root);
  const hit = repoFor(ws, root, join(root, 'app', 'src', 'a.ts'));
  assert.equal(hit.path, 'app');
  same(hit.abs, join(root, 'app'));
  same(repoFor(ws, root, join(root, 'app')).abs, join(root, 'app'));
  assert.equal(repoFor(ws, root, join(root, 'application', 'a.ts')), null);
  assert.equal(repoFor(ws, root, join(root, 'HANDOFF.md')), null);
  assert.equal(repoFor(ws, root, root + '/app/../x.md'), null);
  assert.equal(repoFor(ws, root, root + '/../x'), null);
});

test('repoFor canonicalises repo paths', () => {
  const root = makeWorkspace();
  const file = join(root, 'app', 'src', 'a.ts');
  for (const path of ['./app', 'app/../app', 'app/', join(root, 'app')]) {
    const hit = repoFor({ repos: [{ path }] }, root, file);
    assert.equal(hit.path, 'app', path);
    same(hit.abs, join(root, 'app'));
  }
  const whole = repoFor({ repos: [{ path: '.' }] }, root, file);
  assert.equal(whole.path, '');
  same(whole.abs, root);
  assert.equal(repoFor({ repos: [{ path: '../elsewhere' }] }, root, file), null);
});

test('repoFor prefers the most specific nested repo', () => {
  const root = makeWorkspace();
  const ws = { repos: [{ path: '.' }, { path: 'app' }, { path: 'app/packages/lib' }] };
  assert.equal(repoFor(ws, root, join(root, 'app', 'packages', 'lib', 'x.ts')).path, 'app/packages/lib');
  assert.equal(repoFor(ws, root, join(root, 'app', 'x.ts')).path, 'app');
  assert.equal(repoFor(ws, root, join(root, 'docs.md')).path, '');
});
