import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitResult } from '../../plugins/buildorder/lib/git.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'bo test '));
}

test('git outside a repository returns an empty string', () => {
  const dir = tmp();
  try {
    assert.equal(git(dir, ['rev-parse', '--show-toplevel']), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git returns trimmed output inside a repository (path with spaces)', () => {
  const dir = tmp();
  try {
    assert.equal(git(dir, ['init', '-q']), '');
    assert.equal(git(dir, ['rev-parse', '--is-inside-work-tree']), 'true');
    assert.equal(gitResult(dir, ['rev-parse', '--is-inside-work-tree']).stdout, 'true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitResult reports failure without throwing', () => {
  const dir = tmp();
  try {
    const r = gitResult(dir, ['rev-parse', '--show-toplevel']);
    assert.equal(r.ok, false);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /not a git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opts.safeDirectory is passed as a one-off -c before the subcommand', () => {
  const dir = tmp();
  try {
    gitResult(dir, ['init', '-q']);
    const r = gitResult(dir, ['config', '--get-all', 'safe.directory'], { safeDirectory: '/some/where' });
    assert.equal(r.ok, true);
    // The global config may list other safe.directory values; ours must be among them.
    assert.ok(r.stdout.split('\n').includes('/some/where'));
    assert.equal(git(dir, ['config', '--local', '--get-all', 'safe.directory']), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
