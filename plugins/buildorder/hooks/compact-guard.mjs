// SessionStart (matcher: compact): after a compaction, re-sync with the user instead of
// continuing on a lossy summary. Source stays ASCII: the en dash is a \u escape.

/** @returns {{ context: string } | null} */
export default function compactGuard(input, { ws }) {
  if (input.source !== 'compact') return null;
  const name = (key, fallback) => (typeof ws.docs?.[key] === 'string' && ws.docs[key] !== '' ? ws.docs[key] : fallback);
  return {
    context:
      'Context was compacted. Before continuing, summarize the current state in 3\u20135 lines from ' +
      `${name('handoff', 'HANDOFF.md')} and ${name('sprint', 'SPRINT.md')}, then ask the user whether to continue.`,
  };
}
