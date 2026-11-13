// github-plan: the read-only GitHub plan per repo (C2, AK-7).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
// Every file below `dir`, .git included, with its size and modification time: a rewritten index shows up.
const files = (dir) => readdirSync(dir, { recursive: true }).sort()
  .map((p) => [p, statSync(join(dir, p))])
  .filter(([, st]) => st.isFile())
  .map(([p, st]) => `${p} ${st.size} ${st.mtimeMs}`);

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

test('github-plan skips push and settings when the repo has no origin and is not created', () => {
  const { root } = ws();
  const notes = repoOf(plan(root, '--owner', 'o'), 'notes');
  assert.deepEqual(notes.steps, [
    { kind: 'create', skipped: 'no visibility' },
    { kind: 'push', skipped: 'no origin' },
    { kind: 'settings', skipped: 'no origin' },
  ]);
});

// --- review 1.3 fixes ---

test('github-plan keeps the recorded path of upper-case folders and finds --name in any case (C1, I3)', () => {
  const { root } = multiRepoWorkspace({ registered: true, names: ['Shop/Api', 'Shop/Web'], visibility: { 'Shop/Api': 'private' } });
  const out = plan(root, '--owner', 'o', '--name', 'Shop/Api=shop-api');
  assert.deepEqual(out.repos.map((r) => r.path).sort(), ['Shop/Api', 'Shop/Web', 'notes']);
  const api = repoOf(out, 'Shop/Api');
  assert.equal(api.slug, 'o/shop-api');
  assert.deepEqual(step(api, 'push').commands, [['git', '-C', 'Shop/Api', 'push', '-u', 'origin', 'main']]);
  if (process.platform === 'win32') {
    assert.equal(repoOf(plan(root, '--owner', 'o', '--name', 'shop/api=x'), 'Shop/Api').slug, 'o/x', 'Windows paths ignore case');
  }
});

test('github-plan skips create, push and settings for a non-GitHub origin (I4)', () => {
  const { root } = ws();
  gitIn(join(root, 'shop', 'api'), 'remote', 'add', 'origin', 'https://gitlab.com/acme/api.git');
  gitIn(join(root, 'shop', 'web'), 'remote', 'add', 'origin', 'https://gitlab.com/mirror/github.com/o/web.git');
  const out = plan(root, '--owner', 'o');
  for (const path of ['shop/api', 'shop/web']) {
    const repo = repoOf(out, path);
    assert.deepEqual(repo.steps, [
      { kind: 'create', skipped: 'non-GitHub origin' },
      { kind: 'push', skipped: 'non-GitHub origin' },
      { kind: 'settings', skipped: 'non-GitHub origin' },
    ], path);
    assert.equal(repo.exists, false, path);
  }
});

test('github-plan marks whether the repo already exists on GitHub (I5)', () => {
  const { root } = ws({ withOrigin: ['shop/web'] });
  const out = plan(root, '--owner', 'o', '--docs');
  assert.equal(repoOf(out, 'shop/web').exists, true);
  assert.equal(repoOf(out, 'shop/api').exists, false);
  assert.equal(repoOf(out, 'notes').exists, false);
  assert.equal(out.docs.exists, false);
});

test('github-plan skips create for a folder name GitHub would refuse (M2)', () => {
  const { root } = multiRepoWorkspace({ registered: true, names: ['shop/my api', 'shop/web'], visibility: { 'shop/my api': 'private' } });
  const out = plan(root, '--owner', 'o');
  assert.deepEqual(repoOf(out, 'shop/my api').steps, [
    { kind: 'create', skipped: 'invalid name' },
    { kind: 'push', skipped: 'no origin' },
    { kind: 'settings', skipped: 'no origin' },
  ]);
  const named = repoOf(plan(root, '--owner', 'o', '--name', 'shop/my api=my-api'), 'shop/my api');
  assert.deepEqual(step(named, 'create').commands[0].slice(0, 4), ['gh', 'repo', 'create', 'o/my-api']);
});

test('github-plan orders the settings alerts, secret scanning, ruleset and names the --done step of each (M6)', () => {
  const { root } = ws({ withOrigin: ['shop/web'] });
  const out = plan(root, '--owner', 'o');
  // A public repo has two settings steps (before and after the push); together they hold all three commands.
  const parts = repoOf(out, 'shop/web').steps.filter((s) => s.kind === 'settings');
  const web = { ticks: parts.flatMap((s) => s.ticks), commands: parts.flatMap((s) => s.commands) };
  assert.deepEqual(web.ticks, ['settings:alerts', 'settings:secrets', 'settings:ruleset']);
  assert.ok(web.commands[0].includes('repos/o/web/vulnerability-alerts'));
  assert.ok(web.commands[1].some((a) => a.includes('secret_scanning')));
  assert.ok(web.commands[2].includes('repos/o/web/rulesets'));
  const api = step(repoOf(out, 'shop/api'), 'settings');
  assert.deepEqual(api.ticks, ['settings:alerts', 'settings:ruleset'], 'private: no secret scanning');
  assert.equal(api.commands.length, api.ticks.length);
});

test('github-plan enables alerts and secret scanning before the push for a public repo', () => {
  const { root } = ws();
  const web = repoOf(plan(root, '--owner', 'o'), 'shop/web');
  assert.deepEqual(web.steps.map((s) => s.kind), ['create', 'settings', 'push', 'settings']);
  const [, first, , second] = web.steps;
  assert.deepEqual(first.ticks, ['settings:alerts', 'settings:secrets']);
  assert.ok(first.commands[0].includes('repos/o/web/vulnerability-alerts'));
  assert.ok(first.commands[1].some((a) => a.includes('secret_scanning_push_protection')));
  assert.deepEqual(second.ticks, ['settings:ruleset']);
  assert.ok(second.commands[0].includes('repos/o/web/rulesets'));
});

test('github-plan keeps create, push, settings for a private repo', () => {
  const { root } = ws();
  const api = repoOf(plan(root, '--owner', 'o'), 'shop/api');
  assert.deepEqual(api.steps.map((s) => s.kind), ['create', 'push', 'settings']);
  assert.deepEqual(step(api, 'settings').ticks, ['settings:alerts', 'settings:ruleset']);
});

// --- 1.3.1 (practice test S5-1): two repos, one GitHub name ---

test('github-plan flags repos that would get the same GitHub name', () => {
  const { root } = ws({ sameName: true, visibility: { 'a/app': 'public', 'b/app': 'private' } });
  const out = plan(root, '--owner', 'o');
  for (const path of ['a/app', 'b/app']) {
    const repo = repoOf(out, path);
    assert.equal(repo.slug, 'o/app');
    assert.deepEqual(repo.steps, [
      { kind: 'create', skipped: 'duplicate name' },
      { kind: 'push', skipped: 'no origin' },
      { kind: 'settings', skipped: 'no origin' },
    ]);
  }
  // A --name that makes them differ clears the flag again.
  const fixed = plan(root, '--owner', 'o', '--name', 'b/app=app-b');
  assert.ok(step(repoOf(fixed, 'a/app'), 'create').commands);
  assert.ok(step(repoOf(fixed, 'b/app'), 'create').commands);
  assert.equal(repoOf(fixed, 'b/app').slug, 'o/app-b');
  // A repo whose slug comes from its origin is never flagged, also when another repo wants the same name.
  const origin = ws({ sameName: true, withOrigin: ['a/app'] });
  const o = plan(origin.root, '--owner', 'o');
  assert.deepEqual(step(repoOf(o, 'a/app'), 'create'), { kind: 'create', skipped: 'origin exists' });
  assert.deepEqual(step(repoOf(o, 'b/app'), 'create'), { kind: 'create', skipped: 'duplicate name' });
  // The docs repo counts too.
  const docs = ws({ visibility: { 'shop/api': 'private' } });
  const d = plan(docs.root, '--owner', 'o', '--docs', '--name', 'shop/api=shop-docs');
  assert.deepEqual(step(repoOf(d, 'shop/api'), 'create'), { kind: 'create', skipped: 'duplicate name' });
  assert.deepEqual(d.docs.steps, [{ kind: 'create', skipped: 'duplicate name' }]);
});
