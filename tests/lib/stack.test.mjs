import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectStacks } from '../../plugins/buildorder/lib/stack.mjs';

// Writes `files` ({ relPath: content }) into a fresh temp dir whose name contains a space.
function mini(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bo stack '));
  for (const [f, content] of Object.entries(files)) {
    const abs = join(dir, ...f.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function check(files, expected) {
  const dir = mini(files);
  try {
    assert.deepEqual(detectStacks(dir), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pkg = (deps = {}, dev = {}) => JSON.stringify({ dependencies: deps, devDependencies: dev });
const out = (supported = [], unsupported = []) => ({ supported, unsupported });

test('empty folder has no stacks', () => check({}, out()));
test('angular.json means angular', () => check({ 'angular.json': '{}' }, out(['angular'])));
test('react with vite is react', () => check({ 'package.json': pkg({ react: '1' }, { vite: '1' }) }, out(['react'])));
test('react and vite may sit in either dependency block', () =>
  check({ 'package.json': pkg({ vite: '1' }, { react: '1' }) }, out(['react'])));
test('react without vite is unsupported', () => check({ 'package.json': pkg({ react: '1' }) }, out([], ['react'])));
test('vite without react is plain node', () => check({ 'package.json': pkg({}, { vite: '1' }) }, out([], ['node'])));
test('next is unsupported and not react', () =>
  check({ 'package.json': pkg({ react: '1', next: '1', vite: '1' }) }, out([], ['next'])));
test('react-native is unsupported and not react', () =>
  check({ 'package.json': pkg({ react: '1', 'react-native': '1' }) }, out([], ['react-native'])));
test('vue and astro are unsupported', () =>
  check({ 'package.json': pkg({ vue: '1', astro: '1' }) }, out([], ['vue', 'astro'])));
test('package.json without framework is node', () => check({ 'package.json': pkg({ express: '1' }) }, out([], ['node'])));
test('broken package.json is node', () => check({ 'package.json': '{ nope' }, out([], ['node'])));
test('angular.json next to package.json is angular, not node', () =>
  check({ 'angular.json': '{}', 'package.json': pkg({ '@angular/core': '1' }) }, out(['angular'])));
test('manage.py means django', () => check({ 'manage.py': '' }, out(['django'])));
test('django beats python', () =>
  check({ 'requirements.txt': 'Django==5.0\n', 'pyproject.toml': '[project]\n' }, out(['django'])));
test('django in pyproject.toml means django', () =>
  check({ 'pyproject.toml': 'dependencies = ["django>=5"]\n' }, out(['django'])));
test('django-environ alone is python, not django', () =>
  check({ 'requirements.txt': 'django-environ==0.11\ndjangorestframework\n' }, out(['python'])));
test('a commented django line does not count', () =>
  check({ 'requirements.txt': '# django\nrequests\n' }, out(['python'])));
test('requirements.txt alone is python', () => check({ 'requirements.txt': 'requests\n' }, out(['python'])));
test('requirements-dev.txt counts as requirements', () => check({ 'requirements-dev.txt': 'pytest\n' }, out(['python'])));
test('pyproject.toml alone is python', () => check({ 'pyproject.toml': '[project]\nname = "app"\n' }, out(['python'])));
test('flask is unsupported and not python', () => check({ 'requirements.txt': 'flask\n' }, out([], ['flask'])));
test('go.mod means go', () => check({ 'go.mod': 'module app\n' }, out(['go'])));
test('Dockerfile means docker', () => check({ Dockerfile: 'FROM scratch\n' }, out(['docker'])));
test('compose files mean docker', () => {
  for (const name of ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'compose.prod.yaml']) {
    check({ [name]: 'services: {}\n' }, out(['docker']));
  }
});
test('postgres image in compose means postgres', () =>
  check({ 'compose.yml': 'services:\n  db:\n    image: postgres\n' }, out(['docker', 'postgres'])));
test('postgres image with tag or registry prefix counts', () => {
  for (const image of ['postgres:16-alpine', '"postgres:16"', 'docker.io/library/postgres:16', 'registry.example:5000/postgres@sha256:abc']) {
    check({ 'docker-compose.yml': `services:\n  db:\n    image: ${image}\n` }, out(['docker', 'postgres']));
  }
});
test('postgres-like image names do not count', () =>
  check({ 'compose.yml': 'services:\n  db:\n    image: postgres-exporter:1\n  x:\n    image: postgis/postgis\n' }, out(['docker'])));
test('postgres in a Dockerfile alone does not count', () =>
  check({ Dockerfile: 'FROM postgres:16\n' }, out(['docker'])));
test('psycopg in python deps means postgres', () => {
  check({ 'requirements.txt': 'psycopg2-binary==2.9\n' }, out(['python', 'postgres']));
  check({ 'requirements.txt': 'psycopg[binary]\n' }, out(['python', 'postgres']));
});
test('pgx or lib/pq in go.mod means postgres', () => {
  check({ 'go.mod': 'require github.com/jackc/pgx/v5 v5.0.0\n' }, out(['go', 'postgres']));
  check({ 'go.mod': 'require github.com/lib/pq v1.10.0\n' }, out(['go', 'postgres']));
});
test('workflow files mean github-actions', () => {
  check({ '.github/workflows/ci.yml': 'on: push\n' }, out(['github-actions']));
  check({ '.github/workflows/ci.yaml': 'on: push\n' }, out(['github-actions']));
});
test('php files or composer.json are unsupported php', () => {
  check({ 'composer.json': '{}' }, out([], ['php']));
  check({ 'public/index.php': '<?php' }, out([], ['php']));
});
test('two levels deep is found, three is not', () => {
  check({ 'svc/api/go.mod': 'module api\n' }, out(['go']));
  check({ 'a/b/c/go.mod': 'module api\n' }, out());
});
test('node_modules and dist are skipped', () =>
  check({ 'node_modules/x/go.mod': '', 'dist/Dockerfile': '' }, out()));
test('output order is fixed and lists have no duplicates', () => {
  check({
    '.github/workflows/ci.yml': 'x',
    'go.mod': 'x',
    'api/go.mod': 'x',
    'web/angular.json': '{}',
    Dockerfile: 'x',
    'a/package.json': pkg({ vue: '1' }),
    'b/package.json': pkg({ vue: '1' }),
    'c/composer.json': '{}',
  }, out(['angular', 'go', 'docker', 'github-actions'], ['vue', 'php']));
});
test('missing folder has no stacks', () => assert.deepEqual(detectStacks(join(tmpdir(), 'bo missing dir x')), out()));
