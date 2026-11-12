// State of /buildorder:radar: when it last ran, and the fixed list of public pages it reads.
// Reading and judging the pages is the skill's job; this module only keeps the date.
import { join } from 'node:path';
import { readJson, writeJson } from './fsx.mjs';
import { isWorkspace } from './workspace.mjs';

/** Official public Claude Code pages. A fixed list; the reader agent fetches only these plus follow-ups under the official URL prefixes named in its definition. */
export const SOURCES = [
  'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
  'https://github.com/anthropics/claude-code/releases',
  'https://code.claude.com/docs/en/plugins',
  'https://code.claude.com/docs/en/skills',
  'https://code.claude.com/docs/en/hooks',
];

const file = (wsRoot) => join(wsRoot, '.claude', 'workspace.json');

function load(wsRoot) {
  const ws = readJson(file(wsRoot));
  if (!isWorkspace(ws)) throw new Error('not inside a Buildorder workspace (no valid .claude/workspace.json)');
  return ws;
}

/** `{ lastRun, sources }`: `lastRun` is a YYYY-MM-DD date or null before the first run. */
export function radarState(wsRoot) {
  const lastRun = load(wsRoot).radar?.lastRun;
  return { lastRun: typeof lastRun === 'string' ? lastRun : null, sources: [...SOURCES] };
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Records `date` (YYYY-MM-DD) as the last radar run in workspace.json; everything else stays. */
export function radarDone(wsRoot, date) {
  if (!validDate(date)) throw new Error('radar-done needs a date as YYYY-MM-DD (a real calendar day)');
  const ws = load(wsRoot);
  writeJson(file(wsRoot), { ...ws, radar: { ...(ws.radar ?? {}), lastRun: date } });
  return { lastRun: date };
}
