// Single entry point for every plugin hook: `node run.mjs <entry>`, registered in hooks.json.
// Outside a buildorder workspace it ends after one cheap walk-up, so only that walk-up is
// imported statically; the hook modules of the entry are loaded with import() once a
// workspace is found. Contract: always exit 0; stdout is empty or exactly one JSON object;
// stderr carries at most one short line, never a stack trace or text from the input.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findWorkspaceRoot, loadWorkspace } from '../lib/workspace.mjs';

// Hooks a workspace may switch off in `hooks.disabled`. Guards are not in this list.
const OPTIONAL = new Set(['context-inject', 'effort-hint', 'compact-guard', 'handoff-reminder']);

/** The session folder: `input.cwd`, or the process folder (Claude Code starts hooks there) when missing. */
function cwdOf(input) {
  return typeof input.cwd === 'string' && input.cwd !== '' ? resolve(input.cwd) : process.cwd();
}

/** Write/Edit: the target file, made absolute against the session folder. */
function fileStart(input) {
  const file = input.tool_input?.file_path;
  return typeof file === 'string' && file !== '' ? resolve(cwdOf(input), file) : null;
}

// One shell word: a quoted string or a run of characters without spaces, quotes or separators.
const WORD = String.raw`("[^"]*"|'[^']*'|[^\s;&|"']+)`;
const LEADING_CD = new RegExp(String.raw`^\s*(?:cd|Set-Location)\s+${WORD}\s*(?:&&|;)`, 'i');
// `-C` of the git call that commits; `-c key=value` options may come first.
const GIT_C = new RegExp(String.raw`\bgit(?:\s+-c\s+\S+)*\s+-C\s+${WORD}[^\n;|&]*\bcommit\b`);

/** The folder a shell word names, or null when the shell would change it (variables, ~, escapes). */
function literalDir(word) {
  if (word.startsWith("'")) return word.length > 2 ? word.slice(1, -1) : null;
  const dir = word.startsWith('"') ? word.slice(1, -1) : word;
  if (dir === '' || /[$`%]/.test(dir) || /^[~-]/.test(dir) || dir.endsWith('\\')) return null;
  return dir;
}

/**
 * Bash/PowerShell: the folder the git command runs in. A leading `cd <dir> &&|;` or
 * `Set-Location <dir>;` moves the base, `git -C <dir> ... commit` resolves against it.
 * Anything unclear falls back to the session folder instead of guessing.
 */
function gitStart(input) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const cwd = cwdOf(input);
  let dir = cwd;
  for (const re of [LEADING_CD, GIT_C]) {
    const word = command.match(re)?.[1];
    if (word === undefined) continue;
    const next = literalDir(word);
    if (next === null) return cwd;
    dir = resolve(dir, next);
  }
  return dir;
}

const ENTRIES = new Map([
  ['boundary', { event: 'PreToolUse', hooks: ['boundary-guard'], start: fileStart }],
  ['secret', { event: 'PreToolUse', hooks: ['secret-guard'], start: gitStart }],
  ['prompt', { event: 'UserPromptSubmit', hooks: ['context-inject', 'effort-hint'], start: cwdOf }],
  ['compact', { event: 'SessionStart', hooks: ['compact-guard'], start: cwdOf }],
  ['stop', { event: 'Stop', hooks: ['handoff-reminder'], start: cwdOf }],
]);

const notes = [];
// Only the hook name and the error code or class: messages may quote the input.
const safe = (v) => String(v).replace(/[^\w.-]/g, '').slice(0, 40);
const note = (name, err) => notes.push(`buildorder: ${safe(name)} skipped (${safe(err?.code ?? err?.name ?? 'Error')})`);

function readInput() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null;
  } catch {
    return null; // no stdin or no JSON: not a hook call this script can answer
  }
}

/** The stdout text for this call, '' when there is nothing to say. */
async function main(name) {
  const entry = ENTRIES.get(name);
  if (!entry) return '';
  const input = readInput();
  if (!input) return '';
  const startPath = entry.start(input);
  if (!startPath) return '';
  const root = findWorkspaceRoot(startPath);
  if (root === null) return '';
  const ws = loadWorkspace(root);
  if (ws === null) return '';
  const disabled = Array.isArray(ws.hooks?.disabled) ? ws.hooks.disabled : [];
  const hooks = entry.hooks.filter((h) => !(OPTIONAL.has(h) && disabled.includes(h)));
  if (hooks.length === 0) return '';
  const results = [];
  for (const hook of hooks) {
    try {
      const mod = await import(`./${hook}.mjs`);
      results.push(await mod.default(input, { root, ws, startPath }));
    } catch (err) {
      note(hook, err); // one broken hook must not silence the other hook of the same entry
    }
  }
  const { merge, render } = await import('./output.mjs');
  return render(entry.event, merge(results));
}

function finish(out) {
  const exit = () => process.exit(0);
  process.stdout.on('error', exit);
  process.stderr.on('error', exit);
  const writeOut = () => (out ? process.stdout.write(out, exit) : exit());
  if (notes.length) process.stderr.write(`${notes[0]}\n`, writeOut);
  else writeOut();
}

// A late error from a hook module ends the call silently instead of printing a stack.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

let out = '';
try {
  out = await main(process.argv[2]);
} catch (err) {
  note(process.argv[2], err);
}
finish(out);
