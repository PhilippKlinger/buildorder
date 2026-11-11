import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot } from '../helpers/repo.mjs';
import { cli, codeRepo, commitAll, fakeHome, gitIn, gitInit, tmp, write } from '../helpers/cli.mjs';

const VERSION = JSON.parse(readFileSync(join(repoRoot, 'plugins', 'buildorder', '.claude-plugin', 'plugin.json'), 'utf8')).version;

function detect(dir, opts) {
  const r = cli('detect', dir, ...(opts ? [opts] : []));
  assert.equal(r.status, 0, r.stderr);
  return r.json;
}

const byPath = (d) => Object.fromEntries(d.repos.map((r) => [r.path, r]));
const angular = JSON.stringify({ dependencies: { '@angular/core': '^20' } });

test('empty folder suggests new', () => {
  const dir = tmp('empty');
  const d = detect(dir);
  assert.equal(d.dir, dir);
  assert.equal(d.buildorderVersion, VERSION);
  assert.equal(d.isEmpty, true);
  assert.equal(d.rootIsRepo, false);
  assert.deepEqual(d.existingSetup, []);
  assert.equal(d.blockedReason, null);
  assert.equal(d.workspace, null);
  assert.deepEqual(d.repos, []);
  assert.equal(d.workspaceProposal, null);
  assert.equal(d.suggestion, 'new');
  assert.deepEqual(d.skills, { personal: [], project: [] });
});

test('folder of repos suggests multi-repo', () => {
  const dir = tmp('repos');
  codeRepo(null, {
    'manage.py': '',
    'requirements.txt': 'Django==5.2\n',
    'Dockerfile': 'FROM python\n',
    'compose.yml': 'services:\n  db:\n    image: postgres:17\n',
    'tests/test_api.py': 'def test_x():\n    pass\n',
    '.github/workflows/ci.yml': 'on: push\n',
    '.github/workflows/release.yaml': 'on: push\n',
    '.github/workflows/notes.md': '',
  }, { dir: join(dir, 'shop', 'api') });
  codeRepo(null, { 'package.json': angular, 'angular.json': '{}' }, { dir: join(dir, 'shop', 'web') });
  const d = detect(dir);
  assert.equal(d.suggestion, 'multi-repo');
  assert.equal(d.isEmpty, false);
  const repos = byPath(d);
  assert.deepEqual(Object.keys(repos).sort(), ['shop/api', 'shop/web']);
  const api = repos['shop/api'];
  assert.deepEqual(api.stacks, ['django', 'docker', 'postgres', 'github-actions']);
  assert.deepEqual(api.unsupported, []);
  assert.deepEqual(api.deploy, { target: 'container', evidence: ['Dockerfile', 'compose.yml'] });
  assert.deepEqual(api.workflows, ['ci.yml', 'release.yaml']);
  assert.equal(api.hasTests, true);
  assert.deepEqual(api.docker, { dockerfile: true, compose: true });
  const web = repos['shop/web'];
  assert.deepEqual(web.stacks, ['angular']);
  assert.deepEqual(web.workflows, []);
  assert.equal(web.hasTests, false);
  assert.deepEqual(web.docker, { dockerfile: false, compose: false });
  assert.deepEqual(Object.keys(web).sort(),
    ['ahead', 'branch', 'deploy', 'dirty', 'docker', 'hasTests', 'path', 'remote', 'stacks', 'unsupported', 'workflows']);
});

test('single nested repo suggests existing', () => {
  // The parent is a git repo too, but its only own file is a loose script: it holds a repo, it is not one.
  const dir = tmp('parent');
  gitInit(dir);
  write(dir, { 'scripts/helper.py': 'print(1)\n' });
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  const d = detect(dir);
  assert.equal(d.rootIsRepo, true);
  assert.equal(d.suggestion, 'existing');
  assert.equal(d.workspaceProposal, null);
  assert.deepEqual(d.repos.map((r) => r.path), ['app']);
});

test('root is a repo suggests repo-root with sibling proposal', () => {
  const dir = codeRepo('site');
  write(dir, { 'send_mail.php': '<?php // untracked\n' });
  const d = detect(dir);
  assert.equal(d.suggestion, 'repo-root');
  assert.equal(d.rootIsRepo, true);
  assert.deepEqual(d.repos, []);
  assert.deepEqual(d.workspaceProposal, {
    dir: join(dirname(dir), 'target dir-workspace'),
    repoPath: 'target dir',
    remote: null,
    dirty: 0,
    ahead: null,
    untracked: ['send_mail.php'],
    ignored: [],
    inPlace: { dir, repoPath: 'target dir', blockers: [] },
  });

  // The in-place name avoids an existing entry; a linked worktree blocks nesting.
  write(dir, { 'target dir/x.txt': '' });
  gitIn(dir, 'worktree', 'add', '-q', '-b', 'wt', join(dirname(dir), 'wt'));
  const again = detect(dir).workspaceProposal.inPlace;
  assert.equal(again.repoPath, 'target dir-repo');
  assert.equal(again.blockers.length, 1);
  assert.match(again.blockers[0], /worktree/);
});

test('untracked and ignored files are listed without noise', () => {
  const dir = codeRepo('noise');
  write(dir, {
    'CLAUDE.md': '# old notes\n',
    '.gitignore': '.env\nnode_modules/\ndb.sqlite3\n.pytest_cache/\n',
    '.env': 'KEY=x\n',
    'db.sqlite3': '',
    'node_modules/pkg/index.js': '',
    '.pytest_cache/v/x': '',
    'notes draft.txt': 'x\n',
    'src/main.ts': 'console.log(2);\n',
  });
  const d = detect(dir);
  assert.equal(d.suggestion, 'repo-root', 'a code repo wins over an old CLAUDE.md');
  assert.deepEqual(d.existingSetup, ['CLAUDE.md']);
  const p = d.workspaceProposal;
  assert.equal(p.dirty, 1);
  assert.deepEqual([...p.untracked].sort(), ['.gitignore', 'CLAUDE.md', 'notes draft.txt']);
  assert.deepEqual([...p.ignored].sort(), ['.env', 'db.sqlite3']);
});

test('old workspace without schemaVersion is blocked', () => {
  const dir = tmp('old workspace');
  write(dir, { '.claude/workspace.json': JSON.stringify({ initPhase: 'done', profile: 'code-legacy' }) });
  const d = detect(dir);
  assert.equal(d.workspace, 'invalid');
  assert.equal(d.blockedReason, 'foreign-workspace');
  assert.equal(d.suggestion, 'blocked');

  for (const content of ['{ not json', JSON.stringify({ schemaVersion: 2 }), '[]']) {
    write(dir, { '.claude/workspace.json': content });
    assert.equal(detect(dir).blockedReason, 'foreign-workspace', content);
  }

  // A foreign workspace blocks even inside a code repo, and no proposal is made.
  const repo = codeRepo('old workspace repo');
  write(repo, { '.claude/workspace.json': '{}' });
  const r = detect(repo);
  assert.equal(r.suggestion, 'blocked');
  assert.equal(r.workspaceProposal, null);
});

test('buildorder workspace suggests resume', () => {
  const dir = tmp('resume');
  write(dir, { '.claude/workspace.json': JSON.stringify({ schemaVersion: 1, initPhase: 'interview', profile: 'existing', extra: 1 }) });
  const d = detect(dir);
  assert.deepEqual(d.workspace, { schemaVersion: 1, initPhase: 'interview', profile: 'existing' });
  assert.equal(d.blockedReason, null);
  assert.equal(d.suggestion, 'resume');
  assert.deepEqual(d.existingSetup, ['.claude']);
});

test('other agent setup blocks', () => {
  const dir = tmp('agents');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  assert.equal(detect(dir).suggestion, 'existing');
  write(dir, { 'AGENTS.md': '# agents\n', '.cursor/rules': '', 'CLAUDE.md': '# mine\n' });
  const d = detect(dir);
  assert.equal(d.suggestion, 'blocked');
  assert.equal(d.blockedReason, 'agent-setup');
  assert.deepEqual(d.existingSetup, ['CLAUDE.md', 'AGENTS.md', '.cursor']);
  assert.equal(d.workspace, null);
});

test('docs-only git repo is not code', () => {
  const dir = tmp('notes');
  gitInit(dir);
  write(dir, { 'contract.pdf': '%PDF', 'README.md': '# notes\n', 'docs/plan.md': '' });
  const d = detect(dir);
  assert.equal(d.rootIsRepo, true);
  assert.equal(d.suggestion, 'new');
  assert.equal(d.workspaceProposal, null);

  // A nested docs-only repo is no code repo either and is not listed.
  const parent = tmp('docs nested');
  codeRepo(null, { 'README.md': '# docs\n', 'guide.txt': '' }, { dir: join(parent, 'docs') });
  codeRepo(null, undefined, { dir: join(parent, 'app') });
  const p = detect(parent);
  assert.deepEqual(p.repos.map((r) => r.path), ['app']);
  assert.equal(p.suggestion, 'existing');
});

test('branch, dirty and ahead per repo', () => {
  const dir = tmp('state');
  const app = codeRepo(null, undefined, { dir: join(dir, 'app') });
  const remote = join(dir, '..', 'origin.git');
  gitIn(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  gitIn(app, 'remote', 'add', 'origin', remote);
  gitIn(app, 'push', '-q', '-u', 'origin', 'main');
  write(app, { 'src/extra.ts': 'export {};\n' });
  commitAll(app, 'extra');
  write(app, { 'wip.txt': 'x\n', 'src/main.ts': 'console.log(3);\n' });

  const api = codeRepo(null, { 'go.mod': 'module api\n' }, { dir: join(dir, 'api') });
  gitIn(api, 'checkout', '-q', '-b', 'feature/x');

  const repos = byPath(detect(dir));
  assert.equal(repos.app.branch, 'main');
  assert.equal(repos.app.dirty, 2, 'one modified, one untracked');
  assert.equal(repos.app.ahead, 1);
  assert.equal(repos.app.remote, remote);
  assert.equal(repos.api.branch, 'feature/x');
  assert.equal(repos.api.dirty, 0);
  assert.equal(repos.api.ahead, null, 'no upstream configured');
  assert.equal(repos.api.remote, null);
});

test('personal and project skills are listed with descriptions', () => {
  const home = fakeHome();
  write(home, {
    '.claude/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: "Plans a feature: asks first."\n---\n# Alpha\n',
    '.claude/skills/beta/SKILL.md': String.fromCharCode(0xFEFF) + '---\r\nname: \'beta\'\r\ndescription: Reviews code\r\n---\r\nbody\r\n',
    '.claude/skills/broken/SKILL.md': '# no frontmatter\n',
    '.claude/skills/nameless/SKILL.md': '---\ndescription: no name\n---\n',
    '.claude/skills/unclosed/SKILL.md': '---\nname: unclosed\n',
    '.claude/skills/empty/README.md': '',
  });
  const dir = tmp('skills');
  write(dir, { '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ships it\nallowed-tools: Bash\n---\n' });
  const d = detect(dir, { home });
  assert.deepEqual(d.skills.personal, [
    { name: 'alpha', description: 'Plans a feature: asks first.', path: join(home, '.claude', 'skills', 'alpha', 'SKILL.md') },
    { name: 'beta', description: 'Reviews code', path: join(home, '.claude', 'skills', 'beta', 'SKILL.md') },
  ]);
  assert.deepEqual(d.skills.project, [
    { name: 'deploy', description: 'Ships it', path: join(dir, '.claude', 'skills', 'deploy', 'SKILL.md') },
  ]);
});

test('unsupported stack is reported, not guessed', () => {
  const dir = tmp('unsupported');
  codeRepo(null, { 'package.json': JSON.stringify({ dependencies: { vue: '^3' } }), 'src/main.js': '' }, { dir: join(dir, 'web') });
  const d = detect(dir);
  const [web] = d.repos;
  assert.equal(web.path, 'web');
  assert.deepEqual(web.stacks, []);
  assert.deepEqual(web.unsupported, ['vue']);
  assert.deepEqual(web.deploy, { target: 'unknown', evidence: [] });
  assert.equal(d.suggestion, 'existing');
});

test('unknown command and missing folder fail with a short message', () => {
  const bad = cli('nope');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^buildorder: unknown command: nope/);
  assert.doesNotMatch(bad.stderr, /\n\s+at /, 'no stack trace');

  const missing = cli('detect', join(tmp('missing'), 'gone'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^buildorder: not a folder: /);
  assert.equal(missing.stdout, '');

  const file = join(tmp('file'), 'a.txt');
  writeFileSync(file, '');
  assert.equal(cli('detect', file).status, 1);
  mkdirSync(join(dirname(file), 'ok'));
  assert.equal(cli('detect', join(dirname(file), 'ok')).status, 0);
});
