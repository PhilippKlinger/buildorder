import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readJson, walk, writeJson } from '../../plugins/buildorder/lib/fsx.mjs';

const SKIP = new Set(['node_modules', '.git', '.venv', 'dist']);

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bo test '));
  for (const f of files) {
    const abs = join(dir, ...f.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
  }
  return dir;
}

test('walk skips node_modules, .git, .venv and dist', () => {
  const dir = tree(['a.txt', 'src/b.js', 'node_modules/p/i.js', '.git/HEAD', '.venv/x.py', 'dist/o.js', 'src/dist/q.js']);
  try {
    assert.deepEqual(walk(dir, Infinity, SKIP).sort(), ['a.txt', 'src/b.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walk respects depth and returns slash-separated relative paths', () => {
  const dir = tree(['a.txt', 'x/b.txt', 'x/y/c.txt', 'x/y/z/d.txt']);
  try {
    assert.deepEqual(walk(dir, 0, SKIP).sort(), ['a.txt']);
    assert.deepEqual(walk(dir, 1, SKIP).sort(), ['a.txt', 'x/b.txt']);
    assert.deepEqual(walk(dir, 2, SKIP).sort(), ['a.txt', 'x/b.txt', 'x/y/c.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walk on a missing directory returns an empty list', () => {
  assert.deepEqual(walk(join(tmpdir(), 'bo missing dir'), 2, SKIP), []);
});

test('walk returns an empty list when dir is a file', () => {
  const dir = tree(['f.txt']);
  try {
    assert.deepEqual(walk(join(dir, 'f.txt'), 2, SKIP), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJson ignores a leading UTF-8 BOM', () => {
  const dir = tree([]);
  try {
    const file = join(dir, 'bom.json');
    writeFileSync(file, '\uFEFF{"a":1}');
    assert.deepEqual(readJson(file), { a: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJson returns null for missing or invalid files', () => {
  const dir = tree(['bad.json']);
  try {
    assert.equal(readJson(join(dir, 'nope.json')), null);
    writeFileSync(join(dir, 'bad.json'), '{oops');
    assert.equal(readJson(join(dir, 'bad.json')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJson writes 2-space JSON with a trailing newline, readJson reads it back', () => {
  const dir = tree([]);
  try {
    const file = join(dir, 'o.json');
    writeJson(file, { a: 1, b: [2] });
    assert.equal(readFileSync(file, 'utf8'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
    assert.deepEqual(readJson(file), { a: 1, b: [2] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
