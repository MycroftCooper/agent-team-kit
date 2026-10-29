# Board and DSH plugin

The board is a **derived view**. It reads `state.json`, `runtime.json`,
`human-todos.json` and `<artifactDir>/metrics.jsonl`, and never writes task state.
The only write any board UI performs is ticking a human-only todo.

## Three renderers, one source

| Renderer | Command | Output |
|---|---|---|
| Markdown | `atk state board` | configured `paths.board` (default `<flowDir>/board.md`) |
| Static HTML | `atk board` | configured `paths.boardHtml` (default `<flowDir>/board.html`) |
| Live HTML/SSE | `atk serve` | local HTTP server, file watch + SSE, polling fallback |
| DSH panel | `atk plugin sync` + install | same-origin route inside DeepSeek Harness |

Common options:

```bash
atk board --json        # full snapshot as JSON
atk board --compact     # agent view: id / stage / priority / owner
atk board --port 0      # pick a free port (serve)
atk serve               # live board, default port from board.port
```

The markdown board section order and column keys are defined by
`lib/labels.mjs`; changing language changes labels, not data.

## Reading the board

- **Batch slices** - the current batch's units of work and their exit conditions.
- **Status distribution / modules** - package counts by stage and module.
- **Human-only todos** - only the user ticks these; agents read them.
- **Active work packages** - the board of record for package-level state.
- **Linked sub-items** - tracked under their parent; not counted separately.
- **Completed archive** - separate section; archived items never count as active.

For an agent-sized read use `atk state board --compact` or `atk queue --for <ROLE>`
instead of reading `state.json` directly.

## Install the DeepSeek Harness plugin

```bash
atk plugin sync     # copy plugins/dsh-agent-board -> config.plugin.dir
atk plugin verify   # diff the project copy against the toolkit version
```

`config.plugin.dir` defaults to `tools/agent-board`. The sync writes the plugin
package plus a `cordis.patch.yml` snippet with this project's identity
(`plugin.id`, `route`, `title`, `tabKind`, `commandId`) and absolute workspace.

Then, in DSH:

1. **Plugins** -> **Add plugin** -> **Install a third-party plugin**.
2. Paste the absolute path of the plugin directory (the one containing the
   generated `package.json`).
3. Install and **Enable now**.
4. Merge the `insert:` block from `cordis.patch.yml` into
   `~/.dsh/profiles/<profile>/cordis.patch.yml`. Keep the `insert:` wrapper: a
   bare `id + name` is treated as an override of a missing row and silently
   skipped.
5. **Restart DeepSeek Harness.** The plugin tree and client bundle are composed at
   startup; data-only changes do not need a restart.

Verify the composition offline before restarting:

```bash
dsh --profile <tmp-profile> --dump-config | grep <plugin.id>
```

You should see the plugin row with no `not found` warning.

## Keep the board honest

- Do not hand-edit `board.md` / `board.html`; re-render with `atk state board` or
  `atk board`.
- Change state through commands: `atk evidence`, `atk state ...`, `atk batch ...`.
  After receipts land, `atk sync` runs import -> evidence -> board -> measure ->
  check.
- Never tick a human-only todo as an agent. If the UI asks for permission, that is
  the human's click.
- One plugin identity per project. `atk init` derives `<project>-board` from the
  project name; reusing one identity in two profiles makes the panels fight.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Panel missing from the sidebar | DSH was not restarted, or the `insert:` row was pasted without the wrapper. Re-check `cordis.patch.yml`, run `atk plugin verify`, restart. |
| Route returns `503` | `state.json` missing or unreadable. Check `layout.flowDir` / `paths.state` and run `atk state check`. |
| Board is stale in the browser | Static HTML does not update itself; use `atk serve` for SSE, or re-render. |
| Panel never updates | The DSH plugin watches files; verify the configured `flowDir` and that the process can read it. |
| Port in use | Change `board.port` in `agent-flow.config.json` or pass `--port 0` to `atk serve`. |
| Two panels appear | Duplicate `plugin.id` in the profile patch; keep one row. |
| `atk board` fails validation | Fix the state file first: `atk state check --strict`. |
| `atk plugin verify` says `outdated` | Re-run `atk plugin sync`, then restart DSH (the client bundle is rebuilt at startup). |

## Related

- [BOARD.md](BOARD.md) is this page; see [WORKFLOW.md](WORKFLOW.md) for how state
  is produced and [CONFIG.md](CONFIG.md) for `board.*` / `plugin.*` keys.
- The plugin's own selftests live in `plugins/dsh-agent-board/` and run without a
  DSH runtime.
