# Internals — module contract

> This file is the shared build contract for the toolkit. Read it before adding a
> command. English only: publishing target.

## 1. Golden rules

1. **No third-party dependencies.** Node >= 20.11 built-ins only (the toolkit must
   run with a bare `node` inside any project).
2. **No hard-coded project knowledge.** Every path comes from `ctx` (`ctx.paths`,
   `ctx.rel`); every role from `ctx.config.roles`; every label from
   `ctx.labels`. ASCII-only source files except the `zh-CN` label/模板 content.
3. **Deterministic output.** Sort every collection before rendering. Timestamps
   only where the original format requires them.
4. **Machine output is JSON, human output is short.** Commands that other
   commands consume support `--json` (pretty JSON on stdout, nothing else).
5. **Exit codes:** `0` ok, `1` check failed / gate failed, `2` usage error,
   `3` concurrency / drift refusal.
6. **No `process.exit()` inside library functions** — return an exit code and let
   `bin/atk.mjs` apply it. (Commands may set `process.exitCode`.)
7. **Never write outside `ctx.root`** unless the config explicitly points there
   (use `assertInsideRoot` from `lib/config.mjs`). Candidates in the OS temp dir
   are the only exception and are always read-only inputs for apply.

## 2. Command module contract

Every `lib/<name>.mjs` command module exports:

```js
export async function run(argv /* string[] */, ctx) { /* returns exit code */ }
```

`ctx` (see `lib/context.mjs`):

| field | meaning |
|---|---|
| `ctx.config` | fully resolved config object (see `lib/config.mjs`) |
| `ctx.root` | absolute project root |
| `ctx.paths.state` … | absolute paths for every configured file (`ctx.paths[e.key]`) |
| `ctx.rel.state` … | project-relative posix paths for the same keys |
| `ctx.roles` | configured roles, e.g. `["LEAD","FE","BE","QA"]` |
| `ctx.lang` / `ctx.labels` | label language + dictionary (`lib/labels.mjs`) |
| `ctx.log.out/err/json/fail` | output helpers |
| `ctx.relOf(abs)` | project-relative path helper |

`run()` must print `--help` usage when `argv[0]` is `help`/`--help` (or when the
sub-command is missing) and return `2` in that case.

## 3. Naming inside the CLI

| top-level | module | sub-commands |
|---|---|---|
| `atk state` | `lib/state.mjs` | `check`, `board`, `queue`, `task`, `import`, `archive`, `restore` |
| `atk board` / `atk serve` | `lib/board.mjs` | `--serve`, `--json`, `--compact` |
| `atk evidence` | `lib/evidence.mjs` | `--collect-temp`, `--dry`, `--legacy-receipts` |
| `atk ownership` | `lib/ownership.mjs` | `map`, `check` (`--strict` / `--no-strict`), `verify-config` |
| `atk permit` | `lib/permissions.mjs` (+ `lib/permission-registry.mjs`) | `matrix`, `explain`, `check`, `audit` |
| `atk batch` | `lib/batch.mjs` | `manifest`, `verify` (`--require-qa`, `--legacy-receipts`), `apply` (`--legacy-receipts`) |
| `atk baseline` | `lib/baseline.mjs` | `start`, `changed` |
| `atk cache` | `lib/cache.mjs` | `status`, `clean` |
| `atk gate` | `lib/gate.mjs` | `fast`, `quick`, `local` |
| `atk select-tests` | `lib/select-tests.mjs` | `--files`, `--since-baseline`, `--plan`, `--quiet` |
| `atk release` | `lib/release.mjs` | `--version <semver>`, `--apply`, `--skip-gate`, `--allow-dirty` |
| `atk todo` | `lib/human-todos.mjs` | list (default), `add`, `toggle`, `done`, `undone`, `remove` |
| `atk measure` | `lib/measure.mjs` | `record`, `summary` |
| `atk sync` | `lib/sync.mjs` | `--quiet` |
| `atk docs rotate` | `lib/docs.mjs` | `rotate` (`--apply`, `--keep`, `--flavor`) |
| `atk plugin` | `lib/plugin.mjs` | `sync`, `verify` |
| `atk init` | `lib/init.mjs` | `--preset`, `--project`, `--language`, `--roles`, `--force` |

Aliases (`task`, `queue`, `check`, `import`, `archive`, `restore`, `tests`) are
defined in `lib/dispatch.mjs`; do not duplicate them inside modules.

## 4. Data contracts (keep byte-compatible with the existing P4Deck files)

### 4.1 `state.json`

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-29T21:05:00+08:00",
  "source": "optional human note",
  "batch": {
    "id": "CON06+ACTION-R01",
    "goal": "one sentence",
    "stopCondition": "one sentence",
    "devClosedByUser": false,
    "applyMode": "local-tree",
    "openQuestions": ["..."],
    "slices": [
      { "id": "S1A", "label": "ACTION S1A", "status": "done", "qaPassed": true,
        "applied": true, "owner": "BE", "exit": "frozen + QA passed",
        "evidence": "artifacts/evidence", "note": "..." }
    ]
  },
  "counts": { "total": 52, "byStage": { } },
  "packages": [
    { "id": "GRAPH-01", "type": "feature", "typeRaw": "功能需求", "owner": "FE",
      "module": "界面与导航", "scope": "...", "stage": "implemented",
      "statusRaw": "...", "priority": "P1", "evidence": "已应用", "note": "...",
      "depsRaw": "...", "deps": ["UI-01"], "archived": false, "migrated": true,
      "verification": { "humanAccepted": true },
      "updatedAt": "...", "archivedAt": null, "archivedBy": null,
      "archiveReason": null, "archiveEvidence": null, "firstSeenAt": "..." }
  ],
  "subitems": [
    { "id": "CON-01-F01", "parent": "CON-01", "type": "feature", "owner": "FE；QA", "stage": "partial" }
  ]
}
```

`stage` ∈ `done | implemented | partial | in-progress | todo | blocked | proposed`.
`slice.status` ∈ `todo | in_progress | frozen | qa | qa_with_gap | awaiting_apply |
awaiting_accept | blocked | done | paused`.
Archive is allowed only when `verification.humanAccepted === true`.

### 4.2 `ownership.json` (per project, inside `flowDir`)

```jsonc
{
  "schemaVersion": 1,
  "note": "path → role. Longest prefix wins; two roles on one path is a config error.",
  "roles": ["LEAD", "FE", "BE", "QA"],
  "ignoredPrefixes": ["artifacts/", "node_modules/"],
  "rules": [
    { "prefix": "src/test/batch-qa/", "role": "QA", "note": "..." },
    { "prefix": "src/", "role": "FE", "note": "..." }
  ],
  "rootFiles": { "role": "LEAD", "names": ["package.json"] }
}
```

**Modes (`atk ownership check`).** `ownership.mode` in `agent-flow.config.json`
is `"loose"` (default, the v0.2 behaviour) or `"strict"`; `--strict` /
`--no-strict` override the config, and an unknown configured value is a config
error (`exit 2`) so a typo can never silently downgrade a gate. Strict mode is
the fail-closed variant used by execution/integration gates:

1. a Role is mandatory — `--role <ROLE>` or `$AGENT_ROLE`; missing → `exit 2`
   with a usage message (never a violation);
2. an unknown Role (not in `ownership.json` roles, else `config.roles`) →
   `exit 2`;
3. unmapped paths become blocking violations → `exit 1`, and each one appears in
   `violations[]` with `rule: "unmapped"`, `owner: null`;
4. an empty changed-file list is `status: "SKIPPED"` → `exit 0`, printed as
   "nothing was verified, this is not a pass" (never `PASS`).

Strict JSON report (`--json`):

```jsonc
{ "status": "PASS", "mode": "strict", "ok": true, "role": "DEV",
  "checked": 1, "violations": [], "unmapped": [], "ignored": 0 }
```

`ok` is true only for `status: "PASS"`. A strict usage/config error (for example
a missing role or an unknown role) prints
`{ "status": "ERROR", "mode": "strict", "ok": false, "error": "..." }` and exits
`2`; an invalid `ownership.mode` value is rejected earlier by config loading
(`exit 2`). Loose mode keeps the historical report shape and exit codes exactly:
`{ ok, role, checked, violations, unmapped, ignored }`, unmapped paths are a
hint and the Role is optional — `status` / `mode` appear only in strict reports.

### 4.3 `human-todos.json`

```jsonc
{ "schemaVersion": 1, "updatedAt": "...", "note": "...",
  "items": [{ "id": "T01", "text": "...", "done": false, "createdAt": "...", "doneAt": null, "note": "..." }] }
```

Agent may read/add; only a human (or the board UI) may tick. `todo toggle/done`
must refuse when `AGENT_MODE=1`? No — the rule is social; keep the command but
document it. Do not auto-tick anywhere.

### 4.4 `runtime.json`

```jsonc
{ "schemaVersion": 3, "updatedAt": "...", "note": "...",
  "agents": [{ "id": "agent-be-01", "role": "BE", "capabilities": ["WORKER"],
               "status": "working|waiting|idle", "task": "...", "detail": "...", "since": "..." }],
  "events": [{ "at": "...", "role": "LEAD", "text": "..." }] }
```

`id` is the Agent Instance identity used by the scheduler; `capabilities` lists
the Functions that instance may perform. `schemaVersion: 2` files (no id) still
load, but `atk state check` warns and identity checks cannot pass. `atk init`
writes one instance per Role with `<role>` lower-cased in the id.

### 4.5 batch manifest (`atk batch manifest`) — keep the existing format

Line 1 `p4deck-manifest-v1` (or `batch.manifestTag`), line 2 batch id, then the
same fields as `scripts/workflow/batch.mjs` produces (`candidate`, `paths`,
`files[{path,sha256,size}]`, `manifestSha256` over the deterministic payload).
The frozen hash covers the tag, the batch id and the file lines only, so adding
the optional `run` block does not change `manifestSha256`:

```jsonc
"run": { "id": "run-20261102-001", "agent": "agent-be-01", "role": "BE",
         "function": "WORKER", "startedAt": "...",
         "contributors": ["agent-be-02"] }
```

`qa-approval.json` binds `manifestSha256`. The manifest framing above is stable:
changing it needs a `batch.manifestTag` bump plus a migration note. The QA
receipt now carries the signed structure below, versioned by `schemaVersion: 1`
(the pre-M0 `passed: true` receipt is the legacy form; see the migration notes
in [ENTITIES.md](ENTITIES.md#migration)). Root-level paths are accepted only
when `batch.allowRootFiles` is `true` (prefixes cannot express them). Every gate
— `fast`, `quick`, `local` — writes `<artifactDir>/ci-fast-latest.json`, which
`batch apply` and `release` consume as the latest green report. The signed
structure is the single definition exported from `lib/evidence.mjs` as
`QA_APPROVAL_SCHEMA`; `batch.mjs` reuses `validateQaApproval`/`qaPassVerdict`:

```jsonc
{ "schemaVersion": 1, "kind": "qa-approval",
  "manifestSha256": "...", "verdict": "PASS",
  "reviewer": { "run": "run-qa-01", "agent": "agent-qa-01", "role": "QA",
                "function": "REVIEWER" },
  "targetRunId": "run-20261102-001",          // must match manifest.run.id when set
  "policyVersion": "optional run policy snapshot",
  "commitSha": "optional frozen commit",
  "gates": [{ "name": "quick", "status": "PASS", "reportSha256": "optional" }],
  "originalApplied": false }
```

A receipt that only self-reports `{ "passed": true }` / `noninteractiveQA` is a
legacy receipt: it is rejected by default with reason `legacy-receipt`, and is
accepted only through the explicit escape hatch `batch.legacyReceipts: true`
(config) or `--legacy-receipts` (CLI). Every refused receipt is reported in
`rejected` — never silently ignored. `atk evidence` derives QA facts only from
accepted receipts.

`verifyManifest(ctx, manifest, qaPath, { requireQa, legacyReceipts })` returns:

| field | meaning |
|---|---|
| `status` | `"PASS" \| "FAIL" \| "SKIPPED"`; `SKIPPED` only for a plain `verify` without `--qa` (diagnostic-only) |
| `diagnosticOnly` | `true` when no `--qa` was supplied and `requireQa` is off |
| `rejected` | `[{ reason, detail }]` readable refusals (`missing-qa-approval`, `legacy-receipt`, `manifest-sha-mismatch`, `target-run-mismatch`, `self-review`, `gate-not-pass`, `missing-gates`, `qa-already-applied`, ...) |
| `ok` | `checks` all green **and** `rejected` empty (kept for old consumers) |
| `checks` / `drift` | unchanged check list and drift list |

`status: "PASS"` requires a valid approval, an independent REVIEWER run and
every declared gate `PASS`; controlled integration (`--require-qa`, every
`apply`) reports `FAIL` when the receipt is missing. The check names below are
unchanged and are produced for an accepted approval when
`functions.enforceNoSelfReview` is not `false`: `producer-identity`,
`reviewer-identity`, `producer-function`, `reviewer-function`, `no-self-review`,
`producer-registered`, `reviewer-registered`, `producer-capability`,
`reviewer-capability`, `producer-role-match`, `reviewer-role-match`,
`reviewer-role-capability`. `atk state task` refuses a REVIEWER dispatch without
`--agent`, when the target Role owns the task, or when a manifest under
`evidenceDir` records the same instance as producer.

**`atk batch apply` output contract (M0):** every path prints one JSON plan on
stdout — a dry-run plan, or a failure plan whose `error` is one of
`"verify-failed"` (the manifest/QA verification did not pass) or
`"permission-denied"` (the integration permission refused the write; `reason`
carries the permission reason code such as `GATE_NOT_GREEN`, `detail` the readable
why). The original tree is not touched on either failure path. This closes the
only path that used to fail with stderr only, so a script can always read why an
integration did not happen.


### 4.6 `functions` config

`agent-flow.config.json` carries `functions.roles` (Role -> Function(s), with
`LEAD=ORCHESTRATOR`, `QA=REVIEWER`, otherwise `WORKER` defaults) and
`functions.enforceNoSelfReview` (default `true`). `lib/functions.mjs` is the only
module that owns the taxonomy; `config.mjs` normalizes it so every consumer sees
a Function list for every Role.

### 4.7 permission audit (`atk permit`)

The subject x operation matrix is code-owned in `lib/permission-registry.mjs`
(five-character rows in `HUMAN/ORCHESTRATOR/WORKER/REVIEWER/SYSTEM` order, plus
conditions for conditional cells); it is not configurable per project.
`lib/permissions.mjs` evaluates
`RBAC ∧ Scope ∧ Ownership ∧ State ∧ Policy ∧ Approval` in the fixed order from
[docs/PERMISSIONS.md](PERMISSIONS.md), returns a reason code, and appends every
decision to `<artifactDir>/permission-audit.jsonl`:

```jsonc
{ "schemaVersion": 1, "matrixVersion": 1, "at": "...", "entry": "command",
  "operation": "qa.result.submit", "subject": "REVIEWER", "subjectKind": "agent",
  "role": "QA", "agent": "agent-qa-01", "action": "C", "allowed": true,
  "reason": "ALLOWED", "task": "PKG-01", "project": "demo" }
```

The file is append-only (`appendFile`, never rewritten); `audit.modify` is denied
for every subject. `atk permit check` exits `0` allowed, `1` denied, `2`
usage/config error.

Enforcement inside existing commands: `state task` (`task.claim`),
`batch manifest` (`qa.manifest.freeze`), `batch verify` (`qa.result.submit`),
`batch apply` writes (`integration.merge.development`), `state archive`
(`integration.archive`).

### 4.8 gate report (`<artifactDir>/ci-fast-latest.json`)

Every `atk gate fast|quick|local` run writes one report and returns one of five
statuses. `ok` is always exactly `status === "PASS"`; the exit codes are
`PASS 0`, `FAIL 1`, `SKIPPED 0`, `UNCONFIGURED 2`, `ERROR 2`.

`fast` report:

```jsonc
{ "schemaVersion": 1, "status": "PASS", "ok": true, "role": "DEV",
  "scope": { "total": 1, "tests": 0, "byGroup": { "code": 1 } },
  "durationMs": 119, "finishedAt": "2026-11-01T18:33:33.325Z",
  "steps": [{ "name": "lint", "status": "passed", "exitCode": 0,
              "durationMs": 117 }],
  "note": "Fast gate passed. This is not the freeze gate; ..." }
```

`quick` / `local` report:

```jsonc
{ "schemaVersion": 1, "gate": "quick", "status": "UNCONFIGURED", "ok": false,
  "command": null, "exitCode": null, "durationMs": 0,
  "finishedAt": "2026-11-01T18:31:42.147Z",
  "note": "gates.quick.command is not configured. UNCONFIGURED is not a pass; ..." }
```

- `status` is the five-value model; `SKIPPED` means no step applied, not a pass.
- `step.status` ∈ `"passed" | "failed" | "error"`. A step that cannot be launched
  or ends abnormally is `"error"` and carries `exitCode: null` plus an `error`
  string; a normal non-zero exit is `"failed"` with the real `exitCode`.
- `stoppedAt: "preflight"` appears when a preflight step stopped the fast gate;
  an internal exception adds a top-level `error` and status `ERROR`.
- Every run overwrites the report (even UNCONFIGURED/ERROR), so a stale PASS can
  never survive a gate run that did not pass. `release` accepts the report only
  when `status === "PASS"` and `ok === true`; a legacy report without `status`
  is rejected. The report is read BOM-tolerantly (`readJsonStrict`/`stripBom`).
- **One verdict implementation:** `gateReportVerdict(report)` in `lib/gate.mjs` is
  the only place that decides whether a report is green. `atk release` and the
  permission condition `gate-green` (used by `batch apply`) both call it, so the
  two delivery paths cannot drift apart; a test asserts they are the same
  function object. Only `status === "PASS" && ok === true` is green; a legacy
  report without `status`, any SKIPPED/FAIL/UNCONFIGURED/ERROR status, and the
  contradictory `status: "PASS", ok: false` are all refused with a specific
  reason.
- **`gate-green` without a configured gate:** when neither `gates.quick` nor
  `gates.local` is configured the condition reports "not applicable" (allowed,
  `detail: "no quick/local gate configured; gate-green does not apply"`). It
  never claims a report was verified. An unconfigured gate is still caught
  separately: `atk gate <name>` returns UNCONFIGURED with exit 2.

### 4.9 `atk evidence` report

`deriveEvidence()` / `atk evidence --json` returns
`{ ok, receipts, qaApprovals, applies, selfReviewed, rejected, legacyReceipts,
attributedPaths: { qa, applied }, changes }` (the CLI adds `dryRun` and
`collected`). `selfReviewed` stays a number (count of `self-review`
rejections).

**Breaking field change (M0):** `rejected` used to contain only
`[{ file, manifestSha256, agent }]` (self-reviewed approvals). It is now a list
of every refused QA receipt:

```jsonc
{ "file": "<absolute path>", "path": "artifacts/evidence/BATCH-01/qa-legacy.json",
  "reason": "legacy-receipt", "detail": "self-reported passed:true: ...",
  "legacy": true,
  "reasons": [{ "reason": "legacy-receipt", "detail": "..." }] }
```

`reason` is the first (primary) refusal, `reasons` is the complete list, `path`
is project-relative and `file` absolute. Legacy receipts are refused unless
`batch.legacyReceipts: true` or `--legacy-receipts` is set; every rejection is
also printed on stderr as `refused qa-approval <path>: <reason> - <detail>`.
Consumers that read the old `rejected` entry fields must be updated; nothing is
silently dropped.

**Binding rule (M0 QA fix):** a receipt that carries a non-empty `manifestSha256`
is accepted only when a manifest with that hash exists in the evidence directory
that the run scanned. Otherwise it is refused with reason `unbound-manifest` and
no `qa`/`applied` fact is derived — a fabricated or typo'd hash must never advance
`state.json`. Hex comparison is case-insensitive (the manifest side writes upper
case); normalisation is used for comparison only and the receipt keeps its
original value in the report. A receipt that looks like a QA approval (`verdict`,
`reviewer` or `gates` present) but lacks `kind: "qa-approval"` is refused with
reason `missing-kind`, even when the legacy escape hatch is on.

Receipt capture (`atk evidence --collect-temp`) copies recognisable
manifest / apply / qa-approval JSON from `<os.tmpdir()>/<layout.tempPrefix>-*`
into the evidence dir and skips build directories (`node_modules`, `target`,
`dist`, ...). Classification is recognition, not acceptance: a legacy QA receipt
is still copied (it may be needed for audit/migration) and is then reported in
`rejected` when facts are derived, unless the legacy escape hatch is on.

## 5. Board rendering

- `atk state board` renders `ctx.paths.board` (markdown).
- `atk board` renders `ctx.paths.boardHtml` and can `--serve` a live SSE board.
- Markdown section order and column keys are fixed by `lib/labels.mjs`; the board
  plugin reads `state.json` directly (not the markdown), so both stay in sync.

## 6. Testing

- `npm test` runs `node scripts/test.mjs`, which expands `test/*.test.mjs` and
  invokes the built-in `node --test` runner with explicit paths. That indirection
  is required: Node 20 does not expand globs, Node 22+ expands them only as a
  literal, Windows `cmd` expands none, and Node 24 rejects a bare directory
  argument on Windows. No vitest/jest.
- Every command module gets at least one test that builds a throwaway project in
  `mkdtemp(path.join(os.tmpdir(), "atk-test-"))`, writes a minimal config +
  state/ownership files, and asserts both library output and CLI exit codes.
- Plugin selftests stay standalone: `node plugins/dsh-agent-board/selftest.mjs`
  (host side) and `selftest-client.mjs` (client bundle, fake ModuleLoader).

## 7. Plugin copy inside a consuming project

`atk plugin sync --out <dir>` copies `plugins/dsh-agent-board` into the project,
replacing the identity tokens (`__PLUGIN_ID__`, `__PLUGIN_ROUTE__`,
`__PLUGIN_TITLE__`, `__PLUGIN_TAB_KIND__`, `__PLUGIN_COMMAND_ID__`) from
`config.plugin`, and writes the matching `cordis.patch.yml`. A project that wants
the board installs that directory through the DSH Plugins page.
