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
  ['Django SECRET_KEY', /\bSECRET_KEY\s*=\s*['"][^'"]{20,}['"]/],
  ['Password/token in code', /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
];

export const PLACEHOLDER = /(change[-_]?me|your[-_]|example|dummy|placeholder|xxx+|\*{3,}|<[^>]+>|\$\{|os\.environ|getenv|process\.env|config\()/i;

export const isSecretFile = (path) => SECRET_FILE.test(path) && !TEMPLATE_FILE.test(path);

export const mask = (v) => (v.length <= 8 ? '***' : `${v.slice(0, 4)}...${v.slice(-2)}`);

/** First matching pattern in a line of text as `{ label, masked }`, or null. Placeholder lines never match. */
export function scanLine(text) {
  if (PLACEHOLDER.test(text)) return null;
  for (const [label, re] of PATTERNS) {
    const m = text.match(re);
    if (m) return { label, masked: mask(m[0]) };
  }
  return null;
}
