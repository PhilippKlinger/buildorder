import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, tmp, write } from '../helpers/cli.mjs';

after(cleanup);

const WS = ['.claude', 'workspace.json'];

/** A scaffolded workspace with one code repo `app`. */
function workspace(label) {
  const dir = tmp(label);
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  const r = cli('scaffold', dir);
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

const readWs = (dir) => JSON.parse(readFileSync(join(dir, ...WS), 'utf8'));
const writeWs = (dir, ws) => writeFileSync(join(dir, ...WS), JSON.stringify(ws, null, 2) + '\n');
function editWs(dir, change) {
  const ws = readWs(dir);
  change(ws);
  writeWs(dir, ws);
}

function verify(dir) {
  const r = cli('verify', dir);
  assert.equal(r.stderr, '');
  assert.ok(r.json, r.stdout);
  assert.equal(r.status, r.json.ok ? 0 : 1, 'exit code follows ok');
  return r.json;
}

function assertProblems(dir, problems) {
  const out = verify(dir);
  assert.equal(out.ok, false);
  assert.deepEqual(out.problems, problems);
}

test('a scaffolded workspace is ok', () => {
  const dir = workspace('verify ok');
  assert.deepEqual(verify(dir), { ok: true, dir, problems: [] });
});

test('workspace.json missing, invalid or of another schema', () => {
  const dir = tmp('verify no ws');
  assertProblems(dir, ['no .claude/workspace.json']);

  write(dir, { '.claude/workspace.json': '{ nope' });
  assertProblems(dir, ['.claude/workspace.json is not valid JSON']);

  write(dir, { '.claude/workspace.json': '{ "schemaVersion": 2 }' });
  assertProblems(dir, ['.claude/workspace.json: schemaVersion must be 1']);
});

test('every doc-map file must be set and present', () => {
  const dir = workspace('verify docs');
  rmSync(join(dir, 'BACKLOG.md'));
  editWs(dir, (ws) => { delete ws.docs.sprint; });
  assertProblems(dir, ['docs.sprint is not set', 'BACKLOG.md is missing']);
});

test('every repo must exist and be a git repo', () => {
  const dir = workspace('verify repos');
  mkdirSync(join(dir, 'plain'));
  editWs(dir, (ws) => { ws.repos.push({ path: 'gone' }, { path: 'plain' }); });
  assertProblems(dir, ['repo gone does not exist', 'repo plain is not a git repo']);
});

test('no doc-map control file inside a code repo', () => {
  const dir = workspace('verify boundary');
  write(join(dir, 'app'), { 'SPRINT.md': '', 'docs/HANDOFF.md': '', 'src/DECISIONS.md': '' });
  assertProblems(dir, [
    'app/SPRINT.md is a doc-map control file inside a code repo',
    'app/docs/HANDOFF.md is a doc-map control file inside a code repo',
  ]);
});

test('guards.docsOnlyNames must be set', () => {
  const dir = workspace('verify guards');
  editWs(dir, (ws) => { ws.guards.docsOnlyNames = []; });
  assertProblems(dir, ['guards.docsOnlyNames is not set']);
  editWs(dir, (ws) => { delete ws.guards; });
  assertProblems(dir, ['guards.docsOnlyNames is not set']);
});
