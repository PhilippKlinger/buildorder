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

const COMPOSE = ['compose*.y*ml', 'docker-compose*.y*ml'].map(globToRegExp);
const REQUIREMENTS = globToRegExp('requirements*.txt');
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
// An image line whose last path segment is exactly `postgres`: optional registry/namespace
// prefix, optional tag or digest. `postgres-exporter` or `postgis/postgis` do not match.
const POSTGRES_IMAGE = /^\s*(?:-\s*)?image:\s*["']?(?:[\w.-]+(?::\d+)?\/)*postgres(?::[\w.-]+)?(?:@sha256:\w+)?["']?\s*(?:#.*)?$/m;

function read(dir, rel) {
  try {
    return readFileSync(join(dir, rel), 'utf8').replace(/^﻿/, '');
  } catch {
    return '';
  }
}

// `name` as a whole package name: not part of `django-environ`, `djangorestframework`, `my.django`.
const hasPackage = (text, name) => new RegExp(`(^|[^a-z0-9_.-])${name}(?![a-z0-9_.-])`).test(text);

/** Requirement files with comment lines dropped, lowercase. */
const pyText = (dir, files) => files
  .map((f) => read(dir, f).toLowerCase().split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n'))
  .join('\n');

/**
 * `{ supported, unsupported }`: stacks the build order can plan for, and
 * recognised stacks it cannot (each listed once, in a fixed order).
 */
export function detectStacks(dir) {
  const files = walk(dir, DEPTH, SKIP_DIRS);
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
  const composeFiles = named((n) => COMPOSE.some((re) => re.test(n)));
  const dockerfiles = named((n) => n === 'Dockerfile' || /^Dockerfile\./.test(n) || /\.dockerfile$/i.test(n));
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
