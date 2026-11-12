# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/). Versions below 1.0.0 are pre-releases;
interfaces may change.

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

[0.1.0]: https://github.com/PhilippKlinger/buildorder/releases/tag/v0.1.0
