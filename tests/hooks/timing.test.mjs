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

function medianMs(entry, cwd, file) {
  const times = [];
  for (let i = 0; i < RUNS; i++) times.push(runHook(entry, inputFor(entry, cwd, file), { cwd }).ms);
  return median(times);
}

const skip = process.env.BUILDORDER_TIMING === '1' ? false : 'timing test runs only with BUILDORDER_TIMING=1 (needs an unloaded machine)';

test('hook wall time stays within the AK-5 limits per entry', { skip }, (t) => {
  const baseline = [];
  for (let i = 0; i < RUNS; i++) {
    const started = process.hrtime.bigint();
    spawnSync(process.execPath, ['-e', '']);
    baseline.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const base = median(baseline);
  const outsideLimit = base + OUTSIDE_MARGIN_MS;
  const insideLimit = base + INSIDE_MARGIN_MS;
  t.diagnostic(`baseline node -e "" median: ${fmt(base)} ms; limits outside ${fmt(outsideLimit)} ms, inside ${fmt(insideLimit)} ms`);

  const outside = tempDir('out');
  const root = makeWorkspace();
  const app = join(root, 'app');

  const failures = [];
  for (const entry of ['boundary', 'secret', 'prompt', 'compact', 'stop']) {
    const out = medianMs(entry, outside, join(outside, 'src', 'a.js'));
    const inn = medianMs(entry, app, join(app, 'src', 'a.js'));
    t.diagnostic(`${entry}: outside ${fmt(out)} ms (limit ${fmt(outsideLimit)}), inside ${fmt(inn)} ms (limit ${fmt(insideLimit)})`);
    if (!(out < outsideLimit)) failures.push(`${entry} outside median ${fmt(out)} ms >= ${fmt(outsideLimit)} ms`);
    if (!(inn < insideLimit)) failures.push(`${entry} inside median ${fmt(inn)} ms >= ${fmt(insideLimit)} ms`);
  }
  assert.deepEqual(failures, []);
});
