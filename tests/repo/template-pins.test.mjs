// template-pins.yml keeps the action SHAs of the shipped templates visible to Dependabot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../helpers/repo.mjs';
import { PINS_WORKFLOW, actionRefs, drift, readPins, templateFiles, writePins } from '../../scripts/template-pins.mjs';

const SCRIPT = join(repoRoot, 'scripts', 'template-pins.mjs');
const OLD_SHA = '0'.repeat(40);

/** Temp copy with the pins workflow and every template. */
function tempCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'template-pins-'));
  cpSync(join(repoRoot, '.github'), join(dir, '.github'), { recursive: true });
  cpSync(join(repoRoot, 'plugins'), join(dir, 'plugins'), { recursive: true });
  return dir;
}

/** Rewrites the checkout pin in the first template that uses it. */
function outdate(dir) {
  const rel = templateFiles(dir).find((f) => /actions\/checkout@/.test(readFileSync(join(dir, f), 'utf8')));
  const file = join(dir, rel);
  const text = readFileSync(file, 'utf8').replace(/(actions\/checkout@)[0-9a-f]{40}( # )v[\w.]+/, `$1${OLD_SHA}$2v1.0.0`);
  writeFileSync(file, text);
  return rel;
}

test('actionRefs reads remote actions with SHA and version and skips local and docker references', () => {
  const sha = 'a'.repeat(40);
  const text = [
    `- uses: actions/checkout@${sha} # v7.0.1`,
    `  uses: github/codeql-action/init@${sha}`,
    '- uses: ./local-action',
    '  uses: $/.github/workflows/deployment.yml',
    '- uses: docker://alpine:3',
  ].join('\n');
  assert.deepEqual(actionRefs(text), [
    { action: 'actions/checkout', sha, version: 'v7.0.1', line: 1 },
    { action: 'github/codeql-action/init', sha, version: null, line: 2 },
  ]);
});

test("every template action is listed once in template-pins.yml with the template's SHA and version", () => {
  const problems = drift(repoRoot);
  const lines = problems.map((p) => `${p.file}:${p.line} ${p.action}: ${p.problem}, found ${p.found}, expected ${p.expected}`);
  assert.deepEqual(problems.filter((p) => p.problem !== 'unused'), [],
    `template pins drifted; run \`node scripts/template-pins.mjs --write\`\n${lines.join('\n')}`);
});

test('template-pins.yml lists no action that no template uses', () => {
  const unused = drift(repoRoot).filter((p) => p.problem === 'unused');
  assert.deepEqual(unused, [], `unused pins: ${unused.map((p) => p.action).join(', ')}`);
  assert.ok(readPins(repoRoot).size > 0);
});

test('the pins job never runs and has no permissions', () => {
  const text = readFileSync(join(repoRoot, PINS_WORKFLOW), 'utf8');
  assert.match(text, /^name: template-pins$/m);
  assert.match(text, /^on: workflow_dispatch$/m);
  assert.match(text, /^permissions: \{\}$/m);
  assert.match(text, /^ {2}pins:$/m);
  assert.match(text, /^ {4}if: false$/m);
  assert.match(text, /^ {4}permissions: \{\}$/m);
});

test('drift names file, line and the expected SHA of an outdated template', () => {
  const dir = tempCopy();
  try {
    const rel = outdate(dir);
    const hit = drift(dir).find((p) => p.file === rel && p.problem === 'sha');
    assert.ok(hit, 'drift reports the outdated file');
    assert.equal(hit.action, 'actions/checkout');
    assert.equal(hit.found, OLD_SHA);
    assert.equal(hit.expected, readPins(repoRoot).get('actions/checkout').sha);
    assert.equal(readFileSync(join(dir, rel), 'utf8').split('\n')[hit.line - 1].includes(OLD_SHA), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePins brings an outdated template to the pinned SHA and version and leaves the rest untouched', () => {
  const dir = tempCopy();
  try {
    const rel = outdate(dir);
    const others = templateFiles(dir).filter((f) => f !== rel);
    const before = others.map((f) => readFileSync(join(dir, f), 'utf8'));
    const changed = writePins(dir);
    assert.deepEqual(changed, [rel]);
    const pin = readPins(dir).get('actions/checkout');
    assert.ok(readFileSync(join(dir, rel), 'utf8').includes(`actions/checkout@${pin.sha} # ${pin.version}`));
    assert.deepEqual(others.map((f) => readFileSync(join(dir, f), 'utf8')), before);
    assert.deepEqual(drift(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the check script exits 1 on drift and 0 after --write', () => {
  const dir = tempCopy();
  try {
    const rel = outdate(dir);
    const bad = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    const out = bad.stdout + bad.stderr;
    assert.ok(out.includes(`${rel}:`) && out.includes(`actions/checkout: found ${OLD_SHA}, expected `), out);
    assert.ok(out.includes("node scripts/template-pins.mjs --write"));
    const fix = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.equal(fix.status, 0);
    const ok = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
