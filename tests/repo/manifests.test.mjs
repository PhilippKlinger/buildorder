import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, trackedFiles } from '../helpers/repo.mjs';

const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

test('plugin name is buildorder and version is semver', () => {
  const plugin = readJson('plugins/buildorder/.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'buildorder');
  assert.match(plugin.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/);
});

test('marketplace lists buildorder without a version field', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'buildorder');
  const entry = market.plugins.find((p) => p.name === 'buildorder');
  assert.ok(entry, 'buildorder plugin entry missing');
  assert.equal(entry.source, './plugins/buildorder');
  assert.ok(!('version' in entry), 'marketplace entry must not carry a version');
});

test('every tracked .json file parses', () => {
  const jsonFiles = trackedFiles().filter((f) => f.endsWith('.json'));
  assert.ok(jsonFiles.length > 0, 'no tracked .json files found');
  for (const f of jsonFiles) {
    assert.doesNotThrow(() => readJson(f), `${f} must be valid JSON`);
  }
});

test('no .claude directory below plugins/', () => {
  const offenders = trackedFiles().filter(
    (f) => f.startsWith('plugins/') && f.split('/').includes('.claude'),
  );
  assert.deepEqual(offenders, []);
});
