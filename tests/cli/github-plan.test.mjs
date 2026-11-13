// github-plan: the read-only GitHub plan per repo (C2, AK-7).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { cleanup, cli, gitIn, tempDir } from '../helpers/cli.mjs';
import { multiRepoWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

const VIS = { 'shop/api': 'private', 'shop/web': 'public' };
const ws = (opts = {}) => multiRepoWorkspace({ registered: true, visibility: VIS, ...opts });
const plan = (root, ...args) => {
  const r = cli('github-plan', root, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
};
const repoOf = (out, path) => out.repos.find((r) => r.path === path);
const step = (repo, kind) => repo.steps.find((s) => s.kind === kind);
const files = (dir) => readdirSync(dir, { recursive: true }).filter((p) => !p.split(/[\\/]/).includes('.git')).sort();

test('github-plan creates, pushes and sets up a repo without origin', () => {
  const { root } = ws({ withOrigin: ['shop/web'] });
  const out = plan(root, '--owner', 'o');
  assert.equal(out.ok, true);
  assert.equal(out.docs, null);
  const api = repoOf(out, 'shop/api');
  assert.equal(api.slug, 'o/api');
  assert.equal(api.visibility, 'private');
  assert.deepEqual(api.steps.map((s) => s.kind), ['create', 'push', 'settings']);
  assert.deepEqual(step(api, 'create').commands,
    [['gh', 'repo', 'create', 'o/api', '--private', '--source', 'shop/api', '--remote', 'origin']]);
  assert.deepEqual(step(api, 'push').commands, [['git', '-C', 'shop/api', 'push', '-u', 'origin', 'main']]);
  const cmds = step(api, 'settings').commands;
  assert.ok(cmds.length >= 2);
  assert.ok(cmds.every((c) => c[0] === 'gh' && c[1] === 'api' && c.every((a) => typeof a === 'string')));
  assert.ok(cmds.some((c) => c.includes('repos/o/api/rulesets')));
  assert.ok(cmds.some((c) => c.includes('repos/o/api/vulnerability-alerts')));
  assert.ok(!cmds.some((c) => c.some((a) => a.includes('secret_scanning'))), 'private: no secret scanning');
  assert.ok(!cmds.some((c) => c.includes('RULESET_ID')), 'only runnable commands');
});

test('github-plan skips create for a repo with origin', () => {
  const { root } = ws({ withOrigin: ['shop/web'] });
  const web = repoOf(plan(root, '--owner', 'o'), 'shop/web');
  assert.equal(web.slug, 'o/web');
  assert.deepEqual(step(web, 'create'), { kind: 'create', skipped: 'origin exists' });
  assert.ok(step(web, 'push').commands);
  const cmds = step(web, 'settings').commands;
  assert.ok(cmds.some((c) => c.some((a) => a.includes('secret_scanning'))), 'public: secret scanning');
});

test('github-plan skips push for a dirty repo or one without main', () => {
  const { root } = ws({ dirty: ['shop/api'] });
  const out = plan(root, '--owner', 'o');
  assert.deepEqual(step(repoOf(out, 'shop/api'), 'push'), { kind: 'push', skipped: 'dirty' });
  assert.ok(step(repoOf(out, 'shop/web'), 'push').commands);

  const { root: r2 } = ws();
  gitIn(join(r2, 'shop', 'web'), 'branch', '-m', 'main', 'trunk');
  const out2 = plan(r2, '--owner', 'o');
  assert.deepEqual(step(repoOf(out2, 'shop/web'), 'push'), { kind: 'push', skipped: 'no main' });
});

test('github-plan marks create without visibility, takes --name, and refuses bad input', () => {
  const { root } = ws();
  const out = plan(root, '--owner', 'o', '--name', 'shop/api=shop-api');
  assert.equal(repoOf(out, 'shop/api').slug, 'o/shop-api');
  assert.deepEqual(step(repoOf(out, 'notes'), 'create'), { kind: 'create', skipped: 'no visibility' });

  for (const args of [[], ['--owner', '-bad'], ['--owner', 'a/b'], ['--owner', 'o', '--name', 'nope=x'],
    ['--owner', 'o', '--name', 'shop/api=bad name'], ['--owner', 'o', '--name', 'shop/api'], ['--owner', 'o', '--name', '.=x']]) {
    const r = cli('github-plan', root, ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '');
  }
});

test('github-plan offers the docs repo only with --docs and only private', () => {
  const { root } = ws();
  assert.equal(plan(root, '--owner', 'o').docs, null);
  const d = plan(root, '--owner', 'o', '--docs').docs;
  assert.equal(d.path, '.');
  assert.equal(d.slug, 'o/shop-docs');
  assert.equal(d.visibility, 'private');
  assert.deepEqual(d.steps, [{
    kind: 'create',
    commands: [['gh', 'repo', 'create', 'o/shop-docs', '--private', '--source', '.', '--remote', 'origin']],
  }]);
  const named = plan(root, '--owner', 'o', '--docs', '--name', '.=my-docs').docs;
  assert.equal(named.slug, 'o/my-docs');
  assert.ok(named.steps[0].commands[0].includes('--private'));
});

test('github-plan never runs gh and writes no file', () => {
  const { root } = ws({ withOrigin: ['shop/web'], dirty: ['shop/api'] });
  const bin = tempDir('fake-gh');
  const marker = join(bin, 'gh-was-called');
  for (const name of ['gh', 'gh.cmd', 'gh.bat']) {
    const p = join(bin, name);
    writeFileSync(p, name === 'gh' ? `#!/bin/sh\necho x > "${marker}"\n` : `@echo off\r\necho x > "${marker}"\r\n`);
    chmodSync(p, 0o755);
  }
  const before = files(root);
  const r = cli('github-plan', root, '--owner', 'o', '--docs', { env: { PATH: [bin, process.env.PATH].join(delimiter) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(marker), false, 'gh was not run');
  assert.deepEqual(files(root), before);
  const src = readFileSync(new URL('../../plugins/buildorder/lib/github.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /spawn|execFile|child_process|fetch\(/, 'github.mjs has no process or network call');
});
