---
name: review
description: Code review of one repo in a Buildorder workspace. Runs the built-in /code-review, then checks the project's own criteria (standard model, recorded deviations, spec acceptance criteria) and reports findings by severity with a merge-ready verdict. Reports only, changes nothing. Use only inside a Buildorder workspace.
argument-hint: "[repo path] [file, PR number, branch or range]"
context: fork
effort: high
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" plan *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" plan *), Read, Grep, Glob
---

# Review

Review the changes of one repo and report. Read and judge only: edit no file, commit nothing, run only read-only
git commands, and never pass `--fix` or `--comment` to `/code-review`.

## Workspace state (live)

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status`

## 1. Pick the repo

1. If the state above says "Not inside a Buildorder workspace", reply with one friendly sentence that this skill
   needs a Buildorder workspace (set one up with `/buildorder:init`). Do nothing else.
2. Read `.claude/workspace.json` in the workspace root named above.
3. Arguments: **$ARGUMENTS**. If the first word matches a `repos[].path`, that is the repo and the rest is the target.
   Otherwise the repo is the one that contains your working directory, and all arguments are the target.
   If neither gives a repo, list the code repo paths, ask the user to call the skill again with one, and stop.
4. **Mode:** *in-repo* when your working directory is the repo folder or inside it, otherwise *root*.
   Do not `cd`: every command starts in the working directory again. Use `git -C "<repo folder>"` instead.
5. In root mode, the first line of your reply is: `Started outside <repo>: the built-in /code-review cannot run from here and stays pending. For the full run, start a session in <repo folder> and call /buildorder:review again.`
   Decide this now, before any finding, then review as below.

## 2. Correctness

- **In-repo:** invoke the built-in `code-review` skill with the Skill tool and pass the target (empty: the
  branch's commits plus uncommitted changes). Count it as *ran* only when the Skill tool result holds its findings
  or says it found none; then take them over without rewording. If it cannot run, or only reports that it started or
  runs in the background, it is *pending* (its findings arrive separately in the main conversation): review the
  diff yourself as in root mode.
- **Root:** review the same scope yourself. Committed: `git -C "<repo folder>" diff origin/HEAD...` (without
  `origin/HEAD`: `main...`); uncommitted: `git -C "<repo folder>" diff HEAD`; new files: the `??` entries of
  `git -C "<repo folder>" status --porcelain`, read in full. A branch or range target replaces the committed range;
  a path target limits all three to that path; for a PR number ask for its branch instead.
  Look for logic errors, unhandled edge cases, regressions and breaches of the repo's `CLAUDE.md`.
  The built-in `/code-review` is then *pending*, with the tip to start the session in the repo.

## 3. Project criteria

Judge the same diff, not the old code around it.

1. **Standard:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" plan "<repo folder>"` (the read-only plan).
   Visibility: pass `--visibility <value>` from the repo's `visibility` in `workspace.json` when set; otherwise
   `--visibility private` when its `standards.deviations` give a private repo as reason; otherwise leave it out.
   A `mandatory` item in state `missing` is Important when the diff removed or broke it (a workflow job,
   `.pre-commit-config.yaml`, `dependabot.yml`, an action no longer pinned to a SHA); if it was missing before,
   list it as pre-existing.
2. **Deviations:** every entry of the plan's `deviations` and of the repo's `standards.deviations` needs an entry
   with its reason in the decisions file (`docs.decisions`). A deviation this diff introduces without one is Important.
3. **Spec:** if the branch name, the commit messages (`git -C "<repo folder>" log`) or the sprint entry name a spec
   (for example under `docs/specs/` in the workspace or the repo), read it. Each acceptance criterion must be
   implemented and backed by a test or a documented check; changes outside its scope are findings. Without a spec,
   the sprint task is the measure.
4. **Tests:** does a test cover the new behaviour, and would it fail if the code broke?

Skip what CI already enforces (lint, formatting, type checks, test runs, dependency audit).

## 4. Severity

- **Critical:** breaks behaviour for users, loses data or leaks data or secrets.
- **Important:** a correctness or requirement gap: wrong result in a normal case, an acceptance criterion missing or
  unproven, a mandatory standard item removed, a new deviation without a recorded reason.
- **Minor:** everything else worth saying; at most five, the rest as a count.
- **Pre-existing:** problems this diff did not cause. Never blocking.

Confirm every finding in the code (`file:line`) or in a command output. Drop what you cannot back. Merge duplicates.

## 5. Report

Write in the language `language.docs`; keep the severity names and the last line as written here.

```markdown
## Review: <repo> · <scope>
**Built-in /code-review:** ran / pending (started separately: findings arrive in the main conversation | start the session in <repo> for the full run)
**Result:** N critical · N important · N minor · N pre-existing

### Critical
- `file:line`: problem; suggestion _(source: code-review | standard | spec | project)_

### Important
### Minor
### Spec (only with a spec)
| Criterion | Done | Evidence |
|---|---|---|

### Pre-existing

merge-ready: yes / no (one sentence why)
```

`no` as soon as anything is Critical or Important. `yes` only when the built-in run *ran* and nothing blocks.
While it is *pending*, write `merge-ready: no (built-in /code-review pending)`. Leave out empty sections.
