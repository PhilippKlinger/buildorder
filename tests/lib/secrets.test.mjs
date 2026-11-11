import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSecretFile, mask, scanLine } from '../../plugins/buildorder/lib/secrets.mjs';
import { fakeSecret } from '../helpers/workspace.mjs';

test('flags an AWS access key', () => {
  assert.equal(scanLine(`key = ${fakeSecret('aws')}`).label, 'AWS Access Key');
});

test('flags a GitHub token', () => {
  assert.equal(scanLine(`token: ${fakeSecret('github')}`).label, 'GitHub Token');
});

test('flags an sk- API key', () => {
  assert.equal(scanLine(`k ${fakeSecret('openai')}`).label, 'API Key (sk-...)');
});

test('flags a hardcoded Django SECRET_KEY', () => {
  assert.equal(scanLine(`SECRET_KEY = '${fakeSecret('django')}'`).label, 'Django SECRET_KEY');
});

test('flags a private key header', () => {
  assert.equal(scanLine(fakeSecret('privateKey')).label, 'Private Key');
});

test('flags a password literal with an English label', () => {
  assert.equal(scanLine(`password = "${fakeSecret('password')}"`).label, 'Password/token in code');
});

test('never returns the full value', () => {
  const hit = scanLine(`key = ${fakeSecret('aws')}`);
  assert.ok(!hit.masked.includes(fakeSecret('aws')));
});

test('allows placeholders and environment lookups', () => {
  for (const line of [
    "SECRET_KEY = os.getenv('DJANGO_SECRET_KEY')",
    'const t = process.env.GITHUB_TOKEN',
    'password = "change-me-please"',
    'password = "${DB_PASSWORD}"',
    "SECRET_KEY = 'os.environ[DJANGO_KEY_NAME]'",
    'password = "changeme123"',
    'SECRET_KEY = "<your secret key here>"',
  ]) assert.equal(scanLine(line), null, line);
});

test('isSecretFile flags env and key files but not templates', () => {
  assert.equal(isSecretFile('app/.env'), true);
  assert.equal(isSecretFile('.env.production'), true);
  assert.equal(isSecretFile('keys/server.pem'), true);
  assert.equal(isSecretFile('.env.example'), false);
  assert.equal(isSecretFile('src/main.ts'), false);
});

test('mask hides short values entirely and keeps the edges of long ones', () => {
  assert.equal(mask('short'), '***');
  assert.equal(mask('abcdefghijkl'), '***');
  assert.equal(mask('abcdefghijklm'), 'abcd...');
});

test('masked output reveals at most 4 characters of the value, not the prefix', () => {
  const secret = fakeSecret('password').repeat(2);
  const hit = scanLine(`password = "${secret}"`);
  assert.equal(hit.masked, secret.slice(0, 4) + '...');
  assert.ok(!hit.masked.includes('password'));
});

test('a real key on a line with example.com or an example comment is still flagged', () => {
  assert.equal(scanLine(`curl https://example.com -H "x: ${fakeSecret('aws')}"`).label, 'AWS Access Key');
  assert.equal(scanLine(`token = ${fakeSecret('github')} # example`).label, 'GitHub Token');
});

test('flags a Google API key', () => {
  assert.equal(scanLine(`k = ${'AIza' + 'Fake'.repeat(8) + 'abc'}`).label, 'Google API Key');
});

test('flags a Slack token', () => {
  assert.equal(scanLine(`t = ${['xoxb', '1234567890', 'fake'].join('-')}`).label, 'Slack Token');
});

test('a long line of "<" without ">" is scanned quickly', () => {
  const line = 'password = "' + '<'.repeat(20000);
  const start = performance.now();
  scanLine(line);
  scanLine(`password = "${'<'.repeat(20000)}"`);
  assert.ok(performance.now() - start < 50);
});
