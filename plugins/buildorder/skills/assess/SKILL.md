---
name: assess
description: Static assessment of one repo in a Buildorder workspace. Covers stack, git state, dependencies, Docker and CI, tests, secrets and hosting dependencies, and writes an audit file with findings ranked P0 to P3. Pass a repo path from workspace.json. Use only inside a Buildorder workspace.
argument-hint: "<repo path>"
context: fork
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" detect *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" detect *), Read, Grep, Glob
---

# Assess

Assess the repo **$ARGUMENTS**. Read and judge only: change nothing in the repo. Install nothing, build nothing,
run no tests, commit nothing. The only file you write is the audit file. Leave the sprint and backlog files alone;
the caller takes the proposed tasks over.

**Commands:** run every command from the session's working directory, one command per call: never prefix `cd`, never
chain with `&&`, `;` or pipes.

## Workspace state (live)

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status`

## 1. Check the target

1. If the state above says "Not inside a Buildorder workspace", reply with one friendly sentence that this skill
   needs a Buildorder workspace (set one up with `/buildorder:init`). Do nothing else.
2. Read `.claude/workspace.json` in the workspace root named above. If the argument is empty or matches no
   `repos[].path`, list those paths, ask which repo to assess and stop.

## 2. Collect facts

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" detect "<workspace root>"` and take the entry of `repos`
   whose `path` is the repo. Use its `stacks`, `unsupported`, `deploy`, `remote`, `branch`, `dirty`, `ahead`,
   `workflows`, `hasTests` and `docker` as given. Do not detect these again.
2. Read only what the facts point to: README, manifests and lockfiles, Dockerfile and compose file, CI workflows,
   config and entry points, traces of today's deploy (deploy scripts, FTP or SFTP config, `.htaccess`).
   Read-only git commands (`git -C "<repo folder>" log`, `branch -a`, `tag`) are fine for age and branches.
   Do not `cd`: every command starts in the working directory again. Run one command per call, with no `cd ... &&` chains
   (they are denied or ask for permission).
3. **Secrets:** look for tracked env and key files, and for key or token patterns in code and config. Check the
   history for env and key files that were added once. Report file, line and kind only. Never print a value,
   not even shortened.

## 3. Assess

Every finding names its evidence: `file:line` or a fact from `detect`.

| Area | Questions |
|---|---|
| Runs | What does it take to start? Does it depend on hosting or services that are gone (backend URLs, mail scripts)? |
| Dependencies | How old is the stack against the current major? Unpinned versions? Lockfile present? |
| Secrets | Tracked or once-committed secret files are P0. Weigh pattern hits: code is serious, templates and test data need a look. |
| Container | Reproducible build in a container? Pinned images, non-root user, multi-stage, healthchecks? |
| CI/CD | Pipeline from lint to test to build? Actions pinned? Does the deploy path match the `deploy` target? |
| Tests | Present? Which framework? Do they cover the core logic? |
| Docs | Can someone set it up from the README? |

Priorities: **P0** security risk or blocks everything · **P1** needed to run or show it again ·
**P2** professional standard (container, CI, tests) · **P3** polish.
Phrase what is uncertain as an open question, not as a finding. Do not ask again what the workspace's decisions
file already settles.

## 4. Write the audit file

Write `docs/audits/<YYYY-MM-DD>-assess-<repo-slug>.md` in the workspace root (slug: the repo path with `/` as `-`).
If the file exists, append `-2`, `-3` and so on; never overwrite. Write it in the language `language.docs`.
If the write is refused, show the audit text in the reply and stop: no heredoc, no shell, no other file.

```markdown
# Assessment: <repo>

**Date:** … · **State:** branch …, last commit … · **Remote:** …

## Profile
Stack · size · age (first and last commit) · tests · CI · container · deploy target with evidence

## Findings
| # | Prio | Area | Finding | Evidence |
|---|---|---|---|---|

## What is good
- …

## Proposed tasks
| ID proposal | Prio | Task | Definition of done |
|---|---|---|---|

## Open questions
- each names the file and the command, e.g. "`npm test` in `web/`: does it pass for you?"
```

## 5. Reply

At most 15 lines, no findings table: the audit file path, the number of findings per priority, the three most
important findings (one line each), and the deploy target with its evidence.
