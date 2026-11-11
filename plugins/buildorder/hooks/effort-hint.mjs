// UserPromptSubmit: suggests /effort high when a prompt reads like debugging, security or release
// work while the session runs on low or medium. A hook cannot switch effort itself.
// At most once per topic and session. Topics: workspace.json -> effortHints ({ "<regex>": "<topic>" }).
// Source stays ASCII: German umlauts are \u escapes.
import { readState, stateFile, writeState } from './state.mjs';

const DEFAULT_HINTS = {
  'bug\\w*|error\\w*|crash\\w*|regression|debug\\w*|fehler\\w*|absturz|abst\\u00fcrz\\w*|kaputt': 'debugging',
  'security|vulnerab\\w*|cve|secret\\w*|sicherheit\\w*|schwachstelle\\w*|sicherheitsl\\u00fcck\\w*': 'security',
  'release\\w*|deploy\\w*|go-live|production|produktion\\w*|ver\\u00f6ffentlich\\w*': 'release',
};
const LEVELS = new Set(['low', 'medium']);

/** @returns {{ context: string } | null} */
export default function effortHint(input, { ws }) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (prompt === '' || !LEVELS.has(input.effort?.level)) return null;
  const hints = ws.effortHints !== null && typeof ws.effortHints === 'object' && !Array.isArray(ws.effortHints)
    ? ws.effortHints
    : DEFAULT_HINTS;
  let topic;
  for (const [pattern, name] of Object.entries(hints)) {
    if (typeof name !== 'string' || name === '') continue;
    try {
      if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(prompt)) {
        topic = name;
        break;
      }
    } catch { /* invalid regex in workspace.json: skip this entry */ }
  }
  if (topic === undefined) return null;
  const file = stateFile('effort', input.session_id);
  const shown = readState(file).split('\n').filter(Boolean);
  if (shown.includes(topic)) return null;
  writeState(file, [...shown, topic].join('\n'));
  return { context: `This looks like ${topic}. Consider /effort high for this task.` };
}
