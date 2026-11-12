import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanup, commitAll, gitInit, write } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

const stateFiles = [];
after(() => {
  cleanup();
  for (const f of stateFiles) rmSync(join(tmpdir(), 'buildorder', f), { force: true });
});

function stop(root, extra = {}) {
  const session_id = extra.session_id ?? `ci-${randomUUID()}`;
  stateFiles.push(`handoff-${session_id}`);
  return runHook('stop', { hook_event_name: 'Stop', stop_hook_active: false, cwd: root, ...extra, session_id });
}

/** Writes `file` and commits it; `date` (ISO) fixes author and committer date so the order is exact. */
function commitFile(dir, file, text, date) {
  write(dir, { [file]: text });
  const keys = ['GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'];
  if (date) for (const k of keys) process.env[k] = date;
  try {
    commitAll(dir, `add ${file}`);
  } finally {
    for (const k of keys) delete process.env[k];
  }
}

/** The workspace root as a repo of its own; the nested code repo stays out of it. */
function initRoot(root) {
  gitInit(root);
  write(root, { '.gitignore': 'app/\n' });
}

test('reminds once per new commit when there is no handoff yet', () => {
  const root = makeWorkspace();
  initRoot(root);
  commitFile(root, 'BACKLOG.md', '# Backlog\n');
  const session_id = `ci-${randomUUID()}`;
  assert.equal(
    stop(root, { session_id }).json.systemMessage,
    'New commits since the last handoff (Docs). Before ending the session: /buildorder:handoff.',
  );
  assert.equal(stop(root, { session_id }).stdout, '', 'second stop in the same session stays quiet');
});

test('reminds when a code repo has commits newer than the handoff', () => {
  const root = makeWorkspace();
  initRoot(root);
  commitFile(root, 'HANDOFF.md', '# Handoff\n', '2020-01-01T00:00:00Z');
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(root, 'HANDOFF.md'), old, old);
  commitFile(join(root, 'app'), 'app.py', 'print(1)\n');
  assert.match(stop(root).json.systemMessage, /\(app\)/);
});

test('stays silent right after a committed handoff', () => {
  // /handoff writes the file first and commits a little later, so the handoff commit is newer
  // than the file's mtime. That commit must not trigger a reminder.
  const root = makeWorkspace();
  initRoot(root);
  commitFile(root, 'BACKLOG.md', '# Backlog\n', '2020-01-01T00:00:00Z');
  writeFileSync(join(root, 'HANDOFF.md'), '# Handoff\n');
  const written = new Date(Date.now() - 120_000);
  utimesSync(join(root, 'HANDOFF.md'), written, written);
  commitAll(root, 'docs: session handoff');
  assert.equal(stop(root).stdout, '');
});

test('never fires while a stop hook is already active', () => {
  const root = makeWorkspace();
  initRoot(root);
  commitFile(root, 'BACKLOG.md', '# Backlog\n');
  assert.equal(stop(root, { stop_hook_active: true }).stdout, '');
});

test('hooks.disabled switches the reminder off', () => {
  const root = makeWorkspace({ hooks: { disabled: ['handoff-reminder'] } });
  initRoot(root);
  commitFile(root, 'BACKLOG.md', '# Backlog\n');
  assert.equal(stop(root).stdout, '');
});

test('stays silent while init is running and right after it finished, but not for later commits', () => {
  const scaffolded = makeWorkspace({ initPhase: 'scaffolded' });
  initRoot(scaffolded);
  commitFile(join(scaffolded, 'app'), 'app.py', 'print(1)\n'); // init's own starter commit
  assert.equal(stop(scaffolded).stdout, '', 'init still running');

  const done = makeWorkspace({ initPhase: 'done' });
  initRoot(done);
  commitFile(join(done, 'app'), 'app.py', 'print(1)\n', '2020-01-01T00:00:00Z'); // before finalize wrote workspace.json
  assert.equal(stop(done).stdout, '', 'init just finished');

  const later = new Date(Date.now() - 120_000);
  utimesSync(join(done, '.claude', 'workspace.json'), later, later);
  commitFile(join(done, 'app'), 'more.py', 'print(2)\n'); // real work after init
  assert.match(stop(done).json.systemMessage, /\(app\)/);
});
