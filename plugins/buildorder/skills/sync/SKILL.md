---
name: sync
description: Lifts this Buildorder workspace to the installed Buildorder version. Lists which workspace files (CLAUDE.md and the doc-map) the current templates would add or update, writes only after the user's OK and never overwrites a file the user changed.
argument-hint: "(no argument)"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" sync .), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" sync .), Read, AskUserQuestion
---

# Sync

Bring the workspace in the current folder up to the installed Buildorder version. Hooks and skills update with the
plugin itself; sync only reconciles the workspace files Buildorder renders from its templates: `CLAUDE.md` and the
doc-map files. The CLI does the mechanics and decides what is safe to replace. You show the list, ask once and apply.

**CLI:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" sync . [--apply]`. Without `--apply` it only reads
(pre-approved); with `--apply` it writes, so a permission prompt is expected.

## Steps

1. **Plan:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" sync .`. If it fails with a
   `buildorder: ...` line (no Buildorder workspace here, or a workspace from a newer Buildorder), say what it means
   in one friendly sentence, name the next step it gives (`/buildorder:init` or updating the plugin) and stop.
2. **Show the list:** the line `from -> to` (`from` is null for a workspace set up before sync existed), then a
   table Path | Action | Meaning with one row per entry in `changes`:
   - `add`: the file is missing and is created from the current template
   - `update`: the file is exactly what Buildorder wrote, and the template changed; it is replaced
   - `skip-modified`: the user changed the file (or there is no record of it); it stays as it is

   Show every line of `notes` below the table. If `changes` is empty and `from` equals `to`, say the workspace is up
   to date and stop.
3. **One OK:** ask with AskUserQuestion whether to apply. Point out that `update` only replaces files nobody
   changed, and that `.claude/workspace.json` gets the new version and file records.
4. **Apply:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" sync . --apply` and confirm the result in
   one line. Without the OK, run nothing that writes.
5. **Changed files:** for each `skip-modified` file, read the workspace file and its template
   (`${CLAUDE_PLUGIN_ROOT}/templates/workspace/<language.docs>/<file>`, where a doc-map file uses the template of
   its default name, for example `HANDOFF.md`). Name what the template adds or changes in two or three lines and
   propose a merge that keeps the user's text. Edit only after the user's OK for that file; each edit asks for
   permission.
6. **Close:** what was added, updated and kept, in a few lines. The changes are not committed: offer the docs
   commit in the workspace root, or leave it to `/buildorder:handoff`.

## Pitfalls

- Never copy a template over a `skip-modified` file and never edit a file inside a code repo: sync is for the
  workspace files only.
- `.claude/settings.local.json` holds the user's permission answers and is never part of a sync.
- A folder with its own agent setup but without `.claude/workspace.json` is not a Buildorder workspace; sync does
  not convert it.
