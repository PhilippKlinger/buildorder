import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, commitAll, gitIn, tempDir, write } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { fakeSecret, gitInit, makeWorkspace } from '../helpers/workspace.mjs';

after(cleanup);

function commit(command, { cwd, env, tool = 'Bash' } = {}) {
  const input = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } };
  if (cwd !== undefined) input.cwd = cwd;
  return runHook('secret', input, { cwd, env });
}

function assertDeny(res) {
  assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout);
  return res.json.hookSpecificOutput.permissionDecisionReason;
}

const assertSilent = (res) => assert.equal(res.stdout, '');

/** A workspace with a repo `app/` holding the given files, staged. */
function staged(files) {
  const root = makeWorkspace();
  const app = join(root, 'app');
  write(app, files);
  gitIn(app, 'add', '-A');
  return { root, app };
}

const awsLine = () => `const k = '${fakeSecret('aws')}';\n`;

test('denies a staged AWS key and masks it', () => {
  const key = fakeSecret('aws');
  const { app } = staged({ 'src/a.js': `const a = 1;\nconst b = 2;\nconst k = '${key}';\n` });
  const text = assertDeny(commit('git commit -m x', { cwd: app }));
  assert.match(text, /src\/a\.js:3 AWS Access Key AKIA\.\.\./);
  assert.ok(!text.includes(key));
});

test('denies a staged .env file by name', () => {
  const { app } = staged({ '.env': 'PORT=3000\n' });
  assert.match(assertDeny(commit('git commit -m x', { cwd: app })), /\.env/);
});

test('denies a Django SECRET_KEY', () => {
  const { app } = staged({ 'settings.py': `SECRET_KEY = '${fakeSecret('django')}'\n` });
  assert.match(assertDeny(commit('git commit -m x', { cwd: app })), /settings\.py:1 Django SECRET_KEY/);
});

test('denies a quoted JSON password', () => {
  const { app } = staged({ 'config.json': `{\n  "password": "${fakeSecret('password')}"\n}\n` });
  assert.match(assertDeny(commit('git commit -m x', { cwd: app })), /config\.json:2 Password/);
});

test('allows clean code, placeholders and environment lookups', () => {
  const { app } = staged({
    'a.py': "SECRET_KEY = os.getenv('DJANGO_SECRET_KEY')\npassword = \"change-me-please\"\n",
    'b.js': 'const t = process.env.GITHUB_TOKEN;\nconsole.log("hi");\n',
  });
  assertSilent(commit('git commit -m x', { cwd: app }));
});

test('allows .env.example', () => {
  const { app } = staged({ '.env.example': 'PORT=3000\n' });
  assertSilent(commit('git commit -m x', { cwd: app }));
});

test('removing a secret line is not a finding, only added lines count', () => {
  const root = makeWorkspace();
  const app = join(root, 'app');
  write(app, { 'a.js': awsLine() });
  commitAll(app);
  write(app, { 'a.js': 'const k = process.env.K;\n' });
  gitIn(app, 'add', '-A');
  assertSilent(commit('git commit -m x', { cwd: app }));
});

test('ignores other git commands', () => {
  const { app } = staged({ 'a.js': awsLine() });
  assertSilent(commit('git status', { cwd: app }));
  assertSilent(commit('git add -A', { cwd: app }));
});

test('git -C with a path containing spaces', () => {
  const root = makeWorkspace({ repos: [{ path: 'my app' }] });
  const dir = join(root, 'my app');
  gitInit(dir);
  write(dir, { 'a.js': awsLine() });
  gitIn(dir, 'add', '-A');
  assertDeny(commit(`git -C "${dir}" commit -m x`, { cwd: root }));
});

test('a leading cd decides the repo', () => {
  const { root } = staged({ 'a.js': awsLine() });
  assertDeny(commit('cd app && git commit -m x', { cwd: root }));
});


/** A workspace whose repo `app/` has one commit and the given files untracked on top of it. */
function untracked(files) {
  const root = makeWorkspace();
  const app = join(root, 'app');
  write(app, { 'keep.js': 'const a = 1;\n' });
  commitAll(app);
  write(app, files);
  return { root, app };
}

const UNTRACKED_NOTE = /\(untracked, git add may pick it up\)/;

test('git add before the commit: untracked files are scanned, since the add may pick them up', () => {
  const { root, app } = untracked({ 'src/config.js': awsLine() });
  const cases = [
    ['git add src/config.js && git commit -m x', app, 'Bash'],
    ['git add -A && git commit -m x', app, 'Bash'],
    ['cd app && git add . && git commit -m x', root, 'Bash'],
    ['git add -A; git commit -m x', app, 'PowerShell'],
  ];
  for (const [command, cwd, tool] of cases) {
    const text = assertDeny(commit(command, { cwd, tool }));
    assert.match(text, /- src\/config\.js:1 AWS Access Key AKIA\.\.\. \(untracked, git add may pick it up\)\n/, command);
    assert.match(text, /untracked files/, command);
    assert.ok(!text.includes(fakeSecret('aws')), command);
  }
});

test('git add before the commit: an untracked secret file is caught by name', () => {
  const { app } = untracked({ '.env': 'A=1\n' });
  const text = assertDeny(commit('git add -A && git commit -m x', { cwd: app }));
  assert.match(text, /- \.env is a secret file \(never commit it\) \(untracked, git add may pick it up\)/);
});

test('git add before the commit: untracked files of the whole repo count, not only below the folder', () => {
  const { app } = untracked({ 'other/a.js': awsLine(), 'sub/b.js': 'const k = 1;\n' });
  const text = assertDeny(commit('git add -A && git commit -m x', { cwd: join(app, 'sub') }));
  assert.match(text, /- other\/a\.js:1 AWS Access Key/);
});

test('git add before the commit: untracked UTF-16 files are scanned', () => {
  const { app } = untracked({});
  const body = awsLine();
  writeFileSync(join(app, 'u16le.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
  writeFileSync(join(app, 'bare16.txt'), Buffer.from(body, 'utf16le'));
  const text = assertDeny(commit('git add -A && git commit -m x', { cwd: app }));
  assert.match(text, /u16le\.txt:1 AWS Access Key/);
  assert.match(text, /bare16\.txt:1 AWS Access Key/);
});

test('git add before the commit: untracked files over the size budget are denied, not skipped', () => {
  const { app } = untracked({});
  writeFileSync(join(app, 'big.bin'), Buffer.alloc(33 * 1024 * 1024));
  assert.match(assertDeny(commit('git add -A && git commit -m x', { cwd: app })), /too large to check/);
});

test('without a git add first, untracked files are not part of the commit and not scanned', () => {
  const { app } = untracked({ 'src/config.js': awsLine(), '.env': 'A=1\n' });
  assertSilent(commit('git commit -m x', { cwd: app }));
  assertSilent(commit('git commit -am x', { cwd: app }));
});

test('git add before the commit: ignored and clean untracked files pass', () => {
  const root = makeWorkspace();
  const app = join(root, 'app');
  write(app, { '.gitignore': 'secret.js\n.env\n' });
  commitAll(app);
  write(app, { 'secret.js': awsLine(), '.env': 'A=1\n', 'clean.js': 'const t = process.env.TOKEN;\n' });
  assertSilent(commit('git add -A && git commit -m x', { cwd: app }));
});

test('unstaged changes of tracked files are checked on every commit (-a, -am, pathspec, plain)', () => {
  const root = makeWorkspace();
  const app = join(root, 'app');
  write(app, { 'a.js': 'const k = 1;\n' });
  commitAll(app);
  write(app, { 'a.js': awsLine() });
  for (const args of ['-m x', '-a -m x', '-am x', '--all -m x', '-va', 'a.js -m x', '--only a.js -m x', '-i a.js -m x']) {
    const text = assertDeny(commit(`git commit ${args}`, { cwd: app }));
    assert.match(text, /a\.js:1 AWS Access Key/, args);
    assert.match(text, /staged or unstaged/, args);
  }
});

test('a tracked .env that is modified is caught', () => {
  const root = makeWorkspace();
  const app = join(root, 'app');
  write(app, { '.env': 'A=1\n' });
  commitAll(app);
  write(app, { '.env': 'A=2\n' });
  assert.match(assertDeny(commit('git commit -am x', { cwd: app })), /\.env/);
});

test('scans UTF-16 files and files marked -diff in .gitattributes', () => {
  const root = makeWorkspace();
  const app = join(root, 'app');
  const body = awsLine();
  writeFileSync(join(app, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
  write(app, { '.gitattributes': '*.dat -diff\n', 'b.dat': body });
  gitIn(app, 'add', '-A');
  const text = assertDeny(commit('git commit -m x', { cwd: app }));
  assert.match(text, /b\.dat:1 AWS Access Key/);
  assert.match(text, /u16\.txt:\d+ AWS Access Key/);
});

test('diff.relative in the user config does not hide changes outside the folder', () => {
  const { app } = staged({ 'other/a.js': awsLine(), 'sub/b.js': 'const k = 1;\n' });
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.relative', GIT_CONFIG_VALUE_0: 'true' };
  assert.match(assertDeny(commit('git commit -m x', { cwd: join(app, 'sub'), env })), /other\/a\.js:1 AWS/);
});

test('a finding in a file whose name has a space is reported cleanly', () => {
  const { app } = staged({ 'my dir/a b.js': awsLine() });
  assert.match(assertDeny(commit('git commit -m x', { cwd: app })), /- my dir\/a b\.js:1 AWS Access Key AKIA\.\.\.\n/);
});

test('started in repo: cwd and CLAUDE_PROJECT_DIR are the repo, still denies', () => {
  const { app } = staged({ 'a.js': awsLine() });
  assertDeny(commit('git commit -m x', { cwd: app, env: { CLAUDE_PROJECT_DIR: app } }));
});

test('repo outside any workspace is silent', () => {
  const root = makeWorkspace();
  const other = gitInit(tempDir('other'));
  write(other, { 'a.js': awsLine() });
  gitIn(other, 'add', '-A');
  assertSilent(commit('git commit -m x', { cwd: other }));
});

test('an unclear target is denied with the hint', () => {
  const { app } = staged({ 'a.js': 'const k = 1;\n' });
  const text = assertDeny(commit('GIT_DIR=x git commit -m x', { cwd: app }));
  assert.match(text, /git -C <path> commit -m/);
  assert.match(text, /-F <file>/);
});

test('fails closed when the diff cannot be read', () => {
  const root = makeWorkspace();
  const plain = join(root, 'plain');
  mkdirSync(plain, { recursive: true });
  assert.match(assertDeny(commit('git commit -m x', { cwd: plain })), /could not be read/);
});

test('reports at most 10 findings and says how many were left out', () => {
  const lines = Array.from({ length: 13 }, (_, i) => `const k${i} = '${fakeSecret('aws')}';`).join('\n');
  const { app } = staged({ 'a.js': lines + '\n' });
  const text = assertDeny(commit('git commit -m x', { cwd: app }));
  assert.equal(text.match(/a\.js:\d+ AWS Access Key/g).length, 10);
  assert.match(text, /3 more/);
  assert.ok(!text.includes(fakeSecret('aws')));
});

test('file names with spaces and non-ASCII characters are reported as they are', () => {
  const dir = 'my dir/' + String.fromCharCode(0xe4);
  const { app } = staged({ [dir + '/.env']: 'A=1\n' });
  assert.ok(assertDeny(commit('git commit -m x', { cwd: app })).includes(dir + '/.env'));
});
