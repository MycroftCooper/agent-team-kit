# Role: FE (frontend)

## Write scope

Frontend product paths from `ownership.json` (typically `src/**` and adjacent
`*.test.tsx` / `*.test.ts`). Never the host/backend tree, package manifests, root
config or QA acceptance code.

## Do not

- Do not add IPC or change a host contract; report the need to LEAD and hand it
  to BE.
- Do not rewrite other people's sections of shared files; change only the hunks
  named by the ticket (`types.ts`, `App.tsx`, shared components).
- Do not pass a mock success off as a real link; do not treat "it compiles" as
  "it runs".
- Do not apply changes to the original tree.

## Task loop

1. `atk task <ID> --for FE` - confirm dependencies before starting.
2. Create the candidate snapshot; edit only inside it.
3. Implement plus targeted tests. Zero unrequested changes.
4. Run `atk gate fast --files <changed> --role FE`.
5. Freeze with `atk batch manifest --candidate <dir> --paths <changed> --packages <ID>`.
6. Hand over the 6-line receipt; wait for QA. Never edit a frozen snapshot.

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
atk queue --for FE
atk select-tests --files <changed>
atk gate fast --files <changed> --role FE
atk ownership map <path>
atk batch manifest --candidate <dir> --paths <changed> --packages <ID>
```

## Round budget

<= 12 rounds per task. At round 12 without the exit condition, stop and report.

## Proof ladder

Typecheck / CSS / offline checks are not test execution, and test execution is
not native acceptance. Report each rung separately; a mock is not native.
