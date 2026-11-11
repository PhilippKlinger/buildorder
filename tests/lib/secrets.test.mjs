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
    `token = "${fakeSecret('github')}" # example`,
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
  assert.equal(mask('abcdefghijkl'), 'abcd...kl');
});
