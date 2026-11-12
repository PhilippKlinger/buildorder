---
name: secure
description: Security and data protection audit of one repo in a Buildorder workspace. Runs the built-in /security-review (and Cloudflare security-audit when installed), then checks secrets, third parties, personal data and data flows, and reports findings by severity with a release-ready verdict. Argument "all" checks the whole repo. Reports only.
argument-hint: "[repo path] [all]"
context: fork
effort: high
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" standard *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" standard *), Bash(git -C * diff*), PowerShell(git -C * diff*), Bash(git -C * log*), PowerShell(git -C * log*), Bash(git -C * status*), PowerShell(git -C * status*), Read, Grep, Glob
---

# Secure

Audit one repo for security and data protection and report. Read and judge only: edit no file, commit nothing,
never pass `--apply` to the CLI, run no dependency audit (CI does that). Never print a secret value, not even
shortened: name file, line and kind only.

## Workspace state (live)

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" status`

## 1. Pick the repo

1. If the state above says "Not inside a Buildorder workspace", reply with one friendly sentence that this skill
   needs a Buildorder workspace (set one up with `/buildorder:init`). Do nothing else.
2. Read `.claude/workspace.json` in the workspace root named above.
3. Arguments: **$ARGUMENTS**. If the first word matches a `repos[].path`, that is the repo; otherwise the repo is the
   one that contains your working directory. If neither gives a repo, list the code repo paths, ask the user to
   call the skill again with one, and stop. The word `all` sets the scope to the whole repo; otherwise the scope
   is the diff.
4. **Mode:** *in-repo* when your working directory is the repo folder or inside it, otherwise *root*.
   Do not `cd`: every command starts in the working directory again. Use `git -C "<repo folder>"` instead.

## 2. Vulnerabilities

- **In-repo:** invoke the built-in `security-review` skill with the Skill tool and take its findings over without
  rewording them. It takes no target and reads `git diff origin/HEAD...`. If `git -C "<repo folder>" log -1 origin/HEAD`
  fails, tell the user to run `git remote set-head origin --auto` and continue as in root mode.
- **Root:** apply the same method yourself to `git -C "<repo folder>" diff origin/HEAD...` plus
  `git -C "<repo folder>" diff HEAD`: injection, missing auth or access checks, secrets, unsafe deserialisation,
  unvalidated input at trust boundaries, weak crypto. The report then says that the built-in `/security-review`
  is still open, with the tip to start the session in the repo.
- **Cloudflare:** if your skill list holds `security-audit` (also with a plugin prefix, `<plugin>:security-audit`),
  invoke it for the same repo and take its findings over. Otherwise the report says in one line that it is not installed.
- With scope `all`, also read the whole repo for the same patterns, not only the diff.

## 3. Data protection and data flows

The built-in reviews do not cover these. With scope diff, check what the diff touches; with `all`, the whole repo.

- **Secrets:** no keys, tokens or passwords in code, config or history. Check env and key files ever added:
  `git -C "<repo folder>" log --all --diff-filter=A --name-only -- "*.env*" "*.pem" "*.key"`. `.env` is ignored,
  `.env.example` exists. A secret only in the history still counts.
- **Third parties:** every service that receives data (analytics, monitoring, mail, AI APIs, CDNs, web fonts): which
  data goes where. If a privacy policy exists, it must cover each flow; a flow missing there is Important.
- **Personal data:** none in logs, error reports, test data or fixtures. Where it is stored, it can be deleted and
  exported. Data sent to AI APIs is reduced to what the task needs.
- **Public files:** no sensitive values in what ships to the browser or into the image.
- **Standard:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/buildorder.mjs" standard "<repo folder>"`, adding
  `--visibility private` when the repo's `standards.deviations` in `workspace.json` give a private repo as reason.
  The output is a read-only plan. Each `skipped` item whose reason is the private repo (CodeQL, Dependency Review) is
  a scanning gap: Minor when the decisions file (`docs.decisions`) records it with its reason, otherwise Important.
  `secret-scan` in state `missing` is Important.

Skip a point that does not apply to the project; do not report it as a finding.

## 4. Severity

- **Critical:** exploitable vulnerability, a secret in code or history, personal data reaching people it must not reach.
- **Important:** must be fixed before release: missing access check, undocumented third-party flow, an unrecorded
  scanning gap, a missing secret scan.
- **Minor:** hardening and hygiene.

Back every finding with `file:line` or a command output. Phrase a guess without evidence as an open question.

## 5. Report

Write in the language `language.docs`; keep the severity names and the last line as written here.

```markdown
## Security: <repo> · <scope: diff | all>
**Built-in /security-review:** ran / still open (start the session in <repo> for the full run)
**Cloudflare security-audit:** ran / not installed
**Risk:** low / medium / high (one sentence why)

### Critical
- `file:line`: problem; recommendation _(source: security-review | security-audit | data protection | standard)_

### Important
### Minor
### Data flows
what leaves the system, where to, with which content, and whether it is documented

### Open questions

release-ready: yes / no (one sentence why)
```

`no` as soon as anything is Critical or Important. If the built-in run is still open and nothing blocks, write
`release-ready: yes (built-in /security-review open)`. Leave out empty sections.
