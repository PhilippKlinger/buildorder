import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cleanup } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

const GUARDS = { docsOnlyNames: ['CLAUDE.md', 'SPRINT.md', 'HANDOFF.md'], protectedPaths: ['originals/**'] };
const MSG = (name, repo) =>
  `${name} is a workspace control file and belongs in the workspace root, not in the code repo ${repo}.`;

function write(file, { cwd, env, tool = 'Write' } = {}) {
  const input = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file } };
  if (cwd !== undefined) input.cwd = cwd;
  return runHook('boundary', input, { cwd, env });
}

function assertDeny(res, reason) {
  assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout);
  if (reason !== undefined) assert.equal(res.json.hookSpecificOutput.permissionDecisionReason, reason);
}

const assertSilent = (res) => assert.equal(res.stdout, '');

test('denies a control file at repo root', () => {
  const root = makeWorkspace({ guards: GUARDS });
  assertDeny(write(join(root, 'app', 'SPRINT.md'), { cwd: root }), MSG('SPRINT.md', 'app'));
});

test('denies it in <repo>/docs/', () => {
  const root = makeWorkspace({ guards: GUARDS });
  assertDeny(write(join(root, 'app', 'docs', 'HANDOFF.md'), { cwd: root, tool: 'Edit' }), MSG('HANDOFF.md', 'app'));
});

test('allows root docs and code files', () => {
  const root = makeWorkspace({ guards: GUARDS });
  assertSilent(write(join(root, 'SPRINT.md'), { cwd: root }));
  assertSilent(write(join(root, 'docs', 'SPRINT.md'), { cwd: root }));
  assertSilent(write(join(root, 'app', 'src', 'index.js'), { cwd: root }));
  assertSilent(write(join(root, 'app', 'README.md'), { cwd: root }));
});

test('allows deeper files with the same name', () => {
  const root = makeWorkspace({ guards: GUARDS });
  assertSilent(write(join(root, 'app', 'templates', 'SPRINT.md'), { cwd: root }));
  assertSilent(write(join(root, 'app', 'docs', 'sub', 'CLAUDE.md'), { cwd: root }));
});

test('protects configured paths', () => {
  const root = makeWorkspace({ guards: GUARDS });
  const res = write(join(root, 'originals', 'scan.txt'), { cwd: root });
  assertDeny(res);
  assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /originals\/scan\.txt/);
  assertSilent(write(join(root, 'drafts', 'scan.txt'), { cwd: root }));
});

test('started in repo: cwd and CLAUDE_PROJECT_DIR are the repo, still denies', () => {
  const root = makeWorkspace({ guards: GUARDS });
  const app = join(root, 'app');
  assertDeny(write(join(app, 'CLAUDE.md'), { cwd: app, env: { CLAUDE_PROJECT_DIR: app } }), MSG('CLAUDE.md', 'app'));
});

test('windows path with backslashes, other drive case and spaces', { skip: process.platform !== 'win32' }, () => {
  const root = makeWorkspace({ guards: GUARDS, repos: [{ path: 'my app' }] });
  const swapped = root[0] === root[0].toUpperCase() ? root[0].toLowerCase() + root.slice(1) : root[0].toUpperCase() + root.slice(1);
  const file = join(swapped, 'my app', 'sprint.md').replaceAll('/', '\\');
  assertDeny(write(file, { cwd: root }), MSG('sprint.md', 'my app'));
});

test('relative file_path resolved against cwd', () => {
  const root = makeWorkspace({ guards: GUARDS });
  assertDeny(write('SPRINT.md', { cwd: join(root, 'app') }), MSG('SPRINT.md', 'app'));
  assertSilent(write('src/SPRINT.md', { cwd: join(root, 'app') }));
});

test('file outside any workspace is silent', () => {
  const root = makeWorkspace({ guards: GUARDS });
  assertSilent(write(join(root, '..', 'elsewhere-no-ws', 'SPRINT.md'), { cwd: join(root, '..') }));
});
