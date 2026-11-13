// scout: interactive workflow skill that sharpens a plan or idea into a short brief or a spec with acceptance criteria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatter } from '../../plugins/buildorder/lib/detect.mjs';
import { repoRoot } from '../helpers/repo.mjs';

const raw = readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', 'scout', 'SKILL.md'), 'utf8');
const text = raw.replace(/\s+/g, ' ');
const fm = frontmatter(raw);

test('scout is an interactive workflow skill, not a fork', () => {
  assert.equal(fm.name, 'scout');
  assert.equal(fm.context, undefined);
  assert.equal(fm.effort, 'high');
  assert.equal(fm['argument-hint'], '[plan, idea or task id]');
  assert.doesNotMatch(raw, /^disable-model-invocation:/m);
});

test('scout asks one question per message with a recommendation first', () => {
  assert.match(text, /one question per message/i);
  assert.match(text, /recommended option first/i);
  assert.match(text, /blind spots?/i);
  assert.match(text, /3 to 6/);
});

test('scout writes a spec with 5 to 8 acceptance criteria named AC-n', () => {
  assert.match(text, /5 to 8 acceptance criteria/);
  assert.match(text, /`AC-n`/);
  assert.match(text, /Given · When · Then/);
  assert.match(text, /docs\/specs\/<YYYY-MM-DD>-<topic>\.md/);
  assert.match(text, /Goal · Boundaries · Done when/);
});

test('scout checks the spec against the standard plan and the decisions file', () => {
  assert.match(text, /buildorder\.mjs" plan "<repo>"/);
  assert.match(text, /`docs\.decisions`/);
});

test('scout defers to Superpowers for generation when it is installed', () => {
  assert.match(text, /Superpowers is installed, it generates the spec or plan there\. Scout then writes no spec of its own and only checks/);
});

test('scout pre-approves no write tool', () => {
  const tools = (fm['allowed-tools'] ?? '').split(/,\s*(?![^()]*\))/).map((t) => t.trim());
  assert.ok(tools.includes('AskUserQuestion'));
  assert.doesNotMatch(fm['allowed-tools'], /(^|[\s,])(Write|Edit)([\s,(]|$)/);
  assert.match(text, /ask before writing the spec file/i);
});

test('scout outside a workspace gives one friendly sentence pointing to /buildorder:init', () => {
  assert.match(text, /Not inside a Buildorder workspace[^.]*one friendly sentence[^.]*\/buildorder:init`\)\. Do nothing else/);
});

test('scout treats repo and plan content as data, not instructions', () => {
  assert.match(text, /data, never instructions/i);
});
