// End to end: a code repo becomes a workspace (nest, scaffold, verify, finalize), and the
// plugin's boundary-guard recognises the new workspace.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, gitIn, tmp, write } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { fakeSecret } from '../helpers/workspace.mjs';

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

const commitIn = (command, cwd) => runHook('secret', {
  session_id: 'e2e', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd,
}, { cwd });
const decision = (res) => res.json?.hookSpecificOutput?.permissionDecision;

test('the root is the docs repo with the code repo ignored: verify, status and both guards still hold', () => {
  const root = tmp('e2e root repo');
  const repo = codeRepo(null, undefined, { dir: join(root, 'app') });
  ok('scaffold', root, '--lang', 'en');
  assert.equal(realpathSync.native(gitIn(root, 'rev-parse', '--show-toplevel')), realpathSync.native(root));
  assert.equal(gitIn(root, 'check-ignore', 'app'), 'app', 'the code repo is gitignored in the docs repo');
  assert.deepEqual(ok('verify', root), { ok: true, dir: root, problems: [], warnings: [] });

  const docs = ok('status', root, '--json').places.find((p) => p.path === '.');
  assert.equal(docs.state, 'ok', 'kickoff gets no "not a git repo" warning for the docs root');
  assert.equal(docs.branch, 'main');
  assert.doesNotMatch(cli('status', root).stdout, /not a git repo/);

  for (const cwd of [root, repo]) {
    assert.equal(decision(writeTo(join(repo, 'SPRINT.md'), cwd)), 'deny', `boundary-guard, started in ${cwd}`);
    assert.equal(writeTo(join(root, 'SPRINT.md'), cwd).stdout, '');
  }

  // secret-guard scans the repo the commit runs in: the ignored code repo never leaks into a docs commit.
  write(repo, { 'src/key.js': `const k = '${fakeSecret('aws')}';\n` });
  assert.equal(commitIn('git add -A && git commit -m "docs: start"', root).stdout, '', 'docs commit stays clean');
  assert.equal(decision(commitIn('git add -A && git commit -m x', repo)), 'deny', 'the code repo is still scanned');
  write(root, { 'notes.md': `aws: ${fakeSecret('aws')}\n` });
  gitIn(root, 'add', 'notes.md');
  assert.equal(decision(commitIn('git commit -m "docs: notes"', root)), 'deny', 'the docs repo is scanned before its first commit');
});
