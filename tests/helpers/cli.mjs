// Runs the buildorder CLI as a child process, the way the skills call it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoRoot } from './repo.mjs';

export const script = join(repoRoot, 'plugins', 'buildorder', 'scripts', 'buildorder.mjs');

// Commits never depend on the machine's global git config.
const COMMIT_CONFIG = [
  '-c', 'user.name=test', '-c', `user.email=${['test', 'localhost'].join('@')}`, '-c', 'commit.gpgsign=false',
];
// Variables that would send fixture git calls into another repo (e.g. when tests run inside a git hook).
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

const temps = [];

/** A fresh temp folder whose name holds `label` and spaces; removed by `cleanup()`. */
export function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `bo ${label} `));
  temps.push(dir);
  return dir;
}

/** Removes every temp folder created through this helper. */
export function cleanup() {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** A fresh, existing folder named "target dir" inside a temp dir whose name holds `label` and spaces. */
export function tmp(label) {
  const dir = join(tempDir(label), 'target dir');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes `files` ({ 'a/b.txt': content }) below `dir`, creating folders as needed. */
export function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!REDIRECTING.includes(k.toUpperCase())) env[k] = v;
  }
  return env;
}

/** Runs git in `cwd` without hooks and returns its trimmed output; throws when git fails. */
export function gitIn(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** `git init` on branch main (independent of init.defaultBranch). */
export function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'main');
  return dir;
}

/** Stages everything and commits it. */
export function commitAll(dir, message = 'commit') {
  gitIn(dir, 'add', '-A');
  gitIn(dir, ...COMMIT_CONFIG, 'commit', '-q', '-m', message);
}

/**
 * A code repo with one commit: by default an Angular app (`package.json`, `src/main.ts`).
 * `files` replaces that default. With `label` a fresh temp folder is used; pass `{ dir }` to place it.
 */
export function codeRepo(label, files, { dir = tmp(label) } = {}) {
  gitInit(dir);
  write(dir, files ?? {
    'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20' } }),
    'angular.json': '{}',
    'src/main.ts': 'console.log(1);\n',
  });
  commitAll(dir, 'init');
  return dir;
}

/** An empty home folder; detect reads personal skills from `<home>/.claude/skills`. */
export function fakeHome() {
  return tempDir('home');
}

/**
 * Runs `buildorder.mjs ...args`. A trailing options object sets `home` (HOME and USERPROFILE,
 * which `os.homedir()` reads) and `cwd`; without `home` an empty temp home is used, so the
 * real home never leaks into a test.
 * @returns {{ status: number, stdout: string, stderr: string, json: any }}
 */
export function cli(...args) {
  const opts = typeof args.at(-1) === 'object' && args.at(-1) !== null ? args.pop() : {};
  const home = opts.home ?? fakeHome();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  let status = 0;
  let stdout;
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: opts.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch { /* not JSON */ }
  return { status, stdout, stderr, json };
}
