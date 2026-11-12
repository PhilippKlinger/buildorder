// Stop: reminds the user to run /buildorder:handoff when commits are newer than the handoff file.
// Reports once per new commit state per session, so it does not nag every turn.
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../lib/git.mjs';
import { readState, stateFile, writeState } from './state.mjs';

const seconds = (dir, args) => Number(git(dir, args)) || 0;

/** @returns {{ systemMessage: string } | null} */
export default function handoffReminder(input, { root, ws }) {
  if (input.stop_hook_active) return null;
  const handoff = typeof ws.docs?.handoff === 'string' && ws.docs.handoff !== '' ? ws.docs.handoff : 'HANDOFF.md';
  // Reference time: the file's mtime or the commit that recorded it, whichever is later.
  // Otherwise the handoff commit itself (made after the file was written) would trigger the reminder.
  let mtime = 0;
  try {
    mtime = Math.floor(statSync(join(root, handoff)).mtimeMs / 1000);
  } catch { /* no handoff yet */ }
  let since = Math.max(mtime, seconds(root, ['log', '-1', '--format=%ct', '--', handoff]));
  // Init's own commits are no work to hand over: while init runs there is nothing to remind about,
  // and once finalize has written workspace.json, only commits after that count.
  if (ws.initPhase === 'scaffolded') return null;
  if (ws.initPhase === 'done') {
    try {
      since = Math.max(since, Math.floor(statSync(join(root, '.claude', 'workspace.json')).mtimeMs / 1000));
    } catch { /* unreadable: keep the handoff reference */ }
  }

  const places = [{ name: 'Docs', dir: root }];
  for (const repo of Array.isArray(ws.repos) ? ws.repos : []) {
    if (typeof repo?.path !== 'string') continue;
    const dir = resolve(root, repo.path);
    if (places.some((p) => p.dir === dir)) continue;
    places.push({ name: repo.path, dir });
  }
  const newer = places
    .map((p) => ({ ...p, time: seconds(p.dir, ['log', '-1', '--format=%ct']) }))
    .filter((p) => p.time > since);
  if (newer.length === 0) return null;

  const latest = Math.max(...newer.map((p) => p.time));
  const file = stateFile('handoff', input.session_id);
  if (latest <= (Number(readState(file)) || 0)) return null;
  writeState(file, String(latest));
  return {
    systemMessage:
      `New commits since the last handoff (${newer.map((p) => p.name).join(', ')}). ` +
      'Before ending the session: /buildorder:handoff.',
  };
}
