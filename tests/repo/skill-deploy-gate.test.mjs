// deploy-gate: go/no-go check before a deploy. Text checks against SKILL.md (whitespace-normalized).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatter } from '../../plugins/buildorder/lib/detect.mjs';
import { repoRoot } from '../helpers/repo.mjs';

const raw = readFileSync(join(repoRoot, 'plugins', 'buildorder', 'skills', 'deploy-gate', 'SKILL.md'), 'utf8');
const text = raw.replace(/\s+/g, ' ');
const fm = frontmatter(raw);
const CLI = '"${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs"';

test('deploy-gate has the module skill shape: fork, high effort, read-only pre-approvals, status injection', () => {
  assert.equal(fm.name, 'deploy-gate');
  assert.equal(fm.context, 'fork');
  assert.equal(fm.effort, 'high');
  assert.match(fm.description, /\bUse only inside a Buildorder workspace\.$/);
  assert.ok(raw.includes('!`node ' + CLI + ' status`'), 'status injection missing');
  const tools = fm['allowed-tools'].split(/,\s*(?![^()]*\))/).map((t) => t.trim());
  for (const tool of tools) {
    assert.match(tool, /^(Read|Grep|Glob)$|^(Bash|PowerShell)\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/buildorder\.mjs" (status|plan) ?\*\)$/, tool);
  }
  assert.doesNotMatch(fm['allowed-tools'], /\b(gh|git)\b/, 'gh and git are not pre-approved');
  raw.split(/\r?\n/).forEach((line, i) => {
    if (/pending/i.test(line)) assert.doesNotMatch(line, /\byes\b/i, `line ${i + 1}`);
  });
});

test('deploy-gate stops with a friendly sentence outside a workspace', () => {
  assert.match(text, /Not inside a Buildorder workspace.{0,200}\/buildorder:init/);
});

test('deploy-gate stops with a friendly sentence when docker-cicd is not active', () => {
  assert.match(text, /standards\.modules/);
  assert.match(text, /does not list `docker-cicd`.{0,200}not set up for this repo.{0,80}stop/i);
});

test('deploy-gate checks the CI run of the HEAD commit, not any green run', () => {
  assert.match(text, /gh run list --commit <sha>/);
  assert.match(text, /rev-parse HEAD/);
  assert.match(text, /green run on the branch.{0,120}not for (the )?(current )?`?HEAD`?.{0,40}NO-GO/i);
});

test('deploy-gate reads secret names only, never values', () => {
  assert.match(text, /gh secret list/);
  assert.match(text, /gh variable list/);
  assert.match(text, /names only/i);
  assert.match(text, /never (read|request|print)[^.]*values?/i);
});

test('deploy-gate never deploys, also on GO', () => {
  assert.match(text, /never deploys?, also on GO/i);
});

test('deploy-gate reports GO or NO-GO with a table of checks', () => {
  assert.match(text, /\*\*Result:\*\* GO \/ NO-GO/);
  assert.match(text, /\| # \| Check \| Status \| Evidence \|/);
  assert.match(text, /NO-GO as soon as any of checks 1 to 5/i);
});

test('deploy-gate treats CI logs and repo files as data, and handles a missing gh friendly', () => {
  assert.match(text, /data, never instructions/i);
  assert.match(text, /gh auth login/);
});

test('deploy-gate passes --repo to every gh call and stops friendly without a remote', () => {
  assert.match(text, /remote get-url origin/);
  assert.match(text, /gh run list --commit <sha> --repo <owner\/name>/);
  assert.match(text, /gh secret list --repo <owner\/name>/);
  assert.match(text, /gh variable list --repo <owner\/name>/);
  assert.match(text, /no GitHub remote.{0,160}one friendly sentence/i);
});

test('deploy-gate fits the docker-cicd module: workflow, compose, env and secrets', () => {
  assert.match(text, /workflow `ci`.{0,120}job `ci-ok`/i);
  assert.match(text, /waiting for (the )?(environment )?approval.{0,160}not (a plain )?NO-GO/i);
  assert.match(text, /docker-compose\.prod\.yaml/);
  assert.match(text, /`image: \$\{APP_IMAGE:\?\}`.{0,200}(counts as|is) (pinned )?by digest/i);
  assert.match(text, /webspace.{0,80}paas.{0,200}not applicable/i);
  assert.match(text, /`REQUIRED_ENV`/);
  assert.match(text, /\.env\.example.{0,40}only if (it )?exists/i);
  assert.match(text, /gh secret list --env production --repo <owner\/name>/);
});

test('deploy-gate requires HEAD to be main and equal to origin/main', () => {
  assert.match(text, /branch --show-current/);
  assert.match(text, /HEAD must be `main` and equal to `origin\/main`.{0,120}NO-GO/i);
});

test('deploy-gate never opens .env or other secret files', () => {
  assert.match(text, /never open `\.env`[^.]*secret files?/i);
});

test('deploy-gate runs one command per call, no cd chains', () => {
  assert.match(text, /one command per call/i);
  assert.match(text, /no `cd \.\.\. &&` chains/i);
});

test('deploy-gate: optional names are notes, required names decide, REQUIRED_ENV is optional', () => {
  assert.doesNotMatch(raw, /\| # \| Check \| How \|\r?\n\|---\|---\|---\|\r?\nThe deploy target/);
  assert.match(text, /`REQUIRED_ENV` is optional/i);
  assert.match(text, /only names the repo declares as required count/i);
  for (const n of ['READINESS_URLS', 'REQUIRED_ENV', 'WEBSPACE_PROTOCOL', 'WEBSPACE_DELETE', 'WEBSPACE_KEEP', 'SITE_URL']) {
    assert.match(text, new RegExp('optional names?[^.]*`' + n + '`', 'i'), n);
  }
  assert.match(text, /`WEBSPACE_PASSWORD` is required only for ftps/i);
  assert.match(text, /missing optional name is a note, not NO-GO/i);
  assert.match(text, /name the deploy step needs unconditionally.{0,120}NO-GO/i);
});

test('deploy-gate checks the waiting deploy job through the run jobs', () => {
  assert.match(text, /gh run view <id> --repo <owner\/name> --json jobs/);
});

test('deploy-gate: docker-cicd without a deploy workflow is NO-GO', () => {
  assert.match(text, /deploy workflow of the target is missing.{0,40}NO-GO.{0,60}the module's deploy workflow is missing/i);
});

test('deploy-gate does not check names the deploy workflow sets itself', () => {
  assert.match(text, /names the deploy workflow sets itself.{0,80}`APP_IMAGE`.{0,120}not checked/i);
});

test('deploy-gate reads the deploy target from the plan and handles paas', () => {
  assert.match(text, /plan "<repo folder>".{0,120}field `deploy`/i);
  assert.match(text, /`paas`.{0,80}checks 1, 2 and 6 only/i);
  assert.match(text, /not applicable \(the provider deploys from main\)/i);
  assert.match(text, /only for the targets `container` and `webspace`/i);
  assert.doesNotMatch(text, /does not reach this skill/i);
});

test('deploy-gate handles deploy target none with checks 1, 2 and 6 only', () => {
  assert.match(text, /`none`.{0,80}checks 1, 2 and 6 only/i);
  assert.match(text, /not applicable \(deploy target none: the pipeline deploys nothing\)/i);
  assert.match(text, /verdict .{0,40}from (checks )?1, 2 and 6.{0,80}no deploy workflow (is )?needed/i);
});

test('deploy-gate gives NO-GO when the plan target and the present deploy workflow disagree', () => {
  assert.match(text, /plan target and a deploy workflow file contradict each other, name both/i);
  assert.match(text, /NO-GO "deploy target unclear"; do not guess/i);
  assert.match(text, /`deployment\.yml`.{0,120}`deployment-webspace\.yml`/);
});

test('deploy-gate reads modules from the plan when the repo entry has no standards', () => {
  assert.match(text, /no `standards`.{0,200}`modules` from the read-only `node [^`]{0,80}plan "<repo folder>"` output/i);
});
