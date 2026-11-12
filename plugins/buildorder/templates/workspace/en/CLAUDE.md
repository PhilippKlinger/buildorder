# CLAUDE.md — {{name}}

> Workspace set up with Buildorder. Control file: `.claude/workspace.json`.

## What this workspace is

<!-- fill: 2–4 sentences on goal, audience and kind of project. No version, test count or status: those live in SPRINT.md. -->

## Structure and boundaries

<!-- fill: table Folder | Content | Stack | Remote | Visibility, one row per repo. -->

The workspace root is a private docs repo of its own. The doc-map control files live only here, never in a code repo
(the `boundary-guard` hook blocks that). Git commands run in the repo they concern.

## Doc-map: one home per kind of information

| Information | File |
|---|---|
| Handoff between sessions | `HANDOFF.md` |
| Active tasks (at most 5) | `SPRINT.md` |
| Open tasks with details | `BACKLOG.md` |
| Finished blocks | `BACKLOG_ARCHIVE.md` |
| Decisions and their reasons | `DECISIONS.md` |
| Assumptions made | `assumptions.md` |

Keep the docs up to date without being asked: add to them, never overwrite a whole file.
Derived facts (version, test count, status) live in one place only: `SPRINT.md`.

## Commands

<!-- fill: per repo the actual commands for install, test, lint and build. -->

Dev servers, builds and deploys are started by the user.

## Working mode

- Session frame: `/buildorder:kickoff` to start, `/buildorder:handoff` to finish.
- Deliver what was asked, in the intended scope: no unrequested features, refactorings, files, tests or abstractions.
  Resolve ambiguity that barely changes the work yourself and state the assumption in one sentence; ask only when the
  readings lead to substantially different work. If you think the task is wrong, say so in one sentence, then proceed as asked.
- Small, verifiable steps. Lasting assumptions go to `assumptions.md`, decisions with their reason to `DECISIONS.md`.
- "Done" means checked against the source (test, run, finding), not only against the backlog text. CI is authoritative.
- `main` stays stable; every change goes through a branch and a pull request. Conventional Commits.
- Docs, commits, branches, pull requests and code comments in English.
