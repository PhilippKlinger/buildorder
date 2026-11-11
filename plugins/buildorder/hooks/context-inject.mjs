// UserPromptSubmit: adds a short hint when the prompt matches a keyword from
// workspace.json -> keywords ({ "<regex>": "<hint>" }). Silent otherwise, so it costs no tokens.

/** @returns {{ context: string } | null} */
export default function contextInject(input, { ws }) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const keywords = ws.keywords;
  if (prompt === '' || keywords === null || typeof keywords !== 'object' || Array.isArray(keywords)) return null;
  const hints = [];
  for (const [pattern, hint] of Object.entries(keywords)) {
    if (typeof hint !== 'string' || hint === '') continue;
    try {
      if (new RegExp(`\\b(?:${pattern})\\b`, 'i').test(prompt) && !hints.includes(hint)) hints.push(hint);
    } catch { /* invalid regex in workspace.json: skip this entry */ }
  }
  return hints.length ? { context: hints.join('\n') } : null;
}
