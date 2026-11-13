// init: option modules are shown in the confirmation (step 2) and passed on, never asked as a question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/repo.mjs';

const text = readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', 'init', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
const step = (from, to) => text.slice(text.indexOf(from), text.indexOf(to));
const interview = step('## 1. Interview', '## 2. Confirmation');
const confirmation = step('## 2. Confirmation', '## 3. Write');
const write = step('## 3. Write', '## 4. Fill');

test('init recommends versioning for the release style tags with SemVer', () => {
  assert.match(confirmation, /\*\*Options:\*\*/);
  assert.match(confirmation, /Recommend `versioning` when the release style is tags with SemVer/);
  assert.match(confirmation, /`web-quality`/);
});

test('init shows option modules in the confirmation, not as an interview question', () => {
  assert.doesNotMatch(interview, /versioning|web-quality|option module/i);
  assert.match(confirmation, /Options:\*\* the option modules/);
  assert.match(confirmation, /never asked in the interview/);
});

test('init passes the chosen option modules to plan, scaffold and standard', () => {
  assert.match(confirmation, /plan "<repo>" .*\[--with <module>\]\.\.\./);
  assert.match(write, /scaffold \. --lang <lang> --new-repo "<repo>" --visibility <v> \[--with <module>\]\.\.\./);
  assert.match(write, /standard "<repo>" <options of the plan> --apply/);
  assert.match(write, /scaffold \. --lang <lang> --repo "<repo>" --visibility <v> \[--with <module>\]\.\.\./);
  assert.match(write, /every `--with` of the plan/);
});

test('init recommends web-quality for react and angular', () => {
  assert.match(confirmation, /and `web-quality` when the stack is `react` or `angular`/);
  assert.match(confirmation, /`\.claude\/rules\/web-quality\.md`/);
});
