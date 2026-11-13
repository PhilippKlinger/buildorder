#!/usr/bin/env node
// Keeps the action pins of the shipped templates in line with .github/workflows/template-pins.yml,
// the one file Dependabot can update. Check: `node scripts/template-pins.mjs [--root <dir>]`;
// transfer the pins into the templates: add `--write`. Repo tooling, not shipped with the plugin.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINS_WORKFLOW = '.github/workflows/template-pins.yml';

const REPO_TEMPLATES = 'plugins/buildorder/templates/repo';
const STACKS = 'plugins/buildorder/standard/stacks';
const USES = /^(\s*(?:-\s+)?uses:\s*)([^\s@#]+)@([0-9a-f]{40})(?:\s+#\s*(v\S+))?/;

function walk(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const r = `${rel}/${e.name}`;
    return e.isDirectory() ? walk(root, r) : [r];
  });
}

/** Repo-relative paths of every template workflow, sorted. */
export function templateFiles(root) {
  const stacks = existsSync(join(root, STACKS))
    ? readdirSync(join(root, STACKS), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${STACKS}/${e.name}/ci.yml`)
        .filter((f) => existsSync(join(root, f)))
    : [];
  const repo = walk(root, REPO_TEMPLATES).filter((f) => f.endsWith('.yml'));
  return [...repo, ...stacks].sort();
}

/** Remote `uses:` references with SHA and `# v…` comment; local, `$/` and docker references are skipped. */
export function actionRefs(text) {
  const refs = [];
  text.split('\n').forEach((raw, i) => {
    const m = USES.exec(raw);
    if (m) refs.push({ action: m[2], sha: m[3], version: m[4] ?? null, line: i + 1 });
  });
  return refs;
}

/** action -> { sha, version } from the pins workflow. */
export function readPins(root) {
  const pins = new Map();
  for (const r of actionRefs(readFileSync(join(root, PINS_WORKFLOW), 'utf8'))) {
    if (pins.has(r.action)) throw new Error(`template-pins.yml lists '${r.action}' twice`);
    pins.set(r.action, { sha: r.sha, version: r.version });
  }
  return pins;
}

/** Differences between the templates and the pins. */
export function drift(root) {
  const pins = readPins(root);
  const used = new Set();
  const out = [];
  for (const file of templateFiles(root)) {
    for (const r of actionRefs(readFileSync(join(root, file), 'utf8'))) {
      used.add(r.action);
      const pin = pins.get(r.action);
      if (!pin) out.push({ file, line: r.line, action: r.action, problem: 'unlisted', found: r.sha, expected: 'a pin in template-pins.yml' });
      else if (r.sha !== pin.sha) out.push({ file, line: r.line, action: r.action, problem: 'sha', found: r.sha, expected: pin.sha });
      else if (r.version !== pin.version) out.push({ file, line: r.line, action: r.action, problem: 'version', found: r.version ?? 'no version comment', expected: pin.version ?? 'no version comment' });
    }
  }
  const pinLines = new Map(actionRefs(readFileSync(join(root, PINS_WORKFLOW), 'utf8')).map((r) => [r.action, r.line]));
  for (const [action, pin] of pins) {
    if (!used.has(action)) out.push({ file: PINS_WORKFLOW, line: pinLines.get(action), action, problem: 'unused', found: pin.sha, expected: 'no pin (no template uses it)' });
  }
  return out;
}

/** Writes the pinned SHA and version comment into the templates; returns the changed files. */
export function writePins(root) {
  const pins = readPins(root);
  const changed = [];
  for (const file of templateFiles(root)) {
    const path = join(root, file);
    const text = readFileSync(path, 'utf8');
    const next = text
      .split('\n')
      .map((raw) => {
        const m = USES.exec(raw);
        const pin = m && pins.get(m[2]);
        if (!pin) return raw;
        const rest = raw.slice(m[0].length);
        return `${m[1]}${m[2]}@${pin.sha}${pin.version ? ` # ${pin.version}` : ''}${rest}`;
      })
      .join('\n');
    if (next !== text) {
      writeFileSync(path, next);
      changed.push(file);
    }
  }
  return changed;
}

function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const i = argv.indexOf('--root');
  if (i !== -1) root = resolve(argv[i + 1] ?? '.');
  if (argv.includes('--write')) {
    for (const f of writePins(root)) console.log(`updated ${f}`);
  }
  const problems = drift(root);
  for (const p of problems) console.log(`${p.file}:${p.line} ${p.action}: found ${p.found}, expected ${p.expected}`);
  if (problems.length) {
    console.log('Fix: node scripts/template-pins.mjs --write');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
