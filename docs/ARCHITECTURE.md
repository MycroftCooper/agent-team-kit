# Architecture and workflow

## Boundaries

The web client communicates only through HTTP and one SSE stream. The backend is
the only application database writer. External agents call a distinct authenticated
API; they neither inherit a browser session nor choose their own function.

```text
Browser ── /api/v1 + SSE ── Backend ── SQLite (one global authority)
                              │
External agents ─ /api/agent/v1┤
                              ├── project/.agent-team (documents + snapshots)
                              └── ATK data/resources (shared team resources)
```

The backend uses pure domain and scheduling functions inside atomic claims.
There is no resident scheduler worker, runtime host, provider SDK or model route.
The launcher manages only the backend. The machine CLI handles HTTP, receipt
retry and lease renewal. It can launch an explicitly requested team CLI script
or stdio MCP server in the external client's process environment. The backend
does not launch these resources, and ATK does not execute AI processes.

Automation configuration uses the authenticated human API. Commands run in the
registered project root, either on demand or when a configured local Git branch
advances and has a clean checkout. The workflow, its Git cursor and run records
are kept in SQLite. Lifecycle events use the existing SSE stream; live details
and bounded log tails are fetched only in the run view.

Node.js 24, built-in `node:sqlite`, React/TypeScript/Vite. Production Node modules
use relative package paths so the installed package needs no workspace links.
The web build bundles React. Tests use throwaway SQLite files rather than a
second production memory-store implementation.

On Windows, `dev.bat` opens the same React UI in an Electron window. Two
utility processes run the backend and the loopback Vite server. Vite proxies the
human API and SSE; external Agents call the backend directly. The renderer has
no Node integration. Development source changes restart only the backend
process on the same port, after active or uncertain tasks and automations have
settled. The renderer reconnects over SSE without reloading the page. Electron
main process and startup configuration changes require relaunching the app.

## State and identity

- REQUEST tasks start DRAFT. ORCHESTRATOR planning runs leave them DRAFT until
  the human approves a submitted plan version.
- Approval atomically materializes WORK tasks. REQUESTs are containers and cannot
  be claimed as execution tasks.
- WORK flows READY → RUNNING → optional REVIEWING → VERIFIED. VERIFIED or DONE
  dependencies unlock downstream work. Final plan acceptance makes VERIFIED
  children and the REQUEST DONE.
- HUMAN work starts through the UI and completes through explicit human action.
  Its browser renews the lease across pages and workspace switches. A lost human lease uses
  the same conservative recovery rules as an agent lease.
- BUG tasks are direct repair work and have no plan. The selected worker role
  claims them under the same file locks and lease rules. A successful execution
  goes to AWAITING_ACCEPTANCE. Human acceptance closes the bug; rejection
  requeues it with feedback and a reference to the previous receipt.
- Failed execution, content drift, review exhaustion and lease loss are BLOCKED
  reasons, not successful completion. Human retry creates another generation.
- A plan's author identity cannot execute/review its work. An execution author
  cannot review that candidate. These checks use credential-bound IDs.
- A human may set or clear an execution assignee on an approved Agent task in
  READY or BLOCKED, provided no active or uncertain run still owns the task.
  The optional identity is saved on the task and checked in the same claim
  transaction as dependencies and locks. It does not change the approved role,
  start a run, or reserve the independent review.
- Approved plans freeze role instructions. Editing a role does not silently alter
  an existing plan. Changing the function of a role with live identities requires
  a new role instead.

Plans have explicit revisions and approval versions. Revision requests stop
future claims, cancel superseded unfinished nodes and return the REQUEST to
DRAFT. Existing edits remain in the project. Active/uncertain runs must be
reconciled before a revision can replace work.

Superseded acceptance targets stay as history and disappear from the inbox.
Revalidation requires the current approved plan and unchanged delivery results;
it cannot alter a revised requirement or a newer delivery. Drift in a human-owned
final output reopens that HUMAN task through BLOCKED and explicit retry, while
legal downstream edits preserve the earlier human completion.

## File coordination and evidence

Claims transactionally check dependencies, team/agent capacity, identity, full
file scope and global real-path conflicts. Directory scopes cover descendants.
Windows aliases, alternate streams, device paths and out-of-project symlinks are
rejected. Role permissions are checked against resolved paths as well as labels.

No partial lock acquisition or live scope expansion is supported. Stop and report
the old attempt before applying for a larger approved scope. A plan revision is
needed when the approved task's scope itself changes.

Before/after content lives in project snapshots; the database keeps versions,
hashes, metadata and receipt references. Claim/status replies omit snapshots and
full history. Structured results are authenticated external reports, not a claim
that the platform independently reran the reported commands.

Only a stopped execution with a durably saved receipt releases its locks. Lease
expiry quarantines them. Confirming stopped preserves files and records the
interrupted candidate. Cooperative locks do not fence arbitrary filesystem writes.

Pending reviews recheck the candidate. VERIFIED historical outputs remain valid
for approved downstream edits. Final acceptance checks the merged latest output
manifest against current files inside the backend's claim-exclusion transaction.
Changed files/new files in directory scopes make pending targets stale.
Acceptance checks locks over the full approved scope, including empty directories
and not-yet-created descendants. Rework claims include the last review summary
and references to its detailed findings and the exact rejected output.

## Persistence and events

SQLite WAL and `BEGIN IMMEDIATE` protect state changes. Queue/status/project and
plan lookups are indexed. Events have unique producer IDs and monotonic sequence
numbers; repeated IDs cannot be reused across runs. Submission keys make retries
safe; clients retain unacknowledged submissions on disk.

Document jobs are persisted and retried, with failures visible in My inbox.
Generated JSON is an output view, never an alternate authority for task state.
Project paths may be relocated while inactive; projects may be archived without
deleting their directories.

SSE replays forward by sequence and signals resync for invalid/future cursors.
The UI batches ordinary entity invalidations, keeps at most 200 live events and
renders at most 100 timeline entries. Logs and snapshots are read on demand.
