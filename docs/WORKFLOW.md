# Workflow: one task, end to end

The workflow is deliberately boring: a ticket freezes work, QA verifies the frozen
bytes, the integrator applies them, evidence derives the state, the human accepts,
LEAD archives. Nothing advances on "it works on my machine".

```
ticket -> candidate -> freeze -> QA -> verify -> apply -> evidence -> archive
  LEAD      author      executor   QA    QA     integrator  evidence   LEAD
```

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

`skipped` is not a pass. A gate that runs in a group that the change does not
match never ran. Write down what ran and what did not.

## 4. Freeze (executor)

```bash
atk batch manifest --candidate <dir> --paths <changed> --packages <ID>
```

The manifest records the manifest tag, batch id, and a sorted line per file
(path, kind, source sha, expected-original sha) plus `manifestSha256`. Copy the
hash into the receipt. **Do not touch the candidate after freezing** — QA verifies
the bytes named in the manifest.

## 5. QA (QA role)

QA verifies the frozen manifest only:

```bash
atk ownership check --role QA
atk batch verify --manifest <manifest.json> --qa <previous-or-omit>
```

Then the semantic pass: boundaries, honest mocks, `partial`/`unknown` reporting,
single-writer preserved. QA writes `qa-approval.json`, binding the current
`manifestSha256`, and stores it in the evidence directory. A changed hash voids
any previous approval.

Exit condition: PASS/FAIL plus concrete gaps and the approval JSON path; no edits
to product code.

## 6. Verify (QA, or the integrator before apply)

`atk batch verify --manifest <f> --qa <f>` fails on: stale manifest, candidate
changed since freeze, QA approval not bound to the manifest hash, or drift in the
original tree. Treat any of those as a stop, not a retry.

## 7. Apply (integrator only)

```bash
atk ownership check --role BE
atk batch verify --manifest <f> --qa <qa-approval.json>   # must PASS
atk batch apply --manifest <f>                            # dry-run plan
atk batch apply --manifest <f> --apply --confirm-dev-closed
```

Apply requires **both** `--apply` and `--confirm-dev-closed`; the second flag is
the explicit user confirmation that the dev server / app is closed. On drift the
command exits `3` and changes nothing. Never carry an unverified slice into an
apply.

## 8. Evidence (LEAD)

```bash
atk evidence              # derive qaPassed / applied from receipts
atk sync                  # import -> evidence -> board -> measure -> state check
```

`atk evidence` is idempotent and only derives facts backed by receipts. It never
advances `blocked`, `paused` or `done`, and never writes `humanAccepted`. If a
fact looks wrong, the missing input is a receipt, not a manual edit.

## 9. Acceptance and archive (human + LEAD)

- The human accepts the applied result. Only then does LEAD record
  `verification.humanAccepted: true`.
- `atk state archive <ID> --note "why"` records the archive time, reason and
  evidence; it refuses without `humanAccepted`.
- `atk state restore <ID>` reverses an archive; `atk state import` never
  resurrects archived packages.

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
