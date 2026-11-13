// init 1.3.1: findings of the interactive practice test. Every question is a dialog in one turn, commands are shown
// inside the dialog, repo names are checked and offered, no cd or chains, skipped items reach scaffold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/repo.mjs';
import { frontmatter } from '../../plugins/buildorder/lib/detect.mjs';

const raw = readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', 'init', 'SKILL.md'), 'utf8');
const text = raw.replace(/\s+/g, ' ');
const head = text.slice(text.indexOf('# Init'), text.indexOf('## Folder finding'));
const step = (from, to) => text.slice(text.indexOf(from), text.indexOf(to));
const confirmation = step('## 2. Confirmation', '## 3. Write');
const write = step('## 3. Write', '## 4. Fill');
const fill = step('## 4. Fill', '## 5. Check and hand over');
const github = step('## 5. Check and hand over', '## 6. Close');

test('init asks every question with AskUserQuestion and never ends the turn to wait', () => {
  assert.match(head, /ask every question, confirmation and understanding check with `AskUserQuestion`/i);
  assert.match(head, /never end the turn to wait for an answer/i);
  assert.match(head, /pre-approvals of this skill hold only during the turn/i);
  assert.match(head, /"Other"/);
  assert.match(head, /at most 4 questions per call/i);
  assert.match(confirmation, /Ask with `AskUserQuestion`/);
  assert.doesNotMatch(text, /Ask: set it up like this/);
  assert.doesNotMatch(text, /In chat, unless/);
  assert.doesNotMatch(text, /Ask: correct, or correct me/);
  assert.doesNotMatch(text, /Then stop with "This is how I understand/);
});

test('init runs the understanding check as an AskUserQuestion', () => {
  assert.match(fill, /understanding check/i);
  assert.match(fill, /`AskUserQuestion`[^.]*(correct|understand)/i);
  assert.match(fill, /the same turn|without ending the turn/i);
});

test('init puts the exact commands of every consent into the dialog', () => {
  assert.match(head, /`preview` of the "yes" option, one command per line/i);
  assert.match(head, /never refer to "the commands above"/i);
  assert.match(github, /`preview` of the "yes" option/);
  assert.match(github, /docs repo[^]*`preview`|`preview`[^]*docs repo/i);
  assert.match(text, /Removing a skill[^]*`preview`/);
});

test('init names owner/name in the consent and offers another name', () => {
  assert.match(github, /names the target `<owner>\/<name>`/);
  assert.match(github, /"Other" takes a different name/);
  assert.match(github, /`duplicate name`[^.]*ask for a name for each repo of the group/i);
});

test('init checks that a new repo name is free before the consent', () => {
  assert.match(github, /`gh repo view '<owner>\/<name>'`/);
  assert.match(github, /(reads only|only reads)[^.]*without pre-approval|without pre-approval/i);
  assert.match(github, /exists[^.]*another name/i);
});

test('init passes --owner and --name to github-checklist', () => {
  assert.match(github, /github-checklist \. --owner <login> \[--name <path>=<name>\]\.\.\./);
  assert.match(github, /github-plan \. --owner <login> --docs \[--name <path>=<name>\]\.\.\./);
  assert.match(github, /same `--owner` and `--name`/);
});

test('init forbids cd, chains and temp files for every command', () => {
  assert.match(head, /working directory \(the workspace root\)/);
  assert.match(head, /one command per call/i);
  assert.match(head, /never prefix `cd`/i);
  assert.match(head, /never chain with `&&`, `;` or pipes/i);
  assert.match(head, /temp files or heredocs/i);
  assert.match(head, /Read, Edit and Write/);
  assert.match(text, /append each list to `BACKLOG\.md` with Edit/i);
});

test('init passes skipped items to scaffold with --without', () => {
  assert.match(confirmation, /scaffold[^.]*--without <path>:<id>=<reason>/);
  assert.match(write, /--without <path>:<id>=<reason>/);
  assert.match(write.slice(write.indexOf('**Existing project:**')), /--without/);
});

test('init shows option modules in the confirmation, not as an interview question', () => {
  assert.match(confirmation, /web-quality/);
  assert.match(confirmation, /never (asked )?as an interview question|never asked in the interview/);
  assert.match(confirmation, /with the recommendation/i);
});

test('init gives every check at least two options and never continues without an answer', () => {
  assert.match(head, /every `AskUserQuestion` has at least two options/i);
  assert.match(head, /"Correct" and "Fix something"/);
  assert.match(head, /cannot be shown or returns no answer.{0,120}stop and ask again.{0,80}never continue as if the person had confirmed/i);
});

test('init pre-approves the assess skill', () => {
  assert.ok(frontmatter(raw)['allowed-tools'].includes('Skill(buildorder:assess)'));
});
