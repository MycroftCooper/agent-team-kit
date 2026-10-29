# Agent skills

Three skills teach an agent to participate in the workflow without re-reading the
docs on every task:

| Skill | Use it when |
|---|---|
| [`agent-team-flow`](agent-team-flow/SKILL.md) | the agent takes tickets, edits under a write scope, runs gates and reports a 6-line receipt |
| [`agent-team-board`](agent-team-board/SKILL.md) | the agent renders/serves the board, installs the DSH plugin, or diagnoses a stale board |
| [`agent-team-roles`](agent-team-roles/SKILL.md) | the agent adds, removes, renames or re-scopes roles so the team fits the project |

All are plain directories with a `SKILL.md` that starts with YAML frontmatter
(`name`, `description`) followed by short instructions and commands. They contain
no project-specific paths — every command runs against the project in the current
directory.

## Install into an agent host

Copy or link each skill directory into the place your host reads skills from.
Common layouts:

- **Codex CLI**: `~/.codex/skills/` for personal use, or `.codex/skills/` in the
  repository for project-scoped skills.
- **DeepSeek Harness**: use the skills directory documented by your DSH build;
  install the board plugin separately with `atk plugin sync` (the plugin does not
  install skills for you).

```bash
# POSIX
ln -s /path/to/agent-team-kit/skills/agent-team-flow ~/.codex/skills/agent-team-flow
ln -s /path/to/agent-team-kit/skills/agent-team-board ~/.codex/skills/agent-team-board
ln -s /path/to/agent-team-kit/skills/agent-team-roles ~/.codex/skills/agent-team-roles

# Windows (PowerShell, run as the user; no admin needed for the user profile)
New-Item -ItemType SymbolicLink -Path "$HOME\.codex\skills\agent-team-flow" `
  -Target "D:\GitCode\agent-team-kit\skills\agent-team-flow"
New-Item -ItemType SymbolicLink -Path "$HOME\.codex\skills\agent-team-board" `
  -Target "D:\GitCode\agent-team-kit\skills\agent-team-board"
New-Item -ItemType SymbolicLink -Path "$HOME\.codex\skills\agent-team-roles" `
  -Target "D:\GitCode\agent-team-kit\skills\agent-team-roles"
```

If symlinks are not available, copy the directories instead — the skills are
static text and are safe to vendor into a project.

## Make the `atk` CLI available

The skills call `atk`; pick one of:

```bash
npm install --global agent-team-kit     # atk on PATH
npx agent-team-kit <command>            # no install
node <checkout>/bin/atk.mjs <command>   # run from a source checkout
```

When the CLI is not on PATH, tell the agent the exact invocation in its project
instructions (for example `npx agent-team-kit`) so skill examples still work.

## Customize them

- Keep the YAML frontmatter (`name`, `description`) — hosts index by it.
- Keep commands aligned with your project's copy of `atk`; do not invent flags.
- Role-specific behaviour belongs in the generated flow-dir role cards
  (`<flowDir>/roles/<ROLE>.md`), not in a fork of the skill.
- Changing *which roles exist* is a project edit, not a skill fork: follow
  `agent-team-roles` and keep its verification step. Never re-run
  `atk init --force` on a live project to add a role — it resets `state.json`,
  `ownership.json`, the boards and every role card.

## Verify the install

In a project that has `agent-flow.config.json`:

```bash
atk queue --for DEV
atk state board --compact
```

If those fail, the skill will too: fix the CLI/config first, then re-open the
skill.
