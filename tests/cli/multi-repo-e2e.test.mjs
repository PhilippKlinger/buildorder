// End to end: the write path of /buildorder:init for a workspace with several repos (1.3 AK-1).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, gitIn } from '../helpers/cli.mjs';
import { multiRepoWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

function ok(...args) {
  const r = cli(...args);
  assert.equal(r.status, 0, `${args[0]}: ${r.stderr}${r.stdout}`);
  assert.equal(r.stderr, '', args[0]);
  return r;
}
const json = (...args) => ok(...args).json;
const snapshot = (dir) => ({
  head: gitIn(dir, 'rev-parse', 'HEAD'),
  status: gitIn(dir, 'status', '--porcelain', '--untracked-files=all'),
});

test('a multi-repo workspace goes from scaffold to done with per-repo visibility and leaves every repo untouched', () => {
  const { root, code, docs } = multiRepoWorkspace();
  const repos = [...code, ...docs];
  const before = Object.fromEntries(repos.map((p) => [p, snapshot(join(root, ...p.split('/')))]));

  ok('scaffold', root, '--lang', 'en', '--visibility', 'private', '--visibility', 'shop/web=public');
  const ws = JSON.parse(readFileSync(join(root, '.claude', 'workspace.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(ws.repos.map((r) => [r.path, r.visibility])),
    { 'shop/api': 'private', 'shop/web': 'public', notes: 'private' });

  // One gap list per code repo, each with its own tag; no id repeats across the workspace.
  const ids = [];
  for (const [path, tag] of [['shop/api', 'API'], ['shop/web', 'WEB']]) {
    const gaps = ok('plan', join(root, ...path.split('/')), '--gaps').stdout;
    const found = [...new Set([...gaps.matchAll(/STD-[A-Z]+-\d+/g)].map((m) => m[0]))];
    assert.ok(found.length > 0, `${path}: gap ids`);
    assert.ok(found.every((id) => id.startsWith(`STD-${tag}-`)), `${path}: ${found}`);
    ids.push(...found);
  }
  assert.equal(new Set(ids).size, ids.length, 'no id repeats');

  assert.deepEqual(json('verify', root), { ok: true, dir: root, problems: [], warnings: [] });
  assert.equal(json('finalize', root).initPhase, 'done');
  const checklist = json('github-checklist', root);
  const by = Object.fromEntries(checklist.repos.map((r) => [r.path, r.visibility]));
  assert.equal(by['shop/api'], 'private');
  assert.equal(by['shop/web'], 'public');

  assert.equal(JSON.parse(readFileSync(join(root, '.claude', 'workspace.json'), 'utf8')).initPhase, 'done');
  for (const p of repos) {
    assert.deepEqual(snapshot(join(root, ...p.split('/'))), before[p], `${p} stays untouched`);
  }
});
