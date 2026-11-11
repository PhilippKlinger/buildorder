// Path helpers shared by the CLI commands. No dependencies.
import { resolve } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/** Forward slashes, no trailing slash, lowercase on Windows only. */
export function normalizePath(p) {
  let out = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (IS_WINDOWS) out = out.toLowerCase();
  return out;
}

/** Path of `file` relative to `root` (normalized), or null when it lies outside the root. */
export function relativeTo(file, root) {
  // resolve() keeps absolute paths but collapses `..`, so escapes cannot slip through.
  const abs = normalizePath(resolve(root, file));
  const base = normalizePath(resolve(root));
  if (abs === base) return '';
  return abs.startsWith(base + '/') ? abs.slice(base.length + 1) : null;
}

/** Minimal glob: `**` spans directories, `*` and `?` stay within one segment. */
export function globToRegExp(glob) {
  const g = normalizePath(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      const slash = g[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(rel, globs = []) {
  const p = normalizePath(rel);
  return globs.some((g) => globToRegExp(g).test(p));
}
