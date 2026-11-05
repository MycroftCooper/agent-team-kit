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

Each project is one workspace. Use **Switch workspace** at the top of the sidebar
to change the overview, intake, tasks, inbox and run history together. The browser
remembers the selected workspace across reloads. New requests always belong to
the current workspace. Creating a project enters it automatically; archiving the
current project selects another active workspace, or shows the setup screen if
none remain. Project management, reusable agents/teams and operations settings
are explicitly shared global administration. Switching workspace does not stop
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

## Stop, failure and recovery

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

The backup contains a consistent SQLite snapshot, project artifacts and a
checksum manifest. Restore validates the manifest and saved project paths, makes
a safety backup, then restores state and referenced artifacts. Project source
files are **not** part of this backup and are never rolled back by restore.
Use your own source control or file backup for project code.

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
