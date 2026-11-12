// detect: reads a folder and says how buildorder would set it up. Pure reads, no dependencies.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDeploy } from './deploy.mjs';
import { SKIP_DIRS, readJson, walk } from './fsx.mjs';
import { git, gitResult } from './git.mjs';
import { COMPOSE, detectStacks, isDockerfile } from './stack.mjs';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Folder or repo names a person can type: letters, digits, space, `._-`, at most 63 characters. */
export const NAME_RE = /^[\w.-][\w .-]{0,62}$/;

// Agent setups that already live in a folder (Claude's own and other agents').
const AGENT_SETUP = ['.claude', 'CLAUDE.md', 'AGENTS.md', '.agents', '.cursor', '.codex'];
// Claude Code writes this file itself when a permission prompt is answered with "don't ask again".
const LOCAL_SETTINGS = 'settings.local.json';
// Source files that make a git repo a code repo even without a recognised stack.
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.html', '.css', '.scss', '.php',
  '.java', '.kt', '.go', '.rs', '.vue', '.svelte', '.astro',
]);
// Agent folders hold tooling (hooks, scripts), not the project's own code.
const CODE_SKIP = new Set([...SKIP_DIRS, ...AGENT_SETUP.filter((n) => n.startsWith('.'))]);
const CODE_DEPTH = 3;
const REPO_DEPTH = 2; // nested repos are looked for up to `a/b/c`
const MAX_LISTED = 15;
// Caches that are ignored in nearly every repo; listing them would hide the files that matter.
const NOISE = new Set([...SKIP_DIRS, '.pytest_cache', '.mypy_cache', '.ruff_cache', '.angular', 'coverage']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e']);
const TEST_FILE = [/\.(test|spec)\.[cm]?[jt]sx?$/, /^test_.+\.py$/, /_test\.(py|go)$/, /^tests\.py$/];
const TEST_DEPTH = 4;

const BUILDORDER_VERSION = readJson(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))?.version ?? null;

const under = (f, folders) => folders.some((p) => f.startsWith(`${p}/`));

/**
 * What a folder's own files (nested repos and agent folders left out) show: its stacks and
 * whether it has source files (CODE_EXT, three levels deep).
 *
 * A git repo is a code repo when it has a stack, supported or not, or, if it holds no nested
 * repos, source files. A folder that holds repos and some loose scripts is a parent of repos,
 * not a repo of its own. Documents, notes and markdown alone never make code.
 */
function ownCode(dir, nested = []) {
  const stacks = detectStacks(dir, { ignore: nested });
  const hasStack = stacks.supported.length > 0 || stacks.unsupported.length > 0;
  const hasFiles = walk(dir, CODE_DEPTH, CODE_SKIP)
    .some((f) => !under(f, nested) && CODE_EXT.has(extname(f).toLowerCase()));
  return { stacks, hasStack, hasFiles, isCodeRepo: hasStack || (hasFiles && nested.length === 0) };
}

/** Git repos below `root` (`/`-separated relative paths); the search does not enter a repo it found. */
function findRepos(root) {
  const found = [];
  const inner = (d, rel, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const sub = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (existsSync(join(sub, '.git'))) found.push(r);
      else inner(sub, r, depth - 1);
    }
  };
  inner(root, '', REPO_DEPTH);
  return found.sort();
}

/**
 * `git status` as counts and lists. Porcelain v2 with `-z` has no leading spaces or quoted paths,
 * so trimming the output cannot shift a column.
 */
function gitStatus(cwd, { ignored = false } = {}) {
  // Without optional locks, status does not refresh and rewrite the index: detect stays read-only.
  const args = ['--no-optional-locks', 'status', '--porcelain=v2', '-z', ...(ignored ? ['--ignored'] : [])];
  const r = gitResult(cwd, args);
  const out = { changed: 0, untracked: [], ignored: [] };
  if (!r.ok) return out;
  const tokens = r.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('? ')) out.untracked.push(t.slice(2));
    else if (t.startsWith('! ')) out.ignored.push(t.slice(2));
    else if (/^[12u] /.test(t)) {
      out.changed++;
      if (t.startsWith('2 ')) i++; // a rename or copy is followed by its original path
    }
  }
  return out;
}

/** Commits ahead of the upstream, or null without one. */
function aheadOf(cwd) {
  if (!git(cwd, ['rev-parse', '--abbrev-ref', '@{u}'])) return null;
  return Number(git(cwd, ['rev-list', '--count', '@{u}..HEAD'])) || 0;
}

/**
 * A remote URL without credentials: the userinfo of a scheme URL (`https://user:token@host/x`)
 * is dropped, because detect output is shown and logged. The user of an scp-style remote
 * (`git@host:x.git`) is a login name, not a secret, and stays.
 */
export function maskRemote(url) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');
}

const remoteOf = (cwd) => {
  const url = git(cwd, ['remote', 'get-url', 'origin']);
  return url ? maskRemote(url) : null;
};

function workflowsOf(dir) {
  try {
    return readdirSync(join(dir, '.github', 'workflows'), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function hasTestsIn(dir) {
  return walk(dir, TEST_DEPTH, SKIP_DIRS).some((f) => {
    const parts = f.split('/');
    const name = parts.pop();
    return parts.some((p) => TEST_DIRS.has(p)) || TEST_FILE.some((re) => re.test(name));
  });
}

// Same depth and names as the docker stack, so `docker` and these flags never disagree.
function dockerOf(dir) {
  const files = walk(dir, 2, SKIP_DIRS);
  return {
    dockerfile: files.some((f) => isDockerfile(basename(f))),
    compose: files.some((f) => COMPOSE.test(basename(f)) && !f.split('/').includes('.github')),
  };
}

function repoInfo(dir, path, { stacks: { supported, unsupported }, isCodeRepo }) {
  const status = gitStatus(dir);
  return {
    path,
    // Docs-only repos (notes, contracts) are listed but are no code repos.
    isCode: isCodeRepo,
    stacks: supported,
    unsupported,
    deploy: detectDeploy(dir),
    remote: remoteOf(dir),
    branch: git(dir, ['branch', '--show-current']),
    // Changed tracked files plus untracked ones: anything not yet committed.
    dirty: status.changed + status.untracked.length,
    ahead: aheadOf(dir),
    workflows: workflowsOf(dir),
    hasTests: hasTestsIn(dir),
    docker: dockerOf(dir),
  };
}

/**
 * Whether `name` in `root` is an agent setup. A `.claude` folder that is empty or holds only
 * Claude Code's own local settings is not one: it appears during any session in the folder.
 */
function isSetup(root, name) {
  const p = join(root, name);
  if (!existsSync(p)) return false;
  if (name !== '.claude') return true;
  try {
    return readdirSync(p).some((e) => e !== LOCAL_SETTINGS);
  } catch {
    return true; // a file named .claude, or unreadable: treat it as foreign
  }
}

/** `.claude/workspace.json`: null when absent, the summary for buildorder's own, else 'invalid'. */
function readWorkspace(root) {
  const file = join(root, '.claude', 'workspace.json');
  if (!existsSync(file)) return null;
  const ws = readJson(file);
  if (!ws || typeof ws !== 'object' || Array.isArray(ws) || ws.schemaVersion !== 1) return 'invalid';
  return { schemaVersion: 1, initPhase: ws.initPhase ?? null, profile: ws.profile ?? null };
}

/**
 * Default subfolder name for nesting: the repo name; on a clash `-repo`, then `-repo-2`, ...
 * The base is shortened so the name stays within NAME_RE's 63 characters.
 */
export function nestName(entries, base) {
  const taken = new Set(entries.map((e) => e.toLowerCase()));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? '' : i === 2 ? '-repo' : `-repo-${i - 1}`;
    const name = base.slice(0, 63 - suffix.length) + suffix;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Reasons why moving the repo one level down would break its git paths (empty when none). */
export function nestBlockers(root) {
  const blockers = [];
  // Nesting the folder this plugin runs from would move the running script.
  const real = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const rel = relative(real(root), real(PLUGIN_ROOT));
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    blockers.push(`the buildorder plugin runs from inside this folder (${PLUGIN_ROOT}); copy the plugin elsewhere and run it from that copy`);
  }
  const dotGit = join(root, '.git');
  const gitIsDir = existsSync(dotGit) && lstatSync(dotGit).isDirectory();
  if (existsSync(dotGit) && !gitIsDir) blockers.push('.git is a file (worktree or submodule); its gitdir path would break');
  const worktrees = join(dotGit, 'worktrees');
  if (gitIsDir && existsSync(worktrees) && readdirSync(worktrees).length) {
    blockers.push('linked worktrees exist (see git worktree list); remove them first, their paths would break');
  }
  return blockers;
}

/** NAME_RE, and not only dots (`.` and `..` name no new folder). */
export const validName = (name) => NAME_RE.test(name) && !/^\.+$/.test(name);

/**
 * `name` when it satisfies NAME_RE, else an ASCII version of it (accents dropped, other
 * characters replaced by `-`), else `repo`. A proposal is only a default (nest takes another
 * name), so an unusual folder name gets a usable default instead of a blocker.
 */
export function safeName(name) {
  if (validName(name)) return name;
  const ascii = name.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\w .-]+/g, '-')
    .replace(/^[ .-]+|[ .-]+$/g, '').slice(0, 63).replace(/[ .-]+$/, '');
  return validName(ascii) ? ascii : 'repo';
}

/** The repo's own name from origin (e.g. `git@host:me/app.git` -> `app`), else the folder name. */
function repoNameOf(root, remote) {
  // A local remote such as `/srv/app/.git` names the folder before `.git`.
  const fromRemote = remote?.replace(/[/\\]\.git[/\\]?$/, '').match(/([^/:\\]+?)(?:\.git)?\/?$/)?.[1];
  return fromRemote && validName(fromRemote) ? fromRemote : safeName(basename(root));
}

/**
 * The folder is a code repo, so the workspace must not live inside it. Two ways out: a sibling
 * folder `<name>-workspace` with the repo cloned in, or nesting in place, where everything moves
 * into `<root>/<inPlace.repoPath>/`.
 */
function proposal(root, entries) {
  const remote = remoteOf(root);
  const repoPath = repoNameOf(root, remote);
  const status = gitStatus(root, { ignored: true });
  const noise = (p) => p.split('/').some((seg) => NOISE.has(seg));
  return {
    dir: join(dirname(root), `${basename(root)}-workspace`),
    repoPath,
    remote,
    dirty: status.changed,
    ahead: aheadOf(root),
    // Neither untracked nor ignored files travel with a clone (e.g. .env, a local database).
    untracked: status.untracked.slice(0, MAX_LISTED),
    ignored: status.ignored.filter((p) => !noise(p)).slice(0, MAX_LISTED),
    inPlace: { dir: root, repoPath: nestName(entries, repoPath), blockers: nestBlockers(root) },
  };
}

/** Minimal YAML frontmatter: single-line `key: value` pairs, optional matching quotes. */
export function frontmatter(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a leading BOM is ignored
  const lines = body.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close < 0) return null;
  const out = {};
  for (const line of lines.slice(1, close)) {
    const m = line.match(/^([\w-]+):\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    else if (/^[>|]/.test(value)) continue; // block scalars are not read
    out[m[1]] = value;
  }
  return out;
}

/** `SKILL.md` frontmatter of each `<base>/.claude/skills/*`, sorted by folder; malformed ones are skipped. */
function skillsIn(base) {
  const skillsDir = join(base, '.claude', 'skills');
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(skillsDir, e.name, 'SKILL.md');
    let fm;
    try {
      fm = frontmatter(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!fm?.name) continue;
    out.push({ name: fm.name, description: fm.description ?? '', path });
  }
  return out;
}

/**
 * Reads `dir` and suggests how to set it up. First match wins:
 * foreign workspace (blocked) > buildorder workspace (resume) > the folder is a code repo (repo-root)
 * > another agent setup (blocked) > several code repos (multi-repo) > one (existing) > new.
 * Throws when `dir` is not a folder.
 */
export function detect(dir, { home = homedir() } = {}) {
  const root = resolve(dir);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch { /* missing */ }
  if (!isDir) throw new Error(`not a folder: ${root}`);

  const entries = readdirSync(root).filter((e) => e !== '.git');
  const rootIsRepo = existsSync(join(root, '.git'));
  const workspace = readWorkspace(root);
  const existingSetup = AGENT_SETUP.filter((f) => isSetup(root, f));
  // Every nested git repo is listed; only code repos count for the suggestion.
  const nested = findRepos(root).map((path) => {
    const abs = join(root, ...path.split('/'));
    return { path, abs, code: ownCode(abs) };
  });
  const codeRepoCount = nested.filter((r) => r.code.isCodeRepo).length;
  const own = ownCode(root, nested.map((r) => r.path));
  const rootIsCode = rootIsRepo && own.isCodeRepo;

  let suggestion;
  let blockedReason = null;
  if (workspace === 'invalid') { suggestion = 'blocked'; blockedReason = 'foreign-workspace'; }
  else if (workspace) suggestion = 'resume';
  // A code repo gets a sibling or nested workspace, even with an old CLAUDE.md, which then stays in the repo.
  else if (rootIsCode) suggestion = 'repo-root';
  else if (existingSetup.length) { suggestion = 'blocked'; blockedReason = 'agent-setup'; }
  else if (codeRepoCount > 1) suggestion = 'multi-repo';
  // Loose code of the folder's own (no git, or a parent of repos with scripts) is existing code too.
  else if (codeRepoCount === 1 || own.hasStack || own.hasFiles) suggestion = 'existing';
  else suggestion = 'new';

  return {
    dir: root,
    buildorderVersion: BUILDORDER_VERSION,
    isEmpty: entries.length === 0,
    rootIsRepo,
    existingSetup,
    blockedReason,
    workspace,
    // Also listed when blocked: the output stays true to the folder, and the cost is a few git calls per repo.
    repos: nested.map((r) => repoInfo(r.abs, r.path, r.code)),
    workspaceProposal: suggestion === 'repo-root' ? proposal(root, entries) : null,
    suggestion,
    skills: { personal: skillsIn(home), project: skillsIn(root) },
  };
}
