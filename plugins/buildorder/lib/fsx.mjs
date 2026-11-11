// Small filesystem helpers. No dependencies.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files below `dir` as `/`-separated relative paths. `depth` counts directory
 * levels below `dir` (0 = only files directly in `dir`); directories named in
 * `skip` are not entered. Unreadable or missing directories are skipped.
 */
export function walk(dir, depth = Infinity, skip = new Set()) {
  const inner = (d, level, rel) => {
    if (level < 0) return [];
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return []; // missing, not a directory, or no permission
    }
    return entries.flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) return skip.has(e.name) ? [] : inner(join(d, e.name), level - 1, r);
      return [r];
    });
  };
  return inner(dir, depth, '');
}

/** Parsed JSON (a leading UTF-8 BOM is ignored), or null when the file is missing or invalid. */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
