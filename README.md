# agent-team-kit

A reusable multi-agent delivery workflow: a state-machine CLI (`atk`), role
contracts with enforceable write scopes, evidence gates that refuse to advance on
missing receipts, and a kanban board with a DeepSeek Harness plugin.

- **Zero dependencies.** Node.js >= 20.11 built-ins only, ESM, runs from a bare
  `node` inside any project.
- **Config-driven.** Paths, roles, gates and the board plugin identity come from
  `agent-flow.config.json`; no project knowledge is hard-coded.
- **Agent-friendly.** 9-line tickets, 6-line receipts, a queue command per role,
  a compact board view and two installable skills.

## 60-second quickstart

```bash
npm install --global agent-team-kit      # or: npx agent-team-kit <cmd>
cd my-project
atk init --project my-app                # config + flow dir + board plugin copy
atk board                                # render the board
atk state check                          # validate state.json
```

Then, as an agent:

```bash
atk queue --for DEV
atk task <ID> --for DEV --message        # the ticket to execute
atk gate fast --files <changed> --role DEV
atk evidence                             # derive qaPassed / applied
```

Useful `init` flags: `--preset generic|p4deck`, `--roles LEAD,DEV,QA`,
`--language en|zh-CN`, `--flow-dir <dir>`, `--force`, `--dry-run`,
`--no-plugin`, `--json`.

## The four layers

```
                 +---------------------------------------+
 human  -------> |  board  (markdown / HTML / SSE / DSH) |  read-only view
                 +---------------------------------------+
                                  ^ derived
                 +---------------------------------------+
                 |  evidence gates  (receipts, manifests) |  what counts as done
                 +---------------------------------------+
                                  ^ produced
                 +---------------------------------------+
 agents -------> |  role contracts  (ownership.json + cards) |  who may write what
                 +---------------------------------------+
                                  ^ coordinated
                 +---------------------------------------+
                 |  state machine  (state.json + atk CLI) |  what exists, at which stage
                 +---------------------------------------+
```

1. **State machine** — `state.json` is the single source of truth; every `atk`
   command is a small deterministic transition or query. Nothing is derived from
   chat messages.
2. **Role contracts** — `ownership.json` maps path prefixes to roles (longest
   prefix wins, one role per path) and `atk ownership check` enforces it. Every
   role gets a card: write scope, do-not list, task loop, 6-line receipt,
   commands, round budget, proof ladder.
3. **Evidence gates** — candidate snapshot -> frozen manifest (`manifestSha256`)
   -> QA approval bound to that hash -> verify -> apply receipt -> `atk evidence`.
   Archived work requires `verification.humanAccepted === true`.
4. **Board** — markdown, static HTML, live SSE server and a DSH sidebar panel all
   render the same `state.json`; the board is never an input.

Read more in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

| Command | Purpose |
|---|---|
| `atk init` | scaffold the workflow into a project (or adopt an existing layout) |
| `atk state check\|board\|queue\|task\|import\|archive\|restore` | state machine |
| `atk board [--json\|--compact]` | render the HTML board |
| `atk serve` | live board (file watch + SSE, polling fallback) |
| `atk evidence [--collect-temp\|--dry]` | derive acceptance facts from receipts |
| `atk ownership map\|check\|verify-config` | write-scope checks |
| `atk batch manifest\|verify\|apply` | freeze / verify / apply a candidate batch |
| `atk baseline start\|changed` | change baseline that does not need git commits |
| `atk cache status\|clean` | inspect and clean shared build caches |
| `atk gate fast\|quick\|local` | config-driven gates |
| `atk select-tests` | turn changed files into a test plan |
| `atk todo list\|add\|toggle\|done\|undone\|remove` | human-only todos |
| `atk measure record\|summary` | workflow measurements |
| `atk sync` | import -> evidence -> board in one command |
| `atk docs rotate` | rotate long-lived docs (dry-run by default) |
| `atk plugin sync\|verify` | install / verify the DSH board plugin copy |

Aliases: `atk task`, `atk queue`, `atk check`, `atk import`, `atk archive`,
`atk restore`, `atk tests`. Every command accepts `--cwd <dir> --config <file>`.

## Board and DeepSeek Harness

`atk init` copies the board plugin unless `--no-plugin`. Install
`config.plugin.dir` through the DSH **Plugins** page, merge the generated
`cordis.patch.yml` `insert:` block into your profile patch, and restart DSH — the
plugin tree and client bundle are composed at startup. See
[docs/BOARD.md](docs/BOARD.md) for routing, SSE behaviour and troubleshooting.

## Skills for agents

[`skills/agent-team-flow`](skills/agent-team-flow/SKILL.md) teaches an agent to
pull tickets, respect write scopes, run gates and report the 6-line receipt.
[`skills/agent-team-board`](skills/agent-team-board/SKILL.md) covers rendering,
serving, installing the plugin and keeping state honest.
[`skills/agent-team-roles`](skills/agent-team-roles/SKILL.md) reshapes the team
itself: add, remove, rename or re-scope roles so they match the project, without
re-running `atk init`. Install instructions: [skills/README.md](skills/README.md).

## Demo

[`examples/minimal/`](examples/minimal/README.md) is a tiny committed project you
can render directly:

```bash
node bin/atk.mjs --cwd examples/minimal board
```

## Docs

- [Quickstart](docs/QUICKSTART.md) · [中文摘要](docs/QUICKSTART.zh-CN.md)
- [Architecture](docs/ARCHITECTURE.md) · [中文摘要](docs/ARCHITECTURE.zh-CN.md)
- [Configuration](docs/CONFIG.md)
- [Roles and write scopes](docs/ROLES.md)
- [Workflow](docs/WORKFLOW.md) · [中文摘要](docs/WORKFLOW.zh-CN.md)
- [Board and plugin](docs/BOARD.md)
- [Migration](docs/MIGRATION.md)
- [Publishing](docs/PUBLISHING.md)
- [FAQ](docs/FAQ.md)
- [Internals / module contract](docs/INTERNALS.md)

## Requirements

Node.js >= 20.11. No runtime dependencies. The test suite uses the built-in
`node --test` runner:

```bash
npm test          # node --test "test/*.test.mjs"
npm run selftest  # tests + board plugin selftests
```

## License

MIT. See [LICENSE](LICENSE).
