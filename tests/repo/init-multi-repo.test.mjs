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
  assert.match(text, /`plan '<repo>' <options of the plan> --gaps` once per code repo/);
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

// --- review 1.3 fixes ---
const multiBranch = step('## Multi-repo branch', '## 1. Interview');

test('init records the docs repo as .=create, which the CLI accepts (I2)', () => {
  assert.match(github, /`--done \.=create`/);
  assert.doesNotMatch(github, /the docs repo has the path `\.`/);
});

test('init offers "settings only" only for a repo that already exists on GitHub (I5)', () => {
  assert.match(github, /yes \/ no \/ settings only.{0,120}`exists: true`/);
  assert.match(github, /otherwise yes \/ no/i);
});

test('init renders every argument in single quotes and asks for --name on an invalid name (M2)', () => {
  assert.match(github, /every argument in single quotes/);
  assert.match(github, /never double quotes/);
  assert.match(github, /`invalid name`.{0,160}`--name <path>=<name>`/);
});

test('init runs the settings commands one by one and ticks each (M6)', () => {
  assert.match(github, /in the order the plan lists them/);
  assert.match(github, /alerts and secret scanning with push protection, then `push`, then the ruleset/);
  assert.match(github, /continue with the next settings command/);
  assert.match(github, /`settings:<name>`/);
  assert.match(github, /`ticks`/);
});

test('init shows the docs command in the opt-in question, with its own consent (M8)', () => {
  assert.match(github, /docs repo has its own consent/i);
  assert.match(github, /gh repo create '<owner>\/<docs name>' --private --source '\.' --remote origin/);
});

test('init texts match 1.3: several repos, the scaffold call, the backlog task (M9)', () => {
  assert.match(frontmatter(raw).description, /several repos/);
  assert.doesNotMatch(frontmatter(raw).description, /or one existing repo/);
  assert.match(multiBranch, /leave out `--repo`/);
  assert.match(multiBranch, /a repo without code gets a value only through its own `<path>=<value>`/);
  assert.match(github, /backlog task/);
});

test('init removes a skill only from the two skill folders, after showing the command (M11)', () => {
  assert.match(text, /parent is exactly `~\/\.claude\/skills` or `<root>\/\.claude\/skills`/);
  assert.match(text, /Show both commands before they run/i);
  assert.doesNotMatch(frontmatter(raw)['allowed-tools'], /\brm\b|Remove-Item|\bmv\b|Move-Item/);
});

test('init moves a removed skill to a backup folder instead of deleting it', () => {
  assert.match(text, /mkdir -p -- '<backup>'/);
  assert.match(text, /mv -n -- '<folder>' '<backup>\/<name>-<YYYY-MM-DD>'/);
  assert.match(text, /New-Item -ItemType Directory -Force -Path '<backup>'/);
  assert.match(text, /Move-Item -LiteralPath '<folder>' -Destination '<backup>\/<name>-<YYYY-MM-DD>'/);
  assert.match(text, /skills-backup/);
  assert.match(text, /how to undo it/);
  assert.doesNotMatch(text, /rm -r|Remove-Item/);
});
