import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

const start = (root, source) =>
  runHook('compact', { session_id: 'ci-compact', hook_event_name: 'SessionStart', source, cwd: root });

test('injects the re-sync instruction after compaction', () => {
  const root = makeWorkspace({ docs: { handoff: 'HAND.md', sprint: 'PLAN.md' } });
  const out = start(root, 'compact').json.hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  assert.equal(
    out.additionalContext,
    'Context was compacted. Before continuing, summarize the current state in 3\u20135 lines from HAND.md and PLAN.md, ' +
      'then ask the user whether to continue.',
  );
});

test('stays silent on a normal start', () => {
  const root = makeWorkspace();
  assert.equal(start(root, 'startup').stdout, '');
  assert.equal(start(root, undefined).stdout, '');
});

test('falls back to the default doc names', () => {
  const root = makeWorkspace({ docs: {} });
  assert.match(start(root, 'compact').json.hookSpecificOutput.additionalContext, /HANDOFF\.md and SPRINT\.md/);
});
