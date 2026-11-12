// standard: the standard model (mandatory / standard / option) and the repo files that set it up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './detect.mjs';
import { readJson, walk } from './fsx.mjs';

export const STANDARD_DIR = join(PLUGIN_ROOT, 'standard');
/** Where the stack modules live (`<id>/stack.json`, `ci.yml`, ...); see standard/README.md. */
export const STACKS_DIR = join(STANDARD_DIR, 'stacks');
const TEMPLATES = join(PLUGIN_ROOT, 'templates', 'repo');
const STACK_ID = /^[a-z][a-z0-9-]{0,31}$/;

// CD variants of docker-cicd that write files: the deploy job for ci.yml and the workflow it calls.
const CD = {
  container: { job: 'deploy-container.yml', workflow: 'deployment.yml' },
  webspace: { job: 'deploy-webspace.yml', workflow: 'deployment-webspace.yml' },
};

/** The standard model: `{ classes, items: [{ id, class, provider, where, summary, check?, paidOnPrivate? }] }`. */
export function loadModel() {
  const model = readJson(join(STANDARD_DIR, 'model.json'));
  if (!Array.isArray(model?.items)) throw new Error('standard/model.json is missing or invalid');
  return model;
}

/**
 * `--without <id>=<reason>` values as a Map id -> reason. Throws when an id is unknown, mandatory,
 * or has no reason: a mandatory item cannot be deselected, a standard item only with a reason.
 */
export function deselections(model, without = []) {
  const out = new Map();
  for (const raw of without ?? []) {
    const eq = raw.indexOf('=');
    const id = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    const reason = eq < 0 ? '' : raw.slice(eq + 1).trim();
    const item = model.items.find((i) => i.id === id);
    if (!item) throw new Error(`unknown standard item '${id}'`);
    if (item.class === 'mandatory') throw new Error(`'${id}' is mandatory and cannot be deselected`);
    if (!reason) throw new Error(`deselecting '${id}' needs a reason: --without ${id}=<reason>`);
    out.set(id, reason);
  }
  return out;
}

/** A text file with LF line endings, or null when it cannot be read. */
function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

const template = (rel) => {
  const text = readText(join(TEMPLATES, ...rel.split('/')));
  if (text === null) throw new Error(`template missing: templates/repo/${rel}`);
  return text;
};

/** Top-level keys of a YAML fragment (the job ids of a CI fragment). */
const topKeys = (text) => text.split('\n').map((l) => l.match(/^([\w-]+):\s*$/)?.[1]).filter(Boolean);

const indent = (text, n) => text.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

/**
 * The stack module `id` from `stacksDir`, or null when there is none:
 * `{ id, codeql, dependabot, provides, ci, jobs, preCommit, docker: [{ path, content }] }`.
 */
export function loadStack(id, stacksDir = STACKS_DIR) {
  if (typeof id !== 'string' || !STACK_ID.test(id)) return null;
  const dir = join(stacksDir, id);
  const meta = readJson(join(dir, 'stack.json'));
  const ci = readText(join(dir, 'ci.yml'));
  if (!meta || ci === null) return null;
  const jobs = topKeys(ci);
  if (!jobs.length) throw new Error(`stack module '${id}': ci.yml defines no job`);
  const dockerDir = join(dir, 'docker');
  const docker = walk(dockerDir).sort().map((path) => ({ path, content: readText(join(dockerDir, ...path.split('/'))) }));
  return {
    id,
    codeql: meta.codeql ?? null,
    dependabot: meta.dependabot ?? [],
    provides: meta.provides ?? {},
    ci,
    jobs,
    preCommit: readText(join(dir, 'pre-commit.yml')) ?? '',
    docker,
  };
}

/** Whether the selection builds an image, and the CD variant that writes files (or null). */
export function parts({ stack, deploy, skip }) {
  const image = Boolean(stack) && !skip.has('container-image');
  const cd = image && !skip.has('deploy') ? CD[deploy] ?? null : null;
  return { image, cd };
}

function ciWorkflow({ stack, skip }, { image, cd }) {
  const jobs = [template('ci/gitleaks.yml'), template('ci/zizmor.yml'), template('ci/pre-commit.yml')];
  if (!skip.has('dependency-review')) jobs.push(template('ci/dependency-review.yml'));
  if (!skip.has('codeql')) {
    const langs = [{ language: 'actions', buildMode: 'none' }, ...(stack?.codeql ? [stack.codeql] : [])];
    const matrix = `[${langs.map((l) => `{ language: ${l.language}, build-mode: ${l.buildMode} }`).join(', ')}]`;
    jobs.push(template('ci/codeql.yml').replace('__CODEQL_MATRIX__', matrix));
  }
  if (stack) jobs.push(stack.ci);
  if (image) jobs.push(template('docker-cicd/ci/image.yml').replace('__STACK_JOBS__', stack.jobs.join(', ')));
  // ci-ok needs every job that runs on a pull request; the deploy job runs on main only.
  const needs = jobs.flatMap(topKeys);
  if (cd) jobs.push(template(`docker-cicd/ci/${cd.job}`));
  jobs.push(template('ci/ci-ok.yml').replace('__NEEDS__', needs.join(', ')));
  return template('ci/header.yml') + jobs.map((j) => indent(j.trimEnd(), 2)).join('\n\n') + '\n';
}

function dependabot(stack, image) {
  const ecosystems = [
    { ecosystem: 'github-actions', directory: '/' },
    { ecosystem: 'pre-commit', directory: '/' },
    ...(stack?.dependabot ?? []),
    ...(image ? [{ ecosystem: 'docker', directory: '/' }] : []),
  ];
  const entry = ({ ecosystem, directory }) => [
    `  - package-ecosystem: "${ecosystem}"`,
    `    directory: "${directory}"`,
    '    schedule:',
    '      interval: "weekly"',
    '    cooldown:',
    '      default-days: 14',
    '    groups:',
    `      ${ecosystem}:`,
    '        patterns:',
    '          - "*"',
  ].join('\n');
  return `version: 2\nupdates:\n${ecosystems.map(entry).join('\n')}\n`;
}

function preCommit(stack) {
  const hooks = stack?.preCommit.trim() ? `\n${indent(stack.preCommit.trimEnd(), 2)}` : '';
  return template('pre-commit-config.yaml').trimEnd() + hooks + '\n';
}

/**
 * The repo files of the standard for a selection, as `[{ path, content }]` in write order.
 * `stack`: a loaded stack module or null (then only the stack-independent parts are written);
 * `deploy`: container | webspace | paas | none; `skip`: Set of item ids that are left out.
 */
export function render({ stack, deploy, skip }) {
  const sel = parts({ stack, deploy, skip });
  const files = [{ path: '.github/workflows/ci.yml', content: ciWorkflow({ stack, skip }, sel) }];
  if (sel.cd) {
    const path = `.github/workflows/${sel.cd.workflow}`;
    files.push({ path, content: template(`docker-cicd/github/workflows/${sel.cd.workflow}`) });
  }
  files.push({ path: '.github/dependabot.yml', content: dependabot(stack, sel.image) });
  files.push({ path: '.pre-commit-config.yaml', content: preCommit(stack) });
  if (sel.image) files.push(...stack.docker);
  return files;
}
