import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, trackedFiles } from '../helpers/repo.mjs';

const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
// Personal names may appear only in LICENSE and the manifests' author/owner fields.
// The pattern is read from the manifest, so no name is spelled out in this file.
const author = readJson('plugins/buildorder/.claude-plugin/plugin.json').author.name;
const NAME_PARTS = author.split(/\s+/).filter((p) => p.length > 2);

// The owner may appear only as part of the repository slug (<owner>/buildorder), as spec AK-7 allows.
const ownerSlug = new RegExp(`${author.replace(/\s+/g, '')}/buildorder`, 'gi');
const namesPerson = (text) => {
  const rest = text.replace(ownerSlug, '').toLowerCase();
  return NAME_PARTS.some((p) => rest.includes(p.toLowerCase()));
};

test('the version lives only in plugin.json', () => {
  assert.ok(readJson('plugins/buildorder/.claude-plugin/plugin.json').version, 'plugin.json needs a version');
  const market = readJson('.claude-plugin/marketplace.json');
  assert.ok(!('version' in market), 'marketplace must not carry a version');
  assert.ok(market.plugins.every((p) => !('version' in p)), 'marketplace entries must not carry a version');
});

test('README and CHANGELOG exist and the CHANGELOG covers the plugin version', () => {
  const files = trackedFiles();
  assert.ok(files.includes('README.md'), 'README.md must be tracked');
  assert.ok(files.includes('CHANGELOG.md'), 'CHANGELOG.md must be tracked');
  const { version } = readJson('plugins/buildorder/.claude-plugin/plugin.json');
  assert.ok(read('CHANGELOG.md').includes(`## [${version}]`), 'CHANGELOG needs a section for the plugin version');
});

test('README and CHANGELOG name no person', () => {
  assert.ok(NAME_PARTS.length > 0 && namesPerson(author), 'the check must have a name to look for');
  for (const f of ['README.md', 'CHANGELOG.md']) {
    assert.ok(!namesPerson(read(f)), `${f} must not name a person`);
  }
});
