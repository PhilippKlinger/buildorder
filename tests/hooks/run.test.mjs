import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/repo.mjs';
import { cleanup, tempDir, write } from '../helpers/cli.mjs';
import { runHook } from '../helpers/hooks.mjs';
import { makeWorkspace } from '../helpers/workspace.mjs';
import { render, merge, MAX_CONTEXT } from '../../plugins/buildorder/hooks/output.mjs';

after(cleanup);

const PLUGIN = join(repoRoot, 'plugins', 'buildorder');
const ENTRIES = ['boundary', 'secret', 'prompt', 'compact', 'stop'];
const same = (a, b) => assert.equal(a.replace(/\\/g, '/').toLowerCase(), b.replace(/\\/g, '/').toLowerCase());

// Each stub reports what run.mjs handed it, in the result kind its real hook uses.
const STUB_KIND = {
  'boundary-guard': 'deny',
  'secret-guard': 'deny',
  'context-inject': 'context',
  'effort-hint': 'context',
  'compact-guard': 'context',
  'handoff-reminder': 'systemMessage',
};
const stubSource = (name, kind) =>
  `export default function run(input, { root, ws, startPath, startUnclear }) {\n` +
  `  return { ${kind}: JSON.stringify({ hook: '${name}', root, startPath, startUnclear, name: ws.name }) };\n}\n`;

/**
 * A copy of the plugin's run.mjs, output.mjs and lib/ with stub hook modules, so the entry point
 * is tested without the real guards. `overrides` maps a hook name to replacement module source;
 * `withoutOutput` leaves output.mjs out. Returns the path of the copied run.mjs.
 */
function stubPlugin(overrides = {}, { withoutOutput = false } = {}) {
  const dir = join(tempDir('plugin'), 'buildorder');
  cpSync(join(PLUGIN, 'lib'), join(dir, 'lib'), { recursive: true });
  const files = withoutOutput ? ['run.mjs'] : ['run.mjs', 'output.mjs'];
  for (const f of files) cpSync(join(PLUGIN, 'hooks', f), join(dir, 'hooks', f));
  for (const [name, kind] of Object.entries(STUB_KIND)) {
    writeFileSync(join(dir, 'hooks', `${name}.mjs`), overrides[name] ?? stubSource(name, kind));
  }
  return join(dir, 'hooks', 'run.mjs');
}

/** Hook input for `entry` that points into `dir` (cwd, file, or git command). */
function inputFor(entry, dir) {
  const base = { session_id: 's1', cwd: dir };
  switch (entry) {
    case 'boundary':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, 'x.md') } };
    case 'secret':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } };
    case 'prompt':
      return { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' };
    case 'compact':
      return { ...base, hook_event_name: 'SessionStart', source: 'compact' };
    default:
      return { ...base, hook_event_name: 'Stop', stop_hook_active: false };
  }
}

/** The stub reports carried by a hook's output, one per stub that ran. */
function reports(json) {
  if (!json) return [];
  const text = json.hookSpecificOutput?.permissionDecisionReason
    ?? json.hookSpecificOutput?.additionalContext
    ?? json.systemMessage;
  return text.split('\n').map((line) => JSON.parse(line));
}

const silent = (res) => {
  assert.equal(res.stdout, '');
  assert.equal(res.json, null);
};

test('invalid stdin exits 0 without output', () => {
  const root = makeWorkspace();
  const run = stubPlugin();
  for (const raw of ['', '   ', 'not json', '{"cwd":', '[]', 'null', '42', '"text"']) {
    for (const entry of ENTRIES) {
      const res = runHook(entry, raw, { run, cwd: root });
      silent(res);
      assert.equal(res.stderr, '', `no note for bad stdin ${JSON.stringify(raw)}`);
    }
  }
});

test('unknown entry exits 0 without output', () => {
  const root = makeWorkspace();
  const run = stubPlugin();
  for (const entry of [undefined, '', 'nope', 'BOUNDARY', 'constructor', '__proto__', 'toString', 'boundary-guard']) {
    silent(runHook(entry, inputFor('prompt', root), { run, cwd: root }));
  }
});

test('outside a workspace every entry is silent', () => {
  const outside = tempDir('outside');
  write(outside, { 'readme.txt': 'x\n' });
  const root = makeWorkspace();
  const run = stubPlugin();
  for (const entry of ENTRIES) {
    silent(runHook(entry, inputFor(entry, outside), { run, cwd: outside }));
    // Positive control: the same entry inside the workspace reaches its hook.
    assert.ok(runHook(entry, inputFor(entry, root), { run, cwd: outside }).json, `${entry} must answer inside`);
  }
  // A workspace.json with another schema is not a workspace.
  write(outside, { '.claude/workspace.json': JSON.stringify({ schemaVersion: 2 }) });
  for (const entry of ENTRIES) silent(runHook(entry, inputFor(entry, outside), { run }));
});

test('real entry point is silent outside a workspace', () => {
  const outside = tempDir('outside real');
  for (const entry of ENTRIES) silent(runHook(entry, inputFor(entry, outside), { cwd: outside }));
});

test('disabled advisory hook is silent, guards cannot be disabled', () => {
  const all = ['context-inject', 'effort-hint', 'compact-guard', 'handoff-reminder', 'boundary-guard', 'secret-guard'];
  const root = makeWorkspace({ hooks: { disabled: all } });
  const run = stubPlugin();
  for (const entry of ['prompt', 'compact', 'stop']) silent(runHook(entry, inputFor(entry, root), { run }));
  const boundary = runHook('boundary', inputFor('boundary', root), { run });
  assert.equal(boundary.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(reports(boundary.json).map((r) => r.hook), ['boundary-guard']);
  const secret = runHook('secret', inputFor('secret', root), { run });
  assert.deepEqual(reports(secret.json).map((r) => r.hook), ['secret-guard']);

  // Disabling one of the two prompt hooks keeps the other.
  const partial = makeWorkspace({ hooks: { disabled: ['effort-hint'] } });
  const prompt = runHook('prompt', inputFor('prompt', partial), { run });
  assert.deepEqual(reports(prompt.json).map((r) => r.hook), ['context-inject']);
});

test('prompt runs both hints in one output', () => {
  const root = makeWorkspace();
  const res = runHook('prompt', inputFor('prompt', root), { run: stubPlugin() });
  assert.equal(res.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.deepEqual(reports(res.json).map((r) => r.hook), ['context-inject', 'effort-hint']);
});

test('each entry answers in the form of its event', () => {
  const root = makeWorkspace();
  const run = stubPlugin();
  const deny = runHook('boundary', inputFor('boundary', root), { run }).json;
  assert.deepEqual(Object.keys(deny), ['hookSpecificOutput']);
  assert.equal(deny.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(typeof deny.hookSpecificOutput.permissionDecisionReason, 'string');
  const compact = runHook('compact', inputFor('compact', root), { run }).json;
  assert.equal(compact.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof compact.hookSpecificOutput.additionalContext, 'string');
  const stop = runHook('stop', inputFor('stop', root), { run }).json;
  assert.deepEqual(Object.keys(stop), ['systemMessage']);
  same(reports(stop)[0].root, root);
  assert.equal(reports(stop)[0].name, 'demo');
});

test('boundary starts at file_path, resolved against cwd', () => {
  const root = makeWorkspace();
  const outside = tempDir('outside cwd');
  const run = stubPlugin();
  const at = (cwd, file_path) => {
    const input = { cwd, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path } };
    return runHook('boundary', input, { run, cwd: outside });
  };
  same(reports(at(join(root, 'app'), join('src', 'main.ts')).json)[0].startPath, join(root, 'app', 'src', 'main.ts'));
  // An absolute file_path decides even when the session runs elsewhere.
  same(reports(at(outside, join(root, 'app', 'a.md')).json)[0].startPath, join(root, 'app', 'a.md'));
  // A file outside the workspace is silent even when cwd is inside it.
  silent(at(root, join(outside, 'a.md')));
  // Without a file_path there is nothing to check.
  for (const file_path of [undefined, '', 42]) silent(at(root, file_path));
});

test('secret starts at the folder the git command runs in', () => {
  const root = makeWorkspace();
  const app = join(root, 'app');
  const outside = tempDir('outside git');
  const run = stubPlugin();
  const report = (command, cwd = outside) => {
    const input = { cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    const res = runHook('secret', input, { run, cwd: outside });
    return res.json ? reports(res.json)[0] : null;
  };
  const clear = (command, cwd, expected) => {
    const r = report(command, cwd);
    assert.ok(r, `answer for ${command}`);
    same(r.startPath, expected);
    assert.equal(r.startUnclear, false, command);
  };
  // Unclear targets use cwd and say so, so the guard can refuse instead of checking the wrong repo.
  const unclear = (command, cwd) => {
    const r = report(command, cwd);
    assert.ok(r, `answer for ${command}`);
    same(r.startPath, cwd);
    assert.equal(r.startUnclear, true, command);
  };
  // No commit: nothing to check, so the hook is not called even inside the workspace.
  const none = (command, cwd = app) => assert.equal(report(command, cwd), null, String(command));
  // Typed backslashes and backticks get mangled by some tools, so they are built at runtime.
  const BS = String.fromCharCode(92);
  const BT = String.fromCharCode(96);
  const fwd = (p) => p.split(BS).join('/');

  // Commands inside the strict grammar resolve to their folder.
  clear(`git -C "${fwd(app)}" commit -m x`, outside, app);
  clear(`git -C '${fwd(app)}' commit -m x`, outside, app);
  clear('git -C app commit -m x', root, app);
  clear('git -C app -C src commit -m x', root, join(app, 'src'));
  clear('git --no-pager -C app commit -m x', root, app);
  clear(`cd "${fwd(app)}" && git commit -m x`, outside, app);
  clear(`Set-Location '${fwd(app)}'; git commit -m x`, outside, app);
  clear("Set-Location -Path 'app'; git commit -m x", root, app);
  clear('pushd app && git commit -m x', root, app);
  clear('cd app; git -C src commit -m x', root, join(app, 'src'));
  clear('cd app\ngit commit -m x', root, app);
  clear('git commit -m x', app, app);
  clear('git commit -m "fix the git commit hook"', app, app);
  clear('git commit -m "feat(hooks): add x"', app, app);
  clear('git commit -m "cd docs; git -C elsewhere commit"', app, app);
  clear('git log --grep commit && git -C app commit -m x', root, app);
  clear('FOO=1 git -C src commit -m x', app, join(app, 'src'));
  // `commit` inside a -C folder is a folder name, not the subcommand.
  write(app, { 'commit-tools/.keep': '', 'my commit dir/.keep': '', 'tools/pre-commit/.keep': '' });
  clear('git -C ./commit-tools commit -m x', app, join(app, 'commit-tools'));
  clear('git -C "my commit dir" commit -m x', app, join(app, 'my commit dir'));
  clear('git -C tools/pre-commit commit -m x', app, join(app, 'tools', 'pre-commit'));

  none('git log --grep commit');
  none('git status');
  none('cd .git && git status');
  none('cd app');
  none('echo hello');
  none(`echo "it${BS}'s" ${BT}date${BT}`);
  for (const command of [undefined, 42]) none(command);

  // Outside the grammar, any command that mentions git and commit is unclear.
  // (A) escapes, continuations and comments.
  unclear(`git -C my${BT} dir commit -m x`, root);
  unclear(`git -C app ${BT}\ncommit -m x`, root);
  unclear(`git -C my${BS} dir commit -m x`, root);
  unclear(`git -C app ${BS}\ncommit -m x`, root);
  unclear("# don't\ngit -C ../o commit -m x", root);
  unclear(`git commit -m it${BS}'s`, root);
  unclear(`git commit -m "a${BS}"b"`, root);
  // (B) git not at the command position, or inside another command.
  unclear('xargs git -C ../o commit', root);
  unclear('watch git -C ../o commit', root);
  unclear('cmd /c git -C ../o commit', root);
  unclear('pwsh -c git -C ../o commit', root);
  unclear('bash -c "git -C ../o commit"', root);
  unclear("sh -c 'cd ../o && git commit'", root);
  unclear(`${BT}git -C ../o commit${BT}`, root);
  unclear('echo "$(git -C ../o commit)"', root);
  unclear('if ($true) { git -C ../o commit }', root);
  unclear('try { git -C ../o commit } catch {}', root);
  unclear('if true; then git -C ../o commit; fi', root);
  unclear('git -c alias.ci=commit -C ../o ci', root);
  unclear('git -C ../o ci -m x', root);
  unclear('env FOO=1 git -C src commit -m x', root);
  unclear('git -c user.name=x commit -m x', root);
  unclear(`git commit -m "it's"`, root);
  unclear('git -C app"x" commit -m x', root);
  unclear('cd $REPO && git commit -m x', app);
  unclear('cd ~/x && git commit -m x', app);
  unclear('cd $HOME && git -C app commit -m x', root);
  unclear('cd app && git -C $DIR commit -m x', root);
  unclear('cd app && cd src && git commit -m x', root);
  unclear('echo x && cd app && git commit -m x', root);
  unclear('Set-Location -Path $env:REPO; git commit -m x', root);
  unclear('git --git-dir=app/.git commit -m x', root);
  unclear('git --work-tree app -C app commit -m x', root);
  unclear('git -C app commit -m x && git commit -m y', root);
  // Environment or config that sends git to another repo.
  unclear('GIT_DIR=app/.git git commit -m x', root);
  unclear('GIT_WORK_TREE=app git commit -m x', root);
  unclear('GIT_INDEX_FILE=/tmp/index git commit -m x', root);
  unclear('env GIT_DIR=app/.git git commit -m x', root);
  unclear('export GIT_DIR=app/.git; git commit -m x', root);
  unclear("$env:GIT_DIR='app/.git'; git commit -m x", root);
  unclear('$env:GIT_WORK_TREE = "app"; git commit -m x', root);
  unclear("[Environment]::SetEnvironmentVariable('GIT_DIR', 'app/.git'); git commit -m x", root);
  unclear('export GIT_DIR; git commit -m x', root);
  unclear('GIT_AUTHOR_NAME=x git commit -m x', root);
  unclear('git -c core.worktree=app commit -m x', root);
  unclear('git -c core.bare=false -C app commit -m x', root);
  unclear('git -c "Core.WorkTree=app" commit -m x', root);
  // Other unclear shapes.
  unclear('env -C app git commit -m x', root);
  unclear('(cd app; git commit -m x)', root);
  unclear('git commit -m "open quote', root);
  // Native Windows paths carry backslashes, which the grammar does not accept.
  if (process.platform === 'win32') unclear(`git -C "${app}" commit -m x`, root);
});

test('secret reads Git Bash drive paths on Windows', { skip: process.platform !== 'win32' }, () => {
  const root = makeWorkspace();
  const app = join(root, 'app');
  const outside = tempDir('outside bash');
  const run = stubPlugin();
  const bash = (p) => `/${p[0].toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}`;
  const start = (command) => {
    const input = { cwd: outside, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    const r = reports(runHook('secret', input, { run, cwd: outside }).json)[0];
    assert.equal(r.startUnclear, false, command);
    return r.startPath;
  };
  same(start(`cd "${bash(app)}" && git commit -m x`), app);
  same(start(`git -C "${bash(app)}" commit -m x`), app);
  same(start(`cd /${app[0].toLowerCase()} && git -C "${app.slice(3).replace(/\\/g, '/')}" commit -m x`), app);
});

// Ways a hook module can fail; each message carries a marker that must never reach the output.
const BROKEN = {
  'sync throw': 'export default function run() { throw new Error("secret value"); }\n',
  'syntax error': 'export default function run( { secret value\n',
  'rejected promise': 'export default async function run() { throw new Error("secret value"); }\n',
  'late throw': 'export default function run() {\n' +
    '  return new Promise(() => { setTimeout(() => { throw new Error("secret value"); }, 0); });\n}\n',
  'never settles': 'export default function run() { return new Promise(() => {}); }\n',
  'process.exit': 'export default function run() { process.exit(3); }\n',
  'invalid result': 'export default function run() { return { unknown: "secret value" }; }\n',
  'empty deny': 'export default function run() { return { deny: "" }; }\n',
  'string result': 'export default function run() { return "secret value"; }\n',
  'undefined result': 'export default function run() {}\n',
};
const GUARDS = [['boundary', 'boundary-guard'], ['secret', 'secret-guard']];
const guardFailed = (entry) => `buildorder: the ${entry} check could not run, so this action was blocked. ` +
  'Try again; if it keeps failing, report the hook error.';
const quietStderr = (res, label) => {
  assert.ok(res.stderr === '' || /^[^\n]+\n$/.test(res.stderr), `${label}: one stderr line at most: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, /\bat |secret value/, label);
};

test('a guard that cannot run denies with a generic reason', () => {
  const root = makeWorkspace();
  for (const [entry, hook] of GUARDS) {
    for (const [kind, source] of Object.entries(BROKEN)) {
      const res = runHook(entry, inputFor(entry, root), { run: stubPlugin({ [hook]: source }) });
      const label = `${entry} / ${kind}`;
      assert.deepEqual(res.json, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: guardFailed(entry),
        },
      }, label);
      assert.match(res.stderr, new RegExp(`^buildorder: ${hook} skipped \\(`), label);
      quietStderr(res, label);
    }
    // Without output.mjs the fixed deny still comes out.
    const bare = runHook(entry, inputFor(entry, root), { run: stubPlugin({}, { withoutOutput: true }) });
    assert.equal(bare.json.hookSpecificOutput.permissionDecisionReason, guardFailed(entry));
    quietStderr(bare, `${entry} / no output.mjs`);
    // A guard that allows (null) stays silent.
    silent(runHook(entry, inputFor(entry, root), { run: stubPlugin({ [hook]: 'export default () => null;\n' }) }));
  }
});

test('a broken guard outside a workspace stays silent', () => {
  const outside = tempDir('outside broken');
  for (const [entry, hook] of GUARDS) {
    const res = runHook(entry, inputFor(entry, outside), { run: stubPlugin({ [hook]: BROKEN['sync throw'] }), cwd: outside });
    silent(res);
    assert.equal(res.stderr, '');
  }
});

test('a failing advisory hook exits 0 without output or stack', () => {
  const root = makeWorkspace();
  const advisory = { compact: 'compact-guard', stop: 'handoff-reminder' };
  for (const [entry, hook] of Object.entries(advisory)) {
    for (const [kind, source] of Object.entries(BROKEN)) {
      const res = runHook(entry, inputFor(entry, root), { run: stubPlugin({ [hook]: source }) });
      silent(res);
      quietStderr(res, `${entry} / ${kind}`);
    }
    silent(runHook(entry, inputFor(entry, root), { run: stubPlugin({}, { withoutOutput: true }) }));
  }
  // One broken prompt hook does not silence the other.
  const prompt = runHook('prompt', inputFor('prompt', root), { run: stubPlugin({ 'effort-hint': BROKEN['sync throw'] }) });
  assert.deepEqual(reports(prompt.json).map((r) => r.hook), ['context-inject']);
  assert.equal(prompt.stderr, 'buildorder: effort-hint skipped (Error)\n');
  // A deny from an advisory hook is dropped with a note.
  const deny = runHook('compact', inputFor('compact', root), {
    run: stubPlugin({ 'compact-guard': 'export default () => ({ deny: "no" });\n' }),
  });
  silent(deny);
  assert.equal(deny.stderr, 'buildorder: compact skipped (deny-outside-PreToolUse)\n');
});

test('hooks.json registers exactly the six entries', () => {
  const file = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const hook = (entry, extra) => ({
    type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs', entry], ...extra,
  });
  assert.deepEqual(file, {
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit', hooks: [hook('boundary', { timeout: 10 })] },
        { matcher: 'Bash', hooks: [hook('secret', { if: 'Bash(git *)', timeout: 20, onFailure: 'block' })] },
        { matcher: 'PowerShell', hooks: [hook('secret', { if: 'PowerShell(git *)', timeout: 20, onFailure: 'block' })] },
      ],
      UserPromptSubmit: [{ hooks: [hook('prompt', { timeout: 10 })] }],
      SessionStart: [{ matcher: 'compact', hooks: [hook('compact', { timeout: 10 })] }],
      Stop: [{ hooks: [hook('stop', { timeout: 20 })] }],
    },
  });
});

test('output renders each result kind and caps context', () => {
  assert.equal(render('PreToolUse', null), '');
  assert.deepEqual(JSON.parse(render('PreToolUse', { deny: 'no' })), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
  });
  assert.deepEqual(JSON.parse(render('SessionStart', { context: 'c' })), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'c' },
  });
  assert.deepEqual(JSON.parse(render('Stop', { systemMessage: 'm' })), { systemMessage: 'm' });
  assert.equal(MAX_CONTEXT, 10000);
  const long = JSON.parse(render('UserPromptSubmit', { context: 'x'.repeat(MAX_CONTEXT + 50) }));
  assert.equal(long.hookSpecificOutput.additionalContext.length, MAX_CONTEXT);
  assert.ok(long.hookSpecificOutput.additionalContext.endsWith('x\n[truncated]'));
  const exact = JSON.parse(render('UserPromptSubmit', { context: 'y'.repeat(MAX_CONTEXT) }));
  assert.equal(exact.hookSpecificOutput.additionalContext, 'y'.repeat(MAX_CONTEXT));
  for (const bad of [{}, { deny: '' }, { context: 42 }, { other: 'x' }, 'text', []]) {
    assert.equal(render('PreToolUse', bad), '', JSON.stringify(bad));
  }
  // A deny exists only on PreToolUse; elsewhere it is dropped and reported.
  const warned = [];
  assert.equal(render('UserPromptSubmit', { deny: 'no' }, (code) => warned.push(code)), '');
  assert.deepEqual(JSON.parse(render('Stop', { deny: 'no', systemMessage: 'm' }, (code) => warned.push(code))), {
    systemMessage: 'm',
  });
  assert.deepEqual(warned, ['deny-outside-PreToolUse', 'deny-outside-PreToolUse']);
});

test('merge keeps the first deny and joins texts', () => {
  assert.equal(merge([]), null);
  assert.equal(merge([null, undefined]), null);
  assert.deepEqual(merge([{ context: 'a' }, null, { context: 'b' }]), { context: 'a\nb' });
  assert.deepEqual(merge([{ deny: 'x' }, { deny: 'y' }, { context: 'c' }]), { deny: 'x' });
  assert.deepEqual(merge([{ systemMessage: 'a' }, { systemMessage: 'b' }]), { systemMessage: 'a\nb' });
});
