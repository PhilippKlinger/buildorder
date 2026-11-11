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

/*
 * Start folder of a git commit (secret entry). An allowlist, not a shell parser: a target is
 * `clear` only on route (a) or (b) below, and every other command that mentions git and a
 * commit is `unclear`, so the guard refuses instead of checking the wrong repo.
 *
 *   command   = simple { sep simple }            sep = "&&" | "||" | ";" | newline
 *   simple    = { assign } word { word }         assign = NAME=value, NAME not GIT_*
 *   word      = plain | 'quoted' | "quoted"      one per word, never glued together
 *   plain     = [~] [A-Za-z0-9_./:@%+=,-]+
 *   quoted    = no ` $ # ' " or newline inside, and a \ only when the next character is none of
 *               $ ` " \ or newline, so "E:\dir\app" reads the same in Bash and PowerShell
 *   cd        = (cd | pushd | Set-Location | Push-Location) [-Path | -LiteralPath] dir,
 *               at most one, only as the first simple command, followed by "&&", ";" or newline
 *   git call  = git | git.exe at the command position, then neutral flags or -C <dir> (repeatable,
 *               each relative to the one before), then the subcommand
 *   add call  = git | git.exe as the first word, then `add` or `stage` (its synonym) and words that
 *               are no git word and not exactly commit or ci, followed by "&&", ";", newline or the
 *               end; it sets no folder, but before a commit it is handed to the guard as
 *               `addBeforeCommit`, and with -f/--force (also -fA etc.) as `forceAddBeforeCommit`
 *
 * Route (a), the whole command fits the grammar: subcommand `commit` gives its folder; another
 * subcommand at the command position is no commit, unless one of its later words is git (git
 * submodule foreach git ..., rebase -x "git ...", bisect run git ...: that runs a command of its
 * own), which is unsure. `ci`, any other option, a second folder change, a folder-change word
 * anywhere in another command (command cd, builtin cd), git anywhere else in a command (xargs git,
 * bash -c "git ..."), an add call with assignments, global options or another separator, GIT_*
 * assignments or commits into different folders are unsure.
 * Route (b), the rest of a commit is message text: when route (a) fails or is unsure, the raw text
 * up to and including the first plain `commit` word must fit the grammar as
 * `[cd <dir> sep] {add call sep} {assign} git {neutral flag | -C <dir>} commit`. The raw text
 * after that word (heredoc, $(...), quotes, escapes, newlines) is free text when it has no `git`,
 * no `commit` or `ci`, no folder-change word (cd, pushd, popd, chdir, sl, Set-Location,
 * Push-Location, Pop-Location) and no GIT_* name, so nothing in it can move the target.
 * Otherwise the raw text decides, before any tokenizing, so no escape, continuation or comment
 * can hide a commit: git as a word and commit, ci or alias. anywhere means unclear, otherwise
 * there is no commit. In any command that mentions git and a commit, a repo-moving GIT_* name
 * (GIT_DIR, GIT_WORK_TREE, ...) makes the target unclear, with or without `=`.
 */
const LEX = /[ \t]+|(&&|\|\||;|\r?\n)|(~?[A-Za-z0-9_./:@%+=,-]+)|'((?:[^\\`$#'"\n]|\\(?![$`"\\\n]))*)'|"((?:[^\\`$#'"\n]|\\(?![$`"\\\n]))*)"/y;
const GIT_WORD = /\bgit\b/i;
const COMMIT_WORD = /\b(?:commit|ci)\b|\balias\./i;
const REDIRECT_ENV = /\bGIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|CONFIG_PARAMETERS|CONFIG_COUNT)\b/i;
const ASSIGN = /^[A-Za-z_]\w*=/;
const GIT_EXE = /^git(?:\.exe)?$/i;
// Route (b): words that must not appear in the free text after the commit word.
const TAIL_DENY = [
  GIT_WORD,
  /\b(?:commit|ci)\b/i,
  /\b(?:cd|chdir|pushd|popd|sl|set-location|push-location|pop-location)\b/i,
  /\bGIT_[A-Z_]+/i,
];
// Commands that change the folder (compared in lower case) and the ones whose folder is read.
const DIR_CMDS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location']);
const READ_CMDS = new Set(['cd', 'pushd', 'set-location', 'push-location']);
// Separators an add call may end with ('' is the end of the command).
const ADD_SEPS = ['&&', ';', '\n', ''];
// git add and its built-in synonym.
const ADD_SUBS = new Set(['add', 'stage']);
// The force option of git add: -f, inside combined short flags (-fA), or --force and its unique prefixes.
const FORCE_FLAG = /^(?:-[A-Za-z]*f[A-Za-z]*|--f(?:o(?:r(?:ce?)?)?)?)$/;
// For the guard to show when the target is unclear: both ways to a commit it can read.
const UNCLEAR_HINT =
  'buildorder: cannot tell which repo this git commit goes to, so it was blocked. ' +
  'Run the commit as its own command: git -C <path> commit -m <message>. ' +
  'If the message mentions git, commit, ci or cd, write it to a file and run git -C <path> commit -F <file>.';
// Global git options that do not change which repo git works in.
const NEUTRAL = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-optional-locks', '--no-replace-objects',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice',
]);

/**
 * The tokens of `command`: `{ sep }` or `{ word, end }` (word without quotes, `end` just after it),
 * or null when the text leaves the grammar. With `untilCommit` the list stops at the first plain
 * `commit` word, and is null when there is none.
 */
function lex(command, untilCommit = false) {
  const list = [];
  let i = 0;
  while (i < command.length) {
    LEX.lastIndex = i;
    const m = LEX.exec(command);
    if (m === null) return null;
    i = LEX.lastIndex;
    if (m[1] !== undefined) {
      list.push({ sep: m[1].trim() === '' ? '\n' : m[1] });
      continue;
    }
    const word = m[2] ?? m[3] ?? m[4];
    if (word === undefined) continue; // blanks
    if (i < command.length && !/[ \t;&|\r\n]/.test(command[i])) return null; // glued words
    list.push({ word, end: i });
    if (untilCommit && m[2] === 'commit') return list;
  }
  return untilCommit ? null : list;
}

/** The simple commands of a token list as `{ words, sep }`. */
function simpleCommands(tokens) {
  const list = [{ words: [], sep: '' }];
  for (const t of tokens) {
    if (t.sep === undefined) {
      list.at(-1).words.push(t.word);
      continue;
    }
    list.at(-1).sep = t.sep;
    list.push({ words: [], sep: '' });
  }
  return list.filter((c) => c.words.length > 0);
}

/** A folder word as a path, or null for ~, an option or an empty word. Git Bash `/e/dir` becomes `e:/dir` on Windows. */
function literalDir(text) {
  if (text === '' || /^[~-]/.test(text)) return null;
  return IS_WINDOWS ? text.replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/') : text;
}

/** A plain `git add ...` or `git stage ...`: git as the first word, the subcommand right after it (no assignment, no global option). */
const isAddCall = (words) => GIT_EXE.test(words[0]) && ADD_SUBS.has(words[1]);

/**
 * Commit folders of a command inside the grammar: `{ targets, addBefore, forceAddBefore }`, or
 * `{ unsure: true }`. `addBefore` is true when an add call runs before a commit, so the commit may
 * take files that are untracked now; `forceAddBefore` when such an add call has -f, so ignored
 * files may be taken too.
 */
function grammarTargets(commands, cwd) {
  const unsure = { unsure: true };
  const targets = new Set();
  let base = cwd;
  let moved = false;
  let added = false;
  let forced = false;
  let addBefore = false;
  let forceAddBefore = false;
  for (let i = 0; i < commands.length; i++) {
    const { words, sep } = commands[i];
    let k = 0;
    while (k < words.length - 1 && ASSIGN.test(words[k])) {
      if (/^GIT_/i.test(words[k])) return unsure;
      k++;
    }
    const cmd = words[k];
    if (DIR_CMDS.has(cmd.toLowerCase())) {
      const args = words.slice(k + 1);
      const flag = args.length === 2 && /^-(?:literal)?path$/i.test(args[0]);
      const dir = args.length === 1 || flag ? literalDir(args.at(-1)) : null;
      const first = i === 0 && k === 0 && !moved && READ_CMDS.has(cmd.toLowerCase());
      if (!first || dir === null || !['&&', ';', '\n'].includes(sep)) return unsure;
      base = resolve(cwd, dir);
      moved = true;
      continue;
    }
    if (!GIT_EXE.test(cmd)) {
      // git inside another command (xargs git, bash -c "git ...", if/then) cannot be read, nor can a
      // folder change behind another word (command cd, builtin cd).
      if (words.some((w) => GIT_WORD.test(w) || DIR_CMDS.has(w.toLowerCase()))) return unsure;
      continue;
    }
    const dirs = [];
    let j = k + 1;
    for (; j < words.length; j++) {
      if (words[j] === '-C') {
        const dir = words[j + 1] === undefined ? null : literalDir(words[j + 1]);
        if (dir === null) return unsure;
        dirs.push(dir);
        j++;
      } else if (!NEUTRAL.has(words[j])) break;
    }
    const sub = words[j];
    if (sub === undefined) continue;
    if (sub.startsWith('-') || sub === 'ci') return unsure;
    if (sub === 'commit') {
      targets.add(dirs.reduce((dir, next) => resolve(dir, next), base));
      addBefore ||= added;
      forceAddBefore ||= forced;
      continue;
    }
    // git among the arguments of another subcommand runs on its own (submodule foreach, rebase -x, bisect run).
    const rest = words.slice(j + 1);
    if (rest.some((w) => GIT_WORD.test(w))) return unsure;
    const oddAdd = !isAddCall(words) || !ADD_SEPS.includes(sep) || rest.some((w) => /^(?:commit|ci)$/i.test(w));
    if (ADD_SUBS.has(sub)) {
      if (oddAdd) return unsure;
      added = true;
      forced ||= rest.some((w) => FORCE_FLAG.test(w));
    }
  }
  return targets.size > 1 ? unsure : { targets, addBefore, forceAddBefore };
}

/** Route (b): `{ path, addBefore, forceAddBefore }` of a commit whose rest is message text, or null (see the grammar above). */
function freeTextTarget(command, cwd) {
  const tokens = lex(command, true);
  if (tokens === null) return null;
  const commands = simpleCommands(tokens);
  // Only an optional folder change, then add calls, then the git call that ends in this commit word.
  let i = commands.length > 1 && DIR_CMDS.has(commands[0].words[0].toLowerCase()) ? 1 : 0;
  for (; i < commands.length - 1; i++) if (!isAddCall(commands[i].words)) return null;
  const result = grammarTargets(commands, cwd);
  if (result.unsure || result.targets.size !== 1) return null;
  const tail = command.slice(tokens.at(-1).end);
  if (TAIL_DENY.some((re) => re.test(tail))) return null;
  return { path: [...result.targets][0], addBefore: result.addBefore, forceAddBefore: result.forceAddBefore };
}

/**
 * Bash/PowerShell: `{ path, unclear, addBefore, forceAddBefore }` for the folder the git commit runs
 * in, or null when the command makes no commit. `addBefore`: a git add call runs before the commit;
 * `forceAddBefore`: one of them has -f. Unclear targets use the session folder and carry `hint`
 * (see the grammar above).
 */
function gitStart(input) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const cwd = cwdOf(input);
  const unclear = { path: cwd, unclear: true, hint: UNCLEAR_HINT };
  const bearing = GIT_WORD.test(command) && COMMIT_WORD.test(command);
  if (bearing && REDIRECT_ENV.test(command)) return unclear;
  const tokens = lex(command);
  const result = tokens === null ? { unsure: true } : grammarTargets(simpleCommands(tokens), cwd);
  if (!result.unsure) {
    if (result.targets.size === 0) return null;
    const { addBefore, forceAddBefore } = result;
    return { path: [...result.targets][0], unclear: false, addBefore, forceAddBefore };
  }
  if (!bearing) return null;
  const target = freeTextTarget(command, cwd);
  return target === null ? unclear : { ...target, unclear: false };
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
  const context = {
    root, ws, startPath: start.path, startUnclear: start.unclear, startHint: start.hint,
    addBeforeCommit: start.addBefore === true,
    forceAddBeforeCommit: start.forceAddBefore === true,
  };
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
