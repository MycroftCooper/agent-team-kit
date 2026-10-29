# {{PROJECT}} workflow

> Flow directory: `{{FLOW_DIR}}` - language: `{{LANGUAGE}}`. Paths on this page are
> relative to it unless stated otherwise.

**Single entry point.** Read this page plus `current-batch.md` before taking work;
that is ~3k characters and enough to start.

**Do not read `state.json`** (it is large and machine-oriented). Use these three
commands instead:

```bash
atk task <ID> --for <ROLE> --message   # one ticket, ready to forward
atk queue --for <ROLE>                # my queue
atk state board --compact             # minimal board for agents
```

## Authority map

| What | Authoritative location | How to use it |
|---|---|---|
| Package / slice / archive state | `state.json` | scripts only; humans use commands |
| Write scopes | `ownership.json` | `atk ownership map <path>` |
| Acceptance receipts | `layout.evidenceDir` | `atk evidence` derives facts |
| Human view | `board.md` / `atk serve` / DSH panel | event-driven (SSE), do not poll |
| Current batch and decisions | `current-batch.md` | rolling, overwritten each batch |
| Command surface | `commands.md` | if a command is not there it is not part of the contract |
| Role contracts | `roles/<ROLE>.md` | read your own card before starting |
| Human-only todos | `human-todos.json` | only the user ticks these |

## Roles and write scopes

{{ROLES_TABLE}}

Single writer: `atk ownership check --role <ROLE>` turns the convention into an
enforced check. Two roles on one path is a configuration error, not a merge
conflict.

## One task's lifecycle

```
1 LEAD    open the slice in state.batch.slices, generate the ticket
2 LEAD    forward the ticket in one message (do not write a document)
3 DEV     create a candidate snapshot outside the original tree
4 DEV     freeze: atk batch manifest --candidate ... --packages <ID>
5 QA      qa-approval.json binds the frozen manifestSha256
6 QA      verify: atk batch verify --manifest ... --qa ...
7 BE/LEAD apply: dry-run first, then --apply --confirm-dev-closed
8 LEAD    derive: atk evidence (QA -> ready to apply, apply -> awaiting acceptance)
9 human   accept; LEAD writes humanAccepted, then atk state archive
```

Never advance when: the manifest is not frozen, QA is not bound, the original
tree drifted, the user has not confirmed dev is closed, or the batch carries
unverified slices.

## Gate layers

| Layer | Command | What it proves |
|---|---|---|
| Fast | `atk gate fast --files ... --role <ROLE>` | write scope + format / typecheck / selected tests |
| Full | `atk gate quick` | freeze is usable |
| Heavy | `atk gate local` | delivery candidate is usable |
| QA | targeted checks on the frozen snapshot | can be released |
| Human | dev machine / native run | can be archived |

## Proof ladder

`typecheck ok` is **not** `tests passed`, and `tests passed` is **not**
`human-accepted`. `skipped` is not a pass, `mock` is not native, an isolated
pass is not a combined pass. Report each rung separately; never collapse them.

## Token discipline

1. Tickets are generated, <= 200 words, 9 fixed lines. Never hand-write them.
2. Receipts are 6 lines: scope / commands / tests / blockers / snapshot / stop.
3. Over budget means stop and report: <= 12 rounds per task. Entry reading is
   this page and `current-batch.md` only.

## Archive and rotation

- `atk state archive <ID> --note "why"`: precondition
  `verification.humanAccepted === true`; records time, reason and evidence.
  `atk state import` will not resurrect archived packages.
- The board keeps an independent "completed archive" section; archived work is
  not mixed into the active board.
- Long-lived docs rotate with `atk docs rotate` (dry-run by default, concurrency
  guarded).

## Non-negotiables

The original tree is read-only for agents. Fresh verify before apply. QA is
independent. One writer per path. No production access, no packaging or
publishing without explicit user authorization. Never inflate evidence.
