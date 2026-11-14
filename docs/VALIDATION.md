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
node scripts/smoke.mjs
node scripts/benchmark.mjs
```

The backend tests cover PM approval, identity constraints, review configuration,
human tasks, VERIFIED dependency progression, file/directory/case locking,
generation fencing, duplicate events/results, content drift, quarantine/restart,
project isolation, document retries and backup integrity.

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
