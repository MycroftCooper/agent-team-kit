---
name: agent-team-roles
description: Reshape the agent team of an initialized agent-team-kit project - add, remove, rename or re-scope roles (agents) so the team matches the project's real directories and responsibilities. Use when the user asks to add, delete or change an agent or role, when the current roles do not fit the codebase, or when config.roles, ownership.json and the role cards disagree. Requires agent-flow.config.json and the atk CLI; it edits files in place and never re-runs `atk init --force` on a live project.
---

# Agent team roles

A role (agent) is four machine records that must agree, plus one human-readable
copy (the flow README table):

| Record | Source of truth for |
|---|---|
| `agent-flow.config.json` -> `roles` | which ids exist, their board order, what `atk queue/task --for` accept |
| `<flowDir>/ownership.json` -> `roles`, `rules`, `rootFiles` | which paths the role may write |
| `<flowDir>/roles/<ROLE>.md` | what the agent reads: scope intent, bans, task loop, 6-line receipt, round budget, proof ladder |
| `<flowDir>/runtime.json` -> `agents` | who the board and `atk serve` show as working now |

Ownership decides, the card explains. When they disagree, fix the card. A role
that exists in only some of these places produces silent bugs: a missing config
entry makes `atk queue --for X` fail, a missing runtime entry hides the role from
the board, a stale runtime entry shows a ghost, and a stale ownership rule makes
`atk ownership verify-config` fail.

Run every command from the project root. `atk` below means whichever invocation
the project uses: `atk`, `npx agent-team-kit`, or `node <checkout>/bin/atk.mjs`.

> **Windows PowerShell caveat:** quote comma lists. Unquoted, `--roles LEAD,DEV`
> splits into two arguments and `atk init` fails with "unexpected argument"; other
> comma values are silently truncated instead: `--for LEAD,DEV` uses only the
> first role, and `--files a.mjs,b.mjs` checks only the first path, which is a
> false PASS on write scope. Write `--roles "LEAD,DEV,QA"` and
> `--files "a.mjs,b.mjs"`.

## Before any change

1. Find the config at the project root: `agent-flow.config.json` (or
   `.agent-flow/config.json`). Read `layout.flowDir`, any `paths.*` overrides,
   `language` and `roles`.
2. If there is no config, this skill does not apply. Run `atk init --roles <list>`
   once (first setup) and stop.
3. Snapshot the files this change will touch: the config, `ownership.json`,
   `runtime.json`, the flow README and the `roles/` directory. If `git status` is
   clean, git is your rollback; otherwise make a temp copy first - uncommitted
   changes are not a rollback point.
4. Run the baseline and record it:

   ```bash
   atk state check
   atk ownership verify-config
   atk board --json
   ```

   If the baseline already fails, fix that first; do not stack a role change on a
   broken config.
5. **Never run `atk init --force` on an initialized project.** It overwrites the
   config and every generated flow document: `state.json`, `ownership.json`,
   `human-todos.json` (user todo data is lost), `runtime.json`,
   `current-batch.md`, `commands.md`, `task-template.md`, the flow README,
   `board.md` and the cards of the roles passed in `--roles`. Verified: batch
   goals, custom ownership rules and a `KEEP-ME` todo were all reset. Two extra
   traps: `board.html` is not rewritten (it keeps showing the old state), and
   cards of roles dropped from `--roles` are left behind. Without `--flow-dir` it
   can also scaffold a second flow directory and orphan the real one. `atk init`
   is for first setup; this skill edits the existing files instead.

## Step 1 - Read the project, then propose the team

Collect evidence instead of guessing:

- top-level directories and what lives in each of them;
- build/test manifests (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`,
  `pom.xml`, `Makefile`) and the test layout;
- separate design / data / infra / docs areas;
- current load: `atk queue --for <ROLE> --json` for each configured role.

Use this table as a starting point, then trim it to what the project actually
has:

| Signal in the project | Role to consider | Typical write scope |
|---|---|---|
| batch/state/coordination only | `LEAD` (keep) | `<flowDir>/`, `docs/`, root files |
| one product codebase | `DEV` | `src/`, `lib/`, `app/` |
| separate frontend and backend | `FE` / `BE` | `frontend/`, `web/` / `server/`, `api/`, `src-tauri/` |
| acceptance tests, e2e, QA evidence | `QA` (keep) | `tests/`, `e2e/`, `qa/` |
| design tokens, specs, prototypes | `DESIGN` | `design/` |
| schema, pipelines, notebooks | `DATA` | `data/`, `pipelines/` |
| deployment, IaC, CI, containers | `OPS` | `infra/`, `deploy/`, `.github/` |
| review-only gate with no product writes | `REVIEW` | a `reviews/` output dir, or none (see below) |

Write the proposal, then **wait for the human to confirm it** before writing
anything:

```
Role   action  write scope                 why
LEAD   keep    .agent-flow/, docs/          workflow owner and integrator
DESIGN add     design/                      tokens and prototypes live in design/
DEV    keep    src/                         the only product codebase
QA     remove  -                            no independent acceptance step; lead accepted
```

Proposal rules:

- 2-4 roles. A role that owns nothing is noise, and a role per person or per
  ticket is not a write scope.
- Exactly one role per path (longest prefix wins; overlapping prefixes are legal).
- Keep `LEAD` first and `QA` last unless the project has a concrete reason not to;
  order is the display order.
- Ids match `^[A-Z][A-Z0-9_]*$`, are unique, and are case-sensitive in practice -
  always write them upper-case.
- A reviewer/observer role with no paths is legal in the model, but
  `atk ownership verify-config` will report `role <ROLE> has no write scope` and
  exit 1. Give it a real prefix (for example `reviews/`) when you want a clean
  exit.

## Step 2 - Add a role

Five record edits, then re-render and verify. Example: `DESIGN` owning `design/`.

1. **Config** - insert the id where it should display:

   ```jsonc
   "roles": ["LEAD", "DESIGN", "DEV", "QA"]
   ```

2. **Ownership** - keep both lists in sync, then **reassign an existing rule or
   add a new one**. `atk init` assigns every top-level directory to some role, so
   the prefix you want is often already there with a fallback note
   (`unclassified top-level directory - review this rule`). Change that rule's
   `role` instead of appending a second rule for the same prefix:

   ```jsonc
   "roles": ["LEAD", "DESIGN", "DEV", "QA"],
   "rules": [
     { "prefix": "design/", "role": "DESIGN", "note": "design tokens, specs and prototypes" },
     { "prefix": "src/", "role": "DEV", "note": "product code and its adjacent tests" }
   ]
   ```

   Two rules on one prefix is a config error: `atk ownership verify-config` exits
   1 with `prefix "design" is claimed by both DESIGN and DEV`. Rules are sorted
   longest prefix first for readability; matching is by longest prefix, not by
   array order. `rootFiles.role` is a single project-wide owner - pointing it at a
   new role takes root files away from the previous owner, and `rootFiles` alone
   does not satisfy `verify-config` ("has no write scope"), so a root-files-only
   role still needs one rule.

3. **Card** - write `<flowDir>/roles/<ROLE>.md` using the skeleton at the end of
   this skill (skip the three sections that do not apply, keep the contract
   sections). For a `zh-CN` project use the Chinese section headings other cards
   use: 写域 / 禁做 / 任务循环 / 回执格式 / 命令 / 轮次预算 / 证据阶梯.

4. **Runtime** - add an idle entry so `atk board` (HTML), `atk board --json` and
   `atk serve` show the role (the Markdown `board.md` has no agents section):

   ```jsonc
   { "role": "DESIGN", "status": "idle", "task": "", "detail": "", "since": "<ISO-8601 timestamp>" }
   ```

5. **Flow README** - add a row to the role table (`## Roles and write scopes`;
   `## 角色与写域` in a `zh-CN` project):
   `| DESIGN | design/ | Owns design tokens, specs and prototypes. |`
   If the prefix moved from another role, fix that role's row too - a table that
   gives one path to two roles reintroduces the silent bug this skill prevents.
   If the flow directory has no `README.md` or no `roles/` yet (the committed demo
   project is one example), create them in the same shape as the templates.

6. Re-render the board (`state board` writes `board.md`; `board` writes only
   `board.html`, the file with the agents panel):

   ```bash
   atk state board
   atk board
   ```

**New top-level scope?** When the role's paths start with a directory the config
does not know yet (the usual `DESIGN`/`DATA`/`OPS` case), update the rest of the
config in the same change:

- `batch.allowedPrefixes` - add the directory, otherwise `atk batch manifest`
  refuses the path with `... is outside batch.allowedPrefixes (...)`;
- `baseline.roots` (when non-empty) - add it so `atk baseline` sees the files;
- `gates.fast.groups` (when gates are wired) - add patterns for the new file
  types, otherwise no fast-gate step runs for them.

## Step 3 - Change a role

- **Write scope only** - edit the rule(s) in `ownership.json`, then update the
  card's write-scope paragraph and the README table row. When a path moves between
  roles, edit both roles in the same change; never leave one path owned twice. A
  new top-level scope also needs the config note from Step 2.
- **Responsibility / mandate only** - edit the card and the README table row;
  ownership does not change.
- **Merge two roles** - reassign every rule of the loser to the survivor, then
  remove the loser (Step 4).
- **Rename** - ids are keys, so a rename is an add plus a remove. Add the new id
  everywhere first, move the rules/card/agents entry, then remove the old id
  everywhere. `owner` strings in `state.json` are free text and no command
  rewrites them: update them only with explicit human approval (see Step 4). Also
  fix the generated docs that hard-code the old id (`commands.md`,
  `task-template.md`, the flow README lifecycle paragraph, `human-todos.json`
  notes) - they were generated around the role set at `init` time (the `ROLE`
  placeholder is the executor and the examples are hard-coded).

## Step 4 - Remove a role

Stop unless all preconditions hold:

1. `atk queue --for <ROLE> --json` returns `"count": 0`. Any non-zero count is
   active (not archived) work; no command reassigns `owner` strings. Note that the
   queue only reads `state.packages`.
2. No `batch.slices[].owner` or `subitems[].owner` still contains the id
   (including compound values such as `"DEV; QA"`). `atk state check` does not
   validate owners, so search `state.json` by hand.
3. No runtime entry says the role is working on something.

If work exists, report the ids and ask the human to finish/archive the work, or
to explicitly authorize an owner rewrite. Never delete first and reassign later.

Removal writes, in this order:

1. remove the id from `agent-flow.config.json` -> `roles`;
2. in `ownership.json`: remove the id from `roles`, reassign each rule (usually to
   LEAD; for a merge, to the survivor) and repoint `rootFiles.role` if it named
   this role. After reassigning, update the receiving role's README table row and
   card write-scope paragraph, exactly like Step 3 - otherwise the docs keep a
   stale scope while the config passes. Deleting a rule instead leaves the path
   unmapped: `atk ownership check` still reports PASS with a hint, so
   single-writer protection is silently lost - delete only as an explicit choice;
3. delete `<flowDir>/roles/<ROLE>.md`;
4. remove the `runtime.json` -> `agents` entry;
5. remove the README table row, then fix the generated docs that hard-code the
   role (`commands.md`, `task-template.md`, the flow README lifecycle paragraph,
   `human-todos.json` notes);
6. re-render the board (`atk state board` and `atk board`).

**Authorized owner rewrite** (only when the human approved it): `state.json` is
the single source of truth and is normally command-owned, so treat this as a
LEAD-only, backed-up edit. Replace the role id in `packages[].owner`,
`batch.slices[].owner` and `subitems[].owner` (including compound values such as
`"DEV; QA"`), keep archived history untouched unless asked, then run
`atk state check`, `atk state board` and `atk board`. If the work is already
archived, leave it.

## Step 5 - Verify (do not skip)

```bash
atk ownership verify-config     # exit 0; {"ok": true, "rules": <n>, "problems": []}
atk state check                 # exit 0; JSON on stdout, status line on stderr ("PASS"/"通过")
atk board --json                # exit 0; agents[] has every role exactly once, sorted by id
atk queue --for <ROLE>          # new role: exit 0 and count 0 (label is localized)
atk ownership map <path>        # "<path> -> <ROLE> [<prefix>]"; rootFiles hits show [rootFiles]
atk ownership check --role <ROLE> --files "<path>"   # PASS, exit 0
```

Failure signals: `verify-config` exits 1 with `ok:false`; `queue` exits 2 with
`unknown role "<X>" (configured: ...)`. Quote comma lists on PowerShell.

`verify-config` only reads `ownership.json`; it does not compare it with
`config.roles`. Check the two lists yourself. The comparison is order-free (config
order is display order; ownership order has no meaning), and it follows the
configured config file, flow dir, `paths.ownership` override and a UTF-8 BOM:

```bash
node -e "const fs=require('fs');const read=p=>fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');const pick=['agent-flow.config.json','.agent-flow/config.json'].find(p=>fs.existsSync(p));const cfg=JSON.parse(read(pick));const flow=cfg.layout.flowDir;const ownPath=(cfg.paths&&cfg.paths.ownership)||flow+'/ownership.json';const own=JSON.parse(read(ownPath));const a=[...cfg.roles].sort().join(',');const b=[...own.roles].sort().join(',');console.log(a===b?'roles in sync':'MISMATCH config='+a+' ownership='+b);process.exit(a===b?0:1);"
```

Also check:

- `<flowDir>/roles/` holds exactly one card per configured role, with no orphan
  cards left from a rename;
- after a remove or rename, search the config and the flow directory for the old
  id (`state.json` owner strings, `runtime.json`, `README.md`, `current-batch.md`,
  `commands.md`, `task-template.md`, `human-todos.json`, docs). Hits in
  archived/historical records are expected; hits in live files are not;
- `board.md` has no agents section - confirm the runtime entry through
  `atk board --json` or `board.html`, not through the Markdown board;
- if the project wires `atk ownership check` into `atk gate fast`, run it as LEAD
  over your changed files - the role config itself is LEAD-owned.

## Step 6 - Report

```
Roles <before> -> <after>
Files <config + flow files + cards, count>
Verify <commands + results; note any known problem you accepted>
Stale <none | id + file:line>
Rollback <snapshot path, or git restore of the listed files>
```

## Failure table

| Symptom | Cause | Fix |
|---|---|---|
| `rule "tests" references unknown role "QA"` (verify-config, exit 1) | the id was removed from `ownership.json` roles but a rule still names it | reassign the rule (preferred) or delete it |
| `prefix "design" is claimed by both DESIGN and DEV` (verify-config, exit 1) | two rules claim one prefix - usually init's fallback rule plus a new one | edit the existing rule's `role` instead of adding a second |
| `role DESIGN has no write scope` (verify-config, exit 1) | role added without a rule | add a prefix rule, or accept the diagnostic for a scope-less reviewer |
| `unknown role "DESIGN" (configured: LEAD, DEV, QA)` from `atk queue/task` | id missing from `agent-flow.config.json` | add it to `config.roles` |
| Board still shows a deleted role | `runtime.json` entry left behind | remove the agents entry and re-render |
| Board does not show a new role | `runtime.json` entry missing | add the agents entry and re-render |
| `atk gate fast` ownership violation | the change touches paths outside the acting role, or a role claims the wrong path | LEAD performs role-config changes; fix the rule, not the gate |
| State looks reset, human todos vanished, a second flow directory appeared, or `board.html` shows old data | someone ran `atk init --force` | restore the snapshot or `git restore`; `board.html` does not self-heal - run `atk board` after restoring; redo the changes with this skill |
| `atk ownership check --role X` passes but real files are unmapped | rule prefix too narrow or misspelled | `atk ownership map <file>` for each affected path |
| `atk batch manifest` says `... is outside batch.allowedPrefixes` | the role owns a new top-level directory not listed there | add the prefix, and add it to `baseline.roots` / `gates.fast.groups` as needed |

## Do not

- Do not run `atk init --force` on an initialized project.
- Do not hand-edit `board.md`, `board.html` or `state.json` - the one exception is
  the human-authorized owner rewrite above (LEAD only, backup first).
- Do not rename a role by renaming its card; the id is the key.
- Do not give one path to two roles; longest-prefix does not merge ownership.
- Do not put the write scope only in the card - the config is enforced.
- Do not rebuild the whole team on a whim: change one role per request unless the
  user asked for a full re-scoping.

## Card skeleton

```markdown
# Role: <ROLE>

## Write scope

The paths assigned to <ROLE> in `ownership.json` (<list them>). Check with
`atk ownership map <path>` whenever you are unsure - the config is the truth,
not this page.

## Do not

- Do not write paths owned by another role.
- Do not edit another slice's files; shared files change only in the hunks named
  by the ticket.
- Do not mark work done before the gates and human acceptance.
- Do not apply changes to the original tree; only the designated integrator
  applies.
- Do not tick human-only todos.
- <role-specific bans, e.g. DESIGN does not touch src/>

## Task loop

1. `atk task <ID> --for <ROLE>` - take the ticket; confirm dependencies.
2. Work only inside your write scope, on a candidate snapshot.
3. Run the gates the ticket names, e.g.
   `atk gate fast --files <changed> --role <ROLE>`.
4. Run `atk evidence` after receipts land; never hand-edit derived facts.
5. Report the 6-line receipt, then stop.

## Receipt format (6 lines)

Scope / Commands / Tests / Blockers / Evidence / Stop - exactly these six lines,
in this order. (`docs/ROLES.md` and the flow skill call the fifth line
`Snapshot`; keep whatever the project's existing cards use.)

## Commands

    atk queue --for <ROLE>
    atk task <ID> --for <ROLE> --message
    atk ownership check --role <ROLE>
    atk gate fast --files <changed> --role <ROLE>

## Round budget

<= 12 rounds per task (<= 10 for a QA slice). Over budget means stop and report.

## Proof ladder

`typecheck ok` is not `tests passed`, and `tests passed` is not `human-accepted`.
Keep the rungs separate and never inflate evidence.
```

## 中文速查

1. 先读项目和现有配置，列出「角色 / 动作 / 写域 / 为什么」，让用户确认后再动文件。
2. 一次只做一件事：新增、删除、改职责、改名。
3. 每个角色都要同时改齐：`config.roles`、`ownership.json`（roles + rules；已有
   prefix 要改指而不是追加第二条）、`roles/<ID>.md`、`runtime.json` 的 agents；再同步
   `<flowDir>/README.md` 的角色表（新增/移动角色时把失去该 prefix 的原角色那一行一起
   改掉），最后 `atk state board` + `atk board` 重新渲染看板。
4. 删除前先跑 `atk queue --for <角色> --json`，`count` 必须为 0，并检查 `state.json` 的
   `batch.slices` / `subitems` 里没有该角色的 owner（`queue` 只看 packages，
   `state check` 不校验 owner）；删除时把规则改给幸存角色后，同步它的 README 行和卡
   写域。有在途工作就停下问人，不要先删再补。
5. 校验：`atk ownership verify-config`、`atk state check`、`atk board --json`、
   `atk queue --for <角色>`；另外确认 `config.roles` 与 `ownership.json` 的 `roles`
   完全一致（`verify-config` 不比对这两处）。
6. 已有项目上绝不跑 `atk init --force`：它会重写 config、state、ownership、
   human-todos、看板和各角色卡（用户待办会被清空，`board.html` 却不会更新）。
7. Windows PowerShell 里逗号列表必须加引号（`--roles "A,B"`、`--files "a,b"`），
   否则可能报参数错误，或 `--files` 静默只检查第一个文件造成假 PASS。
