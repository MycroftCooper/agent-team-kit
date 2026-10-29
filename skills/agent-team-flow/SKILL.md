---
name: agent-team-flow
description: Participate in an agent-team-kit delivery workflow as LEAD, DEV, FE, BE or QA. Use when a project has agent-flow.config.json (or .agent-flow/config.json) and work is tracked through the atk CLI. Covers pulling tickets from the queue, write scopes, gates, the 6-line receipt and the proof ladder.
---

# Agent team flow

You are one role in a single-writer, evidence-gated workflow. The CLI (`atk`) owns
state; you work through tickets and receipts.

## Before you start

1. Run `atk state check` from the project root. If the config is missing, stop and
   ask the human to run `atk init` (or `npx agent-team-kit init`).
2. Read `<flowDir>/README.md` and `<flowDir>/current-batch.md`. Do **not** open
   `state.json`; query it with commands instead.
3. Read your role card: `<flowDir>/roles/<ROLE>.md`.

## Ground rules

- **One writer per path.** `ownership.json` is the truth; check it before editing.
- **Never edit the original tree.** Work in a candidate snapshot; only the
  designated integrator applies.
- **Never self-approve.** QA accepts frozen snapshots; the human accepts the
  product. A passing typecheck is not a passing test is not human acceptance.
- **Human-only todos stay human.** Read and add with `atk todo`, never tick.
- **State is derived, not narrated.** Run `atk evidence`; do not hand-edit
  `state.json`, `board.md` or `board.html`.

## Pull work

```bash
atk queue --for <ROLE>                   # my queue
atk task <ID> --for <ROLE> --message     # one ticket, ready to forward/execute
atk ownership map <path>                 # who owns this path
```

Start only when the ticket's `Depends on` line is satisfied. If a dependency is
missing, report it instead of guessing.

## Respect write scope

```bash
atk ownership check --role <ROLE> --files a.ts,b.tsx
```

If a needed file is outside your scope, message LEAD with the exact path and the
reason; do not edit it "just this once".

## Run the gates

```bash
atk select-tests --files <changed>           # plan
atk gate fast --files <changed> --role <ROLE>
atk gate quick                                # when the ticket says freeze/full
atk gate local                                # only when the ticket requires it
```

Report exactly what ran. `skipped` is not a pass; a gate you did not run is not a
gate that passed.

## Freeze and hand off

```bash
atk batch manifest --candidate <dir> --paths <changed> --packages <ID>
atk batch verify --manifest <f> --qa <f>   # QA / integrator side
```

Keep the candidate frozen after freezing. QA verifies the manifest hash, not your
working copy.

## Receipt format (6 lines, nothing else)

```
Scope <files changed, count>
Commands <what ran + results>; Not run <...>
Tests <mock count / typecheck / failures>
Blockers <none | specific>
Snapshot <candidate path + manifest sha>
Stop <yes/no; any half-written files>
```

## Proof ladder

`typecheck ok` is not `tests passed`, and `tests passed` is not
`human-accepted`. Keep the rungs separate in the receipt and in chat. Never write
`unknown` as success.

## Stop conditions

Stop and report (do not improvise) when: the round budget is exhausted
(<= 12 rounds per task, <= 10 for a QA slice), a gate fails in a way the ticket
does not authorize fixing, the original tree drifts, a dependency is missing, or
you are about to write outside your scope.

## Checklist before you report

- [ ] Changes are inside my write scope and only in ticket hunks.
- [ ] I ran the named gates and recorded exact commands + results.
- [ ] I did not tick a human-only todo or mark my own work accepted.
- [ ] Receipt is exactly 6 lines.
- [ ] No half-written files; the candidate is frozen or clearly described.
