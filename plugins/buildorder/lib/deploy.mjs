// Deploy target from evidence in the repo. Without evidence the answer is 'unknown':
// a note claiming a host is no evidence. 'none' is never returned here; it is a value
// a person can set later.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SKIP_DIRS, readJson, walk } from './fsx.mjs';

const CONTAINER_FILES = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const PAAS_FILES = ['netlify.toml', 'vercel.json', 'firebase.json', 'render.yaml', 'Procfile'];
// "ftp", "sftp", "ftps" as a word of its own, not inside other words.
const FTP_RE = /(^|[^a-z])s?ftps?([^a-z]|$)/i;
const MAX_EVIDENCE = 3;
const WEBSPACE_DEPTH = 3;
// Build output is skipped while walking; these folders are looked at one level deep separately.
const OUTPUT_DIRS = ['dist', 'build', 'public'];

/**
 * Precedence: container (root files) > paas (root files) > webspace > unknown.
 * Evidence lists at most 3 entries, in the order found.
 */
export function detectDeploy(dir) {
  const has = (f) => existsSync(join(dir, f));
  const container = CONTAINER_FILES.filter(has);
  if (container.length) return { target: 'container', evidence: container.slice(0, MAX_EVIDENCE) };
  const paas = PAAS_FILES.filter(has);
  if (paas.length) return { target: 'paas', evidence: paas.slice(0, MAX_EVIDENCE) };

  // Sorted so the capped evidence does not depend on directory order.
  const skip = new Set([...SKIP_DIRS, 'build']);
  const webspace = walk(dir, WEBSPACE_DEPTH, skip).sort()
    .filter((f) => basename(f) === '.htaccess' || /\.php$/i.test(f) || FTP_RE.test(basename(f)));
  // A manual FTP upload often leaves a backup in the build output (e.g. "dist/bak ftp").
  for (const out of OUTPUT_DIRS) {
    try {
      webspace.push(...readdirSync(join(dir, out)).sort().filter((e) => FTP_RE.test(e)).map((e) => `${out}/${e}`));
    } catch { /* no such folder */ }
  }
  const scripts = readJson(join(dir, 'package.json'))?.scripts;
  if (scripts && typeof scripts === 'object') {
    for (const [name, cmd] of Object.entries(scripts)) {
      if (/\b(lftp|s?ftps?)\b/i.test(String(cmd))) webspace.push(`package.json (scripts.${name})`);
    }
  }
  if (webspace.length) return { target: 'webspace', evidence: [...new Set(webspace)].slice(0, MAX_EVIDENCE) };
  return { target: 'unknown', evidence: [] };
}
