import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { globToRegExp, matchesAny, normalizePath, relativeTo } from '../../plugins/buildorder/lib/paths.mjs';

const WIN = process.platform === 'win32';

test('normalizePath uses forward slashes and drops trailing slashes', () => {
  assert.equal(normalizePath('a\\b\\c\\'), 'a/b/c');
  assert.equal(normalizePath('a/b//'), 'a/b');
});

test('normalizePath lowercases only on win32', () => {
  assert.equal(normalizePath('C:\\A\\b\\'), WIN ? 'c:/a/b' : 'C:/A/b');
  assert.equal(normalizePath('Foo/Bar'), WIN ? 'foo/bar' : 'Foo/Bar');
});

test('relativeTo returns the path below the root', () => {
  const root = resolve('some', 'root');
  assert.equal(relativeTo(resolve(root, 'a', 'b.txt'), root), 'a/b.txt');
  assert.equal(relativeTo('a/b.txt', root), 'a/b.txt');
  assert.equal(relativeTo(root, root), '');
});

test('relativeTo returns null outside the root', () => {
  const root = resolve('some', 'root');
  assert.equal(relativeTo(resolve('some', 'other', 'x.txt'), root), null);
  assert.equal(relativeTo(resolve('some', 'root2', 'x.txt'), root), null);
});

test('globToRegExp: ** spans directories', () => {
  const re = globToRegExp('docs/**');
  assert.ok(re.test('docs/a/b.md'));
  assert.ok(re.test('docs/a.md'));
  assert.ok(!re.test('src/a.md'));
  assert.ok(globToRegExp('**/x.md').test('x.md'));
  assert.ok(globToRegExp('**/x.md').test('a/b/x.md'));
});

test('relativeTo collapses .. in absolute paths', () => {
  const root = resolve('some', 'root');
  assert.equal(relativeTo(resolve(root, '..', 'etc', 'passwd'), root), null);
  assert.equal(relativeTo(root + '/../etc/passwd', root), null);
  assert.equal(relativeTo(root + '/a/../b.txt', root), 'b.txt');
  assert.equal(relativeTo('../x', root), null);
});

test('relativeTo is case-insensitive on win32 only', () => {
  const root = resolve('some', 'Root');
  const file = resolve('some', 'ROOT', 'x');
  assert.equal(relativeTo(file, root), WIN ? 'x' : null);
});

test('globToRegExp: docs/** does not match docs itself', () => {
  assert.ok(!globToRegExp('docs/**').test('docs'));
});

test('globToRegExp: * and ? stay within one segment', () => {
  assert.ok(globToRegExp('docs/*.md').test('docs/a.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
  assert.ok(globToRegExp('a?c').test('abc'));
  assert.ok(!globToRegExp('a?c').test('a/c'));
});

test('globToRegExp escapes regex metacharacters', () => {
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb'));
  assert.ok(globToRegExp('(x)+').test('(x)+'));
});

test('matchesAny checks every glob and tolerates backslashes', () => {
  assert.ok(matchesAny('docs\\a.md', ['src/**', 'docs/*.md']));
  assert.ok(!matchesAny('lib/a.md', ['src/**', 'docs/*.md']));
  assert.ok(!matchesAny('a', []));
  assert.ok(!matchesAny('a'));
});
