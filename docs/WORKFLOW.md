# Workflow: one task, end to end

The workflow is deliberately boring: a ticket freezes work, QA verifies the frozen
bytes, the integrator applies them, evidence derives the state, the human accepts,
LEAD archives. Nothing advances on "it works on my machine".

```
ticket -> candidate -> freeze -> QA -> verify -> apply -> evidence -> archive
  LEAD      author      executor   QA    QA     integrator  evidence   LEAD
```

Roles are permission templates; the work is performed by named **Agent
Instances** (`runtime.json`) that declare the **Functions** they support. The
manifest records the producing `WORKER` run and the QA approval records the
reviewing `REVIEWER` run, which is how the scheduler proves independence. See
[ENTITIES.md](ENTITIES.md).

## 0. Open the batch (LEAD)

`state.json` records one batch: `id`, `goal`, `stopCondition`, `openQuestions` and
`slices[]`. A slice is the unit QA verifies and the integrator applies.

- Batch id should match `batch.idPattern` (e.g. `APP-R01`).
- Slices start as `todo`; only LEAD closes them (`done`, `blocked`, `paused`).

## 1. Ticket (LEAD)

```bash
atk task <ID> --for <ROLE> --message
```

The output is the 9-line ticket: task / scope / write scope / depends on / exit /
do not / gates / evidence / budget. Forward it in one message. Do not attach a
summary — the ticket is the message.

The dispatch is permission-checked (`task.claim`); requesting a ticket for a task
the acting Role does not participate in is refused with a reason code. See
[PERMISSIONS.md](PERMISSIONS.md).

Exit condition: the executor can answer "what do I change, what must pass, when do
I stop" from the ticket alone.

## 2. Candidate (executor)

Work outside the original tree, in a candidate snapshot. The original tree is
read-only for agents; the only writer is the integrator's apply step.

- Record the baseline (`atk baseline start`) if git history is not a reliable
  "changed since I started" signal.
- Keep exactly one candidate per slice in flight.

Exit condition: implementation plus targeted tests, and the gates the ticket names
pass.

## 3. Gates (executor)

```bash
atk select-tests --files <changed>            # what to run
atk gate fast --files <changed> --role <ROLE> # preflight + change-scoped checks
atk gate quick                                # when the ticket requires freeze
atk gate local                                # when the ticket requires delivery
```

Every gate run ends in exactly one of five states. The report's `ok` field is
always exactly `status === "PASS"`, so a consumer that only reads `ok` can never
be told a skipped / unconfigured / error run passed.

| status | meaning | exit code | counts as a pass? |
|---|---|---|---|
| `PASS` | at least one step ran and every step exited 0 | `0` | yes |
| `FAIL` | a configured step ran and exited non-zero | `1` | no — fix it |
| `SKIPPED` | configured, but no step applies to these changes | `0` | **no** — nothing was verified |
| `UNCONFIGURED` | `gates.fast.steps` is empty, or no `gates.quick` / `gates.local` command | `2` | **no** — configuration error |
| `ERROR` | a step could not be started or executed (spawn failure, signal kill, invalid exit code) | `2` | **no** |

The same `status`, `ok`, `note`, `steps[]` and `finishedAt` are written to
`<artifactDir>/ci-fast-latest.json`; every gate run overwrites that report, so a
SKIPPED / UNCONFIGURED / ERROR run cannot leave a stale PASS behind. Delivery
(`atk release`) accepts only a report whose `status` is exactly `PASS`: a legacy
report with only `{ "ok": true }` and no `status` is rejected. A gate step that
runs in a group the change does not match never ran — write down what ran and
what did not.

## 4. Freeze (executor)

```bash
atk batch manifest --candidate <dir> --paths <changed> --packages <ID> --agent <agent-id> [--contributors a,b]
```

`--agent` records the producing Agent Instance and its Role in `manifest.run`;
`--contributors` lists additional Agent Instances that helped produce the
candidate. Without `--agent` the manifest still freezes, but it can never pass a
QA review: the scheduler has no identity to compare the reviewer against. Pass
`--function` only for a non-`WORKER` run (for example an orchestrator producing
config changes).

The manifest records the manifest tag, batch id, and a sorted line per file
(path, kind, source sha, expected-original sha) plus `manifestSha256`. Copy the
hash into the receipt. **Do not touch the candidate after freezing** — QA verifies
the bytes named in the manifest.

## 5. QA (QA role)

QA verifies the frozen manifest only:

```bash
atk task <ID> --for QA --agent <qa-agent-id>   # review dispatch: --agent is required
atk ownership check --role QA --strict
atk batch verify --manifest <manifest.json> --qa <qa-approval.json>   # omit --qa only for a diagnostic run
```

The review dispatch refuses without `--agent`, and refuses when the task belongs
to QA's own role or when a manifest already names that instance as the producer.

Then the semantic pass: boundaries, honest mocks, `partial`/`unknown` reporting,
single-writer preserved. QA writes a signed `qa-approval.json` that binds the
frozen manifest hash and records the reviewing Run:

```jsonc
{
  "schemaVersion": 1,
  "kind": "qa-approval",
  "manifestSha256": "...",
  "verdict": "PASS",
  "reviewer": {
    "run": "run-qa-01",
    "agent": "agent-qa-01",
    "role": "QA",
    "function": "REVIEWER"
  },
  "targetRunId": "run-20261102-001",      // the producing WORKER run (manifest.run.id)
  "gates": [
    { "name": "quick", "status": "PASS", "reportSha256": "..." }
  ],
  "originalApplied": false
}
```

`passed: true` on its own is not a QA fact. An approval counts only when all of
the following hold:

- `verdict` is `"PASS"` and `manifestSha256` is non-empty and equals the frozen
  `manifestSha256`;
- `reviewer.function` is `"REVIEWER"`, with non-empty `reviewer.run` and
  `reviewer.agent`;
- `reviewer.agent` is neither the manifest's producing `run.agent` nor one of its
  `run.contributors` (no self-review, see [ENTITIES.md](ENTITIES.md));
- `targetRunId` equals `manifest.run.id` when both sides carry the field;
- every declared `gates[]` entry has `status: "PASS"`; in controlled integration
  (see §6/§7) at least one gate must be declared;
- in `batch verify` / `batch apply`, the approval has not already been applied
  (`originalApplied` is not `true`);

A changed manifest hash, a changed candidate byte or a new commit voids any
previous approval: re-freeze and re-review. Receipts that only self-report
`passed: true` / `noninteractiveQA: "passed"` (the pre-M0 format) are refused by
default with a readable `legacy-receipt` reason. They keep working only through
the explicit escape hatches `"batch": { "legacyReceipts": true }` or
`--legacy-receipts` (on `batch verify` / `batch apply` / `evidence`).

Exit condition: PASS/FAIL plus concrete gaps and the approval JSON path; no edits
to product code.

## 6. Verify (QA, or the integrator before apply)

`atk batch verify --manifest <f> --qa <qa-approval.json>` checks the frozen
manifest, the candidate bytes, the original tree, the QA receipt structure and
the reviewer identity. Its verdict is `status: "PASS" | "FAIL" | "SKIPPED"`,
with a `rejected: [{ reason, detail }]` list naming every refused receipt.

- **Controlled integration** — `atk batch verify --require-qa`: a structurally
  valid QA receipt is mandatory. Missing or refused → `status: FAIL`, exit `1`,
  and a readable reason such as `missing-qa-approval`, `legacy-receipt`,
  `manifest-sha-mismatch`, `target-run-mismatch`, `self-review`, `gate-not-pass`
  or `missing-gates`.
- **Read-only diagnostic** — `atk batch verify` without `--qa`: still usable, but
  the report is `status: "SKIPPED"` with `diagnosticOnly: true`, and the human
  output never prints PASS:

  ```
  SKIPPED BATCH-01: diagnostic-only, no qa-approval supplied; QA was not evaluated; 3 structural check(s) ok | receipt artifacts/evidence/BATCH-01/verify-....json
  ```

  Treat it as "no QA verdict yet", never as an approval.

`atk batch apply` runs the same checks and is always controlled integration (see
§7). Treat any failing check as a stop, not a retry.

## 7. Apply (integrator only)

```bash
atk ownership check --role BE --strict
atk batch verify --manifest <f> --qa <qa-approval.json>   # must PRINT PASS
atk batch apply --manifest <f> --qa <qa-approval.json>    # dry-run plan
atk batch apply --manifest <f> --qa <qa-approval.json> --apply --confirm-dev-closed
```

Every form of `atk batch apply` — the dry-run plan included — is controlled
integration and requires a structurally valid QA approval bound to the manifest.
Without one the plan is still printed, but with `"status": "FAIL"`, the
`rejected` reasons (`missing-qa-approval`, `legacy-receipt`, ...) and exit code
`1`; the original tree is never touched. A dry-run is still a dry-run: it writes
the plan receipt, not product files.

Apply requires **both** `--apply` and `--confirm-dev-closed`; the second flag is
the explicit user confirmation that the dev server / app is closed. On drift the
command exits `3` and changes nothing. Never carry an unverified slice into an
apply.

A real apply is also the permission-checked operation
`integration.merge.development`: it refuses without a QA approval bound to the
manifest, and (when `gates.quick` / `gates.local` are configured) without a green
gate report — a self-declared gate inside the QA receipt is not a gate report.
The denial carries a reason code (`REVIEW_EVIDENCE_INVALID`, `GATE_NOT_GREEN`,
`APPROVAL_REQUIRED`, ...); see [PERMISSIONS.md](PERMISSIONS.md).

## 8. Evidence (LEAD)

```bash
atk evidence              # derive qaPassed / applied from receipts
atk sync                  # import -> evidence -> board -> measure -> state check
```

`atk evidence` is idempotent and only derives facts backed by receipts. It never
advances `blocked`, `paused` or `done`, and never writes `humanAccepted`. If a
fact looks wrong, the missing input is a receipt, not a manual edit.

A receipt that does not validate is never silently ignored: it is counted in the
`rejected` list of the JSON report and printed on stderr with a readable
`reason` / `detail`, for example `legacy-receipt`, `self-review`,
`manifest-sha-mismatch` or `gate-not-pass`. Legacy `passed: true` receipts are
refused by default; the explicit escape hatches are
`"batch": { "legacyReceipts": true }` or `atk evidence --legacy-receipts`.

## 9. Acceptance and archive (human + LEAD)

- The human accepts the applied result. Only then does LEAD record
  `verification.humanAccepted: true`.
- `atk state archive <ID> --note "why"` records the archive time, reason and
  evidence; it refuses without `humanAccepted`.
- `atk state restore <ID>` reverses an archive; `atk state import` never
  resurrects archived packages.

## 10. Release (human + LEAD)

- Day-to-day commits stay on `branch.development` (default `dev`).
- Once the gate is green, run `atk release --version x.y.z` to preview the plan,
  then `--apply` to checkout `branch.release` (default `master`), merge with
  `--no-ff` and create the `v<version>` tag; the command switches back to dev.
- The release command refuses an unclean worktree, a mismatched version file, a
  stale/red gate report or a duplicate tag; `--skip-gate` / `--allow-dirty` are
  explicit escape hatches. A gate report is accepted only when its `status` is
  exactly `PASS` — `ok: true` alone, or any SKIPPED / UNCONFIGURED / ERROR report,
  is not green. A UTF-8 BOM on the report is tolerated.
- No push is performed: push both branches and the tag yourself.

## The proof ladder

| Rung | Proves | Does not prove |
|---|---|---|
| typecheck / compile | types and syntax are consistent | tests were executed |
| unit / integration tests | the tested behavior holds | native product behavior |
| QA on a frozen snapshot | the frozen bytes satisfy the ticket | the human accepts it |
| human acceptance | the product is accepted | — |

Report each rung separately. `mock` is not native; an isolated pass is not a
combined pass; `unknown` is never success.

## Round budget

Default `batch.budgetRounds` is 12 (`<= 10` for a QA slice). When the budget is
exhausted without meeting the exit condition, stop and report: the task should be
split, not stretched. LEAD reports to the user in <= 5 lines; executors report in
the 6-line receipt.

## Human-only todos

`human-todos.json` (and `atk todo`) records things only the human can do: confirm
dev is closed, accept a result, rotate a credential, test on another machine.
Agents may read and add; only the human (or the board UI) may tick. There is no
command that ticks a todo automatically, and that is intentional.

## Concurrency and exit codes

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | a check or gate failed, or a safety refusal |
| `2` | usage or configuration error |
| `3` | concurrency/drift refusal — an input changed mid-operation |

When in doubt, stop and report. A stopped task with an honest receipt is cheaper
than a merged task with a fabricated one.
