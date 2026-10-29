# Command cheat sheet

> One page. If a command is not here, it is not part of the workflow contract.
> Every command accepts `--cwd <dir>` and `--config <file>`.

## State and tasks

| Command | What it does |
|---|---|
| `atk state check [--strict] [--verbose]` | Validate state.json: packages, slices, dependencies, owners, evidence |
| `atk state board` | Render the markdown board |
| `atk state board --compact` | Minimal view for agents (id / status / priority / owner) |
| `atk queue --for <ROLE> [--json]` | Tickets assigned to a role |
| `atk task <ID> --for <ROLE> [--message] [--json]` | One ticket, formatted for forwarding |
| `atk state import` | Import a markdown backlog table (`paths.todoSource`) |
| `atk state archive <ID> --note "why"` | Archive; refused unless `verification.humanAccepted === true` |
| `atk state restore <ID>` | Undo an archive |

## Evidence and gates

| Command | What it does |
|---|---|
| `atk evidence [--collect-temp] [--dry]` | Derive acceptance facts from receipts (idempotent) |
| `atk ownership check --role <ROLE> [--files a,b]` | Write-scope check |
| `atk ownership map <path>` | Which role owns this path |
| `atk ownership verify-config` | Ownership config self-check (overlap / gaps) |
| `atk select-tests [--files a,b] [--since-baseline]` | Turn changed files into a test plan |
| `atk gate fast [--files a,b] [--role <ROLE>] [--since-baseline]` | Change-scoped fast gate |
| `atk gate quick` / `atk gate local` | Full / heavy local gates |

## Batch and cache

| Command | What it does |
|---|---|
| `atk batch manifest --candidate <dir> --paths a,b --packages <ID>` | Freeze a candidate manifest |
| `atk batch verify --manifest <f> --qa <f>` | Check drift, candidate changes and QA binding |
| `atk batch apply --manifest <f> [--apply --confirm-dev-closed]` | Dry-run by default; writes only with both flags |
| `atk baseline start` / `atk baseline changed` | Change baseline that does not depend on git commits |
| `atk cache status` / `atk cache clean` | Inspect and clean shared build caches |
| `atk measure record` / `atk measure summary` | Record and summarise workflow measurements |
| `atk sync` | import -> evidence -> board in one command |
| `atk docs rotate [--apply] [--keep N]` | Rotate long-lived docs into an archive (dry-run by default) |

## Board and plugin

| Command | What it does |
|---|---|
| `atk board` | Render the static HTML board (`board.md` comes from `atk state board`) |
| `atk serve` | Serve the live board (file watch + SSE, fallback poll) |
| `atk plugin sync [--out <dir>]` | Copy the DeepSeek Harness board plugin into this project |
| `atk plugin verify` | Check the project copy against the toolkit version |

## Human-only todos

| Command | What it does |
|---|---|
| `atk todo` | List human todos |
| `atk todo add "text" [--note "why"]` | Add a human-only todo |
| `atk todo toggle\|done\|undone <ID>` | Tick / untick — **the user only** |
| `atk todo remove <ID>` | Remove a todo |

## First commands after init

```bash
atk board
atk queue --for {{ROLE}}
atk task <ID> --for {{ROLE}} --message
atk plugin sync
```
