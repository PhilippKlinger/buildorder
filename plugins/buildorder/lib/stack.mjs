// Stack detection for one code repo. Pure reads, no dependencies.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SKIP_DIRS, readJson, walk } from './fsx.mjs';
import { globToRegExp } from './paths.mjs';

// Manifests are looked for in the repo root and up to two folders below it
// (`a/b/file`), so monorepos with `web/` and `api/` are covered.
const DEPTH = 2;

// Output order. Lists are always in this order and never hold a stack twice.
const SUPPORTED = ['angular', 'react', 'django', 'python', 'go', 'docker', 'postgres', 'github-actions'];
const UNSUPPORTED = ['vue', 'next', 'astro', 'react-native', 'react', 'flask', 'php', 'node'];

// `compose.yml`, `docker-compose.prod.yaml`, ... but not `composer.yml` or `compose-ci.yml`.
export const COMPOSE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/;
/** `Dockerfile`, `Dockerfile.prod`, `api.dockerfile` (a file name, not a path). */
export const isDockerfile = (name) => name === 'Dockerfile' || /^Dockerfile\./.test(name) || /\.dockerfile$/i.test(name);
const REQUIREMENTS = globToRegExp('requirements*.txt');
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
// An image line whose last path segment is exactly `postgres`: optional registry/namespace
// prefix, optional tag or digest. `postgres-exporter` or `postgis/postgis` do not match.
const POSTGRES_IMAGE = /^\s*(?:-\s*)?image:\s*["']?(?:[\w.-]+(?::\d+)?\/)*postgres(?::[\w.-]+)?(?:@sha256:\w+)?["']?\s*(?:#.*)?$/m;

function read(dir, rel) {
  try {
    return readFileSync(join(dir, rel), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

// `name` as a whole package name: not part of `django-environ`, `djangorestframework`, `my.django`.
const hasPackage = (text, name) => new RegExp(`(^|[^a-z0-9_.-])${name}(?![a-z0-9_.-])`).test(text);

// Drops a `#` comment, ignoring `#` inside quotes.
function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

const quoted = (text) => [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);

/**
 * Dependency declarations of a pyproject.toml, one per entry, nothing else (classifiers,
 * keywords, descriptions stay out). Line-based, no TOML parser. Read:
 * `[project] dependencies = [...]`, `[project.optional-dependencies]`, `[dependency-groups]`
 * (quoted requirement strings) and `[tool.poetry.dependencies]`,
 * `[tool.poetry.group.*.dependencies]` (the package names on the left of `=`).
 */
export function pyprojectDeps(text) {
  const out = [];
  let section = '';
  let depth = 0; // open brackets of an array being read
  for (const raw of text.split('\n')) {
    const line = stripComment(raw).trim();
    if (depth > 0) {
      out.push(...quoted(line));
      depth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
      continue;
    }
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) { section = header[1]; continue; }
    const kv = line.match(/^([\w."-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, key, rest] = kv;
    if (/^tool\.poetry\.(group\.[^.]+\.)?dependencies$/.test(section)) out.push(key.replace(/"/g, ''));
    else if ((section === 'project' && key === 'dependencies')
      || section === 'project.optional-dependencies' || section === 'dependency-groups') {
      if (!rest.startsWith('[')) continue;
      out.push(...quoted(rest));
      depth = (rest.match(/\[/g) ?? []).length - (rest.match(/\]/g) ?? []).length;
    }
  }
  return out;
}

/** Python dependency declarations of the given files, lowercase, one per line, without comments. */
const pyText = (dir, files) => files.map((f) => {
  const text = read(dir, f);
  if (basename(f) === 'pyproject.toml') return pyprojectDeps(text).join('\n').toLowerCase();
  return text.toLowerCase().split('\n').map(stripComment).join('\n');
}).join('\n');

/**
 * `{ supported, unsupported }`: stacks the build order can plan for, and
 * recognised stacks it cannot (each listed once, in a fixed order).
 * `ignore` lists `/`-separated folders below `dir` whose files do not count (e.g. nested repos).
 */
export function detectStacks(dir, { ignore = [] } = {}) {
  const files = walk(dir, DEPTH, SKIP_DIRS).filter((f) => !ignore.some((p) => f.startsWith(`${p}/`)));
  const named = (test) => files.filter((f) => test(basename(f)));
  const supported = new Set();
  const unsupported = new Set();

  // --- JavaScript: every package.json found is judged on its own.
  if (files.some((f) => basename(f) === 'angular.json')) supported.add('angular');
  for (const f of named((n) => n === 'package.json')) {
    const pkg = readJson(join(dir, f));
    // react and vite count in dependencies as well as devDependencies.
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    let framework = false;
    if (deps['@angular/core']) framework = true;
    if (deps.next) { unsupported.add('next'); framework = true; }
    if (deps.vue) { unsupported.add('vue'); framework = true; }
    if (deps.astro) { unsupported.add('astro'); framework = true; }
    if (deps['react-native'] || deps.expo) { unsupported.add('react-native'); framework = true; }
    else if (deps.react && !deps.next) {
      // Only the React + Vite combination is supported; any other React setup is not.
      if (deps.vite) supported.add('react');
      else unsupported.add('react');
      framework = true;
    }
    // Node with no frontend framework (also a package.json that cannot be parsed).
    const angularJson = f.slice(0, f.length - 'package.json'.length) + 'angular.json';
    if (!framework && !files.includes(angularJson)) unsupported.add('node');
  }

  // --- Python and Django.
  const pyFiles = named((n) => REQUIREMENTS.test(n) || n === 'pyproject.toml');
  const py = pyText(dir, pyFiles);
  if (files.some((f) => basename(f) === 'manage.py') || hasPackage(py, 'django')) supported.add('django');
  else if (hasPackage(py, 'flask')) unsupported.add('flask');
  else if (pyFiles.length) supported.add('python');

  // --- Go.
  const goMod = named((n) => n === 'go.mod');
  if (goMod.length) supported.add('go');

  // --- Docker and Postgres.
  // Files under a `.github` folder (workflow files) are never compose files.
  const composeFiles = files.filter((f) => COMPOSE.test(basename(f)) && !f.split('/').includes('.github'));
  const dockerfiles = named(isDockerfile);
  if (composeFiles.length || dockerfiles.length) supported.add('docker');
  const goText = goMod.map((f) => read(dir, f)).join('\n');
  if (composeFiles.some((f) => POSTGRES_IMAGE.test(read(dir, f)))
    || /(^|[^a-z0-9_.-])psycopg/.test(py)
    || /github\.com\/jackc\/pgx|github\.com\/lib\/pq/.test(goText)) supported.add('postgres');

  // --- CI and PHP.
  if (files.some((f) => WORKFLOW.test(f))) supported.add('github-actions');
  if (named((n) => n === 'composer.json' || /\.php$/i.test(n)).length) unsupported.add('php');

  return {
    supported: SUPPORTED.filter((s) => supported.has(s)),
    unsupported: UNSUPPORTED.filter((s) => unsupported.has(s)),
  };
}
