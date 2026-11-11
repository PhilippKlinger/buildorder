// Runs the plugin's hook entry point as a child process, the way Claude Code calls it.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { repoRoot } from './repo.mjs';

export const RUN = join(repoRoot, 'plugins', 'buildorder', 'hooks', 'run.mjs');

/**
 * Pipes `input` (an object is sent as JSON, a string as is) into `node <run> <entry>`.
 * `env` adds variables, `cwd` sets the process folder, `run` swaps the script (e.g. a copy with
 * stub hook modules). Asserts the hook contract: exit 0, and stdout is empty or exactly one JSON object.
 * @returns {{ status: number, stdout: string, stderr: string, json: any, ms: number }}
 */
export function runHook(entry, input, { env = {}, cwd, run = RUN } = {}) {
  const args = entry === undefined ? [run] : [run, entry];
  const started = process.hrtime.bigint();
  const res = spawnSync(process.execPath, args, {
    input: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (res.error) throw res.error;
  const stdout = res.stdout ?? '';
  let json = null;
  if (stdout.trim() !== '') {
    assert.doesNotThrow(() => { json = JSON.parse(stdout); }, `stdout must be one JSON object: ${stdout}`);
    assert.ok(json !== null && typeof json === 'object' && !Array.isArray(json), `stdout must be a JSON object: ${stdout}`);
  }
  assert.equal(res.status, 0, `hook must exit 0 (stderr: ${res.stderr})`);
  return { status: res.status, stdout, stderr: res.stderr ?? '', json, ms };
}
