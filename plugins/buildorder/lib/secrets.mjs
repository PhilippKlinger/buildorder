// Secret patterns shared by the secret guard (blocks commits) and the inventory,
// so both always flag the same things. No dependencies.

export const SECRET_FILE = /(^|\/)(\.env(\.(local|dev|development|prod|production|staging))?|id_(rsa|ed25519|ecdsa)|[^/]+\.(pem|key|p12|pfx|jks|keystore))$/i;
export const TEMPLATE_FILE = /\.(example|template|sample|dist)$/i;

export const PATTERNS = [
  ['Private Key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub Token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['API Key (sk-...)', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Google API Key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack Token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Django SECRET_KEY', /\bSECRET_KEY\s*=\s*['"]([^'"]{20,})['"]/],
  ['Password/token in code', /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b['"]?\s*[:=]\s*['"]([^'"\s]{8,})['"]/i],
];

// Applies to the matched secret value only, never to the rest of the line.
export const PLACEHOLDER = /(change[-_]?me|your[-_]|example|dummy|placeholder|xxx+|\*{3,}|<[^>]{1,100}>|\$\{|os\.environ|getenv|process\.env)/i;

export const isSecretFile = (path) => SECRET_FILE.test(path) && !TEMPLATE_FILE.test(path);

/** Hides short values completely; long ones show at most their first 4 characters. */
export const mask = (v) => (v.length <= 12 ? '***' : `${v.slice(0, 4)}...`);

/**
 * First secret in a line of text as `{ label, masked }`, or null. A match is ignored when the
 * matched value itself is a placeholder; other text on the line (URLs, comments) does not matter.
 */
export function scanLine(text) {
  for (const [label, re] of PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags + 'g'))) {
      const value = m[1] ?? m[0]; // quoted patterns capture the value without prefix and quotes
      if (!PLACEHOLDER.test(value)) return { label, masked: mask(value) };
    }
  }
  return null;
}
