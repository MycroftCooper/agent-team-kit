# Architecture

agent-team-kit is a **state machine with role contracts and evidence gates**,
plus a board that only renders. Four layers, each cheap to explain and cheap to
enforce:

```
                   +---------------------------------------+
 human  ---------> |  board  (markdown / HTML / SSE / DSH) |  read-only view
                   +---------------------------------------+
                                   ^ derives
                   +---------------------------------------+
                   |  evidence gates  (receipts, manifests) |  what counts as done
                   +---------------------------------------+
                                   ^ produce
                   +---------------------------------------+
 agents ---------> |  role contracts (ownership.json + cards) |  who may write what
                   +---------------------------------------+
                                   ^ coordinate
                   +---------------------------------------+
                   |  state machine (state.json + atk CLI)  |  what exists, in which stage
                   +---------------------------------------+
```

## 1. State machine — `state.json` + `atk`

`state.json` is the single source of truth: one `batch`, its `slices`, the active
`packages`, and `subitems`. Every command is a small, deterministic transition:

- query: `atk state check | board | queue | task`
- derive: `atk evidence` (receipt -> `qaPassed` / `applied`)
- apply: `atk batch manifest | verify | apply`
- archive: `atk state archive` (refused unless `verification.humanAccepted`)

The CLI never asks an LLM what the status is. If a receipt is missing, the state
is not advanced. `atk sync` chains import -> evidence -> board, so state and board
cannot drift apart after a batch.

## 2. Role contracts — `ownership.json` + role cards

- `roles` in `agent-flow.config.json` lists the identifiers.
- `ownership.json` maps **path prefixes** to roles (longest prefix wins, two roles
  on one path is a config error) and reserves root files.
- `roles/<ROLE>.md` is the human/agent contract: write scope, do-not-do list, task
  loop, receipt format, command list, round budget, proof ladder.

Enforcement is a command, not a review habit: `atk ownership check --role <ROLE>`
fails when a change escapes the role's scope. That is what turns "single writer"
from a social rule into a checkable one.

## 3. Evidence gates — receipts, manifests, approvals

"Done" is derived from artifacts, never from a chat message:

| Artifact | Produced by | Proves |
|---|---|---|
| candidate snapshot | executor | work exists outside the original tree |
| `manifest` + `manifestSha256` | `atk batch manifest` | an exact, frozen set of files and hashes |
| `qa-approval.json` | QA | that manifest hash was verified |
| apply receipt | `atk batch apply` | the frozen bytes landed in the original tree |
| `verification.humanAccepted` | LEAD, after the human accepts | the product is accepted |

`atk batch verify` refuses when the manifest is stale, the candidate changed, the
QA approval does not bind the current hash, or the original tree drifted.
`atk evidence` is idempotent and never invents facts: absent receipts stay absent.

## 4. Board — derived view

`atk state board` renders the configured `board.md`; `atk board` renders a
self-contained HTML board; `atk serve` adds file watching and SSE. The DSH plugin
(`atk plugin sync`) is a third renderer of the same `state.json` — it registers one
same-origin read-only route and never writes task state.

Because every renderer reads `state.json` directly, the board is never an input.
The only write the board interface may perform is ticking a **human-only** todo.

## Module map

| Layer | Modules |
|---|---|
| CLI / context | `bin/atk.mjs`, `lib/dispatch.mjs`, `lib/context.mjs` |
| Config / labels | `lib/config.mjs`, `lib/labels.mjs`, `lib/util.mjs` |
| State machine | `lib/state.mjs`, `lib/human-todos.mjs`, `lib/evidence.mjs` |
| Batch / gates | `lib/batch.mjs`, `lib/gate.mjs`, `lib/select-tests.mjs`, `lib/baseline.mjs`, `lib/ownership.mjs` |
| Board / plugin | `lib/board.mjs`, `lib/plugin.mjs`, `plugins/dsh-agent-board/` |
| Scaffolding | `lib/init.mjs`, `presets/`, `templates/flow/` |

`templates/flow/` is the canonical content of everything `atk init` writes;
`presets/` holds the starting configurations. A consuming project never imports
the toolkit's source for normal operation — it calls the CLI.

## Design constraints

- **Zero third-party dependencies**, Node >= 20.11, ESM. The toolkit must run from
  a bare `node` inside any project.
- **No hard-coded project knowledge.** Paths come from config; roles from config;
  labels from `lib/labels.mjs`.
- **Deterministic output.** Sorted collections, JSON on stdout for `--json`,
  short human output otherwise.
- **Exit codes**: `0` ok, `1` check/gate failed or refusal, `2` usage error,
  `3` concurrency/drift refusal.

The precise module contract (fields, data formats, command surface) lives in
[INTERNALS.md](INTERNALS.md) and is what the test suite enforces.
