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

test('the release workflow attests the release archive with least privilege', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /^on:\s*\n\s+release:\s*\n\s+types:\s*\[published\]/m, 'must trigger on published releases only');
  assert.match(wf, /^permissions:\s*\{\}\s*$/m, 'top-level permissions must be empty');
  const perms = [...wf.matchAll(/^ {6}([a-z-]+): (read|write)\s*$/gm)].map((m) => `${m[1]}: ${m[2]}`).sort();
  assert.deepEqual(perms, ['attestations: write', 'contents: write', 'id-token: write'], 'job permissions must be exactly these three');
  assert.match(wf, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d/, 'attest action must be pinned by full SHA');
  for (const m of wf.matchAll(/^\s*(?:- )?uses: (\S+)@(\S+)/gm)) {
    assert.match(m[2], /^[0-9a-f]{40}$/, `${m[1]} must be pinned by full SHA`);
  }
  assert.match(wf, /persist-credentials: false/, 'checkout must not persist credentials');
  assert.match(wf, /^ {10}ref: refs\/tags\/\$\{\{ github\.event\.release\.tag_name \}\}$/m, 'checkout must name the tag as refs/tags/<tag> in with:');
  assert.match(wf, /-o buildorder-"\$TAG"\.tar\.gz/, 'archive name must follow buildorder-<tag>.tar.gz');
  assert.match(wf, /git archive --format=tar\.gz --prefix=buildorder-"\$TAG"\//, 'archive must be built with git archive');
  // No expression interpolation inside any run block (template injection).
  const lines = wf.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    const block = [m[2]];
    if (/^[|>]/.test(m[2])) {
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) block.push(lines[j]);
    }
    assert.ok(!block.join('\n').includes('${{'), `run block at line ${i + 1} must not interpolate expressions`);
  }
});

test('the README quickstart describes 1.3: several repos, the question limits and skill removal (review 1.3 M9)', () => {
  const quick = read('README.md').replace(/\s+/g, ' ');
  assert.doesNotMatch(quick, /a folder that holds one existing git repo\./);
  assert.match(quick, /or in a folder with one or more existing git repos/);
  assert.match(quick, /at most 8 shared questions, plus at most 3 per code repo/);
  assert.doesNotMatch(quick, /It never changes them\./);
  assert.match(quick, /removes a personal or workspace skill only after your explicit consent/);
  assert.match(quick, /a value without `=` is the default for every code repo/);
  assert.match(quick, /settings only \(for a repo that is already on GitHub\)/);
});
