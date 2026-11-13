// review and secure: in root mode the first line of the reply warns that the built-in review stays pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/repo.mjs';

const load = (name) => readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', name, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
const CASES = [
  { skill: 'review', builtin: '/code-review', command: '/buildorder:review' },
  { skill: 'secure', builtin: '/security-review', command: '/buildorder:secure' },
];

for (const { skill, builtin } of CASES) {
  test(`${skill} warns first in root mode that the built-in ${builtin} stays pending`, () => {
    const text = load(skill);
    assert.match(text, new RegExp(`In root mode, the first line of your reply is: \`Started outside <repo>: the built-in ${builtin} cannot run from here and stays pending\\.`));
    assert.match(text, /before any finding/);
    assert.ok(text.includes(`merge-ready: no (built-in ${builtin} pending)`) || text.includes(`release-ready: no (built-in ${builtin} pending)`));
  });
}

test('the warning names the repo folder to start the session in', () => {
  for (const { skill, command } of CASES) {
    assert.ok(load(skill).includes(`start a session in <repo folder> and call ${command} again.`), skill);
  }
});

test('the warning comes before the correctness and vulnerability steps', () => {
  for (const { skill } of CASES) {
    const text = load(skill);
    const warn = text.indexOf('Started outside <repo>');
    assert.ok(warn > 0, `${skill}: warning missing`);
    assert.ok(warn < text.indexOf('## 2.'), `${skill}: warning must precede step 2`);
  }
});
