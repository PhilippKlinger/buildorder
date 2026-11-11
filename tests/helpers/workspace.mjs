// Fixtures for hook and workspace tests: a workspace folder, git repos and fake secrets.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gitInit, tempDir, write } from './cli.mjs';

export { gitInit };

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
