// standard: the standard model (mandatory / standard / option) and what it asks of a code repo.
import { join } from 'node:path';
import { PLUGIN_ROOT } from './detect.mjs';
import { readJson } from './fsx.mjs';

export const STANDARD_DIR = join(PLUGIN_ROOT, 'standard');

/** The standard model: `{ classes, items: [{ id, class, provider, where, summary, check?, paidOnPrivate? }] }`. */
export function loadModel() {
  const model = readJson(join(STANDARD_DIR, 'model.json'));
  if (!Array.isArray(model?.items)) throw new Error('standard/model.json is missing or invalid');
  return model;
}

/**
 * `--without <id>=<reason>` values as a Map id -> reason. Throws when an id is unknown, mandatory,
 * or has no reason: a mandatory item cannot be deselected, a standard item only with a reason.
 */
export function deselections(model, without = []) {
  const out = new Map();
  for (const raw of without ?? []) {
    const eq = raw.indexOf('=');
    const id = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    const reason = eq < 0 ? '' : raw.slice(eq + 1).trim();
    const item = model.items.find((i) => i.id === id);
    if (!item) throw new Error(`unknown standard item '${id}'`);
    if (item.class === 'mandatory') throw new Error(`'${id}' is mandatory and cannot be deselected`);
    if (!reason) throw new Error(`deselecting '${id}' needs a reason: --without ${id}=<reason>`);
    out.set(id, reason);
  }
  return out;
}
