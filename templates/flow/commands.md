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
| `atk task <ID> --for <ROLE> [--agent <id>] [--function <NAME>] [--message] [--json]` | One ticket, formatted for forwarding |
| `atk state import` | Import a markdown backlog table (`paths.todoSource`) |
| `atk state archive <ID> --note "why"` | Archive; refused unless `verification.humanAccepted === true` |
| `atk state restore <ID>` | Undo an archive |

## Functions and separation of duties

| Rule | Command / file |
|---|---|
| A review ticket needs the reviewer instance | `atk task <ID> --for QA --agent <id>` |
| The scheduler refuses self-review | task owned by the reviewing Role, or produced by that instance |
| The manifest records the producing Run | `atk batch manifest ... --agent <id>` |
| The approval records the reviewing Run | `qa-approval.json` → signed `kind: "qa-approval"` receipt |
| Verify refuses a self-review | `atk batch verify --manifest <f> --qa <f>` (`no-self-review`, `reviewer-identity`, ...) |
| Controlled integration needs a QA receipt | `atk batch verify --require-qa` / `atk batch apply` exit `1` without a valid signed `qa-approval.json`; omitting `--qa` is diagnostic only (`status: SKIPPED`) |

## Evidence and gates

| Command | What it does |
|---|---|
| `atk evidence [--collect-temp] [--dry] [--legacy-receipts]` | Derive acceptance facts from receipts (idempotent); invalid receipts are reported in `rejected` |
| `atk ownership check --role <ROLE> [--files a,b] [--strict]` | Write-scope check (`--strict` = fail closed: role required, unmapped blocks) |
| `atk ownership map <path>` | Which role owns this path |
| `atk ownership verify-config` | Ownership config self-check (overlap / gaps) |
| `atk select-tests [--files a,b] [--since-baseline]` | Turn changed files into a test plan |
| `atk gate fast [--files a,b] [--role <ROLE>] [--since-baseline]` | Change-scoped fast gate |
| `atk gate quick` / `atk gate local` | Full / heavy local gates |

Every gate reports `PASS` / `FAIL` / `SKIPPED` / `UNCONFIGURED` / `ERROR`; only
`PASS` satisfies a gate, and `atk release` accepts only an explicit `PASS`
report.

## Permissions

| Command | What it does |
|---|---|
| `atk permit check <operation> [--subject S\|--agent id] [--task ID] [--files a,b]` | Decision with a machine-readable reason code; appends to the audit |
| `atk permit matrix [--group G] [--json]` | The subject x operation matrix (A / C / N) |
| `atk permit explain <operation>` | Cell conditions and reason codes |
| `atk permit audit [--tail N]` | Append-only decision trail |

## Batch and cache

| Command | What it does |
|---|---|
| `atk batch manifest --candidate <dir> --paths a,b --packages <ID> --agent <id> [--contributors a,b]` | Freeze a candidate manifest and record the producing Run |
| `atk batch verify --manifest <f> [--qa <f>] [--require-qa] [--legacy-receipts]` | Check drift, candidate changes, QA receipt binding and reviewer independence; no `--qa` is diagnostic only (`status: SKIPPED`, never PASS) |
| `atk batch apply --manifest <f> [--qa <f>] [--apply --confirm-dev-closed]` | Dry-run by default (a valid QA receipt is required even for the plan); writes only with both flags |
| `atk baseline start` / `atk baseline changed` | Change baseline that does not depend on git commits |
| `atk release --version <semver> [--note] [--apply]` | Merge development -> release with --no-ff and tag it (dry-run by default; checks branch/worktree/version/gate) |
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
