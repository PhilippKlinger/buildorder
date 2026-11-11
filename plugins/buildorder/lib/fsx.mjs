// Small filesystem helpers. No dependencies.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files below `dir` as `/`-separated relative paths. `depth` counts directory
 * levels below `dir` (0 = only files directly in `dir`); directories named in
 * `skip` are not entered.
 */
export function walk(dir, depth = Infinity, skip = new Set(), rel = '') {
  if (depth < 0 || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return skip.has(e.name) ? [] : walk(join(dir, e.name), depth - 1, skip, r);
    return [r];
  });
}

/** Parsed JSON, or null when the file is missing or invalid. */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
