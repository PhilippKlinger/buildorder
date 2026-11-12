# Buildorder

[![ci](https://github.com/PhilippKlinger/buildorder/actions/workflows/ci.yml/badge.svg)](https://github.com/PhilippKlinger/buildorder/actions/workflows/ci.yml)

A Claude Code plugin that sets up a workspace and engineering standards for your project.
Your agent writes the code. Buildorder builds the engineering around it.

> **Pre-release (0.x).** Interfaces may change between versions.

## Requirements

- Claude Code
- Node.js 22 or newer
- git
- `gh` (optional)

## Installation

```text
/plugin marketplace add PhilippKlinger/buildorder
/plugin install buildorder@buildorder
```

The plugin is installed at user scope. To turn it off for one project, disable it there with `/plugin`
(project scope).

## Quickstart

Run `/buildorder:init` in an empty folder (new Django project) or in a folder that holds one existing git repo.
It does the following:

1. Checks the folder and runs a short interview (at most 8 questions).
2. Shows the plan and writes only after your confirmation.
3. Creates the workspace with its doc-map and the GitHub settings checklist.
4. New project: writes the standard pipeline and a tested starter into the repo in one commit.
   Existing project: leaves the repo unchanged and turns missing items into backlog tasks.
5. Pushes nothing.

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

**Stack:** `django` in 0.1.0. Other stacks get the workspace and the stack-independent CI only.

**Deploy targets:** `container`, `paas`, `webspace` or `none`. The container image (Trivy scan, SBOM,
build-provenance attestation) and its CD come from the `docker-cicd` module.

## Limits and safety

- Buildorder never pushes, never creates repositories and never calls the GitHub API in 0.1.0.
  GitHub settings are a checklist with ready commands that you run.
- Hooks are guardrails, not a guarantee. Known limits: the `if: Bash(git *)` filter does not see
  `/usr/bin/git`, `git.exe` or `sh -c`; `onFailure: block` needs `node`; only `commit` is scanned.
- Private repos skip CodeQL and Dependency Review (paid GitHub products) and record this as a deviation.
- Behind a reverse proxy that terminates TLS, set `DJANGO_BEHIND_PROXY=true` for the Django starter.

## License

MIT, see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
