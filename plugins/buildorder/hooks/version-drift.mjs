// UserPromptSubmit: when a prompt talks about a release, compares the latest v* git tag with the
// version files of every repo that has the `versioning` module and warns once when they differ.
// Silent otherwise. Reads package.json, package-lock.json and the static version of pyproject.toml.
// Source stays ASCII: the German umlaut is a \u escape.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../lib/git.mjs';
import { readState, stateFile, writeState } from './state.mjs';

const RELEASE = /\b(?:release\w*|bump\w*|tag(?:s|ged|ging)?|versions?|ver\u00f6ffentlich\w*)\b/i;
// Only SemVer-like values are shown: repo text is data and never reaches the prompt context otherwise.
const SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const validVersion = (v) => typeof v === 'string' && v.length <= 64 && SEMVER.test(v);
const SEP = ' \u00b7 ';

/** The `version` string of a JSON file, or null when missing, unreadable or not a string. */
function jsonVersion(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))?.version;
    return validVersion(v) ? v : null;
  } catch {
    return null;
  }
}

/** The static `version = "..."` in the [project] table of a pyproject.toml, or null. */
function pyprojectVersion(file) {
  try {
    let inProject = false;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) {
        inProject = /^\[project\]\s*(?:#.*)?$/.test(line);
        continue;
      }
      const m = inProject ? /^version\s*=\s*["']([^"']+)["']/.exec(line) : null;
      if (m) return validVersion(m[1]) ? m[1] : null;
    }
  } catch { /* unreadable: skipped */ }
  return null;
}

/** The drift text of one repo, or null when all versions agree. */
function driftOf(repo, dir) {
  const found = [];
  const tag = git(dir, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
  if (validVersion(tag)) found.push({ label: `tag ${tag}`, value: tag.replace(/^v/, '') });
  const files = [
    ['package.json', jsonVersion],
    ['package-lock.json', jsonVersion],
    ['pyproject.toml', pyprojectVersion],
  ];
  for (const [name, read] of files) {
    const file = join(dir, name);
    const value = existsSync(file) ? read(file) : null;
    if (value !== null) found.push({ label: `${name} ${value}`, value });
  }
  if (new Set(found.map((f) => f.value)).size < 2) return null;
  return `Version drift in ${repo}: ${found.map((f) => f.label).join(SEP)}. Align one version in all places before the release.`;
}

/** @returns {{ context: string } | null} */
export default function versionDrift(input, { root, ws }) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!RELEASE.test(prompt) || !Array.isArray(ws.repos)) return null;
  const drifts = [];
  for (const repo of ws.repos) {
    const modules = repo?.standards?.modules;
    if (typeof repo?.path !== 'string' || !Array.isArray(modules) || !modules.includes('versioning')) continue;
    const dir = resolve(root, repo.path);
    if (!existsSync(join(dir, '.git'))) continue;
    const text = driftOf(repo.path, dir);
    if (text !== null) drifts.push(text);
  }
  if (drifts.length === 0) return null;
  const file = stateFile('version', input.session_id);
  const shown = readState(file).split('\n').filter(Boolean);
  const fresh = drifts.filter((d) => !shown.includes(d));
  if (fresh.length === 0) return null;
  writeState(file, [...shown, ...fresh].join('\n'));
  return { context: fresh.join('\n') };
}
