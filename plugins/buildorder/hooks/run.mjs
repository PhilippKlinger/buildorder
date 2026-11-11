// Single entry point for every plugin hook: `node run.mjs <entry>`, registered in hooks.json.
// Outside a buildorder workspace it ends after one cheap walk-up, so only that walk-up is
// imported statically; the hook modules of the entry are loaded with import() once a
// workspace is found. Contract: always exit 0; stdout is empty or exactly one JSON object;
// stderr carries at most one short line, never a stack trace or text from the input.
// Guards fail closed: inside a workspace, a guard that cannot give a valid answer denies.
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { findWorkspaceRoot, loadWorkspace } from '../lib/workspace.mjs';

const IS_WINDOWS = process.platform === 'win32';

// Hooks a workspace may switch off in `hooks.disabled`. Guards are not in this list.
const OPTIONAL = new Set(['context-inject', 'effort-hint', 'compact-guard', 'handoff-reminder']);

/** The session folder: `input.cwd`, or the process folder (Claude Code starts hooks there) when missing. */
function cwdOf(input) {
  return typeof input.cwd === 'string' && input.cwd !== '' ? resolve(input.cwd) : process.cwd();
}

const sessionStart = (input) => ({ path: cwdOf(input), unclear: false });

/** Write/Edit: the target file, made absolute against the session folder. */
function fileStart(input) {
  const file = input.tool_input?.file_path;
  return typeof file === 'string' && file !== '' ? { path: resolve(cwdOf(input), file), unclear: false } : null;
}

// One shell word: a quoted string or a run of characters without spaces, quotes or separators.
const WORD = String.raw`("[^"]*"|'[^']*'|[^\s;&|"']+)`;
const WORDS = new RegExp(WORD, 'g');
// Any command that changes the folder, at the start or after a separator.
const DIR_CHANGE = /(?:^|[\n;&|({])\s*(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?=[\s;&|)]|$)/gi;
// The one form that is read: a leading `cd|pushd|Set-Location|Push-Location [-Path|-LiteralPath] <dir>` and `&&` or `;`.
const LEADING_CD = new RegExp(
  String.raw`^\s*(?:cd|pushd|Set-Location|Push-Location)\s+(?:-(?:Literal)?Path\s+)?${WORD}\s*(?:&&|;)`, 'i',
);
// A git call up to its first `commit`, within one simple command.
const GIT_CALL = /\bgit\b([^\n;|&]*?)\bcommit\b/g;
// Global git options that do not change which repo git works in.
const NEUTRAL = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-optional-locks', '--no-replace-objects',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice',
]);

/**
 * The folder a shell word names, or null when the shell would change it (variables, ~, escapes).
 * On Windows a Git Bash path `/e/dir` (or `/e`) becomes `e:/dir`.
 */
function literalDir(word) {
  let dir;
  if (word.startsWith("'")) dir = word.slice(1, -1);
  else {
    dir = word.startsWith('"') ? word.slice(1, -1) : word;
    if (/[$`%]/.test(dir) || dir.endsWith('\\')) return null;
  }
  if (dir === '' || /^[~-]/.test(dir)) return null;
  return IS_WINDOWS ? dir.replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/') : dir;
}

/**
 * The `-C` folders of one git call before its subcommand: `{ dirs }`, `{ unclear: true }` when an
 * option could change the repo or a folder is not literal, or null when the subcommand is not commit.
 */
function gitDirs(prefix) {
  const tokens = [...prefix.matchAll(WORDS)].map((m) => m[1]);
  const dirs = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-C' || token === '-c') {
      const value = tokens[++i];
      if (value === undefined) return { unclear: true };
      if (token === '-c') continue;
      const dir = literalDir(value);
      if (dir === null) return { unclear: true };
      dirs.push(dir);
    } else if (!NEUTRAL.has(token)) {
      return token.startsWith('-') ? { unclear: true } : null;
    }
  }
  return { dirs };
}

/**
 * Bash/PowerShell: the folder the git commit runs in. One leading `cd`/`pushd`/`Set-Location`
 * moves the base; each `git -C <dir>` resolves against the previous one, as git does.
 * When the folder cannot be read literally, the session folder is used with `unclear: true`,
 * so the guard can refuse instead of checking the wrong repo.
 */
function gitStart(input) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const cwd = cwdOf(input);
  const unclear = { path: cwd, unclear: true };
  let base = cwd;
  const changes = command.match(DIR_CHANGE)?.length ?? 0;
  if (changes > 1) return unclear;
  if (changes === 1) {
    const word = command.match(LEADING_CD)?.[1];
    const dir = word === undefined ? null : literalDir(word);
    if (dir === null) return unclear;
    base = resolve(cwd, dir);
  }
  const targets = new Set();
  for (const m of command.matchAll(GIT_CALL)) {
    const call = gitDirs(m[1]);
    if (call === null) continue;
    if (call.unclear) return unclear;
    targets.add(call.dirs.reduce((dir, next) => resolve(dir, next), base));
  }
  // Several commits into different repos cannot be checked from one start folder.
  if (targets.size > 1) return unclear;
  return { path: targets.size === 1 ? [...targets][0] : base, unclear: false };
}

const ENTRIES = new Map([
  ['boundary', { event: 'PreToolUse', hooks: ['boundary-guard'], start: fileStart, guard: true }],
  ['secret', { event: 'PreToolUse', hooks: ['secret-guard'], start: gitStart, guard: true }],
  ['prompt', { event: 'UserPromptSubmit', hooks: ['context-inject', 'effort-hint'], start: sessionStart }],
  ['compact', { event: 'SessionStart', hooks: ['compact-guard'], start: sessionStart }],
  ['stop', { event: 'Stop', hooks: ['handoff-reminder'], start: sessionStart }],
]);

const entryName = process.argv[2];
let current = entryName; // the hook that runs, for the stderr note
let failClosed = false; // true once a guard runs inside a workspace
let done = false;

const notes = [];
// Only the hook name and the error code or class: messages may quote the input.
const safe = (v) => String(v).replace(/[^\w.-]/g, '').slice(0, 40);
const note = (name, err) => notes.push(`buildorder: ${safe(name)} skipped (${safe(err?.code ?? err?.name ?? 'Error')})`);

// Fixed text and JSON, so a guard can still deny when output.mjs or the guard itself is broken.
const guardFailed = (name) =>
  `buildorder: the ${name} check could not run, so this action was blocked. ` +
  'Try again; if it keeps failing, report the hook error.';
const guardDenied = () => JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: guardFailed(entryName),
  },
});

/** Writes the stderr note and `out` synchronously, once; later calls do nothing. */
function emit(out) {
  if (done) return;
  done = true;
  try {
    if (notes.length) writeSync(2, `${notes[0]}\n`);
  } catch { /* stderr closed */ }
  try {
    if (out) writeSync(1, out);
  } catch { /* stdout closed */ }
}

/** The answer when something went wrong: a deny for a running guard, nothing otherwise. */
function fail(err) {
  note(current, err);
  emit(failClosed ? guardDenied() : '');
  process.exit(0);
}

function invalidResult() {
  const err = new Error('invalid guard result');
  err.code = 'INVALID_RESULT';
  return err;
}

function readInput() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null;
  } catch {
    return null; // no stdin or no JSON: not a hook call this script can answer
  }
}

/** The stdout text for this call, '' when there is nothing to say. Throws only for a failing guard. */
async function main() {
  const entry = ENTRIES.get(entryName);
  if (!entry) return '';
  const input = readInput();
  if (!input) return '';
  const start = entry.start(input);
  if (!start) return '';
  const root = findWorkspaceRoot(start.path);
  if (root === null) return '';
  const ws = loadWorkspace(root);
  if (ws === null) return '';
  failClosed = entry.guard === true;
  const disabled = Array.isArray(ws.hooks?.disabled) ? ws.hooks.disabled : [];
  const hooks = entry.hooks.filter((h) => !(OPTIONAL.has(h) && disabled.includes(h)));
  if (hooks.length === 0) return '';
  const context = { root, ws, startPath: start.path, startUnclear: start.unclear };
  const results = [];
  for (const hook of hooks) {
    current = hook;
    try {
      const mod = await import(`./${hook}.mjs`);
      results.push(await mod.default(input, context));
    } catch (err) {
      if (failClosed) throw err;
      note(hook, err); // one broken advisory hook must not silence the other hook of the same entry
    }
  }
  const { merge, render } = await import('./output.mjs');
  const out = render(entry.event, merge(results), (code) => note(entryName, { code }));
  // A guard answers with null (allow) or a result that renders; anything else is a failure.
  if (failClosed && out === '' && results.some((r) => r !== null && r !== undefined)) throw invalidResult();
  return out;
}

// A late error, an early process.exit() or a promise that never settles must not let a guard pass.
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.on('exit', () => {
  if (!done) {
    note(current, { code: 'NO_ANSWER' });
    emit(failClosed ? guardDenied() : '');
  }
  process.exitCode = 0;
});

main().then((out) => {
  emit(out);
  process.exit(0);
}, fail);
