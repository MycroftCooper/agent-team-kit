---
name: agent-team-board
description: Render, serve and install the agent-team-kit board. Use when asked to show the workflow board, start the live board, install or refresh the DeepSeek Harness board plugin, or debug a stale/missing board. Requires the atk CLI and an agent-flow.config.json in the project.
---

# Agent team board

The board is always **derived** from `state.json`; never treat it as input.

## Render it

```bash
atk state board          # markdown board at the configured paths.board
atk board                # static HTML board at paths.boardHtml
atk board --json         # machine snapshot (same data, no files)
```

Open `board.md` for a quick text view. The HTML file works offline (checkbox
state is local only, it does not write `human-todos.json`).

## Serve it live

```bash
atk serve
```

- Watches the configured state/runtime/human-todo files and pushes updates over
  SSE; falls back to polling (`board.fallbackPollMs`) when SSE is unavailable.
- Listens on `board.port` from `agent-flow.config.json`; change the port there if
  it is busy.
- Stop it with Ctrl+C. It does not modify workflow state.

## Install the DeepSeek Harness plugin

```bash
atk plugin sync      # copies the bundled plugin into config.plugin.dir
atk plugin verify    # checks the project copy against the toolkit version
```

Then, in the DSH GUI:

1. Open **Plugins** -> **Add plugin** -> **Install a third-party plugin**.
2. Paste the absolute path of `config.plugin.dir` (the directory containing the
   generated `package.json` and `cordis.patch.yml`).
3. Install, then **Enable now**.
4. Merge the `insert:` block from `cordis.patch.yml` into
   `~/.dsh/profiles/<profile>/cordis.patch.yml`. The `insert:` wrapper is
   required: without it DSH treats the row as an override of a missing entry and
   silently skips it.
5. **Restart DeepSeek Harness.** The plugin tree and client bundle are composed
   at startup; adding data-only changes does not need a restart.

Each project must use a distinct `plugin.id` / `plugin.route`. `atk init` derives
them from the project name; do not reuse one identity for two projects.

## Read the board correctly

- Prefer `atk state board --compact` for an agent-sized view.
- The board shows: active packages, batch slices, human-only todos, and a
  separate completed-archive section. Archived items never count as active work.
- If the board looks stale, the state is stale: check `atk state check`, then
  `atk evidence` / `atk sync`.

## Keep state honest

- Never hand-edit `board.md` or `board.html`; they are overwritten.
- Change `state.json` only through commands (`atk evidence`, `atk state ...`,
  `atk batch ...`). Only LEAD writes `humanAccepted` and `blocked` / `paused`.
- Human-only todos: agents may list and add (`atk todo add`), never tick.
- After QA/apply receipts land: `atk evidence`, then `atk board` (or `atk sync`,
  which does import -> evidence -> board).

## Troubleshooting

| Symptom | Check |
|---|---|
| Plugin missing from the sidebar | Restart DSH; confirm the `insert:` row in `cordis.patch.yml`; re-run `atk plugin verify` |
| Board route returns 503 | `state.json` missing or unreadable; check `layout.flowDir` / `paths.state` |
| Board does not update | Use `atk serve` (SSE) or refresh the static HTML; the plugin reads files, not the markdown |
| Port already in use | Change `board.port` in `agent-flow.config.json` |
| Two projects fight over the plugin | Give each project its own `plugin.id`, `plugin.route`, `plugin.tabKind` |
| `atk board` fails validation | Fix `state.json` first: `atk state check --strict` |
