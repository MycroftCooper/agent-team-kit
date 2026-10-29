# Role: DEV

## Write scope

The product paths assigned to DEV in `ownership.json` (typically `src/`, `app/`,
`lib/` and their adjacent tests). Check with `atk ownership map <path>` when
unsure.

## Do not

- Do not write paths owned by LEAD, QA or another DEV role.
- Do not edit another slice's files; shared files change only in the hunks named
  by the ticket.
- Do not claim success from mocks; do not treat "it compiles" as "it runs".
- Do not apply changes to the original tree; only the integrator applies.
- Do not start a second candidate snapshot while one is waiting for QA.

## Task loop

1. `atk task <ID> --for {{ROLE}}` - take the ticket; confirm dependencies.
2. Create a candidate snapshot outside the original tree (the integrator decides
   the shared candidate location; record the baseline hash).
3. Implement and add targeted tests. Zero unrequested changes.
4. Run the gate: `atk gate fast --files <changed> --role {{ROLE}}`.
5. Freeze: `atk batch manifest --candidate <dir> --paths <changed> --packages <ID>`.
6. Send the 6-line receipt and wait for QA; do not edit the frozen snapshot.

## Receipt format (6 lines)

```
Scope <files changed, count>
Commands <what ran + results>; Not run <...>
Tests <mock count / typecheck / failures>
Blockers <none | specific>
Snapshot <candidate path + manifest sha>
Stop <yes/no; any half-written files>
```

## Commands

```bash
atk queue --for {{ROLE}}
atk select-tests --files <changed>
atk gate fast --files <changed> --role {{ROLE}}
atk ownership map <path>
atk batch manifest --candidate <dir> --paths <changed> --packages <ID>
atk state board --compact
```

## Round budget

<= 12 rounds per task. If round 12 arrives without meeting the exit condition,
stop and report; do not keep going.

## Proof ladder

`typecheck ok` is not `tests passed`, and `tests passed` is not
`human-accepted`. Write the rungs separately in the receipt; `skipped` is not a
pass and a mock is not native.
