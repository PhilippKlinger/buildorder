// Per-session state for advisory hooks: small files under os.tmpdir()/buildorder/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** State file path `<prefix>-<session>`; the session id is cut to [A-Za-z0-9_-] (fallback 'default'). */
export function stateFile(prefix, sessionId) {
  const id = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return join(tmpdir(), 'buildorder', `${prefix}-${id === '' ? 'default' : id}`);
}

/** The file's text, or '' when it is missing or unreadable. */
export function readState(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Best effort: without state a hint may repeat once more, which is acceptable. */
export function writeState(file, text) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  } catch { /* ignore */ }
}
