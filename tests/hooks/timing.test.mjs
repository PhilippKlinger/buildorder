// AK-5: wall time per hook entry point. Runs only with BUILDORDER_TIMING=1 (own CI step, no parallel load).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, tempDir } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

const RUNS = 9;
// AK-5: limits are margins over the baseline measured in the same run (relative-limit decision), not absolute times.
const OUTSIDE_MARGIN_MS = 25;
const INSIDE_MARGIN_MS = 150;
const session = 'ci-timing';

after(() => {
  cleanup();
  for (const f of [`effort-${session}`, `handoff-${session}`]) rmSync(join(tmpdir(), 'buildorder', f), { force: true });
});

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (ms) => ms.toFixed(1);

function inputFor(entry, cwd, file) {
  const base = { session_id: session, cwd };
  switch (entry) {
    case 'boundary':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } };
    case 'secret':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } };
    case 'prompt':
      return { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'The app has a crash', effort: { level: 'low' } };
    case 'compact':
      return { ...base, hook_event_name: 'SessionStart', source: 'compact' };
    case 'stop':
      return { ...base, hook_event_name: 'Stop', stop_hook_active: false };
  }
}

function nodeStartMs() {
  const started = process.hrtime.bigint();
  spawnSync(process.execPath, ['-e', '']);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

// Baseline and hook alternate, so load drift on shared runners (macOS) hits both alike;
// one unmeasured pair warms the file cache first.
function measure(entry, cwd, file) {
  const input = inputFor(entry, cwd, file);
  nodeStartMs();
  runHook(entry, input, { cwd });
  const base = [];
  const hook = [];
  for (let i = 0; i < RUNS; i++) {
    base.push(nodeStartMs());
    hook.push(runHook(entry, input, { cwd }).ms);
  }
  return { base: median(base), hook: median(hook) };
}

const skip = process.env.BUILDORDER_TIMING === '1' ? false : 'timing test runs only with BUILDORDER_TIMING=1 (needs an unloaded machine)';

test('hook wall time stays within the AK-5 limits per entry', { skip }, (t) => {
  const outside = tempDir('out');
  const root = makeWorkspace();
  const app = join(root, 'app');

  const failures = [];
  const check = (entry, where, cwd, margin) => {
    const { base, hook } = measure(entry, cwd, join(cwd, 'src', 'a.js'));
    const limit = base + margin;
    t.diagnostic(`${entry} ${where}: ${fmt(hook)} ms (baseline node -e "" ${fmt(base)} ms, limit ${fmt(limit)})`);
    if (!(hook < limit)) failures.push(`${entry} ${where} median ${fmt(hook)} ms >= ${fmt(limit)} ms`);
  };
  for (const entry of ['boundary', 'secret', 'prompt', 'compact', 'stop']) {
    check(entry, 'outside', outside, OUTSIDE_MARGIN_MS);
    check(entry, 'inside', app, INSIDE_MARGIN_MS);
  }
  assert.deepEqual(failures, []);
});
