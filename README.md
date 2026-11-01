# agent-team-kit

[![ci](https://github.com/MycroftCooper/agent-team-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MycroftCooper/agent-team-kit/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](package.json)

A reusable multi-agent delivery workflow: a state-machine CLI (`atk`), role
contracts with enforceable write scopes, evidence gates that refuse to advance on
missing receipts, and a kanban board with a DeepSeek Harness plugin.

> **2.0 本地系统（v1.0 candidate，Mock 运行时）**：仓库里已有 Backend + Scheduler
> + Runtime Host + Web 工作台（`apps/*` 与 `packages/*`），一条命令启动：
> `node apps/launcher/cli.mjs start --port 1421`，浏览器打开
> `http://127.0.0.1:1421/`。能力、边界与门禁清单见
> [docs/V1-READINESS.md](docs/V1-READINESS.md)。
>
> 里程碑回执：[M0](docs/roadmap/m0-status.md) · [M1](docs/roadmap/m1-status.md) ·
> [M2](docs/roadmap/m2-status.md) · [M3](docs/roadmap/m3-status.md) ·
> [M4](docs/roadmap/m4-status.md) · [M5](docs/roadmap/m5-status.md) ·
> [M6](docs/roadmap/m6-status.md)；独立 QA 报告在
> `docs/architecture/qa-review-m{0..6}.md`。
>
> 门禁（HEAD 实测，全部必须绿）：
> `node scripts/test.mjs` · `node scripts/test-workspace.mjs` ·
> `node scripts/check-boundaries.mjs` · `node scripts/m1-smoke.mjs` …
> `node scripts/m6-smoke.mjs`。
>
> **旧的 0.x CLI（本 README 余下部分）在 2.0 里退化为只读兼容层**（ADR-006
> Phase C）：它的写命令会以 `READ_ONLY_MODE` 拒绝，读操作走 SQLite 投影；需要
> JSON 时用 `atk-backend export`。启动 2.0 系统后不要再用旧 CLI 写 `state.json`。

- **Zero dependencies.** Node.js >= 20.11 built-ins only, ESM, runs from a bare
  `node` inside any project.
- **Config-driven.** Paths, roles, gates and the board plugin identity come from
  `agent-flow.config.json`; no project knowledge is hard-coded.
- **Agent-friendly.** 9-line tickets, 6-line receipts, a queue command per role,
  a compact board view and three installable skills.
- **Enforced independence.** Roles declare Functions (`ORCHESTRATOR` / `WORKER` /
  `REVIEWER`); Agent Instances carry ids and capabilities; the scheduler refuses
  a review from the instance that produced the manifest. See
  [docs/ENTITIES.md](docs/ENTITIES.md).
- **Deny-by-default permissions.** A subject x operation registry (`HUMAN`, the
  three Functions and the trusted `SYSTEM` layer) decides every sensitive
  action; `atk permit check` returns machine-readable reason codes, and every
  decision is appended to an audit trail. See
  [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

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
| `atk permit matrix\|check\|explain\|audit` | deny-by-default permission decisions and audit |
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
- [Entities and Functions](docs/ENTITIES.md) · [中文摘要](docs/ENTITIES.zh-CN.md)
- [Permissions](docs/PERMISSIONS.md) · [中文摘要](docs/PERMISSIONS.zh-CN.md)
- [Self-hosting](docs/SELFHOSTING.md) · [中文摘要](docs/SELFHOSTING.zh-CN.md)
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
npm test          # node scripts/test.mjs (works on Node 20 / Windows / POSIX)
npm run selftest  # tests + board plugin selftests
```

## License

MIT. See [LICENSE](LICENSE).
