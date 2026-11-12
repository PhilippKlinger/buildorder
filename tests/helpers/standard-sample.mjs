// Writes the standard's repo files for the sample stacks into sample repos, for the zizmor and
// actionlint steps in CI:
//   node tests/helpers/standard-sample.mjs <out-dir>
// creates one folder per sample (see SAMPLES in standard.mjs): the fake stack with each CD variant
// of docker-cicd, and the django module with deploy targets container and none.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { render } from '../../plugins/buildorder/lib/standard.mjs';
import { samples } from './standard.mjs';

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node tests/helpers/standard-sample.mjs <out-dir>\n');
  process.exit(1);
}
for (const { name, stack, deploy } of samples()) {
  const root = resolve(out, name);
  for (const { path, content } of render({ stack, deploy, skip: new Set() })) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  process.stdout.write(`${root}\n`);
}
