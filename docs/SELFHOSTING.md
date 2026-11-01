# Self-hosting the toolkit

The repository is also a project. The workflow is configured to develop
**agent-team-kit itself**, and the biggest risk in that setup is simple: a change
to the toolkit can break the toolkit, and then the pipeline that was supposed to
verify the change cannot run. This page is the isolation and recovery contract
that makes self-hosting safe.

## What "self-hosted" means here

- `agent-flow.config.json`, `.agent-flow/` and the role cards belong to this
  repository (committed), so a fresh checkout can run the workflow immediately.
- `gates.fast` checks the real repository paths; `gates.quick` runs the full
  suite; `gates.local` runs the suite plus the workflow integrity checks.
- The board/UI is developed with the same tickets, gates, evidence and
  permission rules that the toolkit sells.

Do **not** run `atk init --force` in this repository: it would regenerate the
workflow from the generic preset and overwrite the self-host configuration.

## Baseline

Before a risky batch, record a known-good point:

```bash
node scripts/selfhost.mjs status
node scripts/selfhost.mjs snapshot --label before-ui-batch
node scripts/selfhost.mjs tag selfhost-baseline-YYYY-MM-DD
```

- The git tag is the durable baseline (`git reset --hard <tag>`,
  `git switch -c rescue <tag>`, or `git restore --source=<tag> -- .`).
- The snapshot is the fast local recovery path for files that git does not
  protect between commits (`.agent-flow/state.json`, `runtime.json`, local
  configuration edits).

## Isolation model

| Layer | Mechanism |
|---|---|
| Source of truth | `main` checkout stays the known-good tree; risky work happens in a candidate. |
| Candidate work | `node scripts/selfhost.mjs prepare <TICKET>` creates an external git worktree under `../agent-team-kit-candidates/<TICKET>-<stamp>` (outside the original tree, so the `workspace-isolated` permission condition passes). |
| Freeze | From the main checkout: `atk batch manifest --candidate <candidate> ... --agent <id>`. |
| Review | An independent Agent Instance (`agent-qa-01`/`agent-qa-02`) or the human reviews the frozen manifest. |
| Apply | Only after `atk batch verify` passes; real writes also need a green gate report and QA evidence (`integration.merge.development`). |
| Cleanup | `node scripts/selfhost.mjs remove <TICKET>`; a broken candidate is deleted, never merged. |

The candidate is disposable. If a change in the candidate breaks the toolkit,
delete the worktree and start over; the main checkout is untouched.

## Snapshots and recovery

```bash
node scripts/selfhost.mjs snapshot --label <why>          # code + workflow
node scripts/selfhost.mjs restore latest                 # dry-run
node scripts/selfhost.mjs restore latest --apply         # restore + guard
node scripts/selfhost.mjs restore latest --code-only --apply
node scripts/selfhost.mjs restore latest --workflow-only --apply
```

A snapshot contains `bin/`, `lib/`, `scripts/`, `test/`, `package.json`,
`agent-flow.config.json`, the config schema and `.agent-flow/` (excluding
`.agent-flow/.backup/` and generated `board.html`). Restores are explicit:
without `--apply` nothing is written.

`scripts/selfhost.mjs` deliberately imports none of `lib/`, so it still runs when
a `lib/` change has broken `atk`.

## Health checks

```bash
node scripts/selfhost.mjs status    # git state, workflow JSON, atk health, gate report, backups
node scripts/selfhost.mjs guard     # exit 1 when the toolkit or its state is broken
node scripts/selfhost.mjs verify    # atk runs, state/ownership/permissions load
node scripts/selfhost.mjs verify --full   # + the full suite
```

`atk gate fast` is the change-scoped gate; `atk gate quick` runs the full suite;
`atk gate local` runs the suite plus workflow integrity. Every gate writes
`<artifactDir>/ci-fast-latest.json`, which `atk batch apply` and `atk release`
consume. A red or missing report blocks a real apply.

## Recovery runbook

| Symptom | Recovery |
|---|---|
| `atk` crashes / `node bin/atk.mjs --version` fails | `node scripts/selfhost.mjs restore latest --code-only --apply` |
| `agent-flow.config.json` invalid, every command refuses | `node scripts/selfhost.mjs restore latest --workflow-only --apply` |
| `state.json`/`ownership.json`/`runtime.json` corrupted | restore workflow, then `atk state check`; a snapshot is the fallback |
| `scripts/selfhost.mjs` itself broken | `git restore --source=<baseline-tag> -- scripts bin lib package.json` then re-run the guard |
| Gates red after a candidate apply | stop, inspect the receipt; do not retry the apply. Restore the baseline if the tree is inconsistent |
| Everything is broken | `git reset --hard <baseline-tag>` (committed work only) or restore the newest snapshot |

## Rules of engagement

1. **Never bypass a red gate or a permission denial** to make progress; a
   refused `apply` is a stop, not a retry.
2. **Security-relevant changes** (gates, permission matrix, role scopes) need a
   human approval and an independent review; do not let the same instance write
   and approve them.
3. **One writer per path.** `atk ownership check --role <ROLE> --files ...`
   before handing work back. The repo's roles are LEAD / DEV / QA; the mapping is
   in `.agent-flow/ownership.json`.
4. **Snapshot before** changing gate logic, the permission registry, the config
   loader or the batch/apply path.
5. **Candidates are disposable.** A candidate that breaks tests or gates is
   deleted (`node scripts/selfhost.mjs remove <TICKET>`), never merged "because
   it is almost right".
