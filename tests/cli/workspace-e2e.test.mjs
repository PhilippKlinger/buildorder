// End to end: a code repo becomes a workspace (nest, scaffold, verify, finalize), and the
// plugin's boundary-guard recognises the new workspace.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cleanup, cli, codeRepo } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';

after(cleanup);

function ok(...args) {
  const r = cli(...args);
  assert.equal(r.status, 0, `${args[0]}: ${r.stderr}${r.stdout}`);
  return r.json;
}

const writeTo = (file, cwd) => runHook('boundary', {
  session_id: 'e2e', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file }, cwd,
}, { cwd });

test('nest, scaffold, verify, finalize; boundary-guard blocks SPRINT.md in the repo', () => {
  const root = codeRepo('e2e');
  const nested = ok('nest', root);
  assert.equal(nested.ok, true, nested.reason);
  const repo = join(root, nested.repoPath);

  ok('scaffold', root, '--lang', 'de');
  assert.deepEqual(ok('verify', root), { ok: true, dir: root, problems: [], warnings: [] });

  for (const cwd of [root, repo]) {
    const denied = writeTo(join(repo, 'SPRINT.md'), cwd);
    assert.equal(denied.json?.hookSpecificOutput?.permissionDecision, 'deny', `started in ${cwd}: ${denied.stdout}`);
    assert.equal(writeTo(join(root, 'SPRINT.md'), cwd).stdout, '', 'the workspace root is the home of SPRINT.md');
  }

  assert.equal(ok('finalize', root).initPhase, 'done');
});
