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
  `export default function run(input, { root, ws, startPath }) {\n` +
  `  return { ${kind}: JSON.stringify({ hook: '${name}', root, startPath, name: ws.name }) };\n}\n`;

/**
 * A copy of the plugin's run.mjs, output.mjs and lib/ with stub hook modules, so the entry point
 * is tested without the real guards. `overrides` maps a hook name to replacement module source.
 * Returns the path of the copied run.mjs.
 */
function stubPlugin(overrides = {}) {
  const dir = join(tempDir('plugin'), 'buildorder');
  cpSync(join(PLUGIN, 'lib'), join(dir, 'lib'), { recursive: true });
  for (const f of ['run.mjs', 'output.mjs']) cpSync(join(PLUGIN, 'hooks', f), join(dir, 'hooks', f));
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
  const start = (command, cwd = outside) => {
    const input = { cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    const res = runHook('secret', input, { run, cwd: outside });
    return res.json ? reports(res.json)[0].startPath : null;
  };
  same(start(`git -C "${app}" commit -m x`), app);
  same(start(`git -C '${app}' commit -m x`), app);
  same(start('git -C app commit -m x', root), app);
  same(start(`cd "${app}" && git commit -m x`), app);
  same(start(`Set-Location '${app}'; git commit -m x`), app);
  same(start('cd app; git -C src commit -m x', root), join(app, 'src'));
  same(start('git commit -m x', app), app);
  // Unclear targets fall back to cwd instead of guessing.
  same(start('cd $HOME && git commit -m x', app), app);
  same(start('cd ~/x && git commit -m x', app), app);
  same(start('cd $HOME && git -C app commit -m x', root), root);
  same(start('cd app && git -C $DIR commit -m x', root), root);
  assert.equal(start(`echo "${app}" && git commit -m x`), null);
  for (const command of [undefined, 42]) assert.equal(start(command), null);
});

test('a failing hook module exits 0 without output or stack', () => {
  const root = makeWorkspace();
  const boom = 'export default function run() { throw new Error("secret value in message"); }\n';
  const run = stubPlugin({
    'boundary-guard': boom,
    'compact-guard': 'export default function run() { return null; }\n',
    'handoff-reminder': 'export default async function run() { return { unknown: 1 }; }\n',
    'secret-guard': 'syntax error here (\n',
  });
  for (const entry of ['boundary', 'secret']) {
    const res = runHook(entry, inputFor(entry, root), { run });
    silent(res);
    assert.ok(res.stderr.trim().split('\n').length <= 1, `one line at most: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /\n\s+at |secret value/);
  }
  silent(runHook('compact', inputFor('compact', root), { run }));
  silent(runHook('stop', inputFor('stop', root), { run }));
  // One broken prompt hook does not silence the other.
  const prompt = runHook('prompt', inputFor('prompt', root), { run: stubPlugin({ 'effort-hint': boom }) });
  assert.deepEqual(reports(prompt.json).map((r) => r.hook), ['context-inject']);
  assert.equal(prompt.stderr, 'buildorder: effort-hint skipped (Error)\n');
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
  for (const bad of [{}, { deny: '' }, { context: 42 }, { other: 'x' }, 'text', []]) {
    assert.equal(render('PreToolUse', bad), '', JSON.stringify(bad));
  }
});

test('merge keeps the first deny and joins texts', () => {
  assert.equal(merge([]), null);
  assert.equal(merge([null, undefined]), null);
  assert.deepEqual(merge([{ context: 'a' }, null, { context: 'b' }]), { context: 'a\nb' });
  assert.deepEqual(merge([{ deny: 'x' }, { deny: 'y' }, { context: 'c' }]), { deny: 'x' });
  assert.deepEqual(merge([{ systemMessage: 'a' }, { systemMessage: 'b' }]), { systemMessage: 'a\nb' });
});
