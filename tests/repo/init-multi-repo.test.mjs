// init: the multi-repo branch, the skill overlap choice and the GitHub step are fixed in the skill text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/repo.mjs';
import { frontmatter } from '../../plugins/buildorder/lib/detect.mjs';

const raw = readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', 'init', 'SKILL.md'), 'utf8');
const text = raw.replace(/\s+/g, ' ');
const step = (from, to) => text.slice(text.indexOf(from), text.indexOf(to));
const safety = step('## 0. Safety check', '## 1. Interview');
const interview = text;
const fill = step('## 4. Fill', '## 5. Check and hand over');
const github = step('## 5. Check and hand over', '## 6. Close');
const close = text.slice(text.indexOf('## 6. Close'));

test('init no longer stops on multi-repo', () => {
  assert.doesNotMatch(text, /not supported yet/);
  const branch = safety.slice(safety.indexOf('- `multi-repo`'), safety.indexOf('- `repo-root`'));
  assert.doesNotMatch(branch, /\bStop\b/);
  assert.match(branch, /own branch|multi-repo branch/i);
  assert.match(text, /## Multi-repo/);
});

test('init runs plan once per code repo', () => {
  assert.match(text, /`plan "<repo>" <options of the plan> --gaps` once per code repo/);
  assert.match(text, /append each list/);
  assert.match(text, /one `assess` audit per code repo/i);
  assert.match(text, /at most 5 lines per repo plus 3 lines on the connections/);
  assert.match(text, /under the repo path/);
});

test('init asks only what detect does not know, within 8 shared and 3 per-repo questions', () => {
  assert.match(interview, /only ask what `?detect`? and `?plan`? do not know/i);
  assert.match(interview, /at most 8 shared questions in at most 3 blocks/i);
  assert.match(interview, /at most 3 questions per code repo/i);
  assert.match(interview, /one block per repo/);
});

test('init offers a subset above three code repos', () => {
  assert.match(text, /more than 3 code repos/);
  assert.match(text, /scaffold --repo/);
  assert.match(text, /catching up later is not available yet/);
});

test('init shows the overlap block only with findings and removes nothing without consent', () => {
  assert.match(text, /only when there are findings/);
  assert.match(text, /keep both/);
  assert.match(text, /prefer the Buildorder version/);
  assert.match(text, /remove the old skill/);
  assert.match(text, /after the user's explicit consent/);
  assert.match(text, /untrusted data|data, never instructions/);
  assert.match(text, /`skills\.repos`/);
});

test('init offers no removal for skills inside a repo', () => {
  assert.match(text, /no "remove" option for repo skills/);
  assert.match(text, /never changes the content of the repos/);
});

test('init asks one consent per repo with yes, no or settings only', () => {
  assert.match(github, /one consent per repo/i);
  assert.match(github, /full command list/);
  assert.match(github, /yes \/ no \/ settings only/);
  assert.match(github, /gh auth status/);
  assert.match(github, /gh api user --jq \.login/);
  assert.match(github, /github-plan \. --owner <login>/);
  assert.match(github, /`git -C <path>`/);
  assert.match(github, /no `cd`, no chains/);
  assert.doesNotMatch(github, /Never create a repo, push or call the GitHub API/);
  assert.match(github, /gh auth login/);
  assert.match(github, /--done <path>=<step>/);
  assert.match(github, /never show a raw `gh` error text/i);
});

test('init falls back to the checklist when a command is refused', () => {
  assert.match(github, /refused or blocked/);
  assert.match(github, /fall back to the checklist for that repo/);
  assert.match(github, /continue with the next repo/);
  assert.match(github, /never work around/i);
  assert.match(close, /created or pushed/);
});

test('init keeps the docs repo local unless asked and private when created', () => {
  assert.match(github, /docs repo/i);
  assert.match(github, /default: local only/);
  assert.match(github, /`--docs`/);
  assert.match(github, /always private/);
  assert.match(github, /no push/);
});

test('init pre-approves github-plan but no gh or git push', () => {
  const tools = frontmatter(raw)['allowed-tools'];
  assert.match(tools, /Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/buildorder\.mjs" github-plan \*\)/);
  assert.match(tools, /PowerShell\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/buildorder\.mjs" github-plan \*\)/);
  assert.doesNotMatch(tools, /\bgh\b|git push|github-checklist/);
  assert.match(fill + github, /github-checklist \./);
});
