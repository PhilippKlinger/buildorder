import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, tempDir } from '../helpers/cli.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

const wsFile = (root) => join(root, '.claude', 'workspace.json');

test('radar-state reports null before the first run', () => {
  const root = makeWorkspace();
  const r = cli('radar-state', root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.lastRun, null);
  assert.ok(Array.isArray(r.json.sources) && r.json.sources.length > 0);
  for (const url of r.json.sources) assert.match(url, /^https:\/\//);
});

test('radar-done records the date and radar-state returns it', () => {
  const root = makeWorkspace();
  const done = cli('radar-done', root, '2026-11-12');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(cli('radar-state', root).json.lastRun, '2026-11-12');
  const ws = JSON.parse(readFileSync(wsFile(root), 'utf8'));
  assert.equal(ws.radar.lastRun, '2026-11-12');
  assert.equal(ws.name, 'demo', 'other workspace.json fields stay');
});

test('radar-state outside a workspace refuses', () => {
  const r = cli('radar-state', tempDir('plain'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^buildorder: .*workspace/);
});

test('radar-done rejects a date that is not YYYY-MM-DD', () => {
  const root = makeWorkspace();
  for (const bad of ['12.11.2026', '2026-13-01', '2026-02-30', 'today']) {
    const r = cli('radar-done', root, bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /YYYY-MM-DD/);
  }
  assert.equal(cli('radar-state', root).json.lastRun, null);
});
