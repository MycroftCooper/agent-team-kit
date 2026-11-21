# Changelog

## 0.0.1

Initial GitHub Release of Agent Team Kit — a local web workspace for coordinating external pull-based agents across multiple projects.

### Core workspace & protocol
- Multi-project registration (Git optional), versioned PM planning, human plan approval, optional independent review, human tasks, VERIFIED dependency progression, and final acceptance with output drift checks.
- External pull-based HTTP & CLI agent protocol (`atk`, `atk-agent`) with cooperative file/directory leases, generation fencing, quarantined locks, durable receipts, and backup/restore.
- Bilingual (Chinese/English) Linear-style web UI with SSE invalidation, paginated views, theme support, and Windows double-click `start.bat` / `stop.bat` launchers.

### Collaboration, resources, bugs & automations
- Project-owned agent identities with isolated credentials, deletion/recovery lifecycle, **Collaboration** live workspace view, and collapsible right-side task drawer.
- Built-in, global, and project-scoped **Team resources** (agent templates, skills, MCP configurations, and CLI scripts).
- Dedicated **Bugs** workflow with direct role dispatch, human acceptance, and feedback-driven rework.
- Guarded task board drag-and-drop with confirmation panels, task cancellation with impact review and active-run stop reconciliation, archive/restore, and read-only archived project history.
- Project-owned CI **Automations** stored under `.atk/automations/` and `.atk/runs/`, including one-time, multi-date, finite-interval, and ongoing interval schedules.

### External bug runner & desktop development shell
- Added `atk-agent run --task <bugId> --check '<cmd>'` supporting local **Codex CLI** and **DSH CLI** (`--engine dsh`) with process-tree supervision, file-scope auditing, lease renewal, and idempotent receipt replay.
- Added Windows x64 Electron desktop development workspace (`dev.bat`) with custom title bar and hot reload (development prototype; excluded from release package).

### GitHub Releases & auto-update
- Automated **GitHub Release** publishing on `v<version>` tags with `agent-team-kit-<version>.tgz`, `SHA256SUMS.txt`, and `release-manifest.json` (plus optional npm publishing when `NPM_TOKEN` is configured).
- Added built-in auto-update check, SHA-256 verification, and package installation via Web UI (**Settings & operations → Application & updates**), backend API (`/api/v1/system/update`, `/api/v1/operations/update/check`, `/api/v1/operations/update/apply`), and CLI (`atk check-update`, `atk update`).
