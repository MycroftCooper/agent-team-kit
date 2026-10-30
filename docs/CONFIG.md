# Configuration

`agent-flow.config.json` lives at the project root (an `.agent-flow/config.json`
is also discovered). Every path is **project-relative and posix**. `atk init`
writes a fully expanded config; the presets in `presets/` are starting points.

The file is validated on load: `schemaVersion` must be `1`, roles must match
`^[A-Z][A-Z0-9_]*$`, paths must stay inside the project, the board port must be a
real TCP port, and plugin identifiers must be valid.

```jsonc
{
  "schemaVersion": 1,
  "project": "my-app",
  "language": "en",
  "layout": { "flowDir": ".agent-flow", "artifactDir": "artifacts/agent-flow", "evidenceDir": "artifacts/evidence", "tempPrefix": "my-app" },
  "roles": ["LEAD", "DEV", "QA"],
  "gates": { "fast": { "parallel": true, "groups": {}, "steps": [] }, "quick": null, "local": null },
  "batch": { "manifestTag": "agent-flow-manifest-v1", "qaSchemaVersion": 1, "idPattern": "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$", "allowedPrefixes": ["src", "docs"], "budgetRounds": 12 },
  "baseline": { "roots": ["src", "docs"] },
  "cache": { "targets": [] },
  "board": { "title": "Agent Board", "port": 1421, "compactLimit": 50, "fallbackPollMs": 30000 },
  "plugin": { "id": "my-app-board", "route": "/my-app-board", "title": "Agent Board", "tabKind": "myAppBoard", "commandId": "my-app-board.open", "dir": "tools/agent-board" },
  "rotation": []
}
```

> `atk init` strips the `$schema` entry from presets (the schema file is not
> copied into consuming projects). Editors that support JSON schema can add
> `"$schema": "node_modules/agent-team-kit/agent-flow.config.schema.json"`
> manually when the toolkit is installed as a dev dependency.

## Top level

| Key | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Config format version. Required by validation. |
| `project` | string \| null | Display name; defaults to the directory name. |
| `language` | `"en"` \| `"zh-CN"` | Label language for boards, tasks and generated docs. |
| `roles` | string[] | Role identifiers, e.g. `["LEAD","DEV","QA"]`. Order is the display order. |
| `todoSource` | string \| null | Shortcut for `paths.todoSource`. |
| `handoffDoc` | string \| null | Shortcut for `paths.handoffDoc`. |

## `layout`

Where workflow files live and which directories hold machine artifacts.

| Key | Default | Meaning |
|---|---|---|
| `flowDir` | `.agent-flow` | Directory holding state, board, role cards and docs. All unset `paths` derive from it. |
| `artifactDir` | `artifacts/agent-flow` | Machine artifacts: metrics, gate reports, manifests. |
| `evidenceDir` | `artifacts/evidence` | Durable acceptance receipts (QA approvals, apply receipts). |
| `tempPrefix` | `agent-flow` | Prefix used to recognise candidate snapshots / receipts under the OS temp dir. |

`flowDir` may be any project-relative directory (`docs/workflow`, `ForAIDoc/PM/...`);
use `atk init --flow-dir <dir>` to generate one there.

## `paths`

Explicit overrides for individual files. Missing keys derive from `flowDir` +
the default filename.

| Key | Default (inside `flowDir`) | Meaning |
|---|---|---|
| `state` | `state.json` | Source of truth. |
| `ownership` | `ownership.json` | Path prefix -> role map. |
| `board` | `board.md` | Markdown board. |
| `boardHtml` | `board.html` | Static HTML board. |
| `humanTodos` | `human-todos.json` | Human-only todo list. |
| `runtime` | `runtime.json` | Agents working now + recent events. |
| `currentBatch` | `current-batch.md` | Rolling batch notes. |
| `taskTemplate` | `task-template.md` | The 9-line ticket format. |
| `commandsDoc` | `commands.md` | Command cheat sheet. |
| `rolesDir` | `roles` | One card per role. |
| `archiveDir` | `archive` | Archived packages and rotated docs. |
| `todoSource` | unset | Markdown backlog imported by `atk state import`. |
| `handoffDoc` | unset | Long-lived handoff log rotated by `atk docs rotate`. |

## `roles`

Non-empty array of unique identifiers matching `^[A-Z][A-Z0-9_]*$`. The default
three are `LEAD`, `DEV`, `QA`; the `p4deck` preset uses `LEAD`, `FE`, `BE`, `QA`.
Every role gets a card in `rolesDir` (a generic card is generated for custom
roles) and must appear in `ownership.json`.

Changing this list on an initialized project also means editing `ownership.json`
(its `roles` plus rules), `runtime.json` (`agents`), the role card and the flow
README together - see the `agent-team-roles` skill and
[ROLES.md](ROLES.md). Do not re-run `atk init --force` for it; that rewrites the
whole flow directory, `state.json` included.

## `gates`

```jsonc
"gates": {
  "fast": {
    "parallel": true,
    "groups": {
      "code": ["src/**/*.ts", "src/**/*.tsx"],
      "tests": ["**/*.test.ts", "tests/**/*"],
      "docs": ["docs/**", "*.md"]
    },
    "steps": [
      {
        "name": "format",
        "phase": "preflight",
        "command": ["npx", "prettier", "--check"],
        "when": { "group": "code" },
        "files": { "group": "code", "mode": "append" }
      },
      {
        "name": "typecheck",
        "kind": "typecheck",
        "command": ["npm", "run", "typecheck"],
        "when": { "group": "code" }
      }
    ]
  },
  "quick": { "command": ["npm", "run", "check"] },
  "local": { "command": ["npm", "run", "verify"] }
}
```

- `gates.fast.steps[]` run only when `when` matches the changed files. Preflight
  steps run serially and abort on first failure; main steps run in parallel unless
  `parallel: false`.
- `when.group` accepts one group name or a list; `when.changed: true` matches when
  any file changed; `when.includingTests` covers test files too.
- `files` appends `--files <list>` (`mode: "append"`) or runs the command once per
  file (`mode: "each"`); `includeTouchedTests` adds adjacent tests.
- `roleFlag` / `filesFlag` append `--role <ROLE>` / `--files <list>`.
- `gates.quick` / `gates.local` are single commands run by `atk gate quick|local`.
- `command` is a string or an argv array; use an array on Windows to avoid shell
  quoting surprises.

## `batch`

| Key | Meaning |
|---|---|
| `manifestTag` | First line of the frozen manifest (e.g. `agent-flow-manifest-v1`). Changing it invalidates old manifests. |
| `qaSchemaVersion` | Schema version written into `qa-approval.json`. |
| `idPattern` | Regex package ids must match (default requires a `PREFIX-NN` shape). |
| `allowedPrefixes` | Top-level prefixes a batch may touch. |
| `budgetRounds` | Default round budget shown in tickets (default 12). |

## `branch`

Branch rules scaffolded by `atk init` and enforced by `atk release`. The kit
repository itself does not require this flow; projects created with the kit get
these defaults:

```json
"branch": {
  "development": "dev",
  "release": "master",
  "tagPrefix": "v",
  "versionFile": "package.json",
  "gateReport": null,
  "requireCleanTree": true
}
```

- `development`: day-to-day branch; every agent commit lands here.
- `release`: release line; only `--no-ff` merges from `development` plus tags.
- `versionFile`: `.version` must match `atk release --version`; `false` disables.
- `gateReport`: checked before releasing; `null` means
  `<artifactDir>/ci-fast-latest.json`, `false` disables the check.

## `baseline`

`baseline.roots` lists directories walked by `atk baseline start` / `changed`.
Use it when git history is not a reliable "what changed since this work started"
signal. Falls back to `batch.allowedPrefixes`.

## `cache`

```jsonc
"cache": { "targets": [
  { "name": "cargo-target", "path": "%TEMP%/shared/cargo-target", "env": "CARGO_TARGET_DIR" }
] }
```

`atk cache status` reports size/age per target; `atk cache clean --all --dry`
shows what would be deleted. Paths support `%VAR%`, `$VAR` and `~`.

## `board`

| Key | Default | Meaning |
|---|---|---|
| `title` | `Agent Board` | Board title. |
| `port` | `1421` | Port for `atk serve`. |
| `compactLimit` | `50` | Max rows in the compact agent view. |
| `fallbackPollMs` | `30000` | Polling fallback when SSE is unavailable. |

## `plugin`

Identity of the copied DSH board plugin. `atk init` derives `id`, `route`,
`tabKind` and `commandId` from the project name when starting from the generic
preset, so two projects can be installed side by side; presets with an explicit
identity (like `p4deck`) keep it.

| Key | Example | Meaning |
|---|---|---|
| `id` | `my-app-board` | Plugin id (lower-case kebab-case, unique per DSH profile). |
| `route` | `/my-app-board` | Same-origin HTTP route served by the plugin. |
| `title` | `My App Board` | Sidebar title. |
| `tabKind` | `myAppBoard` | camelCase tab kind. |
| `commandId` | `my-app-board.open` | Command that opens the panel. |
| `dir` | `tools/agent-board` | Where `atk plugin sync` copies the plugin. |

## `import`

Optional overrides for `atk state import` parsing a markdown backlog table:
`stagePatterns` / `typePatterns` are arrays of `[pattern, value]` pairs.

## `rotation`

```jsonc
"rotation": [
  { "path": "docs/HANDOFF.md", "archiveDir": "docs/archive", "archivePrefix": "handoff", "keep": 2, "mode": "sections", "headingLevel": 2 }
]
```

`atk docs rotate` moves old sections (`mode: "sections"`) or a narrative zone
(`mode: "narrative"` + `startMarker`) into the archive. It is a dry run unless
`--apply` is passed, and exits `3` if the live file changed mid-run.

## Validation and inspection

- `atk state check --strict` validates the state file against the config.
- `atk ownership verify-config` reports conflicting ownership rules and unused
  roles.
- `atk --version` and `atk help` print the CLI surface.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | a check or gate failed, or the command refused for safety |
| `2` | usage or configuration error |
| `3` | concurrency / drift refusal (an input changed mid-operation) |
