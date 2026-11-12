---
name: init
description: Sets up a Buildorder workspace in this folder in one guided run, for a new project (empty folder) or one existing repo. Checks the folder, runs a short interview, shows the plan and writes only after the user's OK.
argument-hint: "[what the project is about]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" detect *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" detect *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" nest *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" nest *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" scaffold *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" scaffold *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" standard *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" standard *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" verify *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" verify *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" finalize *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" finalize *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" github-checklist *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" github-checklist *), Bash(git init *), PowerShell(git init *), Read, Grep, Glob, AskUserQuestion
---

# Init

Set up a Buildorder workspace in the current folder. The CLI does the mechanics; you classify, ask, confirm and
write the texts. Write nothing before the user's OK in step 2, except a `nest` the user agreed to.

**CLI:** every command below runs as `node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" <command> …`.
Quote every path: paths may hold spaces.
**Start text:** $ARGUMENTS

## Folder finding (live)

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" detect .`

## 0. Safety check

Act on `suggestion`:
- `blocked`: explain and stop. `foreign-workspace`: the `.claude/workspace.json` here is not Buildorder's.
  `agent-setup`: the folder already has an agent setup (`existingSetup`); Buildorder never overwrites one.
- `multi-repo`: say that several code repos in one workspace are not supported in 0.1.0, and offer to run init in
  a folder that holds one repo. Stop.
- `repo-root`: the folder is itself a code repo, so the workspace cannot live in it. If
  `workspaceProposal.inPlace.blockers` is not empty, name them and stop. Otherwise explain in two sentences:
  everything (history, uncommitted and ignored files such as `.env`) moves into the subfolder `inPlace.repoPath`,
  and the folder becomes the workspace; close editors, dev servers and terminals in it first. Ask. After the OK run
  `nest . "<repoPath>"`. On `ok: false` name `reason` and stop; never move files by hand. If the result has
  `safeDirectory`, show its `command` and run it only after the user's OK. Then run `detect .` again and go on.
- `resume`: `workspace.initPhase` is `done` → nothing to do, point to `/buildorder:kickoff`. `scaffolded` → read
  `.claude/workspace.json` and the docs, ask one block only for the answers they do not record (stack, deploy
  target), repeat step 3 (its commands never overwrite) and continue where `<!-- fill:` markers remain.
- `new`: go on. `existing`: go on if `repos` holds exactly one entry with `isCode: true`; otherwise explain that
  the code must be in one git repo first and stop.

## 1. Interview

At most 8 questions in at most 3 blocks; the free-text question counts. Give every question a recommendation with
one sentence of reason from the finding. Never ask what the finding or the start text answers, or what a standard
covers: standards appear in step 2 and can be changed there.

**New project:**
1. In chat, unless the start text answers it: "Idea, audience and when it is done, in 2–3 sentences."
2. One `AskUserQuestion` block:
   - Stack: `django` (supported, with a tested starter) or another stack (workspace and stack-independent CI only).
   - Visibility: `public` or `private`. Public repos get CodeQL, Dependency Review and push protection for free;
     private ones need paid GitHub products, so these steps are skipped and recorded as deviations.
   - Deploy target: `container` (the starter ships a Dockerfile), `paas`, `webspace` (static sites only), `none`.
   - Release style: every merge to `main`, or tags with SemVer.
3. One block: personal data or login (it sets the checks of `/buildorder:secure`), plus a deviation only where
   the finding argues against a standard.

**Existing project:** one block: confirm the repo and its `stacks`; goal (revive, modernise, extend); visibility;
deploy target (recommend `repos[].deploy` and name its evidence). A second block: personal data or login, plus
deviations only where the finding argues against a standard (a library without runtime: no container image).
If the start text or notes contradict the finding, ask and name the evidence; never decide silently.

## 2. Confirmation

New project: the repo folder is the workspace folder name without a `-workspace` suffix. Docs language: suggest
the language the user writes in (`en` or `de`; others get `en`).

Run the plan: `standard "<repo>" --stack <id> --deploy <target> --visibility <v> [--without <id>=<reason>]...`,
for a new project with `django` also `--starter` (a repo folder that does not exist yet is planned as empty).
Show compactly:
- **Workspace:** `CLAUDE.md`, `.claude/workspace.json`, the six doc-map files, `docs/github-settings.md`,
  `docs/github-ruleset.json`; for an existing project also the audit file in `docs/audits/`.
- **Repo:** new project: the plan's `files`, in one commit, no push. Existing project: unchanged; every
  `missing` item becomes a backlog task.
- **Standards:** `items` with class and state, `modules`, deploy target, visibility. Mandatory items cannot be
  deselected.
- **Deviations** with their reasons (`deviations`), and the first backlog tasks.
- **GitHub:** a checklist with ready commands; Buildorder calls nothing.
- **Docs language.**
- With `django` and deploy target `container` or `paas`: behind a proxy that terminates TLS, set
  `DJANGO_BEHIND_PROXY=true`.

Ask: set it up like this, or change something. A change goes back into the plan. Write only after the OK.

## 3. Write

**New project:**
1. `git init -b main "<repo>"`, unless `<repo>/.git` exists.
2. `scaffold . --lang <lang> --repo "<repo>" --visibility <v>`
3. `standard "<repo>" <options of the plan> --apply`: one commit in the repo, never a push. If git has no
   identity, give the user the two `git config` commands to run, then repeat.

**Existing project:**
1. `scaffold . --lang <lang> --repo "<repo>" --visibility <v>`
2. `standard "<repo>" <options of the plan> --gaps`: keep the output for step 4. Never `--apply`: the repo stays
   unchanged.

Name the files `scaffold` reports as `skipped` (they existed and were kept). On an error, read the message, fix the
options and repeat; never rebuild what the CLI writes by hand.

## 4. Fill

Write in `language.docs` with targeted edits. Invent nothing: unknowns go to `assumptions.md` or become open questions.

- **Existing project:** run `/buildorder:assess "<repo>"` first. Then stop with "This is how I understand the
  project": at most 10 lines (purpose and audience, structure, build, today's deploy path with evidence, external
  services, the chosen deploy target against the evidence, contradictions marked). Ask: correct, or correct me.
  Only then write the backlog: the rows of the `--gaps` output into the short list and its block below the `---`,
  then the tasks the audit proposes, each pointing to the audit file.
- **New project:** the backlog from the interview: the first feature in 2–4 tasks.
- **Both:** add the task "After the first push: apply the GitHub settings from `docs/github-settings.md`" (for a
  new project as the first task). Record each deviation with its reason, the release style and the personal-data
  answer in `DECISIONS.md`. Fill `CLAUDE.md` and the focus of `SPRINT.md`; leave the active sprint table to
  `/buildorder:kickoff`. Remove every `<!-- fill: … -->` marker; check with Grep that none remains.

## 5. Check and hand over

1. `verify .`: fix every problem and run it again; stop and name what cannot be fixed. Name the `warnings`.
2. `finalize .`: sets `initPhase: done`.
3. `github-checklist .`: writes the checklist with ready commands. Never create a repo, push or call the GitHub
   API, even when `gh` is logged in.

## 6. Close

At most 12 lines: what was set up, the number of backlog tasks, the assumptions made, and what did not happen
(no GitHub repo, no push, no build). Then one short list of recommendations, nothing installed:
- the `notes` of the `standard` output (for example installing the pre-commit hooks), and the proxy note of step 2
- the Superpowers plugin, and the code-intelligence plugin for the stack's language
- open a new session so the hooks load, then start with `/buildorder:kickoff`
