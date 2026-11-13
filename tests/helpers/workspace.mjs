// Fixtures for hook and workspace tests: a workspace folder, git repos and fake secrets.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codeRepo, commitAll, gitIn, gitInit, tempDir, tmp, write } from './cli.mjs';

export { gitInit };

const DOC_MAP = {
  handoff: 'HANDOFF.md',
  sprint: 'SPRINT.md',
  backlog: 'BACKLOG.md',
  archive: 'BACKLOG_ARCHIVE.md',
  decisions: 'DECISIONS.md',
  assumptions: 'assumptions.md',
};

const DJANGO_API = {
  'manage.py': '',
  'requirements.txt': 'Django==5.2\n',
  'api/views.py': 'def index(request):\n    return None\n',
};
const ANGULAR_WEB = {
  'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20' } }),
  'angular.json': '{}',
  'src/main.ts': 'console.log(1);\n',
};

/**
 * The multi-repo test layout of the 1.3 spec (section 6): code repos `shop/api` (Django) and `shop/web`
 * (Angular), each with one commit on `main`, and `notes`, a git repo with markdown only (no code).
 * With `sameName` the code repos are `a/app` and `b/app` instead (both Angular), for tag collisions.
 * Options:
 * - `withOrigin`: repo paths that get `origin` = `git@github.com:o/<folder>.git`
 * - `dirty`: repo paths that get an untracked file `wip.txt`
 * - `registered`: also write `.claude/workspace.json` (initPhase `done`, every repo listed with `isCode`)
 * - `visibility`: `{ <path>: 'public' | 'private' }` recorded on the repo entries (needs `registered`)
 * Returns `{ root, code: [paths], docs: [paths] }` with forward-slash repo paths relative to `root`.
 * The root folder name holds spaces, like every temp folder of the helpers.
 */
export function multiRepoWorkspace({ withOrigin = [], dirty = [], registered = false, visibility = {}, sameName = false } = {}) {
  const root = tmp('multi');
  const code = sameName ? ['a/app', 'b/app'] : ['shop/api', 'shop/web'];
  const docs = sameName ? [] : ['notes'];
  const files = sameName ? [ANGULAR_WEB, ANGULAR_WEB] : [DJANGO_API, ANGULAR_WEB];
  code.forEach((path, i) => codeRepo(null, files[i], { dir: join(root, ...path.split('/')) }));
  for (const path of docs) {
    const dir = join(root, path);
    gitInit(dir);
    write(dir, { 'README.md': '# Notes\n', 'ideas.md': '- one\n' });
    commitAll(dir, 'init');
  }
  for (const path of withOrigin) {
    const folder = path.split('/').at(-1);
    gitIn(join(root, ...path.split('/')), 'remote', 'add', 'origin', `git@github.com:o/${folder}.git`);
  }
  for (const path of dirty) write(join(root, ...path.split('/')), { 'wip.txt': 'work in progress\n' });
  if (registered) {
    const entry = (path, isCode) => ({ path, isCode, ...(visibility[path] ? { visibility: visibility[path] } : {}) });
    const ws = {
      schemaVersion: 1,
      name: 'shop',
      language: { docs: 'en' },
      initPhase: 'done',
      docs: DOC_MAP,
      repos: [...code.map((p) => entry(p, true)), ...docs.map((p) => entry(p, false))],
    };
    write(root, { '.claude/workspace.json': JSON.stringify(ws, null, 2) + '\n' });
  }
  return { root, code, docs };
}

/**
 * A temp workspace with `.claude/workspace.json` (schemaVersion 1, doc-map names, one repo `app/`).
 * `overrides` is merged over the defaults on the top level. Returns the workspace root.
 */
export function makeWorkspace(overrides = {}) {
  const root = tempDir('ws');
  const ws = {
    schemaVersion: 1,
    name: 'demo',
    docs: {
      handoff: 'HANDOFF.md',
      sprint: 'SPRINT.md',
      backlog: 'BACKLOG.md',
      archive: 'BACKLOG_ARCHIVE.md',
      decisions: 'DECISIONS.md',
      assumptions: 'assumptions.md',
    },
    repos: [{ path: 'app' }],
    ...overrides,
  };
  write(root, { '.claude/workspace.json': JSON.stringify(ws, null, 2) + '\n' });
  mkdirSync(join(root, 'app'), { recursive: true });
  gitInit(join(root, 'app'));
  return root;
}

const FAKE_SECRETS = {
  aws: () => 'AKIA' + 'FAKE'.repeat(4),
  github: () => 'ghp_' + 'fake'.repeat(9),
  django: () => 'django-insecure-' + 'fake'.repeat(7),
  openai: () => ['sk', 'proj', 'fake'.repeat(6)].join('-'),
  password: () => 'hunter' + 'fake' + '42',
  privateKey: () => ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' '),
};

/** An obviously fake secret of `kind`, assembled at runtime so no secret-looking literal is tracked. */
export function fakeSecret(kind) {
  const make = FAKE_SECRETS[kind];
  if (!make) throw new Error(`unknown fake secret kind: ${kind}`);
  return make();
}
