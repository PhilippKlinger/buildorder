# CLAUDE.md — {{name}}

> Workspace eingerichtet mit Buildorder. Steuerdatei: `.claude/workspace.json`.

## Was dieser Workspace ist

<!-- fill: 2–4 Sätze zu Ziel, Zielgruppe und Projektart. Keine Version, Testanzahl oder Stand: die stehen in SPRINT.md. -->

## Struktur und Grenzen

<!-- fill: Tabelle Ordner | Inhalt | Stack | Remote | Sichtbarkeit, eine Zeile je Repo. -->

Der Workspace-Root ist ein eigenes, privates Docs-Repo. Die Steuer-Dateien der Doc-Map liegen nur hier, nie in einem
Code-Repo (der Hook `boundary-guard` blockt das). Git-Befehle laufen im jeweils betroffenen Repo.

## Doc-Map: eine Heimat pro Info-Typ

| Info | Datei |
|---|---|
| Übergabe zwischen Sessions | `HANDOFF.md` |
| Aktive Aufgaben (max. 5) | `SPRINT.md` |
| Offene Aufgaben mit Details | `BACKLOG.md` |
| Erledigte Blöcke | `BACKLOG_ARCHIVE.md` |
| Entscheidungen und ihr Warum | `DECISIONS.md` |
| Getroffene Annahmen | `assumptions.md` |

Docs werden ohne Aufforderung mitgepflegt: gezielt ergänzen, nie eine ganze Datei überschreiben.
Abgeleitete Fakten (Version, Testanzahl, Stand) stehen nur an einer Stelle: `SPRINT.md`.

## Befehle

<!-- fill: je Repo die tatsächlichen Befehle für Install, Test, Lint und Build. -->

Dev-Server, Builds und Deploys startet der Nutzer selbst.

## Arbeitsweise

- Session-Rahmen: `/buildorder:kickoff` zum Start, `/buildorder:handoff` zum Abschluss.
- Liefere, was gefragt ist, im gemeinten Umfang: keine ungefragten Features, Refactorings, Dateien, Tests oder
  Abstraktionen. Mehrdeutigkeit, die die Arbeit kaum ändert, löst du selbst und nennst die Annahme in einem Satz;
  nachfragen nur, wenn die Lesarten zu wesentlich anderer Arbeit führen. Hältst du den Auftrag für falsch, sag es in
  einem Satz und arbeite dann wie beauftragt weiter.
- Kleine, überprüfbare Schritte. Dauerhafte Annahmen in `assumptions.md`, Entscheidungen mit Begründung in `DECISIONS.md`.
- „Fertig“ heißt: gegen die Quelle geprüft (Test, Lauf, Befund), nicht nur gegen den Backlog-Text. Die CI ist maßgeblich.
- `main` bleibt stabil; jede Änderung läuft über einen Branch und einen Pull Request. Conventional Commits.
- Docs auf Deutsch mit Umlauten; Fachbegriffe bleiben englisch. Commits, Branches, Pull Requests und Code-Kommentare
  auf Englisch.
