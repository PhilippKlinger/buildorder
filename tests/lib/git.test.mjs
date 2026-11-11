import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizePath } from '../../plugins/buildorder/lib/paths.mjs';
import { git, gitResult } from '../../plugins/buildorder/lib/git.mjs';

// A temp dir must not be found inside an enclosing repository.
const isolated = (dir) => ({ env: { GIT_CEILING_DIRECTORIES: dirname(dir) } });

function tmp() {
  return mkdtempSync(join(tmpdir(), 'bo test '));
}

test('git outside a repository returns an empty string', () => {
  const dir = tmp();
  try {
    assert.equal(git(dir, ['rev-parse', '--show-toplevel'], isolated(dir)), '');
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
    const r = gitResult(dir, ['rev-parse', '--show-toplevel'], isolated(dir));
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

test('inherited GIT_DIR does not redirect git away from cwd', () => {
  const a = tmp();
  const b = tmp();
  const saved = process.env.GIT_DIR;
  try {
    gitResult(a, ['init', '-q']);
    gitResult(b, ['init', '-q']);
    process.env.GIT_DIR = join(b, '.git');
    // Without the strip, --git-dir would report B's .git (an absolute path).
    const gitDir = git(a, ['rev-parse', '--git-dir']);
    assert.equal(gitDir, '.git');
    assert.equal(normalizePath(git(a, ['rev-parse', '--show-toplevel'])), normalizePath(a));
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('opts.env wins over the defaults', () => {
  const dir = tmp();
  try {
    gitResult(dir, ['init', '-q']);
    const r = gitResult(dir, ['rev-parse', '--git-dir'], { env: { GIT_DIR: join(dir, '.git') } });
    assert.equal(r.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
