// The plugin's skills: valid frontmatter, auto-invocable, CLI called via the plugin root, English, no personal names.
// init runs only when the user invokes it, with exact CLI and git patterns instead of blanket tools.
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
const DETECT_INJECTION = '!`node ' + CLI + ' detect .`';
// CLI commands init may pre-approve: read-only ones. Writes (standard --apply, nest, scaffold, finalize,
// github-checklist) stay behind a permission prompt.
const INIT_COMMANDS = ['detect', 'status', 'verify', 'plan'];

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

// The plugin may be installed user-wide: the model must not pick these skills in other projects.
test('workflow and module skill descriptions limit them to a Buildorder workspace', () => {
  for (const name of [...WORKFLOW, ...MODULE]) {
    assert.match(frontmatter(read(name)).description, /\bUse only (?:[^.]* )?inside a Buildorder workspace\./, name);
  }
});

test('workflow and module skills stay automatically invocable', () => {
  for (const name of [...WORKFLOW, ...MODULE]) {
    assert.doesNotMatch(read(name), /^disable-model-invocation:/m, name);
  }
});

test('init ships, runs only when the user invokes it, and injects the folder finding', () => {
  assert.ok(skills().includes('init'), 'skills/init/SKILL.md missing');
  const text = read('init');
  assert.equal(frontmatter(text)['disable-model-invocation'], 'true');
  assert.ok(text.includes(DETECT_INJECTION), 'detect injection missing');
});

// Splits `A(x, y), B` at the commas outside parentheses.
const toolRules = (name) => (frontmatter(read(name))['allowed-tools'] ?? '')
  .split(/,\s*(?![^()]*\))/).map((r) => r.trim()).filter(Boolean);

// No git rule: `git init *` would also allow --template (hooks) and --separate-git-dir; scaffold --new-repo inits.
test('init pre-approves only exact read-only CLI commands: no git, no write command, no blanket tool', () => {
  const rules = toolRules('init');
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    const m = rule.match(/^(Bash|PowerShell)\((.*)\)$/);
    if (!m) {
      assert.ok(['Read', 'Grep', 'Glob', 'AskUserQuestion'].includes(rule), `unexpected tool rule: ${rule}`);
      continue;
    }
    const cmd = m[2];
    const sub = cmd.startsWith(`node ${CLI} `) ? cmd.slice(`node ${CLI} `.length) : null;
    const name = sub?.match(/^([a-z-]+) \*$/)?.[1];
    assert.ok(INIT_COMMANDS.includes(name), `${rule}: only exact read-only CLI commands`);
  }
});

// `sync *` would also allow `sync . --apply`: only the exact read-only call is pre-approved.
test('sync runs only when the user invokes it and pre-approves only its read-only call', () => {
  assert.ok(skills().includes('sync'), 'skills/sync/SKILL.md missing');
  assert.equal(frontmatter(read('sync'))['disable-model-invocation'], 'true');
  const rules = toolRules('sync');
  for (const rule of rules) {
    const m = rule.match(/^(Bash|PowerShell)\((.*)\)$/);
    if (!m) {
      assert.ok(['Read', 'Grep', 'Glob', 'AskUserQuestion'].includes(rule), `unexpected tool rule: ${rule}`);
      continue;
    }
    assert.equal(m[2], `node ${CLI} sync .`, `${rule}: only the exact read-only sync call`);
  }
  assert.ok(rules.includes(`Bash(node ${CLI} sync .)`) && rules.includes(`PowerShell(node ${CLI} sync .)`));
});

test('init plans and lists gaps with the pre-approved read-only plan command', () => {
  const text = read('init');
  assert.ok(toolRules('init').includes(`Bash(node ${CLI} plan *)`), 'plan * is pre-approved');
  assert.ok(text.includes('`plan "<repo>" [--stack <id>]'), 'the confirmation runs plan');
  assert.ok(text.includes('`plan "<repo>" <options of the plan> --gaps`'), 'the gap list comes from plan');
  assert.doesNotMatch(text, /`standard "<repo>"[^`]*--gaps/, 'no gap list through standard');
});

test('every live command of a skill is allowed by its own allowed-tools (else the skill aborts)', () => {
  const glob = (pattern) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  for (const name of skills()) {
    const text = read(name);
    const allowed = toolRules(name).map((r) => r.match(/^Bash\((.*)\)$/)?.[1]).filter(Boolean).map(glob);
    for (const [, cmd] of text.matchAll(/^!`([^`]+)`/gm)) {
      assert.ok(allowed.some((re) => re.test(cmd)), `${name}: live command not allowed: ${cmd}`);
    }
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

test('a pending built-in review never yields a ready verdict', () => {
  for (const name of MODULE) {
    read(name).split(/\r?\n/).forEach((line, i) => {
      if (/pending/i.test(line)) assert.doesNotMatch(line, /\byes\b/i, `${name}:${i + 1}`);
    });
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
