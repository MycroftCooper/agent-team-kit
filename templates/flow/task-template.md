# Task ticket template (<= 200 words, 9 fixed lines)

> Tickets are generated, not hand-written:
> `atk task <ID> --for <ROLE> --message`
> prints a ready-to-forward ticket in exactly this shape. This page documents the
> format for hand-written fallbacks and code review.

## Template

```
Task <ID> | <bug|feature|refactor> | <P0|P1|P2> | <module>
Scope <one sentence: what changes this time>
Write scope <paths or globs; for cross-role work: "FE:... / BE:...">
Depends on <ticket id or "none"; "none" means start now>
Exit <checkable completion: deliverable + commands that must pass>
Do not <extra bans for this slice only; role-wide bans live in the role card>
Gates <commands to run, e.g. atk gate fast --files ... --role {{ROLE}}>
Evidence <manifest / receipt / QA json path>
Budget <N rounds; stop and report when exceeded>
```

## Rules

1. **Only this task.** Background and history stay in `state.json` (`note`,
   `evidence`); a ticket that needs a paragraph of context is a missing note.
2. **Exit must be executable.** Write "`atk gate fast` passes + 2 new adapter
   tests", never "finish the adapter".
3. **Do not** lists increments only; the role card already bans shared
   forbidden actions.
4. One thing per line. No sub-headings, no tables, no screenshots.

## Example (feature slice)

```
Task UI-42 | feature | P1 | settings / theme
Scope add a dark-theme override to the settings reducer, no UI wiring
Write scope src/settings/** and adjacent *.test.ts
Depends on none
Exit reducer returns override; 2 new tests; atk gate fast --files src/settings/theme.ts --role DEV passes
Do not touch src/settings/index.tsx; do not add new IPC
Gates atk gate fast --files src/settings/theme.ts --role DEV
Evidence artifacts/evidence/UI-42/manifest.json
Budget 8 rounds
```

## Why the cap

A ticket longer than 200 words means the task was not decomposed. Split it
instead of adding context; the receiving agent reads the ticket, the role card
and the queue, and nothing else.
