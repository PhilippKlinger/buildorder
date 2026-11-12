---
name: kickoff
description: Session start in a Buildorder workspace (a folder with .claude/workspace.json). Shows warnings, the last handoff and the repo state, then proposes tasks. Use only at the start of a session inside a Buildorder workspace.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), Read, Edit
---

# Kickoff

Open the session so the user can choose today's work within a minute.
Show the state and make proposals. Do not start any work until the user picks.

## Workspace state (live)

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status`

## Steps

1. If the state above says "Not inside a Buildorder workspace", reply with one friendly sentence that this skill
   needs a Buildorder workspace (set one up with `/buildorder:init`). Do nothing else.
2. Read `.claude/workspace.json` in the workspace root named above. Take the file names from `docs`
   (`handoff`, `sprint`, `backlog`) and write any doc changes in the language `language.docs`.
3. **Warnings first:** uncommitted changes, commits ahead of or behind the upstream, missing folders,
   folders that are no git repo.
4. **Last session:** sum up the handoff file in 2–3 lines: where it stopped, what was handed over, open risks.
5. **Sprint:** if the active table of the sprint file has tasks, show them and ask whether to continue or reprioritise.
   Make no new proposals then.
6. **Proposals** (empty sprint): pick exactly 5 tasks from the backlog short list.
   - If the user named a focus, filter by it.
   - Otherwise P0 first, then P1 that can be finished in one session, then the remaining P1. P2 and lower only when no P1 is open.
   - Skip tasks that wait on the user or on others.
   - Mark tasks that need a decision before work starts.
   - Give each an effort hint: `low` for docs and small edits, `medium` for normal implementation,
     `high` for debugging, edge cases, security and release checks. Only the user can switch (`/effort`).
7. **Take over the pick:** add the chosen tasks to the active table of the sprint file (at most 5), each with goal,
   boundaries (what not to touch) and definition of done. Where the backlog entry lacks one, propose it and let the user confirm.

## Output

```markdown
## Session start

**Warnings:** … (only if any)

### Last session
2–3 lines from the handoff

### Repos
the status lines above, unchanged

### Sprint
active tasks, or "empty"

### Proposals
| # | Task | ID | Effort | Definition of done |
|---|---|---|---|---|
```

Keep the whole block on one screen.

## Pitfalls

- Do not start work, even when a task looks obvious. Wait for the user's pick.
- Do not trust the backlog text alone: if an open task looks done, check the code or file and point it out.
