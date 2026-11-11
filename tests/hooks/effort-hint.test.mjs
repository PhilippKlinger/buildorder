import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanup } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

const stateFiles = [];
after(() => {
  cleanup();
  for (const f of stateFiles) rmSync(join(tmpdir(), 'buildorder', f), { force: true });
});

function ask(root, text, level, session = `ci-${randomUUID()}`) {
  stateFiles.push(`effort-${session.replace(/[^A-Za-z0-9_-]/g, '')}`);
  return runHook('prompt', {
    session_id: session, hook_event_name: 'UserPromptSubmit', prompt: text, effort: { level }, cwd: root,
  });
}
const context = (res) => res.json?.hookSpecificOutput?.additionalContext;

test('suggests /effort high for bug work on medium', () => {
  const res = ask(makeWorkspace(), 'The app has a crash when saving', 'medium');
  assert.equal(context(res), 'This looks like debugging. Consider /effort high for this task.');
});

test('understands German prompts with umlauts', () => {
  const root = makeWorkspace();
  assert.match(context(ask(root, 'Das ist ein Fehler im Login', 'low')), /debugging/);
  assert.match(context(ask(root, 'Eine Sicherheitsl\u00fccke im Upload', 'low')), /security/);
});

test('silent on high, without a matching topic, or outside a workspace', () => {
  const root = makeWorkspace();
  assert.equal(ask(root, 'Security review please', 'high').stdout, '');
  assert.equal(ask(root, 'Please reword the README', 'low').stdout, '');
  const outside = runHook('prompt', {
    session_id: 'ci-out', prompt: 'crash', effort: { level: 'medium' }, cwd: tmpdir(),
  });
  assert.equal(outside.stdout, '');
});

test('once per topic per session, a new topic still gets its hint', () => {
  const root = makeWorkspace();
  const session = `ci-${randomUUID()}`;
  assert.ok(ask(root, 'Bug in the login', 'medium', session).json);
  assert.equal(ask(root, 'another error in the login', 'medium', session).stdout, '');
  assert.match(context(ask(root, 'Prepare the release', 'medium', session)), /release/);
});

test('topics come from workspace.json effortHints when set', () => {
  const root = makeWorkspace({ effortHints: { migration: 'a data migration', '([': 'broken' } });
  assert.match(context(ask(root, 'The migration of the table', 'low')), /a data migration/);
  assert.equal(ask(root, 'Crash in the login', 'low').stdout, '', 'custom list replaces the defaults');
});

test('a hostile session id stays inside the state folder', () => {
  const res = ask(makeWorkspace(), 'crash', 'medium', '../../evil');
  assert.ok(res.json);
});

test('hooks.disabled switches the hint off', () => {
  const root = makeWorkspace({ hooks: { disabled: ['effort-hint'] } });
  assert.equal(ask(root, 'crash', 'medium').stdout, '');
});
