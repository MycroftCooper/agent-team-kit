# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [Unreleased]

### Added

- `skills/agent-team-roles`: a third agent skill for reshaping an initialized
  project's team - add, remove, rename or re-scope roles across
  `agent-flow.config.json`, `ownership.json`, `runtime.json`, the role cards, the
  flow README and the rendered boards, with a verification checklist, a failure
  table and a card skeleton.
- Tests: `test/skills.test.mjs` (skill frontmatter, README discoverability, and
  every `atk <command>` a skill references) and `test/roles.test.mjs` (add,
  duplicate-prefix and remove role end to end), plus a `--force` regression that
  locks in how much `atk init --force` rewrites.

### Changed

- `docs/ROLES.md`, `docs/CONFIG.md`, `docs/FAQ.md` and both quickstarts no longer
  present `atk init --force` as a safe way to rework a live project: it rewrites
  `state.json`, `ownership.json`, the boards and every card. They point at the
  in-place edit order instead, and the scope-less-role note now matches
  `atk ownership verify-config` (it reports such a role and exits `1`).

### Fixed

- The `atk board` help text and the generated `commands.md` claimed the command
  renders `board.md` too; it writes only `board.html` (`atk state board` writes
  the markdown board).

## [0.1.0] - 2026-10-29

First public release: the workflow extracted from a production desktop-application
project and packaged as a dependency-free CLI, templates, docs and a DSH board
plugin.

### Added

- `atk` CLI with commands: `init`, `state` (`check`, `board`, `queue`, `task`,
  `import`, `archive`, `restore`), `board`, `serve`, `evidence`, `ownership`
  (`map`, `check`, `verify-config`), `batch` (`manifest`, `verify`, `apply`),
  `baseline` (`start`, `changed`), `cache` (`status`, `clean`), `gate` (`fast`,
  `quick`, `local`), `select-tests`, `todo`, `measure`, `sync`, `docs rotate`,
  `plugin` (`sync`, `verify`).
- Config layer: `agent-flow.config.json` with layout/paths, roles, change-scoped
  gates, batch manifest settings, baseline roots, cache targets, board settings,
  plugin identity and document rotation. Validation on load; `--config` /
  `--cwd` globals.
- State machine: `state.json` (batch, slices, packages, subitems), human-only
  todos, runtime status, archive guarded by `verification.humanAccepted`.
- Evidence pipeline: frozen batch manifests with `manifestSha256`, QA approval
  binding, drift-aware `batch verify`, dry-run-first `batch apply`, and
  `evidence` derivation that never invents facts.
- `atk init` scaffolder with `generic` and `p4deck` presets, `--project`,
  `--language`, `--roles`, `--flow-dir`, `--force`, `--dry-run`, `--no-plugin`
  and `--json`. It writes the config, the full flow directory (state, ownership,
  runtime, human todos, task template, command sheet, current batch, board, README
  and one role card per role), derives write scopes from the top-level
  directories it can see, and copies the DSH board plugin in-process.
- Templates for the flow directory in English, with Chinese variants for role
  cards and operational pages: LEAD / DEV / FE / BE / QA / generic role cards
  covering write scope, prohibited actions, task loop, 6-line receipt, commands,
  round budget and the proof ladder; task ticket format capped at 200 words / 9
  lines.
- Agent skills: `skills/agent-team-flow` and `skills/agent-team-board` in
  SKILL.md format, plus install notes.
- Board: markdown board, static HTML board, live `--serve` with file watch + SSE
  and polling fallback, JSON/compact snapshots.
- DeepSeek Harness board plugin (`plugins/dsh-agent-board`) with identity-token
  substitution, a generated `cordis.patch.yml`, and standalone host/client
  selftests.
- Docs: quickstart, architecture, configuration, roles, workflow, board,
  migration, publishing, FAQ, internals contract, with Chinese summaries for the
  key pages.
- Examples: `examples/minimal/` — a committed demo project with two packages, one
  batch slice, ownership, human todos and a board.
- Tests: `node --test` suite covering config, dispatch, state, evidence, batch,
  gates, board, plugin and the `init` scaffolder.

### Notes

- Node.js >= 20.11, ESM, no runtime dependencies.
- The generic preset derives a project-specific DSH plugin identity
  (`<project>-board`) so several projects can be installed side by side.
- State is versioned by `schemaVersion`; batch formats are versioned by
  `batch.manifestTag` and `batch.qaSchemaVersion`.
