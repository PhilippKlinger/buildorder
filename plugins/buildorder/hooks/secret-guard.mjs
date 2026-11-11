// PreToolUse (Bash/PowerShell, git commit): scans the staged diff and the staged file names of
// the target repo for secrets and denies with masked findings. run.mjs hands over the folder the
// commit runs in as `startPath`; an undecidable target arrives as `startUnclear` with `startHint`.
// With `addBeforeCommit` (a git add call runs before the commit) the untracked files of the repo
// are scanned too: the hook runs before the command, so the add has not staged them yet.
// Fail closed: when git or a file cannot be read, the commit is denied.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitResult } from '../lib/git.mjs';
import { isSecretFile, scanLine } from '../lib/secrets.mjs';

const MAX_FINDINGS = 10;
// Stable output: no quoting of non-ASCII names, no lock files, plain prefixes, no external diff drivers.
const BASE = [
  '--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
];
// --text: UTF-16, NUL bytes and -diff/binary attributes must not hide content.
// --diff-filter=d: everything except deletions (type changes included).
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '-U0', '--diff-filter=d'];

// The same budget as the git output of the diff passes (maxBuffer in lib/git.mjs).
const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024;
const UNTRACKED_NOTE = ' (untracked, git add may pick it up)';

const unreadable = () => ({ deny: 'buildorder: the staged changes could not be read, so this commit was blocked. Try again.' });
const tooLarge = () => ({
  deny: 'buildorder: the untracked files that git add may pick up are too large to check for secrets ' +
    '(over 32 MB), so this commit was blocked. Gitignore large files, or run git add on its own first.',
});

/** Added lines of a `-U0` diff as `{ file, line, text }`. */
function addedLines(diff) {
  const out = [];
  let file = null;
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.startsWith('diff --git ')) {
      inHunk = false;
      file = null;
    } else if (!inHunk && text.startsWith('+++ ')) {
      const name = text.slice(4).replace(/\t$/, ''); // git adds a TAB after names with spaces
      file = name === '/dev/null' ? null : name.replace(/^"(.*)"$/, '$1').replace(/^b\//, '');
    } else if (text.startsWith('@@')) {
      const m = /^@@ -\S+ \+(\d+)/.exec(text);
      line = m ? Number(m[1]) : 0;
      inHunk = true;
    } else if (inHunk && file !== null && text.startsWith('+')) {
      out.push({ file, line, text: text.slice(1) });
      line++;
    }
  }
  return out;
}

/** The names from a `-z` listing. */
const names = (stdout) => stdout.split('\0').filter((n) => n !== '');

/**
 * Findings in the untracked, non-ignored files of the repo at `startPath`, read from disk the way
 * the diff passes read git output (NUL bytes dropped, so UTF-16 text is seen), or `{ deny }`.
 */
function untrackedFindings(startPath, seenFiles) {
  const topRes = gitResult(startPath, [...BASE, 'rev-parse', '--show-toplevel']);
  if (!topRes.ok || topRes.stdout === '') return unreadable();
  const top = topRes.stdout;
  const listRes = gitResult(top, [...BASE, 'ls-files', '-o', '--exclude-standard', '-z']);
  if (!listRes.ok) return unreadable();
  const findings = [];
  let budget = MAX_UNTRACKED_BYTES;
  for (const name of names(listRes.stdout)) {
    if (isSecretFile(name) && !seenFiles.has(name)) {
      seenFiles.add(name);
      findings.push(`${name} is a secret file (never commit it)${UNTRACKED_NOTE}`);
    }
    let text;
    try {
      const stat = lstatSync(join(top, name));
      if (!stat.isFile()) continue; // links are added as links; nested repos as gitlinks
      budget -= stat.size;
      if (budget < 0) return tooLarge();
      text = readFileSync(join(top, name)).toString('utf8');
    } catch {
      return unreadable();
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      const hit = scanLine(line.replaceAll('\0', '')); // UTF-16 text has NUL bytes between characters
      if (hit) findings.push(`${name}:${i + 1} ${hit.label} ${hit.masked}${UNTRACKED_NOTE}`);
    }
  }
  return { findings };
}

/** @returns {{ deny: string } | null} */
export default function secretGuard(input, { startPath, startUnclear, startHint, addBeforeCommit }) {
  if (startUnclear) return { deny: startHint };
  // No second look at the command: run.mjs hands over a clear start folder only for a git commit
  // (a command it cannot read is unclear and denied above), and a regex here would miss folders
  // with & ; or | in their name.

  // A commit may take working-tree content (-a, pathspecs, --only, --include), so the unstaged
  // changes of tracked files are checked on every commit, besides the index.
  const passes = [['--cached'], []];
  const findings = [];
  const seenFiles = new Set();

  for (const scope of passes) {
    const nameRes = gitResult(startPath, [...BASE, ...DIFF, ...scope, '--name-only', '-z']);
    if (!nameRes.ok) return unreadable();
    for (const name of names(nameRes.stdout)) {
      if (isSecretFile(name) && !seenFiles.has(name)) {
        seenFiles.add(name);
        findings.push(`${name} is a secret file (never commit it)`);
      }
    }
    const diffRes = gitResult(startPath, [...BASE, ...DIFF, '--text', ...scope]);
    if (!diffRes.ok) return unreadable();
    for (const { file, line, text } of addedLines(diffRes.stdout)) {
      const hit = scanLine(text.replaceAll('\0', '')); // UTF-16 text has NUL bytes between characters
      if (hit) findings.push(`${file}:${line} ${hit.label} ${hit.masked}`);
    }
  }

  let untracked = 0;
  if (addBeforeCommit) {
    const res = untrackedFindings(startPath, seenFiles);
    if (res.deny) return res;
    untracked = res.findings.length;
    findings.push(...res.findings);
  }

  if (findings.length === 0) return null;
  const shown = findings.slice(0, MAX_FINDINGS);
  const more = findings.length - shown.length;
  const where = untracked > 0
    ? 'the staged or unstaged changes or in untracked files that git add may pick up for this commit'
    : 'the staged or unstaged changes of this commit';
  const lines = [
    `buildorder: possible secrets in ${where}, so it was blocked:`,
    ...shown.map((f) => `- ${f}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    'Remove them or move them to an environment variable or a gitignored file, then commit again.',
  ];
  return { deny: lines.join('\n') };
}
