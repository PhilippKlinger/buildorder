import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectDeploy } from '../../plugins/buildorder/lib/deploy.mjs';

function check(files, expected) {
  const dir = mkdtempSync(join(tmpdir(), 'bo deploy '));
  try {
    for (const [f, content] of Object.entries(files)) {
      const abs = join(dir, ...f.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    assert.deepEqual(detectDeploy(dir), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no evidence is unknown', () => check({ 'README.md': 'x' }, { target: 'unknown', evidence: [] }));
test('missing folder is unknown', () =>
  assert.deepEqual(detectDeploy(join(tmpdir(), 'bo missing dir y')), { target: 'unknown', evidence: [] }));
test('Dockerfile means container', () => check({ Dockerfile: 'x' }, { target: 'container', evidence: ['Dockerfile'] }));
test('compose file means container', () =>
  check({ 'compose.yaml': 'x' }, { target: 'container', evidence: ['compose.yaml'] }));
test('paas config files mean paas', () =>
  check({ 'vercel.json': '{}', Procfile: 'web: x' }, { target: 'paas', evidence: ['vercel.json', 'Procfile'] }));
test('container beats paas and webspace', () =>
  check({ Dockerfile: 'x', 'netlify.toml': 'x', '.htaccess': 'x' }, { target: 'container', evidence: ['Dockerfile'] }));
test('paas beats webspace', () => check({ 'netlify.toml': 'x', 'index.php': 'x' }, { target: 'paas', evidence: ['netlify.toml'] }));
test('.htaccess and php files mean webspace', () =>
  check({ '.htaccess': 'x', 'public/index.php': 'x' }, { target: 'webspace', evidence: ['.htaccess', 'public/index.php'] }));
test('ftp-named file means webspace, but not words merely containing ftp', () => {
  check({ 'deploy-ftp.txt': 'x' }, { target: 'webspace', evidence: ['deploy-ftp.txt'] });
  check({ 'softpaw.txt': 'x' }, { target: 'unknown', evidence: [] });
});
test('ftp backup inside dist is found although dist is skipped', () =>
  check({ 'dist/bak ftp': 'x' }, { target: 'webspace', evidence: ['dist/bak ftp'] }));
test('ftp upload script in package.json means webspace', () =>
  check({ 'package.json': JSON.stringify({ scripts: { deploy: 'lftp -f up.txt', build: 'vite build' } }) },
    { target: 'webspace', evidence: ['package.json (scripts.deploy)'] }));
test('broken package.json is no evidence', () => check({ 'package.json': '{ nope' }, { target: 'unknown', evidence: [] }));
test('webspace evidence is capped at 3', () =>
  check({ 'a.php': 'x', 'b.php': 'x', 'c.php': 'x', 'd.php': 'x', '.htaccess': 'x' },
    { target: 'webspace', evidence: ['.htaccess', 'a.php', 'b.php'] }));
test('container evidence is capped at 3', () =>
  check({ Dockerfile: 'x', 'docker-compose.yml': 'x', 'docker-compose.yaml': 'x', 'compose.yml': 'x' },
    { target: 'container', evidence: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'] }));
test('node_modules is not evidence', () => check({ 'node_modules/p/x.php': 'x' }, { target: 'unknown', evidence: [] }));

test('vendor and build folders are no evidence', () =>
  check({ 'vendor/x/y.php': 'x', 'build/z.php': 'x' }, { target: 'unknown', evidence: [] }));
