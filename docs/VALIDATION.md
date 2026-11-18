# Validation

The implementation is verified against the new workflow rather than the previous
CLI's test count. Local execution uses Windows and Node.js 24.16.0.

## Reproducible commands

```sh
corepack pnpm install --frozen-lockfile
node scripts/check-boundaries.mjs
node scripts/test.mjs
node scripts/build-web.mjs
node scripts/e2e.mjs
node scripts/collaboration-e2e.mjs
node scripts/task-movement-e2e.mjs
node scripts/task-lifecycle-e2e.mjs
node scripts/agent-identities-e2e.mjs
node scripts/automation-e2e.mjs
node scripts/automation-schedule-e2e.mjs
node scripts/smoke.mjs
node scripts/benchmark.mjs
```

The backend tests cover PM approval, identity constraints, review configuration,
human tasks, VERIFIED dependency progression, file/directory/case locking,
generation fencing, duplicate events/results, content drift, quarantine/restart,
project isolation, document retries and backup integrity.

## 2026-11-18 removal of the separate Agent revoke operation

The Agent card and connection UI offer deletion and recovery without a separate
revoke button, dialog, service method or HTTP endpoint. The removed endpoint is
tested to return 404 without changing identity state. Assignment, credential and
locking tests now exercise deletion after confirmed stop. Existing disabled
records can still recover their original identity.

All 116 backend/protocol tests and five identity browser scenarios passed.
The production TypeScript/Vite build, module boundaries and whitespace checks
also passed. Logs are `artifacts/agent-delete-only-full-tests.log`,
`artifacts/agent-delete-only-ui.log` and `artifacts/agent-delete-only-build.log`.

## 2026-11-18 project Agent deletion and connection recovery

All 116 backend/protocol tests passed with zero failures or skips using
`--test-concurrency=2`, including six identity lifecycle cases. They cover
credential rotation on the same ID, existing disabled identity recovery, credential
invalidation, roster pagination, retained historical references, version and
project scope, human-only management, and active/uncertain task and CI barriers.

The dedicated browser suite passed five scenarios, including repeated reconnects
without duplicate identities, credential reissue from the connection guide,
blocked deletion retaining file locks, deletion after confirmed stop, cancellation
and narrow-screen layout. All 30 existing web workflow checks also passed.
The production TypeScript/Vite build, module boundaries (12 modules, 19 edges,
no cycles) and whitespace checks passed. All mutations used isolated test data.

Local evidence: `artifacts/agent-identities-tests.log`,
`artifacts/agent-identities-full-tests.log`, `artifacts/agent-identities-ui.log`,
`artifacts/agent-identities-web-regression.log` and screenshots/results under
`artifacts/agent-identities-e2e/`.

## 2026-11-17 isolated automation/UI commit verification

The submitted automation/UI tree was exported from the Git index and tested
independently of the separate cancellation/archive work remaining in the local
workspace. It passed all 98 backend/protocol tests, 30 web workflow checks,
10 automation browser checks, 8 scheduling browser checks and 10 installed-package
smoke checks. Module boundaries and the production TypeScript/Vite build passed.
The heading actions for Tasks and Bugs and the removal of secondary-page
breadcrumbs are included in this version. Earlier counts below describe the
wider development workspace at those points in time.

Evidence is under `artifacts/push-check/artifacts/`: `push-backend-tests.log`,
`push-web-build.log`, `push-web-e2e.log`, `push-automation-e2e.log`,
`push-schedules-e2e.log` and `push-package-smoke.log`.

## 2026-11-17 CI schedules

The final backend/protocol suite passed all 110 tests with zero failures or skips,
including seven schedule tests. The full run used `--test-concurrency=2` after an
unrelated Agent health request timed out under unrestricted parallel test load.
Coverage includes absolute timestamps, all four schedule modes, typed defaults,
pause/resume, elapsed-time interval arithmetic, busy/missed slots, persisted
deduplication, restart, dispatch crash recovery, clock rollback, invalid storage,
manual CI availability and chronological history pagination.

The dedicated scheduling browser suite passed eight scenarios with actual CI
processes and the actual Agent CLI. It verifies human configuration, UTC
conversion, false boolean defaults, pause/enable, scheduled origin and project
archives, Agent configuration/status, JSON/form round trips, narrow/dark views,
unchanged DST-fold instants, nonexistent DST-time rejection and invalid parameter
drafts. Screenshots are under `artifacts/automation-schedule-e2e/`.

The existing automation browser suite passed all 10 scenarios; the complete web
suite passed all 30 scenarios and the Windows desktop suite all 10 checks.
TypeScript/Vite build, module boundaries and whitespace checks passed. Local logs:
`artifacts/automation-schedules-full-tests.log`,
`artifacts/automation-schedules-ui.log`,
`artifacts/automation-schedules-automation-regression.log`,
`artifacts/automation-schedules-web-regression.log` and
`artifacts/automation-schedules-desktop-regression.log`.

## 2026-11-17 project automation implementation

The automation UI subsequently gained a shared secondary sidebar with project
workflows and all-run history, per-workflow history pagination, and separate log,
result and export tabs. This revision passed 17 automation backend tests, 10
automation browser scenarios, all 30 web scenarios and all 10 Windows desktop
checks. The TypeScript/Vite build and module-boundary check also passed. Browser
coverage includes workflow selection clearing the previous run, empty histories,
false boolean defaults, keyboard tab navigation, dark mode and widths of 1024,
768, 600 and 390 pixels. The live P4Deck workflows and parameter form were inspected
without triggering CI. Local logs are `artifacts/automation-ui-backend-tests.log`,
`artifacts/automation-ui-redesign.log`,
`artifacts/automation-redesign-web-regression.log` and
`artifacts/automation-redesign-desktop-regression.log`.

The file-owned automation revision passed the complete backend/protocol suite:
102 tests, zero failures and zero skipped, including 16 automation tests. Coverage
includes strict definitions, typed parameters and literal argv, revision conflicts,
Agent configuration/triggering, concurrent request idempotency, project ownership,
credential stripping, progress and SSE replay, per-run report/export snapshots,
log pagination, fresh directory exports, path/link boundaries, global capacity,
detached-descendant termination, timeout, torn-log recovery, corrupt history,
relocation and version-2 backup/restore. Automation tables and durable events are
absent from the central database. Old workflows are not migrated or deleted.

The dedicated automation browser test passed six scenarios using a real headless
browser and the actual Agent CLI: Agent-created configuration appears in the UI;
UI edits are read by the Agent with a new revision; Agent runs show progress and
logs; detailed results and archived downloads are available; human parameter forms
use the same executor; no browser exceptions or horizontal overflow occur.
Evidence is in `artifacts/automation-e2e/`.

The complete web workflow passed 30 scenarios, including the updated automation
and Git-trigger forms. The Windows Electron test passed all 10 checks, including
native CI execution without system Node.js on PATH, backend reload deferral,
existing Agent workflows and React Fast Refresh. The production TypeScript/Vite
build and module-boundary check passed (12 modules, 19 edges, no cycles).

Raw local logs are `artifacts/automation-full-tests.log`,
`artifacts/automation-web-regression.log`, and
`artifacts/automation-desktop-regression.log`. Package installation and installed
automation execution are verified by `node scripts/smoke.mjs`, with results in
`artifacts/smoke/report.json` and `artifacts/automation-package-smoke.log`.
The installed-package smoke passed all 10 checks, including configuration and
CI execution from the installed Agent CLI and the packaged Windows supervisor.

Browser E2E uses a real headless Chrome/Edge instance with a fresh local profile.
It creates a project and Agent identities through forms, submits a DRAFT through
the UI, uses external HTTP clients for the PM/worker/reviewer, approves the plan,
observes SSE task updates, completes human work and accepts the final plan.
Language switching and 1280px layout are also checked. Screenshots and JSON
results are generated in `artifacts/e2e`.

Collaboration E2E uses actual project-owned credentials and SSE events to check
task motion, independent review, project roster isolation, human work, legacy
identity assignment, and a single nonmodal task drawer across Work. Closing the
drawer preserves filters; narrow layouts and reduced-motion settings are checked.
Evidence is generated in `artifacts/collaboration-e2e`. Backend collaboration
tests also cover same-squad cross-project access and safe legacy run recovery.

Task-movement E2E uses actual pointer events and isolated backend data for all
five human moves, form cancellation, mandatory delivery evidence, stale human
run bindings, plan approval, affected-child acceptance, uncertain-run barriers,
SSE cancellation, keyboard-equivalent actions, executor grouping, swimlane
ownership and narrow filtered views. Evidence is in `artifacts/task-movement-e2e`.
The backend tests reject unbound or stale human completion forms and retain the
existing file-drift and independent-review protections.

The 2026-11-16 cancellation and archive implementation passed 89 backend tests,
including 12 cancellation/archive cases, and 7 new browser scenarios. Existing
30 browser workflow checks, 9 task-movement checks, 7 collaboration checks,
10 desktop checks and 9 installed-package checks also passed. The production
web build and module boundary check (12 modules, 19 edges, no cycles) passed.
All tests used isolated data; backend tests used `--test-isolation=none` in this
local tool environment. No new performance soak was run.

The new browser suite checks dependency impact preview, cancellation reason and
confirmation, SSE scope changes preserving notes, explicit stop reconciliation
and lock retention, requirement archive/restore, history search, read-only
archived-project evidence and dependency navigation, deep links without an active
project, and narrow screens. Evidence is in `artifacts/task-lifecycle-e2e`.
Backend cases also cover planning and downstream-run barriers, superseded
acceptance, independent archive batches, Bug cancellation, history pagination
and project/Agent permission boundaries.

The 2026-11-14 task-board movement implementation passed 77 backend tests,
9 task-movement browser checks, 30 existing browser workflow checks,
7 collaboration checks, 10 desktop checks and 9 installed-package checks.
The production web build and module boundary check (12 modules, 19 edges,
no cycles) also passed. All workflow tests used isolated data directories.
Backend tests used `--test-isolation=none` in this local tool environment.
This change did not repeat the performance soak recorded below.

The 2026-11-14 project-agent and collaboration implementation passed 71 backend
tests, 30 browser workflow checks, 7 collaboration checks, 10 desktop checks and
9 installed-package checks, plus the production web build and module boundary
check. Backend tests ran with Node's `--test-isolation=none` in this local tool
environment; the test cases and assertions were unchanged.

The package smoke packs and installs into an isolated prefix, starts from a
different working directory, checks the built UI and protocol CLI, registers
ordinary project directories, and exercises backup/restore and service shutdown.

The seeded benchmark uses 10 projects, 10,000 task rows and 20 protocol clients.
It measures list/detail/claim round trips and browser update latency, then keeps
an active event timeline and idle long polls running for 30 minutes. It records
the machine, seed, samples, DOM counts and raw timings in
`artifacts/benchmark/report.json`. A shorter `--duration` run is explicitly
labelled as not the full thirty-minute acceptance test.

## Evidence policy

- A missing browser, failed check or interrupted soak is not a pass.
- Token counters are externally reported and remain unknown when absent.
- No AI model is contacted by these tests. The external-agent exercise proves
  the documented protocol, not a particular AI vendor's reasoning quality.
- Local loopback HTTP and browser tests require an environment that allows local
  sockets. A filesystem/network sandbox failure is not recorded as a green test.
- Final measured results are recorded below after all checks finish.

## Results

| Check                                   | Observed result                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Frozen offline pnpm install             | Passed                                                                                    |
| Module boundaries                       | 11 modules, 16 edges, no cycles; obsolete entrypoints absent                              |
| Backend/domain/protocol tests           | 34 passed, 0 failed, 0 skipped                                                            |
| Real browser workflow                   | 13 scenarios passed, plus an automatic-refresh latency observation; no runtime exceptions |
| Isolated package installation           | 8 checks passed, including startup outside the source tree and backup/restore             |
| Full soak                               | 1,800,000 ms; 360 samples; passed                                                         |
| Metadata round-trip P95                 | 129.00 ms (target ≤300 ms)                                                                |
| End-to-end UI refresh after final event | 362.08 ms (target ≤1,000 ms)                                                              |
| DOM / rendered timeline during soak     | 637 / 100, unchanged across all samples                                                   |
| Browser JS heap                         | 3.3 MiB first sample, 4.1 MiB last sample                                                 |

Measured on Windows, Node.js 24.16.0, Intel Core i9-12900K (24 logical CPUs),
64 GiB memory, seed 20261105. The 10,000-row dataset includes 9,998 historical
tasks and a real request/execution pair. Of 20 connected worker clients, one
produces events while 19 use idle long polls. This measures the local platform,
not twenty concurrent AI model executions or large file-copy performance.

Raw full-soak data: [benchmark-full.json](validation/benchmark-full.json).
Browser scenarios: [browser.json](validation/browser.json).
Package scenarios: [package.json](validation/package.json).
The final packaged revision also receives a separate short performance check;
its report is labelled as short rather than another full thirty-minute soak.

Final short check: 30,000 ms, metadata P95 106.66 ms, UI refresh 307.03 ms;
[raw report](validation/benchmark-final.json). This additional check does not
replace the full soak above.

## 2026-11-06 approval and recovery fixes

The follow-up fixes passed 41 backend/protocol tests, 18 browser checks (including
the latency observation), 8 installed-package checks, the production web build
and the module boundary check. Regression coverage now includes private browser
authorization, stale acceptance isolation, complete directory-scope lock checks,
review feedback delivery and human-output drift recovery through the UI. Brief
network failures retry read requests without requiring an SSE disconnection.

The repair revision's 30-second performance smoke used the same 10-project,
10,000-task, 20-client seed: metadata round-trip P95 128.90 ms, UI refresh
306.11 ms, bounded 100-entry timeline. This was a short smoke, not a new full
30-minute soak. Local raw results are in `artifacts/fixes-20261106/benchmark`;
browser and installation results are in `artifacts/e2e` and `artifacts/smoke`.

Windows double-click startup adds one installed-package scenario (9 package
checks total). Real batch start, repeated start and stop were also exercised from
an unrelated working directory with isolated state. The local preview preference
was verified separately without replacing its data or approval state.
