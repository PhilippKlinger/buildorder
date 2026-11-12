# Buildorder

A Claude Code plugin that sets up a workspace and engineering standards for your project.

[![ci](https://github.com/PhilippKlinger/buildorder/actions/workflows/ci.yml/badge.svg)](https://github.com/PhilippKlinger/buildorder/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/PhilippKlinger/buildorder/badge)](https://scorecard.dev/viewer/?uri=github.com/PhilippKlinger/buildorder)
[![License](https://img.shields.io/github/license/PhilippKlinger/buildorder)](LICENSE)

Your agent writes the code. Buildorder builds the engineering around it.

> **Pre-release (0.x).** Interfaces may change between versions.

```mermaid
flowchart LR
  dev["Developer"]
  cc["Claude Code"]
  bo["Buildorder plugin<br/>skills, hooks, CLI"]
  subgraph wsf["Workspace folder"]
    docs["Docs: CLAUDE.md, doc-map, workspace.json<br/>(private git repo)"]
    repo["Code repo<br/>(own git repo, ignored by the docs repo)"]
  end
  gh["GitHub<br/>Actions, rulesets"]
  dev -->|"prompts, confirms"| cc
  cc -->|"runs skills and hooks"| bo
  bo -->|"writes and reads"| docs
  bo -->|"writes the pipeline, checks commits"| repo
  dev -->|"pushes, applies the settings checklist"| gh
  repo -->|"CI on push and pull request"| gh
```

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [How it differs from `/init`](#how-it-differs-from-init)
- [What you get](#what-you-get)
- [What CI checks](#what-ci-checks)
- [Security model](#security-model)
- [Limits and safety](#limits-and-safety)
- [License](#license)

## Requirements

- Claude Code
- Node.js 22 or newer
- git
- `gh` (optional)

## Installation

```text
/plugin marketplace add PhilippKlinger/buildorder#v0.2.0
/plugin install buildorder@buildorder
```

`#v0.2.0` pins the marketplace to that release tag; without it, the marketplace follows `main`.
Install the plugin at user scope (the default of `claude plugin install`). To turn it off for one project,
disable it there with `/plugin` (project scope).

## Quickstart

Run `/buildorder:init` in an empty folder (new Django project) or in a folder that holds one existing git repo.
It does the following:

1. Checks the folder and runs a short interview (at most 8 questions).
2. Shows the plan and writes only after your confirmation.
3. Creates the workspace (a private git repo for the docs) with its doc-map and the GitHub settings checklist.
4. New project: writes the standard pipeline and a tested starter into the repo in one commit.
   Existing project: leaves the repo unchanged and turns missing items into backlog tasks.
5. Pushes nothing.

If you run it inside the existing repo itself, init offers to move the repo into a subfolder first, so the
folder can become the workspace; it moves nothing without your OK. Afterwards, open a new session so the hooks
load, and start with `/buildorder:kickoff`.

## How it differs from `/init`

Claude Code's built-in `/init` reads the codebase and writes a `CLAUDE.md` for it. `/buildorder:init` writes a
`CLAUDE.md` too, but into a workspace folder next to the code repo, together with docs for handoff, sprint,
backlog, decisions and assumptions, kept in a private git repo of their own. For a new project it also writes a CI
pipeline and, for Django, a tested starter into the code repo; for an existing project it records what is missing
as backlog tasks. Inside the workspace, hooks guard commits and control files, and the skills start and end each
session from these docs.

## What you get

**Skills**

| Skill | Purpose |
|---|---|
| `/buildorder:init` | Guided workspace setup |
| `/buildorder:kickoff` | Session start: warnings, last handoff, repo state, task proposals |
| `/buildorder:handoff` | Session end: git state, docs update, handoff file |
| `/buildorder:assess` | Static assessment of one repo, findings ranked P0 to P3 |
| `/buildorder:review` | Code review with the project's own criteria (reports only) |
| `/buildorder:secure` | Security and data protection audit (reports only) |

**Hooks**

- Boundary guard: keeps workspace control files out of code repos.
- Secret guard: scans the staged diff before `git commit` and denies on findings.
- Prompt hints: adds keyword hints and suggests `/effort high` for debugging, security or release work.
- Compaction guard: after a compaction, asks to re-sync from the handoff before continuing.
- Handoff reminder: when commits are newer than the handoff file.

**Stack:** `django` so far. Other stacks get the workspace and the stack-independent CI only.
The Django starter is a minimal project with a `/healthz/` endpoint and its test; it has neither `auth` nor `admin`.

**Deploy targets:** `container`, `paas`, `webspace` or `none`. The container image (Trivy scan, SBOM,
build-provenance attestation) and its CD come from the `docker-cicd` module.

## What CI checks

**The pipeline Buildorder writes** into a new repo is one `ci.yml` that runs on pushes to `main`, on pull
requests and on demand. Its `ci-ok` job is the required check of the ruleset in the settings checklist.

- Stack jobs (Django): `ruff check` and `ruff format --check`, `pytest --cov` against PostgreSQL,
  `manage.py check --deploy` and `collectstatic`, `pip-audit`.
- gitleaks over the full history, zizmor over the workflows, and the pre-commit hooks.
- Dependency Review on pull requests and CodeQL for the stack's language and for GitHub Actions, in public repos
  only: for a private repo both jobs are left out and recorded as a deviation (see
  [Limits and safety](#limits-and-safety)).
- Every action pinned to a full commit SHA; Dependabot keeps the pins and the stack's dependencies current.
- With the `docker-cicd` module: image build, Trivy scan (CRITICAL and HIGH with a fix available), SPDX SBOM, and
  on `main` a push to GHCR by digest with a build-provenance attestation (public repos). CD for `container` and
  `webspace` runs only once the repository variable `DEPLOY_ENABLED` is `true`.

Trivy runs as the pinned `aquasecurity/trivy-action`, the one scanner in this pipeline that comes as an action not
published by GitHub; zizmor and gitleaks run as pinned tool versions (pipx, and a container image pinned by digest).

**Buildorder's own CI** (`.github/workflows/ci.yml`) runs on pushes to `main`, on pull requests, weekly and on
demand; `ci-ok` requires every job to succeed.

- `test`: the full test suite and the hook timing test on Ubuntu, Windows and macOS with Node 22 and 24.
- `validate`: `claude plugin validate --strict` for the marketplace and the plugin.
- `pre-commit`: the repo's pre-commit hooks, gitleaks included.
- `zizmor`: zizmor over this repo's workflows and over the workflows `standard` generates, then actionlint over
  the generated ones.
- `django-fixture`: writes the Django starter and its pipeline into an empty repo and runs that pipeline's core
  steps on it: lint, tests with coverage against PostgreSQL, build checks, dependency audit, image build and Trivy.
- `gitleaks`: `gitleaks/gitleaks-action`; pushes and pull requests scan their new commits, the weekly and manual
  runs scan the full history.
- `codeql`: CodeQL for JavaScript and GitHub Actions.

actionlint runs from its official release archive, pinned by version and SHA-256, because no pinned action checks
the generated workflows in the same job. A separate `scorecard.yml` runs OpenSSF Scorecard on pushes to `main`,
weekly and on branch protection changes, and publishes the result; it rates the repo and is not part of `ci-ok`.

## Security model

The hooks are guardrails, not a guarantee. They catch common mistakes in the commands an agent runs; a command
written to get around them gets around them, and they are no sandbox. Permissions, `settings.json` and the sandbox
stay your decision: Buildorder writes no Claude Code settings file. The hooks act only inside a Buildorder
workspace (a folder with `.claude/workspace.json` at or above the path); elsewhere they stop after that lookup.

**Boundary guard** (Write and Edit tool calls). It denies a doc-map file (the names in `guards.docsOnlyNames`)
at the root or in `docs/` of a code repo, and any path in `guards.protectedPaths`. It does not see files that a
shell command writes, and files with the same name deeper in a repo, such as templates, are allowed.

**Secret guard** (`git commit` through the Bash or PowerShell tool). It scans the added lines of the staged and
unstaged changes of tracked files, and the untracked files when a `git add` runs before the commit in the same
command. It flags secret files by name (`.env`, private keys, `*.pem` and similar) and a fixed list of patterns
(private keys, AWS, GitHub, Slack and Google keys, `sk-` API keys, Django `SECRET_KEY`, quoted passwords and
tokens), and shows the findings masked. It fails closed: when git output cannot be read, or the command does not
show which repo the commit goes to, the commit is denied with a hint for a form it can read.

Known limits:

- The `if: Bash(git *)` filter does not see `/usr/bin/git`, `git.exe` or `sh -c`.
- Shell aliases, git aliases and disguised commands are not recognised.
- Only `commit` is scanned, not `merge`, `cherry-pick` or `am`, nor tools that commit without the word `git`.
- A secret assigned without quotes (`DB_PASSWORD=value`) is not found, and a value that contains a placeholder
  word such as `example` or `your_` is ignored.
- `onFailure: block` needs `node`: without it, every `git` command through these tools is denied in every project
  where the plugin is enabled.
- Commits made outside Claude Code are not seen; the pre-commit gitleaks hook and the CI gitleaks job cover those.

## Limits and safety

- Buildorder never pushes, never creates repositories and never calls the GitHub API at present.
  GitHub settings are a checklist with ready commands that you run.
- Hooks are guardrails, not a guarantee; see [Security model](#security-model) for what they do and their known
  limits.
- Private repos skip CodeQL and Dependency Review (paid GitHub products) and record this as a deviation.
- Behind a reverse proxy that terminates TLS, set `DJANGO_BEHIND_PROXY=true` for the Django starter.

## License

MIT, see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
