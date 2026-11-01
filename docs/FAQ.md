# FAQ

### Is this tied to DeepSeek Harness?

No. The workflow is a Node CLI plus JSON/Markdown files. The DSH board plugin is
optional (`--no-plugin`), and the markdown/HTML board works without DSH.

### Do I need git?

No. `atk baseline start` / `atk baseline changed` give a change baseline that does
not depend on commits. Git helps for review, but no command requires a clean tree
or a commit.

### Are there dependencies?

None. Node.js >= 20.11 built-ins only, ESM. That constraint is intentional: the
toolkit must run from a bare `node` inside any project, including offline ones.

### Why did `atk init` refuse?

An `agent-flow.config.json` (or `.agent-flow/config.json`) already exists. This is
a guard against silently overwriting a live workflow. Re-run with `--force` only
when you intend to regenerate: it rewrites `state.json`, `ownership.json`, the
boards and every role card. To change roles on a live project, use the
`agent-team-roles` skill instead.

### What exactly does `atk init` write?

`agent-flow.config.json`, the flow directory (state, ownership, runtime, human
todos, task template, command sheet, current batch, board, a README and one role
card per role), and — unless `--no-plugin` — a copy of the DSH board plugin. Use
`--dry-run` to print the full list first.

### Can I customize the generated docs?

Yes. They are ordinary Markdown/JSON. `--force` regenerates them, so keep custom
edits in separate files or make them after the last `init`. Role cards are meant
to be edited per project.

### How do I add, remove or change a role (agent)?

Edit the config (`roles` and `functions.roles`), `ownership.json`,
`runtime.json` (the Agent Instance's `id` and `capabilities`), the role card and
the flow README together, then run `atk ownership verify-config`,
`atk state check` and `atk board --json`. The
[`agent-team-roles`](../skills/agent-team-roles/SKILL.md) skill has the exact
order, the card skeleton and the failure table. Do not use `atk init --force` for
this.

### Why doesn't the board update?

The board is derived. Re-render (`atk board` / `atk state board`) or run
`atk serve` for SSE. In the DSH panel the files are watched; if nothing moves, the
writes are not landing where the plugin reads (`layout.flowDir`).

### Can an agent tick a human-only todo?

No. `atk todo` has no auto-tick path and agents must not call `toggle`/`done` for
the user. Only the human (or the board UI clicked by the human) ticks these.

### How do I move the flow directory later?

Edit `layout.flowDir` (and any explicit `paths.*`) in `agent-flow.config.json`,
move the files, then run `atk state check` and `atk board`. Or scaffold the new
location with `atk init --flow-dir <dir> --force` and move your real state files
over. Do not keep two live state files.

### Several projects on one machine — will the DSH panels collide?

`atk init` derives a project-specific plugin identity (`<project>-board`) when
starting from the generic preset, so each project installs under its own
`plugin.id` / `route`. Do not copy one identity into two profiles.

### Does it work on Windows?

Yes; it was built on Windows. Use the npm `bin` or
`node bin/atk.mjs <command>` if `atk` is not on PATH. Paths are normalized to
posix in the files, so a repo is portable between Windows, macOS and Linux.

### How do I uninstall it from a project?

Delete `agent-flow.config.json`, the flow directory and the plugin copy
(`config.plugin.dir`). Nothing is written outside the project except candidate
snapshots and receipts under the OS temp directory, which can be removed with the
normal temp cleanup.

### Where does this workflow come from?

It was extracted from a production desktop-application project whose team ran a
hand-written workflow directory. The templates here are the generalized version;
`docs/MIGRATION.md` walks through adopting an existing layout, and the `p4deck`
preset keeps that original layout as a starting point.

### A command or flag in the docs does not exist. What now?

The command surface is defined in [INTERNALS.md](INTERNALS.md) section 3 and in
each module's `usage()`. Report the mismatch instead of guessing a flag; the test
suite is meant to catch those gaps.

### Is the CLI stable?

The package is `0.x`. The file formats are versioned
(`schemaVersion`, `batch.manifestTag`, `batch.qaSchemaVersion`); CLI flags may
still change in a minor release until 1.0.

### Why is `state.json` large, and do I have to read it?

You do not. Use `atk queue --for <ROLE>`, `atk task <ID> --for <ROLE> --message`
and `atk state board --compact`. `state.json` is machine-oriented; reading it
wastes tokens and invites manual edits.

### Can I use my own gates?

Yes. `gates.fast.groups` and `steps` are fully configurable (any command string or
argv array, conditions on changed file groups). `gates.quick` / `gates.local` are
single commands. See [CONFIG.md](CONFIG.md).

### What happens if an apply is interrupted?

`atk batch apply` writes via the frozen manifest and reports what landed. If the
process dies, re-run `atk batch verify` first: drift or a partial write must be
inspected, not blindly re-applied. The original tree is never modified by any
earlier step.

### How is "no self-review" enforced?

By the scheduler, not by a role card. `atk state task <ID> --for QA` refuses
without `--agent <id>`; the frozen manifest records the producing Agent Instance
(`atk batch manifest --agent <id>`); `qa-approval.json` records the reviewer;
`atk batch verify`/`apply` fail when the reviewer is the producer, when an
identity is missing, or when `runtime.json` does not register the instance;
`atk evidence` refuses to count a provably self-reviewed approval. Exit `1` means
the rule refused; see [ENTITIES.md](ENTITIES.md) for the checks and the
`functions.enforceNoSelfReview` escape hatch.

### How do I know whether a subject may do an operation?

Ask the permission layer:

```bash
atk permit check code.modify --agent agent-fe-01 --task FE-01 --files src/ui/a.ts
```

It evaluates the code-owned matrix plus scope/ownership/state/policy/approval,
prints a machine-readable reason code (`ROLE_DENIED`, `WRITE_SCOPE_VIOLATION`,
`SELF_REVIEW_DENIED`, `APPROVAL_REQUIRED`, ...) and appends the decision to
`artifacts/agent-flow/permission-audit.jsonl`. `atk permit matrix` prints the
whole subject x operation table, `atk permit explain <operation>` shows the
conditions, and `atk permit audit` reads the trail. See
[PERMISSIONS.md](PERMISSIONS.md).

### Does the kit enforce "no production access"?

Not technically. It provides the gates, receipts and the stop conditions; the
role cards state the non-negotiables. If you need a hard ban, express it as a gate
step or a CI policy around the commands.

### Does the kit enforce separation of duties?

Yes, for review: the entity model's `REVIEWER`/`WORKER` runs carry Agent Instance
identities, and the scheduler refuses a self-review (see the question above).
Other social rules (the do-not lists) remain documentation plus gates.
