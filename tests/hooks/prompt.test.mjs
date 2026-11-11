import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanup } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

const session = `ci-${randomUUID()}`;
after(() => {
  cleanup();
  rmSync(join(tmpdir(), 'buildorder', `effort-${session}`), { force: true });
});

test('prompt runs both hints in one process', () => {
  const root = makeWorkspace({ keywords: { crash: 'Check the crash log first.' } });
  const res = runHook('prompt', {
    session_id: session, hook_event_name: 'UserPromptSubmit', prompt: 'The app has a crash', effort: { level: 'low' }, cwd: root,
  });
  assert.equal(
    res.json.hookSpecificOutput.additionalContext,
    'Check the crash log first.\nThis looks like debugging. Consider /effort high for this task.',
  );
});
