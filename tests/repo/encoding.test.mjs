// Every tracked text file must be valid UTF-8 (a cp1252 write once left raw 0x85 bytes in a skill).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { repoRoot, trackedFiles } from '../helpers/repo.mjs';

const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.gz', '.tgz', '.woff', '.woff2', '.ttf']);

test('all tracked text files decode as UTF-8', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const bad = [];
  for (const rel of trackedFiles()) {
    if (BINARY.has(extname(rel).toLowerCase())) continue;
    let buf;
    try {
      buf = readFileSync(join(repoRoot, rel));
    } catch { continue; } // deleted in the working tree
    if (buf.includes(0)) continue; // NUL byte: binary
    try {
      decoder.decode(buf);
    } catch {
      bad.push(rel);
    }
  }
  assert.deepEqual(bad, [], `not valid UTF-8: ${bad.join(', ')}`);
});
