import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, cli, codeRepo, commitAll, gitIn, gitInit, tmp, write } from '../helpers/cli.mjs';
import { repoRoot } from '../helpers/repo.mjs';

after(cleanup);

const DOC_FILES = ['HANDOFF.md', 'SPRINT.md', 'BACKLOG.md', 'BACKLOG_ARCHIVE.md', 'DECISIONS.md', 'assumptions.md'];
// .gitignore keeps the machine-local Claude settings (and every repo folder) out of the docs repo.
const ALL_FILES = ['.claude/workspace.json', 'CLAUDE.md', ...DOC_FILES, '.gitignore'];
const LOCAL = '/.claude/settings.local.json';
const DOCS = {
  handoff: 'HANDOFF.md',
  sprint: 'SPRINT.md',
  backlog: 'BACKLOG.md',
  archive: 'BACKLOG_ARCHIVE.md',
  decisions: 'DECISIONS.md',
  assumptions: 'assumptions.md',
};

const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');
const wsOf = (dir) => JSON.parse(read(dir, '.claude/workspace.json'));
const sorted = (a) => [...a].sort();
const VERSION = JSON.parse(readFileSync(join(repoRoot, 'plugins', 'buildorder', '.claude-plugin', 'plugin.json'), 'utf8')).version;
const sha = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

function scaffold(dir, ...args) {
  const r = cli('scaffold', dir, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
}

test('empty folder gets the English doc-map, CLAUDE.md and workspace.json', () => {
  const dir = tmp('scaffold empty');
  const out = scaffold(dir);
  assert.equal(out.ok, true);
  assert.equal(out.dir, dir);
  assert.deepEqual(sorted(out.created), sorted(ALL_FILES));
  assert.deepEqual(out.skipped, []);
  const { templateHashes, ...ws } = wsOf(dir);
  assert.deepEqual(ws, {
    schemaVersion: 1,
    name: 'target dir',
    buildorderVersion: VERSION,
    language: { docs: 'en' },
    initPhase: 'scaffolded',
    docs: DOCS,
    repos: [],
    guards: { docsOnlyNames: DOC_FILES, protectedPaths: [] },
  });
  assert.deepEqual(sorted(Object.keys(templateHashes)), sorted(['CLAUDE.md', ...DOC_FILES]));
  assert.match(read(dir, 'CLAUDE.md'), /^# CLAUDE\.md — target dir\n/);
  assert.match(read(dir, 'HANDOFF.md'), /^# Handoff — \d{4}-\d{2}-\d{2}\n/);
  for (const f of ALL_FILES) assert.doesNotMatch(read(dir, f), /\{\{/, `${f} has no open placeholder`);
});

test('--lang de and --name write German docs under that name', () => {
  const dir = tmp('scaffold de');
  scaffold(dir, '--lang', 'de', '--name', 'demo');
  const ws = wsOf(dir);
  assert.equal(ws.name, 'demo');
  assert.deepEqual(ws.language, { docs: 'de' });
  assert.match(read(dir, 'HANDOFF.md'), /^# \u00dcbergabe — /);
  assert.match(read(dir, 'SPRINT.md'), /^# Sprint — demo\n/);
  assert.match(read(dir, 'CLAUDE.md'), /Fachbegriffe bleiben englisch/);
});

test('existing files are kept and a second run changes nothing', () => {
  const dir = tmp('scaffold keep');
  write(dir, { 'SPRINT.md': 'mine\n' });
  const first = scaffold(dir);
  assert.deepEqual(first.skipped, ['SPRINT.md']);
  assert.equal(read(dir, 'SPRINT.md'), 'mine\n');

  const before = Object.fromEntries(ALL_FILES.map((f) => [f, read(dir, f)]));
  const second = scaffold(dir, '--lang', 'de', '--name', 'other');
  assert.deepEqual(second.created, []);
  assert.deepEqual(sorted(second.skipped), sorted(ALL_FILES));
  for (const f of ALL_FILES) assert.equal(read(dir, f), before[f], `${f} unchanged`);
});

// sync updates a file only while it is byte for byte what buildorder wrote (Review Focus 4).
test('scaffold records its version and a hash of every file it writes from a template, for sync', () => {
  const dir = tmp('scaffold hashes');
  write(dir, { 'SPRINT.md': 'mine\n' });
  scaffold(dir);
  const ws = wsOf(dir);
  assert.equal(ws.buildorderVersion, VERSION);
  const templates = join(repoRoot, 'plugins', 'buildorder', 'templates', 'workspace', 'en');
  for (const f of ['CLAUDE.md', ...DOC_FILES.filter((f) => f !== 'SPRINT.md')]) {
    assert.deepEqual(ws.templateHashes[f], { file: sha(read(dir, f)), template: sha(read(templates, f)) }, f);
  }
  assert.equal(ws.templateHashes['SPRINT.md'], undefined, "a file the user had is not buildorder's");

  // A resume records the files it creates and keeps the earlier records.
  const earlier = ws.templateHashes['CLAUDE.md'];
  rmSync(join(dir, 'HANDOFF.md'));
  scaffold(dir);
  const resumed = wsOf(dir).templateHashes;
  assert.deepEqual(resumed['CLAUDE.md'], earlier);
  assert.equal(resumed['HANDOFF.md'].file, sha(read(dir, 'HANDOFF.md')));
});

test('Claude Code local settings in .claude do not block, stay as they are and stay out of the docs repo', () => {
  const dir = tmp('scaffold local settings');
  write(dir, { '.claude/settings.local.json': '{ "permissions": {} }\n' });
  const out = scaffold(dir);
  assert.deepEqual(sorted(out.created), sorted(ALL_FILES));
  assert.equal(read(dir, '.claude/settings.local.json'), '{ "permissions": {} }\n');
  assert.equal(read(dir, '.gitignore'), `${LOCAL}\n`);
  assert.deepEqual(out.ignored, [LOCAL]);
  assert.equal(gitIn(dir, 'check-ignore', '.claude/settings.local.json'), '.claude/settings.local.json');
  assert.doesNotMatch(gitIn(dir, 'status', '--porcelain', '--untracked-files=all'), /settings\.local\.json/,
    'never part of the first docs commit');
});

test('a rerun without --lang and --name keeps those of the workspace', () => {
  const dir = tmp('scaffold resume');
  scaffold(dir, '--lang', 'de', '--name', 'demo');
  rmSync(join(dir, 'HANDOFF.md'));
  rmSync(join(dir, 'SPRINT.md'));
  const out = scaffold(dir);
  assert.deepEqual(sorted(out.created), ['HANDOFF.md', 'SPRINT.md']);
  assert.match(read(dir, 'HANDOFF.md'), /^# \u00dcbergabe — /);
  assert.match(read(dir, 'SPRINT.md'), /^# Sprint — demo\n\n\*\*Stand:\*\*/);
});

test('repos come from detect; --repo selects among them', () => {
  const dir = tmp('scaffold repos');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  codeRepo(null, { 'README.md': '# notes\n' }, { dir: join(dir, 'notes') });
  scaffold(dir);
  assert.deepEqual(wsOf(dir).repos, [
    { path: 'app', isCode: true, stacks: ['angular'] },
    { path: 'notes', isCode: false, stacks: [] },
  ]);

  const picked = tmp('scaffold pick');
  codeRepo(null, undefined, { dir: join(picked, 'app') });
  codeRepo(null, { 'README.md': '# notes\n' }, { dir: join(picked, 'notes') });
  scaffold(picked, '--repo', './app/');
  assert.deepEqual(wsOf(picked).repos.map((r) => r.path), ['app']);
});

test('--visibility records the visibility on each repo entry, for /buildorder:secure', () => {
  const dir = tmp('scaffold visibility');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  scaffold(dir, '--visibility', 'private');
  assert.deepEqual(wsOf(dir).repos, [{ path: 'app', isCode: true, stacks: ['angular'], visibility: 'private' }]);
});

test('--new-repo creates the code repo with git init on main and records only it; a rerun keeps it', () => {
  const dir = tmp('scaffold new repo');
  const out = scaffold(dir, '--new-repo', 'shop app', '--visibility', 'public');
  assert.equal(out.ok, true);
  const repo = join(dir, 'shop app');
  assert.ok(existsSync(join(repo, '.git')));
  assert.equal(gitIn(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.deepEqual(wsOf(dir).repos, [{ path: 'shop app', isCode: false, stacks: [], visibility: 'public' }]);

  const again = scaffold(dir, '--new-repo', 'shop app');
  assert.deepEqual(again.created, []);
  assert.equal(gitIn(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
});

test('--new-repo refuses a bad name and a folder that exists without git, and writes nothing', () => {
  const bad = tmp('scaffold new repo bad');
  for (const name of ['a/b', '..', '../out']) {
    const r = cli('scaffold', bad, '--new-repo', name);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /^buildorder: invalid --new-repo /, name);
  }
  assert.deepEqual(readdirSync(bad), []);

  const taken = tmp('scaffold new repo taken');
  write(taken, { 'app/notes.txt': 'mine\n' });
  const r = cli('scaffold', taken, '--new-repo', 'app');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^buildorder: --new-repo 'app' exists and is not a git repo/);
  assert.deepEqual(readdirSync(taken), ['app']);
  assert.deepEqual(readdirSync(join(taken, 'app')), ['notes.txt']);
});

test('refuses folders that are no place for a workspace, and writes nothing', () => {
  const repo = codeRepo('scaffold repo root');
  const r = cli('scaffold', repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^buildorder: .*code repo.*nest/);
  assert.equal(existsSync(join(repo, 'CLAUDE.md')), false);

  const agent = tmp('scaffold agent');
  write(agent, { 'CLAUDE.md': 'own\n' });
  const a = cli('scaffold', agent);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /^buildorder: .*CLAUDE\.md/);
  assert.deepEqual(readdirSync(agent), ['CLAUDE.md']);

  const unknown = tmp('scaffold unknown repo');
  const u = cli('scaffold', unknown, '--repo', 'missing');
  assert.equal(u.status, 1);
  assert.match(u.stderr, /^buildorder: .*missing/);
  assert.deepEqual(readdirSync(unknown), []);
});

test('invalid options fail with one line', () => {
  const dir = tmp('scaffold options');
  for (const args of [['--lang', 'fr'], ['--name', 'a/b'], ['--visibility', 'internal'], ['--nope']]) {
    const r = cli('scaffold', dir, ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^buildorder: [^\n]+\n$/, args.join(' '));
  }
  assert.deepEqual(readdirSync(dir), []);
});

// The workspace root is the private docs repo (spec "Zwei Orte"): git init without a commit, repos gitignored.
const topOf = (dir) => realpathSync.native(gitIn(dir, 'rev-parse', '--show-toplevel'));

test('a new workspace root becomes a git repo on main without a commit, and every repo is gitignored', () => {
  const dir = tmp('scaffold root repo');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  const out = scaffold(dir, '--new-repo', 'shop app');
  assert.equal(out.rootRepo, 'created');
  assert.equal(topOf(dir), realpathSync.native(dir));
  assert.equal(gitIn(dir, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(gitIn(dir, 'rev-list', '--all', '--count'), '0', 'scaffold makes no commit');
  assert.ok(out.created.includes('.gitignore'));
  assert.equal(read(dir, '.gitignore'), `${LOCAL}\n/app/\n/shop app/\n`);
  assert.deepEqual(out.ignored, [LOCAL, '/app/', '/shop app/']);
  const untracked = gitIn(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.slice(3));
  assert.deepEqual(sorted(untracked), sorted(ALL_FILES), 'the nested repos are never added');

  const again = scaffold(dir);
  assert.equal(again.rootRepo, 'existing');
  assert.deepEqual(again.ignored, []);
  assert.ok(again.skipped.includes('.gitignore'));
  assert.equal(read(dir, '.gitignore'), `${LOCAL}\n/app/\n/shop app/\n`);
});

test('a root that is a repo or lies inside one is left alone; an existing .gitignore only gets the missing entries', () => {
  const own = tmp('scaffold own repo');
  gitInit(own);
  write(own, { 'notes.md': '# mine\n', '.gitignore': 'node_modules/\n/app/' });
  commitAll(own, 'mine');
  codeRepo(null, undefined, { dir: join(own, 'app') });
  codeRepo(null, { 'README.md': '# lib\n' }, { dir: join(own, 'lib') });
  const head = gitIn(own, 'rev-parse', 'HEAD');
  const out = scaffold(own);
  assert.equal(out.rootRepo, 'existing');
  assert.equal(gitIn(own, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(read(own, '.gitignore'), `node_modules/\n/app/\n${LOCAL}\n/lib/\n`);
  assert.deepEqual(out.ignored, [LOCAL, '/lib/']);
  assert.ok(!out.created.includes('.gitignore') && !out.skipped.includes('.gitignore'));

  const parent = tmp('scaffold parent repo');
  gitInit(parent);
  write(parent, { 'README.md': '# parent\n' });
  commitAll(parent, 'parent');
  const inner = join(parent, 'work space');
  codeRepo(null, undefined, { dir: join(inner, 'app') });
  const nested = scaffold(inner);
  assert.equal(nested.rootRepo, 'existing');
  assert.equal(existsSync(join(inner, '.git')), false, 'no repo inside the parent repo');
  assert.equal(read(inner, '.gitignore'), `${LOCAL}\n/app/\n`);
  // A line the user already has in another spelling counts as present.
  write(inner, { '.gitignore': '.claude/settings.local.json\n' });
  const kept = scaffold(inner);
  assert.equal(kept.rootRepo, 'existing');
  assert.equal(existsSync(join(inner, '.git')), false, 'no repo inside the parent repo');
  assert.equal(read(inner, '.gitignore'), '.claude/settings.local.json\n/app/\n');
  assert.deepEqual(kept.ignored, ['/app/']);
});

test('scaffold --with records the option modules on the repo entry', () => {
  const dir = tmp('scaffold with');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  codeRepo(null, { 'README.md': '# notes\n' }, { dir: join(dir, 'notes') });
  scaffold(dir, '--repo', 'app', '--with', 'versioning', '--with', 'versioning');
  const app = wsOf(dir).repos[0];
  assert.deepEqual(app.standards.modules.at(-1), 'versioning');
  assert.equal(app.standards.modules.filter((m) => m === 'versioning').length, 1);
  const plain = tmp('scaffold without');
  codeRepo(null, undefined, { dir: join(plain, 'app') });
  scaffold(plain);
  assert.equal('standards' in wsOf(plain).repos[0], false);
});

test('scaffold --with versioning keeps docker-cicd for a repo with a Dockerfile', () => {
  const dir = tmp('scaffold with image');
  codeRepo(null, {
    'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20' } }),
    'angular.json': '{}',
    Dockerfile: 'FROM node:22\n',
  }, { dir: join(dir, 'app') });
  scaffold(dir, '--repo', 'app', '--with', 'versioning');
  const { standards } = wsOf(dir).repos[0];
  assert.deepEqual(standards.modules, ['angular', 'docker-cicd', 'versioning']);
  assert.ok(Array.isArray(standards.deviations));
  assert.equal(existsSync(join(dir, 'app', '.github')), false, 'no repo file written');
});

test('scaffold refuses an unknown option before writing anything', () => {
  const dir = tmp('scaffold with refused');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  for (const id of ['nope', 'codeql']) {
    const r = cli('scaffold', dir, '--with', id);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^buildorder: (unknown option 'nope'|'codeql' is not an option \(class mandatory\))\n$/);
  }
  assert.equal(existsSync(join(dir, '.claude')), false);
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
});

const RULE = '.claude/rules/web-quality.md';

test('scaffold --with web-quality writes the web-quality rule scoped to the repo\'s sources', () => {
  const dir = tmp('scaffold wq');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  const out = scaffold(dir, '--repo', 'app', '--with', 'web-quality');
  assert.ok(out.created.includes(RULE));
  const rule = read(dir, RULE);
  assert.match(rule, /^---\npaths:\n  - "app\/src\/\*\*\/\*\.\{ts,tsx,html,css,scss\}"\n  - "app\/index\.html"\n---\n/);
  for (const h of ['Semantics and SEO', 'Accessibility (WCAG AA)', 'Performance (LCP, CLS, INP)', 'Responsive']) {
    assert.ok(rule.includes(`## ${h}`), h);
  }
  assert.doesNotMatch(rule, /\{\{/);
});

test('scaffold without web-quality writes no rule', () => {
  const dir = tmp('scaffold no wq');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  const out = scaffold(dir, '--repo', 'app');
  assert.equal(out.created.includes(RULE), false);
  assert.equal(existsSync(join(dir, '.claude', 'rules')), false);
});

test('a rerun keeps an edited web-quality rule', () => {
  const dir = tmp('scaffold wq rerun');
  codeRepo(null, undefined, { dir: join(dir, 'app') });
  scaffold(dir, '--repo', 'app', '--with', 'web-quality');
  write(dir, { [RULE]: 'my own rule\n' });
  const again = scaffold(dir, '--repo', 'app', '--with', 'web-quality');
  assert.ok(again.skipped.includes(RULE));
  assert.equal(again.created.includes(RULE), false);
  assert.equal(read(dir, RULE), 'my own rule\n');
});

// --- per-repo values (1.3.0, A2) ---
import { multiRepoWorkspace } from '../helpers/workspace.mjs';

// The folder tree without the inner .git folders of the repos; a root .git (an early git init of the docs repo) counts.
const tree = (dir) => readdirSync(dir, { recursive: true }).filter((p) => !/[\\/]\.git([\\/]|$)/.test(p)).sort();

test('scaffold records the visibility per repo with a default and overrides', () => {
  const { root } = multiRepoWorkspace();
  scaffold(root, '--visibility', 'private', '--visibility', 'shop/web=public');
  const by = Object.fromEntries(wsOf(root).repos.map((r) => [r.path, r.visibility]));
  assert.deepEqual(by, { 'shop/api': 'private', 'shop/web': 'public', notes: undefined }, 'a default skips the repo without code');
  const only = multiRepoWorkspace();
  scaffold(only.root, '--visibility', 'shop/web=public');
  const o = Object.fromEntries(wsOf(only.root).repos.map((r) => [r.path, r.visibility]));
  assert.deepEqual(o, { 'shop/api': undefined, 'shop/web': 'public', notes: undefined });
});

test('a single --visibility value applies to every code repo; a repo without code needs its own <path>=', () => {
  const { root } = multiRepoWorkspace();
  scaffold(root, '--visibility', 'public');
  assert.deepEqual(wsOf(root).repos.map((r) => [r.path, r.visibility]), [['notes', undefined], ['shop/api', 'public'], ['shop/web', 'public']]);
  const own = multiRepoWorkspace();
  scaffold(own.root, '--visibility', 'public', '--visibility', 'notes=private');
  assert.deepEqual(wsOf(own.root).repos.map((r) => r.visibility), ['private', 'public', 'public']);
});

test('scaffold records option modules per repo', () => {
  const { root } = multiRepoWorkspace();
  scaffold(root, '--with', 'versioning', '--with', 'shop/web=web-quality');
  const by = Object.fromEntries(wsOf(root).repos.map((r) => [r.path, r.standards?.modules ?? []]));
  assert.ok(by['shop/api'].includes('versioning') && !by['shop/api'].includes('web-quality'));
  assert.ok(by['shop/web'].includes('versioning') && by['shop/web'].includes('web-quality'));
  assert.deepEqual(by.notes, [], 'a default skips the repo without code');
  const own = multiRepoWorkspace();
  scaffold(own.root, '--with', 'versioning', '--with', 'notes=versioning');
  const notes = wsOf(own.root).repos.find((r) => r.path === 'notes');
  assert.deepEqual(notes.standards.modules, ['versioning']);
});

test('scaffold refuses an unknown repo path, a doubled path or an unknown value before writing anything', () => {
  const { root } = multiRepoWorkspace();
  const before = tree(root);
  const cases = [
    [['--visibility', 'nope/x=public'], /unknown repo 'nope\/x'/],
    [['--visibility', 'shop/web=public', '--visibility', 'shop/web=private'], /'shop\/web' given twice/],
    [['--visibility', 'shop/web=internal'], /--visibility must be one of/],
    [['--with', 'nope/x=web-quality'], /unknown repo 'nope\/x'/],
    [['--with', 'shop/web=nonsense'], /unknown option 'nonsense'/],
  ];
  for (const [args, re] of cases) {
    const r = cli('scaffold', root, ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, re);
    assert.deepEqual(tree(root), before);
  }
});

test('the web-quality rule names every repo that chose the module and no other', () => {
  const { root } = multiRepoWorkspace();
  scaffold(root, '--with', 'shop/web=web-quality', '--with', 'shop/api=web-quality');
  const rule = read(root, RULE);
  assert.match(rule, /"shop\/web\/src\/\*\*\/\*\.\{ts,tsx,html,css,scss\}"/);
  assert.match(rule, /"shop\/api\/index\.html"/);
  assert.doesNotMatch(rule, /notes/);
  assert.doesNotMatch(rule, /\{\{/);
});

// --- upper-case repo folders (1.3 review C1): values are keyed by the normalized path everywhere ---
const UPPER = ['Shop/Api', 'Shop/Web'];

test('scaffold --repo keeps per-repo values for folders with upper-case letters', () => {
  const { root } = multiRepoWorkspace({ names: UPPER });
  scaffold(root, '--repo', 'Shop/Api', '--repo', 'Shop/Web', '--visibility', 'private', '--visibility', 'Shop/Web=public',
    '--with', 'versioning', '--with', 'Shop/Web=web-quality');
  const by = Object.fromEntries(wsOf(root).repos.map((r) => [r.path, r]));
  assert.deepEqual(Object.keys(by).sort(), UPPER);
  assert.equal(by['Shop/Api'].visibility, 'private');
  assert.equal(by['Shop/Web'].visibility, 'public');
  assert.ok(by['Shop/Api'].standards.modules.includes('versioning'));
  assert.ok(by['Shop/Web'].standards.modules.includes('web-quality'));
  assert.match(read(root, RULE), /"Shop\/Web\/src\//);
  const ignore = read(root, '.gitignore').split(/\r?\n/);
  assert.ok(ignore.includes('/Shop/Api/') && ignore.includes('/Shop/Web/'), 'the docs repo ignores the folders as they are on disk');
});

test('scaffold --repo typed in lower case finds an upper-case folder on Windows', { skip: process.platform !== 'win32' }, () => {
  const { root } = multiRepoWorkspace({ names: UPPER });
  scaffold(root, '--repo', 'shop/web', '--visibility', 'public', '--with', 'shop/web=versioning');
  const [web] = wsOf(root).repos;
  assert.equal(web.path, 'Shop/Web', 'the path as it is on disk');
  assert.equal(web.visibility, 'public');
  assert.ok(web.standards.modules.includes('versioning'));
});

test('scaffold refuses two visibility defaults before writing anything', () => {
  const { root } = multiRepoWorkspace();
  const before = tree(root);
  const r = cli('scaffold', root, '--visibility', 'private', '--visibility', 'public');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--visibility default given twice/);
  assert.deepEqual(tree(root), before);
  // For --with plain ids are a list: several stay allowed.
  assert.equal(cli('scaffold', root, '--with', 'versioning', '--with', 'web-quality').status, 0);
});
