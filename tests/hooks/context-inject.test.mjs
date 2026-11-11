import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

const KEYWORDS = {
  'deploy\\w*|release': 'Before a deploy: /deploy-gate.',
  'ship\\w*': 'Before a deploy: /deploy-gate.',
  '([': 'broken pattern',
};
const prompt = (root, text) =>
  runHook('prompt', { session_id: 'ci-ctx', hook_event_name: 'UserPromptSubmit', prompt: text, cwd: root });

test('adds the hint when a keyword matches, without duplicates', () => {
  const root = makeWorkspace({ keywords: KEYWORDS });
  const res = prompt(root, 'Can we ship the Deployment today?');
  assert.equal(res.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(res.json.hookSpecificOutput.additionalContext, 'Before a deploy: /deploy-gate.');
});

test('stays silent without a keyword and survives an invalid regex', () => {
  const root = makeWorkspace({ keywords: KEYWORDS });
  const res = prompt(root, 'Please fix the typo in the footer.');
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('stays silent without keywords or without a prompt', () => {
  assert.equal(prompt(makeWorkspace(), 'deploy it').stdout, '');
  assert.equal(prompt(makeWorkspace({ keywords: KEYWORDS }), '').stdout, '');
});

test('hooks.disabled switches the hint off', () => {
  const root = makeWorkspace({ keywords: KEYWORDS, hooks: { disabled: ['context-inject'] } });
  assert.equal(prompt(root, 'deploy now').stdout, '');
});
