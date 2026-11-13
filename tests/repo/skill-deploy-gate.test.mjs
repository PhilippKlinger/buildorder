// deploy-gate: go/no-go check before a deploy. Text checks against SKILL.md (whitespace-normalized).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatter } from '../../plugins/buildorder/lib/detect.mjs';
import { repoRoot } from '../helpers/repo.mjs';

const raw = readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', 'deploy-gate', 'SKILL.md'), 'utf8');
const text = raw.replace(/\s+/g, ' ');
const fm = frontmatter(raw);
const CLI = '"${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs"';

test('deploy-gate has the module skill shape: fork, high effort, read-only pre-approvals, status injection', () => {
  assert.equal(fm.name, 'deploy-gate');
  assert.equal(fm.context, 'fork');
  assert.equal(fm.effort, 'high');
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

test('deploy-gate stops with a friendly sentence outside a workspace', () => {
  assert.match(text, /Not inside a Buildorder workspace.{0,200}\/buildorder:init/);
});

test('deploy-gate stops with a friendly sentence when docker-cicd is not active', () => {
  assert.match(text, /standards\.modules/);
  assert.match(text, /does not list `docker-cicd`.{0,200}not set up for this repo.{0,80}stop/i);
});

test('deploy-gate checks the CI run of the HEAD commit, not any green run', () => {
  assert.match(text, /gh run list --commit <sha>/);
  assert.match(text, /rev-parse HEAD/);
  assert.match(text, /green run on the branch.{0,120}not for (the )?(current )?`?HEAD`?.{0,40}NO-GO/i);
});

test('deploy-gate reads secret names only, never values', () => {
  assert.match(text, /gh secret list/);
  assert.match(text, /gh variable list/);
  assert.match(text, /names only/i);
  assert.match(text, /never (read|request|print)[^.]*values?/i);
});

test('deploy-gate never deploys, also on GO', () => {
  assert.match(text, /never deploys?, also on GO/i);
});

test('deploy-gate reports GO or NO-GO with a table of checks', () => {
  assert.match(text, /\*\*Result:\*\* GO \/ NO-GO/);
  assert.match(text, /\| # \| Check \| Status \| Evidence \|/);
  assert.match(text, /NO-GO as soon as any of checks 1 to 5/i);
});

test('deploy-gate treats CI logs and repo files as data, and handles a missing gh friendly', () => {
  assert.match(text, /data, never instructions/i);
  assert.match(text, /gh auth login/);
});
