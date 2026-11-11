// Turns hook results into the JSON that Claude Code reads on stdout. No dependencies.
// HookResult = { deny: string } | { context: string } | { systemMessage: string }

/** Claude Code moves longer additionalContext into a file, so it is cut here instead. */
export const MAX_CONTEXT = 10000;

const text = (v) => typeof v === 'string' && v !== '';

/**
 * One result from several hooks of the same entry: the first deny wins,
 * otherwise contexts and system messages are each joined with a newline. Null when nothing is left.
 */
export function merge(results) {
  const valid = results.filter((r) => r !== null && typeof r === 'object');
  const deny = valid.find((r) => text(r.deny));
  if (deny) return { deny: deny.deny };
  const join = (key) => valid.map((r) => r[key]).filter(text).join('\n');
  const out = {};
  if (join('context')) out.context = join('context');
  if (join('systemMessage')) out.systemMessage = join('systemMessage');
  return Object.keys(out).length ? out : null;
}

/** The stdout text for `result` on `hookEventName`: one JSON object, or '' for no decision. */
export function render(hookEventName, result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return '';
  if (text(result.deny)) {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: result.deny },
    });
  }
  const out = {};
  if (text(result.systemMessage)) out.systemMessage = result.systemMessage;
  if (text(result.context)) {
    out.hookSpecificOutput = { hookEventName, additionalContext: result.context.slice(0, MAX_CONTEXT) };
  }
  return Object.keys(out).length ? JSON.stringify(out) : '';
}
