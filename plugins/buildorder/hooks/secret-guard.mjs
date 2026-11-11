// PreToolUse (Bash/PowerShell, git commit): scans the staged diff and the staged file names of
// the target repo for secrets and denies with masked findings. run.mjs hands over the folder the
// commit runs in as `startPath`; an undecidable target arrives as `startUnclear` with `startHint`.
// Fail closed: when git cannot be read, the commit is denied.
import { gitResult } from '../lib/git.mjs';
import { isSecretFile, scanLine } from '../lib/secrets.mjs';

const COMMIT_CALL = /\bgit\b[^\n;|&]*\bcommit\b/;
// `-a`, `--all` or a combined short flag such as `-am` / `-va`, after the commit word.
const ALL_FLAG = /(?:^|\s)(?:--all|-[A-Za-z]*a[A-Za-z]*)(?=\s|$)/;
const MAX_FINDINGS = 10;
// Stable output: no quoting of non-ASCII names, no lock files, plain prefixes, no external diff drivers.
const BASE = [
  '--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
];
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--diff-filter=ACMR'];

const unreadable = () => ({ deny: 'buildorder: the staged changes could not be read, so this commit was blocked. Try again.' });

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
      const name = text.slice(4);
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

/** @returns {{ deny: string } | null} */
export default function secretGuard(input, { startPath, startUnclear, startHint }) {
  if (startUnclear) return { deny: startHint };
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !COMMIT_CALL.test(command)) return null;

  const all = ALL_FLAG.test(command.slice(command.search(/\bcommit\b/)));
  const passes = all ? [['--cached'], []] : [['--cached']];
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
    const diffRes = gitResult(startPath, [...BASE, ...DIFF, ...scope]);
    if (!diffRes.ok) return unreadable();
    for (const { file, line, text } of addedLines(diffRes.stdout)) {
      const hit = scanLine(text);
      if (hit) findings.push(`${file}:${line} ${hit.label} ${hit.masked}`);
    }
  }

  if (findings.length === 0) return null;
  const shown = findings.slice(0, MAX_FINDINGS);
  const more = findings.length - shown.length;
  const lines = [
    'buildorder: possible secrets in this commit, so it was blocked:',
    ...shown.map((f) => `- ${f}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    'Remove them or move them to an environment variable or a gitignored file, then commit again.',
  ];
  return { deny: lines.join('\n') };
}
