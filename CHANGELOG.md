# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [Unreleased]

### Added

- Self-hosted development setup ([docs/SELFHOSTING.md](docs/SELFHOSTING.md)):
  the repository now has real `fast`/`quick`/`local` gates, complete
  `ownership.json` coverage for its own directories, `batch.allowRootFiles` for
  root-level files, and a baseline-tag + snapshot recovery path.
- `node scripts/selfhost.mjs status|guard|snapshot|restore|tag|prepare|remove|verify`:
  snapshot/restore of code and workflow state, isolated external candidate
  worktrees (`../agent-team-kit-candidates/`), and integrity checks that work
  even when `lib/` is broken (the script imports no toolkit module).
- `scripts/selftest.mjs` (suite + optional plugin selftests) and
  `scripts/selfhost-verify.mjs` (suite + workflow integrity for `gate local`).
- `batch.allowRootFiles` config key: a self-hosting project can freeze
  root-level files that path prefixes cannot express.
- `atk gate quick` / `atk gate local` now publish the same
  `<artifactDir>/ci-fast-latest.json` report as `gate fast`, so `batch apply`
  and `release` can consume a green report from any gate.
- Deny-by-default permission layer ([docs/PERMISSIONS.md](docs/PERMISSIONS.md)):
  a 75-operation subject x operation matrix over `HUMAN`, `ORCHESTRATOR`,
  `WORKER`, `REVIEWER` and the trusted `SYSTEM` layer, plus the ordered
  `RBAC ∧ Scope ∧ Ownership ∧ State ∧ Policy ∧ Approval` evaluation with
  machine-readable reason codes (`ROLE_DENIED`, `WRITE_SCOPE_VIOLATION`,
  `SELF_REVIEW_DENIED`, `APPROVAL_REQUIRED`, ...).
- `atk permit matrix|explain|check|audit`: query the matrix, inspect a cell,
  evaluate a decision before acting, and read the append-only decision trail at
  `<artifactDir>/permission-audit.jsonl`.
- Permission enforcement inside existing commands: `task.claim` on task
  dispatch, `qa.manifest.freeze` on manifest freeze, `qa.result.submit` on QA
  verify, `integration.merge.development` on real applies, and
  `integration.archive` on archive.
- Strict integration: `atk batch apply --apply --confirm-dev-closed` requires a
  QA approval bound to the manifest (and a green quick/local gate report when
  those gates are configured). Every form of `apply`, the dry-run included, now
  needs a structurally valid approval — see the QA receipt entry above.
- Tests for the registry, matrix spot checks, deny-by-default, reason codes,
  write scope, review independence, gate proof, append-only audit and the
  `atk permit` CLI surface.
- Entity model ([docs/ENTITIES.md](docs/ENTITIES.md)): Project, Role, Agent
  Instance, Task and Run, plus the `ORCHESTRATOR` / `WORKER` / `REVIEWER`
  Functions. Roles declare their Functions in the new `functions` config section;
  Agent Instances carry `id` + `capabilities` in `runtime.json` (schema version 3).
- Scheduler-enforced separation of duties: `atk state task --for <REVIEWER role>`
  requires `--agent <id>` and refuses a role-owned task or a known producer;
  `atk batch manifest --agent <id>` records the producing Run; `atk batch
  verify`/`apply` refuse a self-review, a missing producer/reviewer identity, an
  unregistered instance, or a capability mismatch; `atk evidence` never counts a
  provably self-reviewed approval. `functions.enforceNoSelfReview` is the
  documented escape hatch.
- `atk init` writes the Function map and one Agent Instance per Role, and the
  generated role table gains a Function column.
- Tests for the identity checks, review-dispatch refusals, evidence rejection and
  the new config surface.
- `branch` config section (development/release/tagPrefix/versionFile/gateReport/
  requireCleanTree) with dev -> master defaults, scaffolded into every project by
  `atk init` (the kit repository itself keeps its single-branch flow).
- `atk release --version <semver>`: dry-run by default; verifies the current
  branch, clean worktree, version file and a fresh/green gate report, then merges
  development into release with `--no-ff` and creates an annotated `v<semver>` tag.
- Generated flow docs (README and commands cheat sheet, both languages) document
  the branch model and release command; `test/release.test.mjs` covers dry-run,
  version mismatch, wrong branch and apply.
- Fail-closed ownership check: `atk ownership check --strict` (or
  `"ownership": { "mode": "strict" }` in `agent-flow.config.json`). Strict mode
  requires a Role (`--role` / `$AGENT_ROLE`, exit `2` when missing or unknown),
  blocks unmapped paths (exit `1`), reports an empty change list as `SKIPPED`
  (exit `0`, never PASS) and writes `status` / `mode` into the JSON report.
  Loose mode keeps the v0.2 output, report shape and exit codes unchanged.
- Structured QA receipts ([docs/WORKFLOW.md](docs/WORKFLOW.md) §5): a
  `kind: "qa-approval"` receipt with `verdict`, `manifestSha256`,
  `reviewer { run, agent, role, function }`, `targetRunId` and per-gate
  `status: "PASS"` is now the only QA fact. A bare `passed: true` is refused by
  default with a readable `legacy-receipt` reason; the explicit escape hatches
  are `"batch": { "legacyReceipts": true }` and the `--legacy-receipts` flag.
- `atk batch verify --require-qa` and every `atk batch apply` (dry-run included)
  are controlled integration: a structurally valid QA receipt bound to the
  manifest is mandatory, otherwise exit `1` with the missing reason. Plain
  `atk batch verify` without `--qa` stays usable as a read-only diagnostic that
  reports `status: "SKIPPED"` and `diagnosticOnly: true` without ever printing
  PASS.
- `atk evidence --legacy-receipts` mirrors the config escape hatch for
  deriving facts from pre-M0 receipts.

### Changed

- Gate runs now report one of five statuses — `PASS`, `FAIL`, `SKIPPED`,
  `UNCONFIGURED`, `ERROR` — with `ok` fixed to `status === "PASS"`. Exit codes:
  `PASS 0`, `SKIPPED 0`, `FAIL 1`, `UNCONFIGURED 2`, `ERROR 2`. A gate that
  applies no step is `SKIPPED` (not a pass), an empty configuration is
  `UNCONFIGURED` (previously exited `0` silently) and a step that cannot be
  launched is `ERROR` instead of `FAIL`. Gate reports always carry `status`, and
  every run overwrites `<artifactDir>/ci-fast-latest.json` so a stale PASS cannot
  survive a non-PASS run. `atk release` accepts only a report whose `status` is
  exactly `PASS` and whose `ok` is true; a legacy `{ "ok": true }` report or any
  SKIPPED / FAIL / UNCONFIGURED / ERROR report is refused.
- `qa-approval.json` moves to the signed structure; manifests should carry the
  producing `run` and reviews should carry a `reviewer` run. A manifest frozen
  without `--agent` can no longer pass a QA review while the no-self-review rule
  is enforced. `atk batch verify` / `atk batch apply` and `atk evidence` no
  longer treat a self-reported `passed: true` as QA evidence; old receipts must
  be re-issued or explicitly accepted through `batch.legacyReceipts` /
  `--legacy-receipts`. `atk evidence` now reports every refused receipt with a
  readable reason instead of silently ignoring it.
- **Breaking (JSON field):** `atk evidence` report `rejected` entries changed
  from `[{ file, manifestSha256, agent }]` (self-reviewed approvals only) to
  `[{ file, path, reason, detail, legacy, reasons }]` (every refused QA receipt).
  `selfReviewed` remains a number. Consumers of the old `rejected` shape must be
  updated; see [docs/INTERNALS.md](docs/INTERNALS.md) §4.9.
- `runtime.json` moves to schema version 3 (`id` + `capabilities` per Agent
  Instance). Existing version 2 files still load, but `atk state check` warns
  about missing ids and a review cannot pass the identity checks until every
  instance is registered.
- The role-change recipe (`docs/ROLES.md`, `agent-team-roles` skill) gains the
  `functions.roles` edit and an Agent Instance entry with an id.

### Fixed

- `atk release --version x.y.z` is no longer swallowed by the global `--version`
  handler: `--version` / `-v` only act as global flags before the first
  positional argument, so the command-level flag reaches `release` (which
  previously printed the CLI version and exited `0`). Top-level `atk --version`
  still prints the CLI version.
- `atk release` reads the gate report through `readJsonStrict`/`stripBom`, so a
  UTF-8 BOM on a valid `ci-fast-latest.json` is no longer reported as a missing
  gate report (PowerShell's `Set-Content -Encoding utf8` writes one).
- `atk baseline start` no longer hashes build output (`target/`, `target-qa/`,
  `dist/`, `artifacts/`, `.local/`, `coverage/`, ...) or generated files
  (`*.tsbuildinfo`, `*.log`). On projects with a large Rust/Cargo target this
  turns a minutes-long snapshot into a sub-second one and stops the baseline from
  churning on every build.
- `atk evidence --collect-temp` skips build directories inside candidate copies
  and tolerates a UTF-8 BOM in receipt JSON (PowerShell's
  `Set-Content -Encoding utf8` writes one), so receipts are no longer silently
  dropped because `JSON.parse` threw.
- `atk cache status` measures GB-scale cache targets with one recursive listing
  plus batched `stat` calls instead of one `stat` per file.
- `atk init` tolerates a BOM in preset files, and `readJsonl` tolerates a BOM on
  the first metrics line.
- Tests cover BOM receipts and the evidence/baseline build-directory skip.

## [0.2.0] - 2026-10-29

### Added

- Release automation for the public repository: the tag-triggered
  `.github/workflows/publish.yml` publishes to npm with provenance, and both
  READMEs carry CI / license / Node badges.
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

- `runCommand` passed the joined command line to `spawn` without a shell off
  Windows, so every array-form step (fast/quick gates, ownership git lookups)
  failed on Linux/macOS; it now spawns command and argv separately.
- `npm test` goes through `scripts/test.mjs`, which expands the test glob itself,
  so the suite runs on Node 20 and on every platform; two cache/util tests no
  longer depend on Windows-only `%TEMP%` behaviour. The CI matrix now covers the
  full suite on Node 20/22/24 across Ubuntu and Windows.
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
