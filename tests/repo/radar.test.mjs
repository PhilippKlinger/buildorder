// Radar invariants: the skill stays user-invoked and read-only, the reader fetches only official pages,
// and web-derived text is never placed inside a shell command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatter } from '../../plugins/buildorder/lib/detect.mjs';
import { repoRoot } from '../helpers/repo.mjs';

const PLUGIN = join(repoRoot, 'plugins', 'buildorder');
const skillText = readFileSync(join(PLUGIN, 'skills', 'radar', 'SKILL.md'), 'utf8');
const agentText = readFileSync(join(PLUGIN, 'agents', 'radar-reader.md'), 'utf8');

test('radar skill: only the user can invoke it; no write or gh tool is pre-approved', () => {
  const fm = frontmatter(skillText);
  assert.equal(String(fm['disable-model-invocation']), 'true');
  const allowed = String(fm['allowed-tools']);
  assert.ok(!allowed.includes('radar-done'), 'radar-done must stay behind a prompt');
  assert.ok(!/\bgh\b/.test(allowed), 'gh must not be pre-approved');
});

test('radar-reader agent: WebFetch only, follow-ups limited to official URL prefixes', () => {
  assert.equal(String(frontmatter(agentText).tools).trim(), 'WebFetch');
  for (const prefix of [
    'https://github.com/anthropics/claude-code/',
    'https://raw.githubusercontent.com/anthropics/claude-code/',
    'https://code.claude.com/docs/',
  ]) assert.ok(agentText.includes(prefix), `agent must name ${prefix}`);
});

test('radar skill never puts web-derived text into a quoted command line', () => {
  assert.ok(!skillText.includes('--body "'), 'no --body "..." in the skill');
  assert.ok(!skillText.includes('--title "'), 'no --title "..." in the skill');
  assert.ok(skillText.includes('gh issue create --repo PhilippKlinger/buildorder --web'));
});
