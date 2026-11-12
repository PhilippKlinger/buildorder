// Writes the standard's repo files for the fake stack into sample repos, for the zizmor and
// actionlint steps in CI:
//   node tests/helpers/standard-sample.mjs <out-dir>
// creates <out-dir>/container, <out-dir>/webspace and <out-dir>/none (docker-cicd with that deploy target).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadStack, render } from '../../plugins/buildorder/lib/standard.mjs';
import { FAKE_STACKS } from './standard.mjs';

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node tests/helpers/standard-sample.mjs <out-dir>\n');
  process.exit(1);
}
const stack = loadStack('fake', FAKE_STACKS);
for (const deploy of ['container', 'webspace', 'none']) {
  const root = resolve(out, deploy);
  for (const { path, content } of render({ stack, deploy, skip: new Set() })) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  process.stdout.write(`${root}\n`);
}
