---
name: handoff
description: Session end in a Buildorder workspace. Checks the git state of all repos, updates sprint, backlog, archive, decisions and assumptions, and writes the handoff file. Use at the end of a session or when the user wraps up.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), Read, Edit, Write
---

# Handoff

Close the session so the next one can start without asking. Act: update the docs and write the handoff yourself.
Start no new features or fixes.

## Workspace state (live)

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status`

## Steps

1. If the state above says "Not inside a Buildorder workspace", reply with one friendly sentence that this skill
   needs a Buildorder workspace (set one up with `/buildorder:init`). Do nothing else.
2. Read `.claude/workspace.json` in the workspace root named above. Take every file name from `docs` and write
   in the language `language.docs`.
3. **Git:** for each repo with uncommitted changes, ask whether to commit, commit as work in progress, or leave it.
   Never decide this yourself. Never push and never open a pull request.
4. **Docs:** update each file in place with targeted edits. Never rewrite a whole file. Check against the source
   (code, tests, files) before marking anything done, not only against the conversation.

   | `docs` key | What to update |
   |---|---|
   | `sprint` | move finished tasks from the active table to done; refresh the status line; keep the file under 50 lines |
   | `backlog` | tick finished tasks; move fully finished epics to `archive` |
   | `archive` | receives the finished epics |
   | `decisions` | add decisions made in this session, each with its reason |
   | `assumptions` | add new assumptions; update the status of confirmed or refuted ones |

5. **Handoff file** (`docs.handoff`): replace its content with this session's handoff, at most 20 lines. Keep the
   headings the file already uses (they follow `language.docs`): date, what was done, open state with branches,
   pull requests and next steps, risks and blockers, decisions of this session (pointing to the decisions file).
6. **Open questions:** list for the user, as questions, every push and pull request still open: each branch ahead of
   its upstream or without one, with the repo it belongs to. If the workspace root is a git repo, also offer to commit
   the doc changes there as `docs: session handoff <YYYY-MM-DD>`.

## Output

```markdown
## Session end
- Git: clean / open: …
- Docs: N files updated
- Questions: push, pull request, docs commit (only if any)

Handoff written. Start the next session with /buildorder:kickoff.
```

## Pitfalls

- The conversation is not the source. If the context was compacted, read the git log and the files instead of recalling.
- Code repos are the user's call: no commits there without an answer to step 3.
