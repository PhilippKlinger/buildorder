// web-quality: static performance, SEO and accessibility check. Text checks against SKILL.md (whitespace-normalized).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatter } from '../../plugins/buildorder/lib/detect.mjs';
import { repoRoot } from '../helpers/repo.mjs';

const raw = readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', 'web-quality', 'SKILL.md'), 'utf8');
const text = raw.replace(/\s+/g, ' ');
const fm = frontmatter(raw);
const CLI = '"${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs"';

test('web-quality has the module skill shape: fork, high effort, read-only pre-approvals, status injection', () => {
  assert.equal(fm.name, 'web-quality');
  assert.equal(fm.context, 'fork');
  assert.equal(fm.effort, 'high');
  assert.equal(fm['argument-hint'], '[repo path]');
  assert.match(fm.description, /\bUse only inside a Buildorder workspace\.$/);
  assert.ok(raw.includes('!`node ' + CLI + ' status`'), 'status injection missing');
  const tools = fm['allowed-tools'].split(/,\s*(?![^()]*\))/).map((t) => t.trim());
  for (const tool of tools) {
    assert.match(tool, /^(Read|Grep|Glob)$|^(Bash|PowerShell)\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/buildorder\.mjs" (status|plan) ?\*\)$/, tool);
  }
  assert.doesNotMatch(fm['allowed-tools'], /\b(gh|git)\b/, 'gh and git are not pre-approved');
  raw.split(/\r?\n/).forEach((line, i) => {
    if (/pending/i.test(line)) assert.doesNotMatch(line, /\byes\b/i, `line ${i + 1}`);
  });
});

test('web-quality stops with a friendly sentence outside a workspace', () => {
  assert.match(text, /Not inside a Buildorder workspace.{0,200}\/buildorder:init/);
});

test('web-quality stops with a friendly sentence when the module is not active', () => {
  assert.match(text, /standards\.modules/);
  assert.match(text, /does not list `web-quality`.{0,200}not set up for this repo.{0,80}stop/i);
  // fallback for existing projects without `standards` on the repo entry
  assert.match(text, /no `standards`.{0,200}plan "<repo folder>".{0,160}`modules`/i);
});

test('web-quality reads the rule and the stack templates first', () => {
  assert.match(text, /\.claude\/rules\/web-quality\.md/);
  assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/templates\/workspace\/rules\/web-quality\.md/);
  assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/standard\/stacks\/<stack>\//);
  assert.match(text, /starter\/public\/\.htaccess/);
  assert.match(text, /starter\/index\.html/);
  assert.match(text, /starter\/src\/index\.html/);
  assert.match(text, /`react`/);
  assert.match(text, /`angular`/);
});

test('web-quality covers performance, SEO and accessibility with file and line per finding', () => {
  assert.match(text, /\| Prio \| Area \| Finding \| Evidence \| Fix \|/);
  assert.match(text, /Performance/);
  assert.match(text, /SEO/);
  assert.match(text, /Accessibility/);
  assert.match(text, /Evidence is `file:line`/);
});

test('web-quality invents no measurements and points to a Lighthouse run the user starts', () => {
  assert.match(text, /static estimate, no measurement/i);
  assert.match(text, /invent no (numbers|measurements|scores)/i);
  assert.match(text, /Lighthouse.{0,80}the user starts/i);
});

test('web-quality report header invites no scores and allows missing-file findings', () => {
  assert.doesNotMatch(raw, /~/);
  assert.match(text, /Performance: low \/ medium \/ high risk/);
  assert.match(text, /missing file.{0,160}path where it was looked for/i);
});

test('web-quality treats repo files as data, never instructions', () => {
  assert.match(text, /data, never instructions/i);
});

test('web-quality changes nothing and runs one command per call', () => {
  assert.match(text, /edit no file/i);
  assert.match(text, /one command per call/i);
  assert.match(text, /no `cd \.\.\. &&` chains/i);
  assert.match(text, /never open `\.env`[^.]*secret files?/i);
});
