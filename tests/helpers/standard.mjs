// Helpers for the standard tests: the fake stack module and a small reader for generated workflows.
import { join } from 'node:path';
import { loadStack } from '../../plugins/buildorder/lib/standard.mjs';
import { repoRoot } from './repo.mjs';

/** Folder of the test stack modules (`fake`), passed as `stacksDir` to the standard lib. */
export const FAKE_STACKS = join(repoRoot, 'tests', 'fixtures', 'stacks');

/**
 * The sample repos that CI lints with zizmor and actionlint, as `[{ name, stack, deploy }]`:
 * the fake stack with every CD variant, and the django module with deploy targets container and none.
 */
export function samples() {
  const fake = loadStack('fake', FAKE_STACKS);
  const django = loadStack('django');
  return [
    ['container', fake, 'container'], ['webspace', fake, 'webspace'], ['none', fake, 'none'],
    ['django-container', django, 'container'], ['django-none', django, 'none'],
  ].map(([name, stack, deploy]) => ({ name, stack, deploy }));
}

/** The job ids of a generated workflow (keys two spaces below `jobs:`). */
export function jobIds(yaml) {
  const lines = yaml.split('\n');
  const start = lines.indexOf('jobs:');
  return lines.slice(start + 1).map((l) => l.match(/^ {2}([\w-]+):\s*$/)?.[1]).filter(Boolean);
}

/** The text of one job of a generated workflow. */
export function jobText(yaml, id) {
  const lines = yaml.split('\n');
  const at = lines.indexOf(`  ${id}:`);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^ {2}[\w-]+:\s*$/.test(l));
  return lines.slice(at, end < 0 ? undefined : end).join('\n');
}

/** The `needs:` list of a job, from its flow sequence (`needs: [a, b]`). */
export function needsOf(yaml, id) {
  const m = jobText(yaml, id)?.match(/^ {4}needs: \[(.*)\]$/m);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Every `uses:` value of a YAML text, with the rest of its line. */
export function usesLines(yaml) {
  return [...yaml.matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)].map((m) => m[1].trim());
}

/** Lines of `run:` steps (single-line values and block scalars), to check for `${{ }}`. */
export function runLines(yaml) {
  const out = [];
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const indent = lines[i].search(/\S/);
    if (!/^[|>][-+]?$/.test(m[2])) {
      out.push(m[2]);
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() !== '' && l.search(/\S/) <= indent) break;
      out.push(l);
    }
  }
  return out;
}
