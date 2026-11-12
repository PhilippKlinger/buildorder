// The plugin's skills: valid frontmatter, auto-invocable, CLI called via the plugin root, English, no personal names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatter } from '../../plugins/buildorder/lib/detect.mjs';
import { repoRoot } from '../helpers/repo.mjs';

const SKILLS = join(repoRoot, 'plugins', 'buildorder', 'skills');
const WORKFLOW = ['assess', 'handoff', 'kickoff'];
const MODULE = ['review', 'secure'];
const CLI = '"${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs"';
const STATUS_INJECTION = '!`node ' + CLI + ' status`';

const UMLAUT = new RegExp(`[${String.fromCharCode(0xe4, 0xf6, 0xfc, 0xc4, 0xd6, 0xdc, 0xdf)}]`); // built from codes: this file stays ASCII
// Common German function words that have no English homograph.
const GERMAN_WORDS = /\b(und|nicht|oder|der|das|ist|wird|sind|eine|auch|wenn|nur)\b/i;

const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
// The only personal names the repo may hold are the manifest author and owner; skills must not repeat them.
const PERSONAL = [
  readJson('plugins/buildorder/.claude-plugin/plugin.json').author?.name,
  readJson('.claude-plugin/marketplace.json').owner?.name,
].filter(Boolean).flatMap((n) => n.split(/\s+/)).filter((w) => w.length >= 3);

const skills = () => (existsSync(SKILLS) ? readdirSync(SKILLS, { withFileTypes: true }) : [])
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();
const read = (name) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');

test('the workflow and module skills ship with the plugin', () => {
  for (const name of [...WORKFLOW, ...MODULE]) assert.ok(skills().includes(name), `skills/${name}/SKILL.md missing`);
});

test('each skill has frontmatter with its folder name and a description', () => {
  for (const name of skills()) {
    const fm = frontmatter(read(name));
    assert.ok(fm, `${name}: no frontmatter`);
    assert.equal(fm.name, name);
    assert.ok(fm.description?.length >= 40, `${name}: description too short`);
    assert.match(fm.description, /Buildorder workspace/, `${name}: description must name the Buildorder workspace`);
  }
});

test('frontmatter values are valid YAML plain scalars or quoted', () => {
  for (const name of skills()) {
    const text = read(name);
    const head = text.slice(text.indexOf('---') + 3, text.indexOf('\n---', 3));
    for (const line of head.split(/\r?\n/).filter(Boolean)) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      if (/^["']/.test(value)) continue;
      // An unquoted ": " or " #" would end or break the scalar.
      assert.doesNotMatch(value, /: | #/, `${name}: quote the value of '${line}'`);
    }
  }
});

test('workflow and module skills stay automatically invocable', () => {
  for (const name of [...WORKFLOW, ...MODULE]) {
    assert.doesNotMatch(read(name), /^disable-model-invocation:/m, name);
  }
});

test('assess reads untrusted repo code, so writing the audit file asks the user', () => {
  const tools = frontmatter(read('assess'))['allowed-tools'] ?? '';
  assert.doesNotMatch(tools, /(^|[\s,])(Write|Edit)([\s,(]|$)/);
});

test('the CLI is called via the plugin root and every workflow and module skill injects status', () => {
  for (const name of skills()) {
    const text = read(name);
    // Commands in code spans and in allowed-tools patterns.
    for (const m of text.matchAll(/(?:`|\()node\s+(\S+)/g)) {
      assert.ok(m[1].startsWith(CLI), `${name}: CLI path must be ${CLI}, got ${m[1]}`);
    }
  }
  for (const name of [...WORKFLOW, ...MODULE]) {
    assert.ok(read(name).includes(STATUS_INJECTION), `${name}: status injection missing`);
  }
});

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Read-only pre-approvals: file tools that only read and the CLI's status and plan commands, which take no
// writing option. Git patterns are not pre-approved: a `*` also matches `-c core.fsmonitor=...`, `--output=`
// and other subcommands; Claude Code's own read-only git handling decides instead.
const READ_ONLY_TOOL = new RegExp([
  '^(Read|Grep|Glob)$',
  `^(Bash|PowerShell)\\(node ${escape(CLI)} (status|plan) ?\\*\\)$`,
].join('|'));

test('module skills only report: they run in a fork and pre-approve read-only tools only', () => {
  const writing = ['Write', 'Edit', 'Bash', 'Bash(*)', 'Bash(git -C * diff*)', 'PowerShell(git -C * status*)',
    'Bash(node x.mjs status*)', `Bash(node ${CLI} standard *)`];
  for (const probe of writing) {
    assert.ok(!READ_ONLY_TOOL.test(probe), `probe '${probe}' must not count as read-only`);
  }
  for (const probe of ['Read', `Bash(node ${CLI} status*)`, `PowerShell(node ${CLI} plan *)`]) {
    assert.ok(READ_ONLY_TOOL.test(probe), `probe '${probe}' must count as read-only`);
  }
  for (const name of MODULE) {
    const fm = frontmatter(read(name));
    assert.equal(fm.context, 'fork', `${name}: context must be fork`);
    const tools = (fm['allowed-tools'] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    assert.ok(tools.length > 0, `${name}: allowed-tools missing`);
    for (const tool of tools) assert.match(tool, READ_ONLY_TOOL, `${name}: '${tool}' is not read-only`);
  }
});

test('skills are English and hold no personal names', () => {
  assert.ok(PERSONAL.length > 0, 'manifest names must be readable');
  assert.ok(GERMAN_WORDS.test('das ist gut') && !GERMAN_WORDS.test('this is the plan'), 'German word probe');
  for (const name of skills()) {
    const lines = read(name).split(/\r?\n/);
    lines.forEach((line, i) => {
      assert.doesNotMatch(line, UMLAUT, `${name}:${i + 1}`);
      assert.doesNotMatch(line, GERMAN_WORDS, `${name}:${i + 1}`);
      for (const word of PERSONAL) {
        assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(line), `${name}:${i + 1} holds a personal name`);
      }
    });
  }
});
