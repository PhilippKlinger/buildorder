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

// A shell word (quoted and unquoted parts glued together) or a separator between simple commands.
const TOKENS = /((?:"[^"]*"|'[^']*'|[^\s;&|()"'])+)|(&&|\|\||[;&|()\n])/g;
const PARTS = /"([^"]*)"|'([^']*)'|([^"']+)/g;
// Commands that change the folder (compared in lower case).
const DIR_CMDS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location']);
// The folder change that is read: `cd|pushd|Set-Location|Push-Location [-Path|-LiteralPath] <dir>`.
const READ_CMDS = new Set(['cd', 'pushd', 'set-location', 'push-location']);
// Words that may run git without changing the folder themselves.
const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'nice', 'sudo']);
const GIT_EXE = /^(?:.*[\\/])?git(?:\.exe)?$/i;
// Global git options that do not change which repo git works in.
const NEUTRAL = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-optional-locks', '--no-replace-objects',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice',
]);
// Environment that sends git to another repo, set inline, exported or through $env: anywhere in the command.
const REDIRECT_NAMES = 'GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|' +
  'GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT';
const REDIRECT_ENV = new RegExp(String.raw`(?:^|[^\w$:])(?:${REDIRECT_NAMES})\s*=|\benv:(?:${REDIRECT_NAMES})\b`, 'i');
// `-c` keys that move the work tree.
const REDIRECT_CONFIG = /^core\.(?:worktree|bare)$/i;

/**
 * The folder a shell word names, or null when the shell would change it (variables, ~, escapes).
 * On Windows a Git Bash path `/e/dir` (or `/e`) becomes `e:/dir`.
 */
function literalDir(word) {
  const { text, literal } = unquote(word);
  if (!literal || text === '' || /^[~-]/.test(text)) return null;
  return IS_WINDOWS ? text.replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/') : text;
}

/**
 * The text of a shell word without its quotes. `literal` is false when the shell would change it:
 * `$`, backtick or `%` outside single quotes, or an unquoted part ending in a backslash (escape).
 */
function unquote(word) {
  let text = '';
  let literal = true;
  for (const [, double, single, bare] of word.matchAll(PARTS)) {
    if (single !== undefined) {
      text += single;
      continue;
    }
    const part = double ?? bare;
    if (/[$`%]/.test(part) || (bare !== undefined && bare.endsWith('\\'))) literal = false;
    text += part;
  }
  return { text, literal };
}

/** The simple commands of `command` as `{ words, sep }` (sep: the separator after it), or null when a quote is open. */
function simpleCommands(command) {
  const list = [{ words: [], sep: '' }];
  let seen = 0;
  for (const m of command.matchAll(TOKENS)) {
    if (command.slice(seen, m.index).trim() !== '') return null; // text no token covers: an open quote
    seen = m.index + m[0].length;
    if (m[1] !== undefined) list.at(-1).words.push(m[1]);
    else {
      list.at(-1).sep = m[2];
      list.push({ words: [], sep: '' });
    }
  }
  if (command.slice(seen).trim() !== '') return null;
  return list.filter((c) => c.words.length > 0 || c.sep !== '');
}

/**
 * The `-C` folders of one simple command when it is a git commit: `{ dirs }`; `{ unclear: true }` when
 * the repo cannot be read literally; null when it is no git commit (another subcommand, or git is
 * only an argument as in `echo git commit`).
 */
function commitDirs(words) {
  const text = (w) => unquote(w).text;
  const at = words.findIndex((w) => GIT_EXE.test(text(w)));
  if (at < 0) return null;
  // Before git: assignments and wrappers keep the folder; after an option (`env -C x`) anything may.
  let unsure = false;
  for (const w of words.slice(0, at)) {
    const t = text(w);
    if (t.startsWith('-')) unsure = true;
    else if (!unsure && !/^[A-Za-z_]\w*=/.test(t) && !WRAPPERS.has(t)) return null;
  }
  const rest = words.slice(at + 1);
  const dirs = [];
  for (let i = 0; i < rest.length; i++) {
    const t = text(rest[i]);
    if (t === '-C' || t === '-c') {
      const value = rest[++i];
      if (value === undefined) return null;
      if (t === '-C') {
        const dir = literalDir(value);
        if (dir === null) unsure = true;
        else dirs.push(dir);
      } else {
        const key = text(value).split('=')[0].trim();
        if (/[$`]/.test(key) || REDIRECT_CONFIG.test(key)) unsure = true;
      }
    } else if (NEUTRAL.has(t)) {
      continue;
    } else if (t.startsWith('-')) {
      // An unknown option may take a value, so any later `commit` may be the subcommand.
      return rest.slice(i + 1).some((w) => text(w) === 'commit') ? { unclear: true } : null;
    } else {
      if (t !== 'commit') return null;
      return unsure ? { unclear: true } : { dirs };
    }
  }
  return null;
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
  if (REDIRECT_ENV.test(command)) return unclear;
  const commands = simpleCommands(command);
  if (commands === null) return unclear;
  let base = cwd;
  const changes = commands.flatMap((c, i) =>
    c.words.flatMap((w, j) => (DIR_CMDS.has(unquote(w).text.toLowerCase()) ? [[i, j]] : [])));
  if (changes.length > 1) return unclear;
  if (changes.length === 1) {
    // Only `<cmd> [-Path|-LiteralPath] <dir>` as the first simple command, then `&&`, `;` or a newline.
    const [first] = commands;
    const words = first.words.map((w) => unquote(w).text.toLowerCase());
    const flag = words.length === 3 && (words[1] === '-path' || words[1] === '-literalpath');
    const dir = first.words.length === 2 || flag ? literalDir(first.words.at(-1)) : null;
    const read = changes[0][0] === 0 && changes[0][1] === 0 && READ_CMDS.has(words[0]);
    if (!read || !['&&', ';', '\n'].includes(first.sep) || dir === null) return unclear;
    base = resolve(cwd, dir);
  }
  const targets = new Set();
  for (const { words } of commands) {
    const call = commitDirs(words);
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
  // A guard answers with null (allow) or a result that renders; anything else, undefined included, fails.
  if (failClosed && out === '' && results.some((r) => r !== null)) throw invalidResult();
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
