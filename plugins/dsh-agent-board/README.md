# __PLUGIN_PACKAGE__

A DeepSeek Harness (DSH) host plugin for the **agent-team-kit** board. It adds a
same-origin kanban tab to the Web GUI and an HTML page that show the task state
(`state.json`), the agents' live status (`runtime.json`), human-only todos
(`human-todos.json`) and artifact metrics (`<artifactDir>/metrics.jsonl`).

- Read-only on task state: the only write the plugin performs is the human-todo
  tick the user clicks in the panel.
- Self-contained: it never imports the `atk` CLI and only reads files inside its
  configured workspace.
- Data-driven: the host pushes an SSE frame when a data file changes; the page
  falls back to a poll only if `EventSource` is unavailable.
- Localized: labels follow `language` in the plugin config, or
  `agent-flow.config.json` when the plugin config omits it.

## Install (DSH Plugins page, no app rebuild)

1. Copy this plugin directory into the project, for example with
   `atk plugin sync`. The project's `plugin.dir` decides the target
   (default `tools/agent-board`). Copy the **whole directory**, not just the
   JS files: `package.json`, `cordis.patch.yml`, `lib/` and this README.
2. Open **Plugins** in the DSH sidebar.
3. Choose **Install a third-party plugin**.
4. Paste the absolute path of the copied project directory (for example
   `D:\path\to\project\tools\agent-board`) and click **Install**.
5. Click **Enable now**.
6. Merge the `insert:` block from `cordis.patch.yml` into the active DSH profile
   patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`). `atk plugin sync`
   already writes the correct `workspace` / `flowDir` / `artifactDir` /
   `language` values there.
7. **Restart DeepSeek Harness.** The plugin tree and the client bundle are
   composed at startup, so a newly installed or replaced plugin is invisible
   until the process restarts. Editing only the data files does not require a
   restart.

> ## Warning: bundle patches must use `insert:`
>
> The bundle layer is a **patch list**, so a new row must be wrapped in
> `insert:`:
>
> ```yaml
> - insert:
>     - id: agent-board
>       name: dsh-agent-board
>       config:
>         workspace: D:/path/to/project
>         flowDir: .agent-flow
>         artifactDir: artifacts/agent-flow
>         language: en
> ```
>
> Writing `id` + `name` at the top level is interpreted as an override of an
> existing row. DSH then reports
> `patch: entry "agent-board" not found` and **silently skips the plugin** -
> which is why a correctly installed package can still be missing from the
> sidebar.

## Configure

The plugin accepts four config keys. All are optional: anything missing falls
back to `<workspace>/agent-flow.config.json`, so a project scaffolded by
`atk init` works without any extra configuration.

| key | fallback |
|---|---|
| `workspace` | the project root written by `atk plugin sync` |
| `flowDir` | `layout.flowDir` in `agent-flow.config.json` (default `.agent-flow`) |
| `artifactDir` | `layout.artifactDir` (default `artifacts/agent-flow`) |
| `language` | `language` in `agent-flow.config.json` (`en` / `zh-CN`) |

`paths.*` overrides in `agent-flow.config.json` (`state`, `runtime`,
`humanTodos`) take precedence over the `flowDir` defaults.

If `state.json` is missing the plugin answers with **503** and a readable
reason naming the file it expected, instead of crashing or serving an empty
board.

## Routes

| method | path | response |
|---|---|---|
| `GET` | `__PLUGIN_ROUTE__` | board page (also `__PLUGIN_ROUTE__/`) |
| `GET` | `__PLUGIN_ROUTE__/api/snapshot` | snapshot JSON, `cache-control: no-store` |
| `GET` | `__PLUGIN_ROUTE__/api/events` | SSE: one frame per data change |
| `POST` | `__PLUGIN_ROUTE__/api/human-todos/toggle` | `{ id }` -> tick that human todo |
| other methods | any registered path | `405` with `allow` |
| other sub-paths | - | `404` |
| missing `state.json` | snapshot route | `503` + reason |

The host registers a **prefix** route plus the **exact** page route. The prefix
must not carry a trailing slash: the web server uses `${prefix}/` as its
boundary, so a trailing slash would stop `__PLUGIN_ROUTE__/api/*` from matching.

## Open the panel

After the restart, the board is a native tab in the right sidebar:

1. The **+** control at the end of the right tab strip opens the guide page.
2. Pick the board entry; the tab stays in the sidebar afterwards.
3. Alternatively open `http://127.0.0.1:<dsh-port>__PLUGIN_ROUTE__` in a
   browser. The page refreshes itself; a change to a data file pushes one SSE
   frame, and polling is only a fallback when `EventSource` is unavailable.

## Selftests (no DSH runtime required)

The two selftests are standalone and runnable with a bare `node` from inside
the toolkit repository. They substitute the `__PLUGIN_*__` / `__PROJECT_*__`
identity tokens with the generic defaults (`agent-board`, `/agent-board`,
`Agent Board`, `agentBoard`, `agent-board.open`) before loading the files.

```powershell
node plugins/dsh-agent-board/selftest.mjs          # host: routes, snapshot, config fallback, boundaries
node plugins/dsh-agent-board/selftest-client.mjs   # client: ModuleLoader, slots, BoardView
```

`selftest.mjs` builds a throwaway workspace with an `agent-flow.config.json`, a
two-slice `state.json`, `runtime.json`, `human-todos.json` and
`metrics.jsonl`, then asserts the snapshot, the routes, the 404/405/503
behaviour and that a toggle changes **only** `human-todos.json`.
`selftest-client.mjs` loads the real `lib/client.js` through a fake
`window.__ModuleLoader__` and a fake `require`; when the surrounding project
ships React it also renders `BoardView` with `react-dom/server`, otherwise it
checks the element tree structurally.

## Known boundaries

- The panel is a right-sidebar tab (`sidebarRightTabs` + `sidebar.right.pane.tab`);
  its data comes from the same-origin `__PLUGIN_ROUTE__/api/snapshot`.
- If the tab is missing after a restart, check the Plugins diagnostics first;
  the common cause is that `dsh.client.inject` points at
  `@deepseek-ai/dsh-client-ui-sidebar-right`, which is not enabled.
- The plugin never changes task state: maintain `state.json` through the `atk`
  CLI and only tick human todos from the board.
