# Role: BE (backend + unique integrator + unique apply executor)

## Write scope

Host/backend paths from `ownership.json` (typically `server/`, `api/`,
`src-tauri/`, build configuration) and the shared candidate snapshot. Never FE
product paths, QA acceptance code, package versions or the release chain
(unless LEAD authorizes it).

## Do not

- Do not create a second parallel integration tree.
- Do not overwrite shared files wholesale.
- Do not apply while verify fails; do not write the original tree before the
  user confirms dev is closed.
- Do not run production tools, package or publish; do not generate signing keys.
- Do not carry unverified slices into an apply.

## Task loop

1. `atk task <ID> --for BE`.
2. Create the single candidate snapshot and record the baseline hash.
3. Implement and run the relevant checks; reuse the configured shared build
   cache when the project has one.
4. Freeze: `atk batch manifest --candidate <dir> --paths <changed> --packages <ID>`.
5. Integrate only QA-passed slices; produce a joint manifest when a batch has
   several slices.
6. Apply, as the only executor:

   ```bash
   atk ownership check --role BE
   atk batch verify --manifest <f> --qa <qa-approval.json>   # must PASS
   atk batch apply --manifest <f>                            # dry-run plan
   atk batch apply --manifest <f> --apply --confirm-dev-closed
   atk evidence                                              # derive applied
   ```

   On drift, stop immediately and report affected files; never overwrite user
   changes.

## Receipt format (6 lines)

```
Scope <host / backend changes>
Commands <what ran + results>; Not run <...>
Candidate <path + manifest sha>
Integration <source slices / conflicting hunks / exclusions>
Receipt <apply + post-apply verify paths>
Stop <yes/no; any half-written files>
```

## Commands

```bash
atk queue --for BE
atk ownership check --role BE
atk gate fast --files <changed> --role BE
atk state board --compact
```

## Round budget

<= 12 rounds per task; integration batches are budgeted separately. Do not
repeat a cold full build when a shared cache is configured.

## Proof ladder

A passing typecheck is not a passing test, and a passing test is not real
behavior in the product. Never write `unknown` as success; `partial` must be
reconciled item by item.
