# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/). Versions below 1.0.0 are pre-releases;
interfaces may change.

## [1.2.0] - 2026-11-13

### Added

- Option modules, added with `--with <module>` on init.
- `versioning` module with the hook `version-drift`: warns on release prompts when the latest tag and the version files disagree.
- `template-pins.yml`: keeps the actions used in the templates current through Dependabot.
- `web-quality` module with the skill `/buildorder:web-quality`: static check of a web frontend for performance, SEO and accessibility; reports only.

### Changed

- `/buildorder:review` and `/buildorder:secure` warn when started outside the repo folder.
- `/buildorder:deploy-gate` handles the deploy target `none` and a mismatch between target and files.
- `/buildorder:deps` and `/buildorder:ci-fix` continue when you decline a `gh` call.
- `/buildorder:assess` runs one command per call.
- The gap list names what it looked for.

### Fixed

- React starter: `minimatch` override 11.0.1.
- Django image stays on the Python line its Django LTS supports.

## [1.1.0] - 2026-11-13

### Added

- `/buildorder:scout`: sharpens a plan before building and writes a short brief or a spec with acceptance criteria.
- `/buildorder:deploy-gate` (needs the `docker-cicd` module): go/no-go check before a deploy; reports only and never deploys.
- `/buildorder:deps`: triage of open Dependabot pull requests with a proposed merge order; merges nothing.
- `/buildorder:ci-fix`: diagnoses failed GitHub Actions runs and proposes a fix branch; applies nothing.

## [1.0.0] - 2026-11-12

### Added

- Four more stack modules, each with a tested starter and its part of the mandatory pipeline: `go` (golangci-lint,
  race tests with coverage, govulncheck, a distroless image), `python` (a library starter with ruff, pytest with
  coverage, pip-audit and a build; libraries get "no Docker" proposed), `react` and `angular` (lint, formatting,
  tests with coverage, build, `npm audit`; deploy as a webspace artifact or an unprivileged Nginx image).
- `/buildorder:sync` and `sync <workspace> [--apply]`: lifts a workspace to the installed version. It adds missing
  files, updates only files that are still exactly what buildorder wrote, and reports every file you changed as
  `skip-modified`. It never writes inside a code repo or to `settings.local.json`.
- `/buildorder:radar` (with a read-only reader agent): reports what is new in the official Claude Code changelog,
  releases and docs since the last run, filtered for your workspace, as at most three proposals. A finding about
  buildorder itself comes as issue text for you to paste into the GitHub form; nothing is filed automatically.
- Release attestation: every published release gets `buildorder-<tag>.tar.gz` with a build-provenance attestation,
  verifiable with `gh attestation verify`.
- A test that every tracked text file is valid UTF-8.

### Changed

- `/buildorder:init` and the README list all five stack modules, ask for the release style of an existing project,
  phrase statements about data before `assess` as hints, and list the GitHub settings files under the final step.
- The README no longer marks buildorder as a pre-release, states that there is no telemetry, names the radar's one
  write (the run date in `.claude/workspace.json`), lists golangci-lint for `go` and shows the full attestation
  check including `--signer-workflow`.
- `github-checklist --repo owner/name` accepts only valid GitHub owner and repository names and only when exactly one
  repo of the workspace has no GitHub origin.
- The Python starter sets `pythonpath = ["src"]`, so a plain `pytest` works without an editable install.

### Fixed

- The init skill contained two invalid UTF-8 bytes; they are replaced.
- The radar no longer prints a `gh issue create` command with web-derived text in quotes (backticks or `$(...)`
  would run when pasted); it prints the texts as plain blocks and offers `gh issue create --web`. The reader agent
  follows links only under the official Claude Code GitHub and docs addresses.
- `sync` compares `.claude` and `.git` path segments case-insensitively on every platform and refuses a target that
  resolves outside the workspace through a link.
- The release workflow checks out the tag as `refs/tags/<tag>`.
- `standard` names a second detected stack as "not covered" only when a stack module is in use.
- No handoff reminder for init's own commit; `standard --apply` refreshes only its own repo entry in
  `workspace.json`; a repo with a second supported stack gets it named as not covered.

## [0.2.0] - 2026-11-12

### Added

- README in full: quickstart, how buildorder differs from the built-in `/init`, what CI checks, the security model
  with the known limits of the hooks, and a context diagram.
- `github-checklist` writes `docs/github-settings.md` in the workspace docs language (German or English); the `gh`
  commands are identical in both.

### Changed

- `/buildorder:init` now says that the Django starter has neither `auth` nor `admin` and recommends "no personal
  data, no login" unless the idea says otherwise.
- buildorder's own CI: zizmor and gitleaks run through their official actions (gitleaks pinned to 8.30.1), and a
  weekly OpenSSF Scorecard run was added.

### Fixed

- `standard --apply` refreshes `isCode` and `stacks` of the repo entry in `workspace.json`, so a starter commit no
  longer leaves the empty-repo state behind.
- The deploy templates explain the `uses: $/...` self-repository call (runner 2.336.0 or newer) in a comment above
  the line, so it no longer reads like a typo.

## [0.1.1] - 2026-11-12

### Fixed

- `nest` now works on Windows when Claude Code runs in the folder; it no longer fails because a watch handle on `.claude/` blocks the folder rename.
- The Django image no longer ships known, fixed HIGH vulnerabilities: Debian security updates run at build time and pip is no longer needed at runtime. buildorder's CI now scans the fixture image with Trivy.

## [0.1.0] - 2026-11-12

First pre-release.

### Added

- Repository: Claude Code marketplace and plugin manifests, CI on three operating systems and Node 22 and 24,
  security policy and MIT license.
- CLI (`buildorder.mjs`): `detect` (folder finding and deploy-target evidence), `nest` (moves a repo into a
  workspace subfolder), `status`, `scaffold`, `verify`, `finalize`, `github-checklist`, `standard` and the
  read-only `plan`.
- Workspace: doc-map templates in English and German (`CLAUDE.md`, handoff, sprint, backlog, backlog archive,
  decisions, assumptions), `.claude/workspace.json` as control file, and the GitHub settings checklist with a
  ruleset file. The workspace root becomes a private git repo for the docs, with the code repos and local
  Claude settings ignored. Nothing is sent to GitHub.
- Standard: a model of mandatory, standard and optional items; generated CI with `ci-ok` gate, gitleaks,
  Dependency Review, CodeQL, zizmor workflow lint, SHA-pinned actions, Dependabot and pre-commit. Deselecting an
  item requires a reason, which is recorded.
- Standard, docker-cicd module: container image with Trivy scan, push by digest, SBOM and build-provenance
  attestation, plus CD for the chosen deploy target.
- Stack module `django`: lint, tests with coverage, build and dependency audit jobs, plus a tested starter
  project with Dockerfile.
- Hooks: boundary guard (keeps workspace control files out of code repos), secret guard (scans the staged diff
  before `git commit`), keyword context hints and effort hints on prompt submit, compaction guard, and a
  handoff reminder on stop.
- Skills: `/buildorder:init`, `kickoff`, `handoff`, `assess`, `review` and `secure`.

[1.2.0]: https://github.com/PhilippKlinger/buildorder/releases/tag/v1.2.0
[1.1.0]: https://github.com/PhilippKlinger/buildorder/releases/tag/v1.1.0
[1.0.0]: https://github.com/PhilippKlinger/buildorder/releases/tag/v1.0.0
[0.2.0]: https://github.com/PhilippKlinger/buildorder/releases/tag/v0.2.0
[0.1.1]: https://github.com/PhilippKlinger/buildorder/releases/tag/v0.1.1
[0.1.0]: https://github.com/PhilippKlinger/buildorder/releases/tag/v0.1.0
