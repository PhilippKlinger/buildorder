# Standard model and stack modules

`model.json` lists every item of the standard with its class and who provides it:

| Class | Meaning |
|---|---|
| `mandatory` | always set up; `--without` refuses it |
| `standard` | set up by default; `--without <id>=<reason>` deselects it, and the reason is recorded |
| `option` | set up only when chosen |

`provider` is `core` (stack-independent, templates in `templates/repo/`), `stack` (the stack module) or a
cross-cutting module such as `docker-cicd`. `where` says where the item lives: `repo` items are written and
checked by `buildorder.mjs standard`; `github` (rulesets), `plugin` (hooks) and `workspace` (doc-map) items are
handled elsewhere. `check` says how a repo is checked for an item (gap list for an existing project):
`files` (one of them exists), `workflow` (every pattern occurs in `.github/workflows/*.yml`), `pins` (every
`uses:` is pinned to a full commit SHA). `paidOnPrivate` items need a paid GitHub product in private repos.

## Stack modules

A stack module lives in `standard/stacks/<id>/`, where `<id>` is the stack id that `detect` reports
(for example `django`). It provides the stack part of the mandatory pipeline:

| File | Content |
|---|---|
| `stack.json` | `codeql`, `dependabot` and `provides` (below) |
| `ci.yml` | One or more CI jobs (lint, tests with coverage, build, dependency audit), written at column 0 as `<job-id>:` mappings. They are inserted under `jobs:` of the generated `ci.yml`; `ci-ok` and the image job need them. |
| `pre-commit.yml` | Optional. The stack's hooks as `- repo:` entries at column 0, appended to the `repos:` list of `.pre-commit-config.yaml` (formatter and linter, for example ruff). |
| `docker/` | Files written to the repo root when `container-image` is selected (`Dockerfile`, `.dockerignore`). The image is built from `Dockerfile` in the repo root. |

`stack.json`:

```json
{
  "codeql": { "language": "python", "buildMode": "none" },
  "dependabot": [{ "ecosystem": "pip", "directory": "/" }],
  "provides": {
    "lint": "ruff check",
    "tests-coverage": "--cov",
    "build": "collectstatic",
    "dependency-audit": "pip-audit"
  }
}
```

- `codeql`: the CodeQL language and build mode for the stack, or `null`. `actions` is always analysed.
- `dependabot`: package ecosystems with their directory; `github-actions` and `pre-commit` (and `docker`
  with `container-image`) are added by the core.
- `provides`: one regular expression per stack item (`lint`, `tests-coverage`, `build`, `dependency-audit`).
  It is matched against the repo's workflow files to tell whether the item is present.

Rules for templates: every `uses:` is pinned to a full 40-character commit SHA with a `# vX.Y.Z` comment,
every job sets least-privilege `permissions`, `actions/checkout` sets `persist-credentials: false`, and no
`${{ }}` expression appears inside `run:` (pass values through `env:`). The generated workflows must pass
`zizmor --persona regular`.

Without a module for the repo's stack (unsupported or no stack), `standard` writes only the
stack-independent mandatory parts and reports the stack items as missing.
