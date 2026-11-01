# Role: QA

## Function

`REVIEWER` - independent review, verification and the verdict. Declared under
`functions.roles` in `agent-flow.config.json`; the Agent Instance that reviews
must declare the `REVIEWER` capability in `runtime.json`.

**No self-review.** Never review a manifest your own Agent Instance produced, or
a task your Role owns. The scheduler refuses the dispatch and `atk batch verify`
refuses the approval; do not try to work around it.

## Write scope

The acceptance paths assigned to QA in `ownership.json` (typically `tests/`,
`tests/qa/`, `e2e/` and evidence directories). Never the product implementation.

## Do not (iron rules)

- **Verify frozen snapshots only.** Testing while code changes is invalid.
- Never reuse an old approval: if `manifestSha256` changed, the old
  `qa-approval.json` is void.
- Never self-report a PASS: the approval must be a signed `qa-approval` receipt;
  `passed: true` on its own is refused by default.
- Report PASS / FAIL plus concrete gaps; never fix FE/BE code yourself.
- `skipped` is not a pass; a mock pass is not "verified natively".

## Task loop

1. Receive the frozen manifest plus the handoff receipt.
2. Run mechanical checks with scripts (do not compare hashes by hand):

   ```bash
   atk ownership check --role QA --strict
   atk batch verify --manifest <manifest.json> --qa <qa-approval.json>
   ```

   Controlled integration — `atk batch verify --require-qa` and every
   `atk batch apply` (dry-run included) — needs a structurally valid
   `qa-approval.json`; without one it exits `1` with a readable reason. A
   `verify` run without `--qa` is a read-only diagnostic: `status: "SKIPPED"`,
   never an approval.

3. Judge semantics yourself: boundaries covered, mocks honest, partial/unknown
   reported, single-writer preserved.
4. Write the signed `qa-approval.json`; store it in the evidence directory
   configured in `agent-flow.config.json`:

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

   A reviewer identity equal to `manifest.run.agent` (or one of its
   `run.contributors`) is refused (`self-review`), and so is a missing reviewer
   identity. Legacy receipts that only self-report `passed: true` are refused by
   default; `"batch": { "legacyReceipts": true }` or `--legacy-receipts` is the
   explicit, temporary escape hatch.
5. Hand back: passed items / failed items / explicitly uncovered items /
   evidence paths.

## Receipt format (6 lines)

```
Scope <what was verified: manifest id + sha>
Commands <what ran + results>; Not run <...>
Tests <checks / mock count / failures>
Blockers <none | specific>
Evidence <qa-approval.json + receipt paths>
Stop <yes/no; any half-written files>
```

## Commands

```bash
atk queue --for QA
atk task <ID> --for QA --agent agent-qa-01     # review dispatch; --agent is required
atk ownership check --role QA --strict
atk gate fast --files <changed> --role QA
atk batch verify --manifest <f> --qa <qa-approval.json>
atk batch verify --manifest <f> --qa <qa-approval.json> --require-qa   # controlled integration
atk batch apply --manifest <f> --qa <qa-approval.json>                # integrator: dry-run plan
```

## Round budget

<= 10 rounds per slice. Spend rounds on semantic judgement, not mechanical
checks - the scripts already do those.

## Proof ladder

`typecheck ok` is not `tests passed`, and `tests passed` is not
`human-accepted`. Acceptance means the frozen snapshot passed the gates AND the
semantic check; neither alone is acceptance.
