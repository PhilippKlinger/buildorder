import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot, trackedFiles } from '../helpers/repo.mjs';

const HOME_PATTERNS = [/[A-Za-z]:[\\/]+Users[\\/]/i, /\/home\/[a-z]/, /\/Users\/[A-Za-z]/];
// Requires a dotted domain ending in letters, so npm specs like pkg@1.2.3 do not match.
const EMAIL = /[\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,}\b/;
const UMLAUT = /[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]/;
const GERMAN_ALLOWED = /(^|\/)templates\/(.*\/)?de\//;

/** Text lines of every tracked file; binary files (containing NUL) are skipped. */
function* textLines() {
  for (const file of trackedFiles()) {
    let buf;
    try {
      buf = readFileSync(resolve(repoRoot, file));
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) yield { file, line: i + 1, text: lines[i] };
  }
}

function offenders(patterns, skipFile = () => false) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const hits = [];
  for (const { file, line, text } of textLines()) {
    if (skipFile(file)) continue;
    if (list.some((re) => re.test(text))) hits.push(`${file}:${line}`);
  }
  return hits;
}

test('no user home paths', () => {
  const win = ['C:', 'Users', 'x'].join('\\');
  const mac = ['', 'Users', 'x'].join('/');
  const linux = ['', 'home', 'x'].join('/');
  for (const probe of [win, mac, linux]) {
    assert.ok(
      HOME_PATTERNS.some((re) => re.test(probe)),
      `pattern must match ${probe}`,
    );
  }
  assert.deepEqual(offenders(HOME_PATTERNS), []);
});

test('no email addresses', () => {
  const address = ['someone', 'example.com'].join('@');
  assert.ok(EMAIL.test(address), 'pattern must match an address');
  const npmSpec = ['pkg', '1.2.3'].join('@');
  assert.ok(!EMAIL.test(npmSpec), 'pattern must not match an npm version spec');
  assert.deepEqual(offenders(EMAIL), []);
});

test('shipped text is English', () => {
  const probe = 'gr' + String.fromCharCode(0xfc) + 'n';
  assert.ok(UMLAUT.test(probe), 'pattern must match an umlaut');
  assert.deepEqual(offenders(UMLAUT, (f) => GERMAN_ALLOWED.test(f)), []);
});

test('German template exemption covers de/ at any depth', () => {
  assert.ok(GERMAN_ALLOWED.test('templates/de/x'));
  assert.ok(GERMAN_ALLOWED.test('plugins/b/templates/a/de/x'));
  assert.ok(!GERMAN_ALLOWED.test('templates/a/x'));
});

const GITLEAKS_ALLOWLIST = /(^|\/)\.gitleaks(\.toml|ignore)$/;

test('no gitleaks config or ignore file is tracked', () => {
  assert.ok(GITLEAKS_ALLOWLIST.test('.gitleaksignore'));
  assert.ok(GITLEAKS_ALLOWLIST.test('a/b/.gitleaks.toml'));
  assert.ok(!GITLEAKS_ALLOWLIST.test('docs/gitleaks.md'));
  assert.deepEqual(trackedFiles().filter((f) => GITLEAKS_ALLOWLIST.test(f)), []);
});
