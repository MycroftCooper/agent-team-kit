# Internals — module contract

> This file is the shared build contract for the toolkit. Read it before adding a
> command. English only: publishing target.

## 1. Golden rules

1. **No third-party dependencies.** Node >= 20.11 built-ins only (the toolkit must
   run with a bare `node` inside any project).
2. **No hard-coded project knowledge.** Every path comes from `ctx` (`ctx.paths`,
   `ctx.rel`); every role from `ctx.config.roles`; every label from
   `ctx.labels`. ASCII-only source files except the `zh-CN` label/模板 content.
3. **Deterministic output.** Sort every collection before rendering. Timestamps
   only where the original format requires them.
4. **Machine output is JSON, human output is short.** Commands that other
   commands consume support `--json` (pretty JSON on stdout, nothing else).
5. **Exit codes:** `0` ok, `1` check failed / gate failed, `2` usage error,
   `3` concurrency / drift refusal.
6. **No `process.exit()` inside library functions** — return an exit code and let
   `bin/atk.mjs` apply it. (Commands may set `process.exitCode`.)
7. **Never write outside `ctx.root`** unless the config explicitly points there
   (use `assertInsideRoot` from `lib/config.mjs`). Candidates in the OS temp dir
   are the only exception and are always read-only inputs for apply.

## 2. Command module contract

Every `lib/<name>.mjs` command module exports:

```js
export async function run(argv /* string[] */, ctx) { /* returns exit code */ }
```

`ctx` (see `lib/context.mjs`):

| field | meaning |
|---|---|
| `ctx.config` | fully resolved config object (see `lib/config.mjs`) |
| `ctx.root` | absolute project root |
| `ctx.paths.state` … | absolute paths for every configured file (`ctx.paths[e.key]`) |
| `ctx.rel.state` … | project-relative posix paths for the same keys |
| `ctx.roles` | configured roles, e.g. `["LEAD","FE","BE","QA"]` |
| `ctx.lang` / `ctx.labels` | label language + dictionary (`lib/labels.mjs`) |
| `ctx.log.out/err/json/fail` | output helpers |
| `ctx.relOf(abs)` | project-relative path helper |

`run()` must print `--help` usage when `argv[0]` is `help`/`--help` (or when the
sub-command is missing) and return `2` in that case.

## 3. Naming inside the CLI

| top-level | module | sub-commands |
|---|---|---|
| `atk state` | `lib/state.mjs` | `check`, `board`, `queue`, `task`, `import`, `archive`, `restore` |
| `atk board` / `atk serve` | `lib/board.mjs` | `--serve`, `--json`, `--compact` |
| `atk evidence` | `lib/evidence.mjs` | `--collect-temp`, `--dry` |
| `atk ownership` | `lib/ownership.mjs` | `map`, `check`, `verify-config` |
| `atk batch` | `lib/batch.mjs` | `manifest`, `verify`, `apply` |
| `atk baseline` | `lib/baseline.mjs` | `start`, `changed` |
| `atk cache` | `lib/cache.mjs` | `status`, `clean` |
| `atk gate` | `lib/gate.mjs` | `fast`, `quick`, `local` |
| `atk select-tests` | `lib/select-tests.mjs` | `--files`, `--since-baseline`, `--plan`, `--quiet` |
| `atk todo` | `lib/human-todos.mjs` | list (default), `add`, `toggle`, `done`, `undone`, `remove` |
| `atk measure` | `lib/measure.mjs` | `record`, `summary` |
| `atk sync` | `lib/sync.mjs` | `--quiet` |
| `atk docs rotate` | `lib/docs.mjs` | `rotate` (`--apply`, `--keep`, `--flavor`) |
| `atk plugin` | `lib/plugin.mjs` | `sync`, `verify` |
| `atk init` | `lib/init.mjs` | `--preset`, `--project`, `--language`, `--roles`, `--force` |

Aliases (`task`, `queue`, `check`, `import`, `archive`, `restore`, `tests`) are
defined in `lib/dispatch.mjs`; do not duplicate them inside modules.

## 4. Data contracts (keep byte-compatible with the existing P4Deck files)

### 4.1 `state.json`

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-29T21:05:00+08:00",
  "source": "optional human note",
  "batch": {
    "id": "CON06+ACTION-R01",
    "goal": "one sentence",
    "stopCondition": "one sentence",
    "devClosedByUser": false,
    "applyMode": "local-tree",
    "openQuestions": ["..."],
    "slices": [
      { "id": "S1A", "label": "ACTION S1A", "status": "done", "qaPassed": true,
        "applied": true, "owner": "BE", "exit": "frozen + QA passed",
        "evidence": "artifacts/evidence", "note": "..." }
    ]
  },
  "counts": { "total": 52, "byStage": { } },
  "packages": [
    { "id": "GRAPH-01", "type": "feature", "typeRaw": "功能需求", "owner": "FE",
      "module": "界面与导航", "scope": "...", "stage": "implemented",
      "statusRaw": "...", "priority": "P1", "evidence": "已应用", "note": "...",
      "depsRaw": "...", "deps": ["UI-01"], "archived": false, "migrated": true,
      "verification": { "humanAccepted": true },
      "updatedAt": "...", "archivedAt": null, "archivedBy": null,
      "archiveReason": null, "archiveEvidence": null, "firstSeenAt": "..." }
  ],
  "subitems": [
    { "id": "CON-01-F01", "parent": "CON-01", "type": "feature", "owner": "FE；QA", "stage": "partial" }
  ]
}
```

`stage` ∈ `done | implemented | partial | in-progress | todo | blocked | proposed`.
`slice.status` ∈ `todo | in_progress | frozen | qa | qa_with_gap | awaiting_apply |
awaiting_accept | blocked | done | paused`.
Archive is allowed only when `verification.humanAccepted === true`.

### 4.2 `ownership.json` (per project, inside `flowDir`)

```jsonc
{
  "schemaVersion": 1,
  "note": "path → role. Longest prefix wins; two roles on one path is a config error.",
  "roles": ["LEAD", "FE", "BE", "QA"],
  "ignoredPrefixes": ["artifacts/", "node_modules/"],
  "rules": [
    { "prefix": "src/test/batch-qa/", "role": "QA", "note": "..." },
    { "prefix": "src/", "role": "FE", "note": "..." }
  ],
  "rootFiles": { "role": "LEAD", "names": ["package.json"] }
}
```

### 4.3 `human-todos.json`

```jsonc
{ "schemaVersion": 1, "updatedAt": "...", "note": "...",
  "items": [{ "id": "T01", "text": "...", "done": false, "createdAt": "...", "doneAt": null, "note": "..." }] }
```

Agent may read/add; only a human (or the board UI) may tick. `todo toggle/done`
must refuse when `AGENT_MODE=1`? No — the rule is social; keep the command but
document it. Do not auto-tick anywhere.

### 4.4 `runtime.json`

```jsonc
{ "schemaVersion": 2, "updatedAt": "...", "note": "...",
  "agents": [{ "role": "BE", "status": "working|waiting|idle", "task": "...", "detail": "...", "since": "..." }],
  "events": [{ "at": "...", "role": "LEAD", "text": "..." }] }
```

### 4.5 batch manifest (`atk batch manifest`) — keep the existing format

Line 1 `p4deck-manifest-v1` (or `batch.manifestTag`), line 2 batch id, then the
same fields as `scripts/workflow/batch.mjs` produces (`candidate`, `paths`,
`files[{path,sha256,size}]`, `manifestSha256` over the deterministic payload).
`qa-approval.json` binds `manifestSha256`; do not change either format without a
version bump + migration note.

## 5. Board rendering

- `atk state board` renders `ctx.paths.board` (markdown).
- `atk board` renders `ctx.paths.boardHtml` and can `--serve` a live SSE board.
- Markdown section order and column keys are fixed by `lib/labels.mjs`; the board
  plugin reads `state.json` directly (not the markdown), so both stay in sync.

## 6. Testing

- `node --test "test/*.test.mjs"` (built-in runner; a bare directory argument is
  rejected by Node 24 on Windows). No vitest/jest.
- Every command module gets at least one test that builds a throwaway project in
  `mkdtemp(path.join(os.tmpdir(), "atk-test-"))`, writes a minimal config +
  state/ownership files, and asserts both library output and CLI exit codes.
- Plugin selftests stay standalone: `node plugins/dsh-agent-board/selftest.mjs`
  (host side) and `selftest-client.mjs` (client bundle, fake ModuleLoader).

## 7. Plugin copy inside a consuming project

`atk plugin sync --out <dir>` copies `plugins/dsh-agent-board` into the project,
replacing the identity tokens (`__PLUGIN_ID__`, `__PLUGIN_ROUTE__`,
`__PLUGIN_TITLE__`, `__PLUGIN_TAB_KIND__`, `__PLUGIN_COMMAND_ID__`) from
`config.plugin`, and writes the matching `cordis.patch.yml`. A project that wants
the board installs that directory through the DSH Plugins page.
