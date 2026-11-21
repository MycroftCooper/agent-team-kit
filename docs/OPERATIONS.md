# Local operations

## Installation and start

Use Node.js 24. The package contains its production web bundle and all backend
modules, with no production dependency install inside target projects.

```sh
atk start --port 1421
atk status
atk logs
atk stop
```

Windows users can double-click the package's `start.bat` and `stop.bat`. Start
opens the private web URL in the default browser without printing the access code.
The scripts work from any current directory. Optional `atk.local.json` beside
them selects `dataDir` (absolute or relative to that directory); it is local-only
and excluded from Git and release packages. Explicit `--data` overrides it;
`ATK_DATA_DIR` also bypasses that file. `--no-open` suppresses the browser for
headless startup checks. These entrypoints require Node.js 24, not an EXE runtime.

`--data <directory>` isolates an installation. On Windows the default is
`%LOCALAPPDATA%/AgentTeamKit/Next`; other platforms use the local data directory.
The service binds 127.0.0.1 and exclusively claims its data directory using a
PID/instance ownership file before opening SQLite. Corrupt ownership fails closed;
dead owners can be replaced without killing any process. The launcher records URL, instance ID and PID, never
credentials. It shuts down only the matching service through authenticated HTTP,
not by trusting a possibly reused PID.

`atk start` returns a private `browserUrl` whose fragment unlocks the web client.
The client removes that fragment immediately and keeps the access code in tab
session storage, so reloads work. A plain URL opens an access-code form. Calling
`GET /api/v1/session` requires the separate `x-atk-access` credential; neither
anonymous requests nor Agent credentials can obtain an approval session. Calling
`atk start` again retrieves the private link for an already-running installation.
Do not share that link or pass it to an Agent.

The access key lives in `runtime/browser-access.json` with owner-only creation
permissions where supported. It is excluded from service state, logs, backups,
project documents and Agent replies. The launcher reads it locally for privileged
operations. This is a local single-user boundary, not an OS sandbox: a process
that can read the user's private files or control their browser is already trusted.

The browser's session is short lived and held in memory. Agent credentials are
shown once and stored hashed in SQLite. Revocation prevents new Agent requests;
active executions require confirmed stopping before locks are released.

## Projects

Each project is one workspace. Use **Switch workspace** in the title bar (or
page header in a browser) to change the overview and daily pages in **Work**:
**My inbox**, **Tasks**, **Bugs**, **Collaboration** and **Runs**. **Archive history**
also lets you select a project for historical browsing. The browser
remembers the selected workspace across reloads. New requests always belong to
the current workspace. Creating a project enters it automatically; archiving the
current project selects another active workspace, or shows the setup screen if
none remain. Agent identities belong to the selected project; squad/role
configuration and operations settings are shared administration. Switching workspace does not stop
running agents or interrupt human-task heartbeats.

Register name, existing root and team in the UI. Git is not required. The default
artifact directory is `<root>/.agent-team`; another path can be explicitly chosen.
The tool does not initialize package managers or inject instructions into the
target project's build. Add the artifact directory to your project's own ignore
rules if appropriate; the tool does not edit those rules automatically.

Archive only disables scheduling. Relocation requires all active/uncertain runs
to be reconciled. Move the project and its artifact directory together, then
update both paths through the UI. No background disk scan or automatic deletion
is performed. Failed document generation appears in My inbox and can be retried.

Workflow boards and swimlanes expose drag handles and **Move to…** for eligible
human actions. Start human work directly, fill delivery notes before completing,
confirm retries, review a submitted plan before approval, and inspect the whole
requirement before final acceptance. Disabled cards explain the missing
condition. Executor grouping does not change execution types. See
[Task board movement](TASK-BOARD-DRAG-DESIGN.md).

Human completion requests now bind `version`, `runId` and `generation`. After
upgrading, reload old web pages before submitting human work. If a form becomes
stale, keep/copy the entered notes and reopen the current task; it must not finish
a later restarted run.

## Stop, failure and recovery

Project automation definitions live in `<root>/.atk/automations/`, independent of
`docsRoot`. Create/edit them in Automations or with the project's Agent credential:
`atk-agent automation apply --file workflow.json --create --project <id>`.
Run using `automation run <workflowId> --revision <sha256> --project <id>`;
use `--param name=value` or `--params-file`, and optionally `--wait`.
The same runId appears in the UI. Definitions specify native `cli` and argv `args`;
Windows .cmd/.bat tools require a project adapter. No shell is invoked implicitly.
Old database workflows are not read or migrated; reconnect them as project files.
Workflows may also declare project-owned `schedules` for one-time, multiple-date,
finite-repeat or ongoing interval runs. See [CI scheduling](AUTOMATION-SCHEDULING.md)
for missed/busy slot behavior, local cursor recovery and the Agent schedules API.

Every run retains its definition/request, log.ndjson, events.ndjson, final result.json
and collected exports in `.atk/runs/<runId>/`. Configure CI to use ATK_OUTPUT_DIR
for fresh outputs; unchanged fixed-path files are refused as evidence. A declared
atk-ci-result/v1 report must match this runId and stepId as well as the process exit.
Full logs stay on disk; the UI displays recent text with incremental log fetching.
No automatic history cleanup is performed. Runs exceeding 256 MiB of logs fail.

After a crash, an uncertain command is RECOVERY_REQUIRED and prevents another run,
relocation, complete backup and hot reload. Inspect/stop the old process tree,
then use the UI's human-only confirmation with a reason. Agent disconnection does
not cancel backend-owned CI; `automation stop <runId>` explicitly requests stopping.
Git triggers observe new local commits only after establishing this machine's baseline.

Task details provide **Cancel task…**, including a preview of unfinished
downstream work or requirement subtasks, a mandatory reason and confirmation.
Active/uncertain runs must be stopped and confirmed first; cancellation never
releases a live writer's locks. Cancelling work leaves the requirement needing
a plan revision; cancelling the requirement supersedes plans and pending
acceptance, while completed work and existing files remain.

Use **Archive task…** only for completed or cancelled records. Requirements
archive their closed subtasks together. **Work → Archive history** offers search,
details and restore; restoring preserves status and never starts execution.
In **Projects**, **View task history** opens an archived project's tasks and
receipts read-only, without restoring the project, including when no active
projects remain. See [Task cancellation and archives](TASK-CANCELLATION-ARCHIVE.md).

Stopping the service does not terminate external agents. Those agents must stop
writing on lease/connection loss. Restart preserves active state and file locks;
expired runs become QUARANTINED. Inspect the external environment, stop the old
writer, and use the UI's explicit stopped confirmation. Existing edits are kept.

To change an approved file scope, reconcile the active run, request a plan
revision, and approve its new version. The application never performs Git reset,
checkout, merge, automatic file rollback or worktree pruning.

## Backup and restore

Reconcile RUNNING, STOP_REQUESTED and QUARANTINED work first. Both UI and CLI
require an idle installation for complete backup and restore.

```sh
atk backup --to <new-backup-directory>
atk restore --from <backup-directory>
```

The version-2 backup contains a consistent SQLite snapshot, project artifacts (including
each docsRoot/resources library and supporting files), project .atk definitions/runs,
global resources and a
checksum manifest. Restoring a backup copies saved resources over matching files
and leaves other resource files in place. Restore validates the manifest and saved project paths, makes
a safety backup, then restores state and referenced artifacts. Project source
files are **not** part of this backup and are never rolled back by restore.
Use your own source control or file backup for project code.
Automation owner locks and trigger cursors under `.atk/local/` are excluded and
are not restored; a restored installation establishes a fresh Git baseline.
Older backup formats are not accepted by this automation revision.

Backups may contain private project content; store them accordingly. Restore
uses the project locations recorded in that backup and requires those roots to
exist. A backup is an integrity-checked local archive, not a signed untrusted
import format. Do not restore archives from untrusted sources.

## Limits

- Single local user, no remote access, TLS, multi-user ACLs or provider services.
- Cooperative file locking cannot fence arbitrary filesystem writes.
- A declared snapshot is limited to 256 MiB; text previews to 512 KiB per file.
- Prefer literal files or narrow directory scopes. Large snapshots take longer
  and are outside metadata request latency targets.
- Document retry is bounded to ten attempts until an explicit UI retry.
- No native installer, code signing or automatic updater is included in alpha.
- Application logs are rolled at service start after 5 MiB, not continuously.
- Database/event retention and signed archive exchange are future operational work.
- Old databases and task JSON are not accepted. Keep old data separately; the new
  service does not auto-upgrade, prune or delete it.
