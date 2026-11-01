# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [1.0.0-candidate] - 2026-11-02

The first end-to-end shape of the 2.0 local system: a backend that owns SQLite, a
scheduler that decides, runtime hosts that execute, a review/approval chain that
is the only way to `DONE`, a launcher that starts all of it with one command, and
a bilingual web workbench. Every milestone was signed off by a reviewer who did
not write the code.

- **Capabilities and boundaries** are documented in
  [docs/V1-READINESS.md](docs/V1-READINESS.md): eight working capabilities (each
  with its gate) and the six things this version deliberately cannot do.
- **Gates** must all be green: `test.mjs` 475/475, `test-workspace.mjs` 604/604,
  `check-boundaries.mjs` PASS (9 packages / 6 edges / 0 cycles) and `m1`..`m6`
  smoke (16/16, 4/4, 6/6, 9/9, 4/4, 12/12).
- **One end-to-end demo** over real processes and real HTTP:
  `node scripts/v1-demo.mjs` (output recorded in
  [docs/evidence/v1.0-demo.md](docs/evidence/v1.0-demo.md)) — launcher up,
  scheduler dispatch, hosts executing, review PASS with evidence, human approval
  bound to a hash, legacy CLI reading the same facts and refusing to write.
- **Independent reviews** QA-001..007 in `docs/architecture/qa-review-m*.md`,
  plus milestone receipts in `docs/roadmap/m*-status.md`.
- **Honest boundary**: real DSH remains unavailable (a stub whose capabilities are
  all false), there is no installer, no CI browser E2E, the legacy CLI is a
  read-only compatibility layer over SQLite, and the target is single-user
  Windows. `QA PASS` is not production readiness.

## [Unreleased]

### Added (M5 / v0.8)

- `apps/launcher`: `atk start|stop|status|logs`. One command brings up the
  backend, the scheduler and N runtime hosts; a detached supervisor holds the
  backend's stdout just long enough to capture the one-time internal credential
  and pass it to children through their environment only. The credential is
  filtered out of every log line, never written to `launcher.json` and never
  returned by `status`. Stops are ordered (hosts → scheduler → backend, SIGTERM
  then SIGKILL) and idempotent; a second `start` exits 2 with the existing PIDs;
  a stale state file is cleaned instead of blocking startup.
- `apps/backend`: `backup` and `restore` subcommands plus `serve --pidfile`.
  Backups use SQLite's backup API from a read-only connection, so data committed
  in the WAL is included (copying the `.db` file alone fails under WAL);
  `manifest.json` records schemaVersion, size and sha256; restore verifies the
  hash and version, writes through a temporary file and atomically renames, and
  refuses to overwrite without `--force`.
- `apps/web`: `#/runs` and `#/runs/:id` with a seq-ordered, de-duplicated
  timeline and a live stream over fetch + ReadableStream (never `EventSource`,
  never a token in a URL). A `system.resync-required` frame triggers a snapshot
  refetch and a visible "gap detected" notice instead of pretending to be live.
- `scripts/m5-smoke.mjs`: the M5 gate over the real launcher, backend, scheduler
  and two hosts — the tree comes up and executes work, the credential is not
  persisted, a killed host is reported down, stop is idempotent, and a backup
  restores and starts. 4/4.
- `docs/operations/install-upgrade-rollback.md`: install, upgrade, rollback and
  crash-recovery runbook with the criteria that must hold for a rollback to count
  as finished.

### Fixed (M5 / v0.8)

- Both long-running CLIs (`apps/scheduler`, `apps/runtime-host`) printed their
  "attached" banner and then exited immediately: every timer was unref'd, so the
  event loop had nothing left. `start({ keepAlive: true })` now keeps the timers
  referenced for the CLI and leaves library/test mode unref'd.
- The launcher initially wrote the backend's stdout verbatim into
  `logs/backend.log`, which persisted the internal credential banner. Credential
  lines are now redacted; the M5 gate asserts no credential value appears in the
  state file, logs or `status` output.
- QA-005 (M4 review): a self-review could be smuggled past the guard with a
  leading space, trailing space or different case (`" agent-1"`, `"AGENT-1"`);
  actors must now be fully normalised and comparisons are case-folded.
- QA-005: approval hash binding was only an echo — nothing in production wrote
  `tasks.target_hash`, so any 64-hex string could approve a task. A PASS review
  now writes the candidate hash in the same transaction, `createApproval`
  requires that exact hash, and the M4 gate covers "old approval + old hash is
  refused after a new PASS".
- QA-005: `store.patchTask` could move a task straight to DONE; it now refuses
  with `human-approval-required`. Rework no longer creates duplicate attempt
  numbers, and evidence counts are bounded.

### Added (M4 / v0.7)

- `packages/contracts`: a `REJECTED` task state (the rework waiting room) and
  `CHANGES_REQUESTED` / `BLOCKED` review states and verdicts, plus four error
  codes — `SELF_REVIEW_FORBIDDEN`, `EVIDENCE_MISSING`, `APPROVAL_STALE`,
  `REWORK_LIMIT_REACHED`.
- `packages/database` (M4): migration `0004_reviews_approvals.sql` and the write
  paths the M1 tables never had — `createReview`, `submitReview`, `reworkTask`,
  `createApproval`, `decideApproval` (plus list/get), with one active review per
  task, a rework budget, and approvals bound to a target hash.
- `apps/backend` (M4): seven public review/approval endpoints and a `PATCH`
  guard: `DONE` is reachable only through a human approval, a self-review is
  refused at the contract layer, and a PASS verdict without a manifest hash and
  fully passing test evidence is rejected.
- `apps/web` (M4): the `#/reviews` workbench — review queue, verdict panel with
  findings, evidence inputs, approval panel showing the target hash, rework
  action, and localised messages for all sixteen error codes in en and zh-CN
  (293 keys each). Write failures show the server code, request id, message and
  details instead of being swallowed.
- `scripts/m4-smoke.mjs`: the M4 gate over the real backend, SQLite, scheduler
  and host — self-review refused, missing evidence refused, legal PASS advances,
  approval hash binding, direct `DONE` refused, the rework loop with its limit,
  approval rejection returning the task to `READY`, and SSE events. 8/8.

### Fixed (M4 / v0.7)

- QA-004 BLOCKER: neither CLI entry point could start — `apps/scheduler/cli.mjs`
  and `apps/runtime-host/cli.mjs` imported `./client.mjs` instead of
  `./src/client.mjs`, so every library test and gate stayed green while the
  actual processes failed at import. Both are fixed, both gained process-level
  tests, and `m3-smoke` now spawns the real scheduler CLI as a sixth check.
- QA-004 findings in `scheduler-core`: `detectCycles` missed simple cycles that
  share nodes (now enumerates every simple cycle per SCC, with explicit limits
  and a `truncated` flag), and `readyCandidates.missingDeps` now has the
  contract shape `{taskId, missing[]}`.
- QA-004 minors: an `idempotencyKey` replay now survives a backend restart (the
  route no longer pre-empts the store's durable idempotency), and write-scope
  comparison is segment-aware (`src` overlaps `src/a.js`).
- M4 gate finding: a legal PASS was rejected with 400 because the backend passed
  an empty `findings: []` to the store, which required findings for every
  verdict. Only `CHANGES_REQUESTED` requires findings now.

### Added (M3 / v0.6)

- `packages/scheduler-core`: a zero-dependency, zero-import, zero-clock planner —
  cycle detection, topological order, ready candidates, deterministic scoring
  (priority → waiting time → id), agent matching (role, capability, IDLE) and
  write-scope conflicts. A cycle refuses the **whole** plan instead of dispatching
  an incomplete DAG; every skipped task carries a reason from a fixed enum.
- `packages/database` (M3): migration `0003_scheduling.sql` (`policy_json`,
  `files_json`, schemaVersion 3), a single-transaction `claimTask` with seven
  ordered checks (CAS, dependencies, agent eligibility, no active run, capacity,
  write-scope, READY→CLAIMED) plus run/command/events in the same transaction, and
  `schedulingSnapshot` whose version is `MAX(events.seq)` so a failed claim never
  moves it. A two-connection barrier race yields exactly one winner.
- `apps/backend` (M3): `GET /internal/v1/scheduling/snapshot`,
  `POST /internal/v1/tasks/:id/claim` and `POST /internal/v1/scheduler/heartbeat`.
  The claim route re-checks all seven conditions at the contract layer, maps each
  failure to a specific code/reason, is idempotent by `idempotencyKey`, refuses a
  non-atomic store (500 instead of a fake transaction) and pushes exactly two SSE
  frames on success.
- `apps/scheduler`: a stateless scheduling loop — snapshot → plan → claim, with
  backoff, heartbeat, and a stop that does not cancel dispatched runs.
- `scripts/m3-smoke.mjs`: the M3 gate over the real backend, SQLite, scheduler and
  host (MockRuntime only): dependency order, wholesale cycle refusal, one live
  lease per run, no duplicate dispatch after a restart, and the chain continuing
  only after the root walks the legal status chain to DONE. 5/5.

### Fixed (M3 / v0.6)

- M2 review finding (BLOCKER): the runtime host's `result` requests omitted
  `ownerId`, so every command completion failed with 400 and was swallowed while
  `m2-smoke` stayed green. The host now sends the contract shape, reports a
  failed start as `session.ended(failed)` (so the Run cannot be stranded in
  STARTING), never calls `runtime.stop` on an already ended session, and the gate
  asserts the dispatch command reaches DONE/FAILED, that nothing stays
  PENDING/CLAIMED, and that the host logged zero errors.

### Added (M2 / v0.5)

- `packages/runtime-sdk`: the `AgentRuntime` interface (probe/capabilities/start/
  send/stop/reconnect/subscribe), runtime event types with validators, a
  deterministic scriptable **MockRuntime** (scenario DSL plus start-failure,
  slow-start, crash, ignore-stop and never-end injections, timer cleanup) and a
  `createDshRuntimeStub()` whose seven capabilities are **all false** and whose
  `start()` rejects with `CAPABILITY_UNAVAILABLE` — the real adapter cannot be
  enabled by accident while RT-P07/P08 are unverified.
- `packages/database` (M2): ordered migration `0002_runs_dispatch.sql`, a Run
  status machine, atomic `claimDispatchCommand` (verified with two real SQLite
  connections racing on a barrier: exactly one winner), lease renewal with
  monotonic generation, `updateRunStatus(..., { generation })` for in-transaction
  fencing, and `reconcileRun`. Releasing a lease expires it instead of deleting
  the row, so a generation can never restart at 1.
- `apps/backend` (M2): `/internal/v1/*` (claim, result, renew, events,
  heartbeat, reconcile) behind a **separate** internal credential that is printed
  once by `serve`, never persisted and never accepted from a browser; runtime
  events are mapped to Run state and pushed to SSE clients immediately, so the UI
  finally receives real `run.updated` / `run.log` events. Exactly one
  `run.updated` per transition (no duplicates).
- `apps/runtime-host`: a process that claims durable commands, drives one
  `AgentRuntime` session, forwards facts, renews leases and completes commands —
  and never writes the database. A reclaimed command (`attempts > 1`) is never
  restarted: it is reported `INTERRUPTED` and closed as `FAILED`.
- `packages/workspace`: one git worktree per Run outside the repository, with
  path/branch validation and a removal that refuses uncommitted work unless the
  caller passes both `force` and `confirmClean`.
- `scripts/m2-smoke.mjs`: end-to-end gate (real backend + SQLite + internal HTTP,
  MockRuntime only) asserting completion, crash/reclaim with **zero** restarts,
  and generation fencing leaving the row untouched. 3/3.
- ADR-010 (the Host talks only to the internal API; MockRuntime first; the real
  DSH adapter stays experimental) and `docs/architecture/m2-contracts.md`.

### Changed (M2 / v0.5)

- `packages/contracts`: `STALE_GENERATION` (409) for lease/generation fencing and
  the `run.log` event type. The web app's completeness guards caught both, and
  the en/zh-CN dictionaries plus the TS type mirror now cover them.
- The M1 smoke gate and QA's migration test assert "a migration ran" rather than
  pinning generation 1, so additive migrations are not reported as regressions.

### Added (M1 / v0.4)

- pnpm workspace: `apps/backend`, `apps/web`, `packages/database`, `packages/contracts`.
  `scripts/check-boundaries.mjs` enforces the allowed dependency edges (web →
  contracts, backend → contracts + database, database → contracts) and rejects
  cycles, undeclared packages and imports that escape a package root.
  `scripts/test-workspace.mjs` runs the package tests and prints SKIPPED (never
  PASS) below Node 22.5, because `node:sqlite` does not exist there.
- `packages/database`: SQLite schema v1 (16 tables) on built-in `node:sqlite`,
  WAL + `busy_timeout` + foreign keys verified at open (a failed PRAGMA is an
  error, not a silent downgrade), ordered idempotent migrations, transactional
  writes, CAS version conflicts (`TASK_VERSION_CONFLICT` / `VERSION_CONFLICT`),
  a behaviour-identical in-memory store, and `importStateJson` /
  `exportStateJson` for the legacy `state.json` (dry-run, idempotent, path-escape
  and duplicate-id refusal).
- `apps/backend`: HTTP API on `127.0.0.1:1421` covering the M1 read/write subset,
  SSE with `Last-Event-ID` replay and `system.resync-required` on a gap, loopback
  `Host` guard, `Origin` / CSRF / `x-atk-token` enforcement, a session token file
  with an in-memory fallback, static SPA serving with client-side-route fallback,
  and a CLI (`serve`, `migrate`, `doctor`, `export`).
- `apps/web`: React 19 + Vite + TypeScript SPA with **zh-CN / en** dictionaries
  (217 keys each, compile-time and runtime key-parity checks) and a top-bar
  language toggle persisted to `localStorage`; dark design tokens; overview,
  task list/board, task detail, agents, reviews and settings pages; SSE consumed
  through `fetch` + `ReadableStream` so the token never lands in a URL;
  per-error-code readable failure states.
- `scripts/m1-smoke.mjs`: end-to-end gate (migrate the repository's own state →
  serve → 12 assertions incl. a forged `Host`, a tokenless 403, the SSE stream
  and the SPA deep link).
- ADR-009 (M1 stack: `node:sqlite` + `node:http` + React/Vite, bilingual UI) and
  `docs/architecture/m1-contracts.md` (store interface, API, SSE, i18n rules).

### Changed (M1 / v0.4)

- CI: a separate `workspace` job (Node 24 + pnpm) runs boundary checks, workspace
  tests, the web build and a backend health smoke; the legacy matrix keeps testing
  the zero-dependency CLI on Node 20/22/24.

### Added (M0 / v0.3)

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
