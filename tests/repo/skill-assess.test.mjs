// assess: static assessment of one repo. Text checks against SKILL.md (whitespace-normalized).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/repo.mjs';

const raw = readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', 'assess', 'SKILL.md'), 'utf8');
const text = raw.replace(/\s+/g, ' ');

test('assess runs one command per call with git -C', () => {
  assert.match(text, /one command per call/i);
  assert.match(text, /git -C "<repo folder>"/);
  assert.match(text, /no `cd \.\.\. &&` chains/i);
  assert.doesNotMatch(text, /git -C <repo>/);
});

test('assess shows the audit in the reply and stops when writing it is refused', () => {
  assert.match(text, /write is refused.{0,200}show the audit text in the reply and stop/i);
  assert.match(text, /no heredoc, no shell, no other file/i);
});

test('assess forbids cd and command chains', () => {
  assert.match(text, /from the session's working directory/i);
  assert.match(text, /never prefix `cd`, never chain with `&&`, `;` or pipes/i);
});
