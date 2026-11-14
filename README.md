# Agent Team Kit

A local web workspace for coordinating external agents across multiple projects.

**2.0.0-alpha.1** is a breaking rebuild: no legacy task import, software plugins,
model adapters, model gateway, automatic agent launch, or worktrees.

## Run

**Windows x64 desktop development: double-click `dev.bat`.** It opens the ATK
desktop window directly. The first launch downloads workspace dependencies and
Electron using portable tools kept under `artifacts/desktop-dev/`; it needs an
internet connection, but no system Node.js installation or prebuilt web UI.

React and CSS changes use Vite hot updates. Saving backend source, bundled resources, or a
shared backend package reloads the backend without refreshing the window. Reload waits until
tasks and automations are idle, including runs awaiting stop confirmation. Relaunch manually
after changing Electron's main process or startup configuration. Closing the development window
stops the backend, so stop active agents before restarting. The app uses the
existing data directory configuration and Agent API (default `127.0.0.1:1421`).
Stop any existing service using the same port or data directory first. Override
the Agent and Vite ports with `ATK_PORT` and `ATK_DEV_PORT`, respectively. This is
a development launcher; installers and macOS are outside this prototype.

Switch or add workspaces in the custom title bar, and drag its empty area to move
the desktop window. Its controls minimize, maximize or restore, and close it.
The bottom bar shows sync status on the left and language and theme controls on the right.
**Settings & operations → Appearance** also offers **Follow system**.

### Existing web launcher

Use Node.js 24. The release package contains the built web application and has
no production dependencies. It installs outside the projects it manages.

On Windows, double-click **start.bat** to start the service and open the unlocked
web UI in your default browser. Repeated starts reuse the running service.
**stop.bat** stops it; closing the browser leaves it running. Desktop shortcuts
to either file work too. A source checkout needs the initial install and web build.

An optional, Git-ignored `atk.local.json` beside the batch files can set
`{"dataDir":"E:/AgentTeamKitData"}`. Relative paths resolve from that directory.
Explicit `--data` and `ATK_DATA_DIR` take precedence; without configuration the
standard application data directory is used.

After a release has been published to npm (a GitHub source push does not publish it):

```sh
npm install -g agent-team-kit@next
atk start
# Open the private browserUrl printed by start (keep its access fragment private)
atk status
atk stop
```

For this source checkout:

```sh
corepack pnpm install --frozen-lockfile
node scripts/build-web.mjs
node apps/launcher/cli.mjs start
# To build/install your own independent release:
npm pack
npm install -g ./agent-team-kit-2.0.0-alpha.1.tgz
```

The new database defaults to `%LOCALAPPDATA%/AgentTeamKit/Next` on Windows.
Use `--data <directory>` to isolate an installation. Existing databases are not
loaded or upgraded. Register projects in the web UI; Git is optional.

## Workflow

1. Create a request. It appears in **Work → Tasks** in the **Draft** column.
2. An external ORCHESTRATOR claims the planning stage and submits a versioned plan.
3. Approve that plan in the browser. WORKER tasks become eligible for claiming.
4. External agents claim authorized tasks, obtain cooperative file locks, renew
   leases and return structured evidence. Model access stays with those agents.
5. Optional independent REVIEWERs verify frozen candidates. Human tasks appear
   in My inbox. VERIFIED tasks unlock dependencies without individual approval.
6. Accept the final plan in the browser, bound to a checked output manifest.

Agents edit the registered project directly. Locks are released after stopped
execution and durable results, **before** review and final acceptance. A changed
candidate invalidates pending review/acceptance; expired leases quarantine locks
until the previous writer is confirmed stopped. Nothing automatically resets or
discards project edits.

## Agent connection

Every agent identity is owned by one project, with its own credential. Choose the
workspace before creating identities. Sharing a role template does not share an
identity between projects. Unbound legacy identities can be assigned a project
in Settings after unresolved runs have stopped.

**Work → Collaboration** shows project agents, current runs and observed task
transitions. Task names across Work open the same collapsible right drawer,
preserving the underlying page and filters. See
[Project agents and collaboration](docs/COLLABORATION.md).

Workflow boards and swimlanes support drag handles and **Move to…** for the five
human operations: start/complete human work, requeue stopped blocked work, approve
a submitted plan and accept a whole requirement. Required forms and confirmation
panels remain in place; agent delivery and review still advance through real
receipts. See [Task board movement](docs/TASK-BOARD-DRAG-DESIGN.md).

In **Work → Bugs**, report a bug and choose a worker role from the workspace's squad.
The bug goes straight to that role's queue. After a worker submits a fix, accept it in
**My inbox** or return it with feedback for another attempt. `atk-agent claim --kind bug`
limits an agent's claims to bugs.

![Workspace](docs/screenshots/overview.png)

Open **Agent team** and use its left sidebar to manage identities and squads. Select **Role template** on
an agent's card to view or edit its assigned template. Create new roles under **Squads**.
Use **Resources** for agent templates, skills, MCP configurations and CLI scripts, grouped into ATK built-ins,
global shared entries and the current project's entries. Global resources stay under ATK's data directory;
project resources live in docsRoot/resources (normally .agent-team/resources).
Use `atk-agent resources list` for global entries or add `--scope project --project <id>` for a project.
Same-named resources stay separate. See [Team resources](docs/TEAM-RESOURCES.md).
Save the credential when creating an agent identity; it is shown once. Agents
can use HTTP or the package's machine CLI:

```sh
# Set ATK_AGENT_TOKEN securely in the external agent's environment.
atk-agent connect
atk-agent claim --wait 30000
atk-agent watch <runId> --generation <n>
atk-agent submit <runId> plan --file plan-receipt.json
# Or submit result / review for the other stages.
```

Run the lease watcher concurrently with your external execution. On loss of the
watcher, a stop request, or a lease error, stop writing. The watcher cannot kill
an external agent. Never put its credential into a repository or a receipt.

## Documentation and validation

- [中文说明](README.zh-CN.md)
- [Architecture and state rules](docs/ARCHITECTURE.md)
- [HTTP protocol, payloads and recovery](docs/AGENT-PROTOCOL.md)
- [Operations and backup/restore](docs/OPERATIONS.md)
- [Removed, retained and rebuilt modules](docs/REFACTOR.md)
- [Validation evidence and limitations](docs/VALIDATION.md)

```sh
node scripts/check-boundaries.mjs
node scripts/test.mjs
node scripts/build-web.mjs
node scripts/e2e.mjs
node scripts/smoke.mjs
node scripts/benchmark.mjs                 # full 30-minute soak
```

The browser checks require Chrome, Edge or Chromium. Set `ATK_BROWSER` for a
custom executable. CI runs the real workflow and an explicitly shorter 30-second
performance check; the full soak is reported separately. These tests use local
protocol clients, not AI models.

MIT license. Single user and loopback access only. File locks coordinate clients
that follow the protocol; they do not block editors or arbitrary processes.
