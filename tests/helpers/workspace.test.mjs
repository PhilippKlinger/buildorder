import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { detect } from '../../plugins/buildorder/lib/detect.mjs';
import { cleanup, fakeHome, gitIn } from './cli.mjs';
import { multiRepoWorkspace } from './workspace.mjs';

after(cleanup);

test('multiRepoWorkspace builds two code repos and one docs folder', () => {
  const { root, code, docs } = multiRepoWorkspace();
  assert.deepEqual(code, ['shop/api', 'shop/web']);
  assert.deepEqual(docs, ['notes']);
  const d = detect(root, { home: fakeHome() });
  assert.equal(d.suggestion, 'multi-repo');
  const byPath = Object.fromEntries(d.repos.map((r) => [r.path, r]));
  assert.equal(byPath['shop/api'].isCode, true);
  assert.ok(byPath['shop/api'].stacks.includes('django'));
  assert.deepEqual(byPath['shop/web'].stacks, ['angular']);
  assert.equal(byPath.notes.isCode, false);
  assert.equal(existsSync(join(root, '.claude', 'workspace.json')), false);
});

test('multiRepoWorkspace sets origins, dirty files, registration and same-named repos on request', () => {
  const { root } = multiRepoWorkspace({
    withOrigin: ['shop/web'], dirty: ['shop/api'], registered: true, visibility: { 'shop/web': 'public' },
  });
  assert.equal(gitIn(join(root, 'shop', 'web'), 'remote', 'get-url', 'origin'), ['git', 'github.com:o/web.git'].join('@'));
  assert.match(gitIn(join(root, 'shop', 'api'), 'status', '--porcelain'), /wip\.txt/);
  const ws = JSON.parse(readFileSync(join(root, '.claude', 'workspace.json'), 'utf8'));
  assert.deepEqual(ws.repos, [
    { path: 'shop/api', isCode: true },
    { path: 'shop/web', isCode: true, visibility: 'public' },
    { path: 'notes', isCode: false },
  ]);
  const same = multiRepoWorkspace({ sameName: true });
  assert.deepEqual(same.code, ['a/app', 'b/app']);
  assert.deepEqual(same.docs, []);
});
