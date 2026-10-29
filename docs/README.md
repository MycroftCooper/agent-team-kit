# agent-team-kit docs

English is the primary language of this documentation; the key pages have a
Chinese summary under `*.zh-CN.md`.

| Page | What it covers | Read it when |
|---|---|---|
| [QUICKSTART.md](QUICKSTART.md) | 60-second setup, first ticket, board, plugin | first time |
| [ARCHITECTURE.md](ARCHITECTURE.md) | the four layers, module map, data flow | deciding whether to adopt it |
| [CONFIG.md](CONFIG.md) | every `agent-flow.config.json` key, with examples | customizing paths, gates, roles, plugin |
| [ROLES.md](ROLES.md) | defining roles and write scopes | adding FE/BE/QA or your own roles |
| [WORKFLOW.md](WORKFLOW.md) | ticket -> candidate -> freeze -> QA -> verify -> apply -> evidence -> archive | running a batch |
| [BOARD.md](BOARD.md) | markdown/HTML/SSE board and the DSH plugin | showing status or installing the panel |
| [MIGRATION.md](MIGRATION.md) | adopting an existing project with its own layout (worked example included) | moving a project onto the kit |
| [PUBLISHING.md](PUBLISHING.md) | npm publish checklist, files field, versioning, template repo | releasing the kit |
| [FAQ.md](FAQ.md) | short answers to recurring questions | something does not fit |
| [INTERNALS.md](INTERNALS.md) | the internal module / data / CLI contract (contributors) | changing the toolkit itself |

Chinese summaries: [QUICKSTART.zh-CN.md](QUICKSTART.zh-CN.md),
[ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md),
[WORKFLOW.zh-CN.md](WORKFLOW.zh-CN.md).

## The 30-second version

```bash
npm install --global agent-team-kit      # or: npx agent-team-kit ...
cd my-project
atk init --project my-app
atk board
```

`atk init` writes `agent-flow.config.json`, a flow directory (`.agent-flow/` by
default) with `state.json`, `ownership.json`, role cards and a command sheet, and
a copy of the DeepSeek Harness board plugin. Then a LEAD opens a batch, DEV/QA
work through tickets, and `state.json` is the only source of truth.

## Where to start as an agent

- Install the skills from [`../skills/`](../skills/README.md).
- In a project, read `<flowDir>/README.md`, `<flowDir>/current-batch.md` and your
  `<flowDir>/roles/<ROLE>.md`; then use `atk queue --for <ROLE>`.
