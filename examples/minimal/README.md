# Minimal demo project

A committed, tiny project that shows the on-disk shape of an agent-team-kit
workflow. It is a fixture, not a real product: the files are intentionally small
so you can diff them against what `atk init` generates.

```
examples/minimal/
  agent-flow.config.json   # project config (flowDir = "flow")
  flow/
    state.json             # 2 packages, 1 batch slice, 1 sub-item
    ownership.json         # src/ -> DEV, tests/ -> QA, docs/ -> LEAD
    human-todos.json       # human-only list
    runtime.json           # who is working on what
    board.md               # rendered board (atk board regenerates board.html)
  src/greet.mjs            # demo product code
  tests/greet.test.mjs     # demo test
```

## Run it

From the repository root:

```bash
node bin/atk.mjs --cwd examples/minimal board          # render flow/board.html
node bin/atk.mjs --cwd examples/minimal board --json   # machine snapshot
node bin/atk.mjs --cwd examples/minimal state check    # validate the state file
node bin/atk.mjs --cwd examples/minimal queue --for DEV
node bin/atk.mjs --cwd examples/minimal serve          # live board on 127.0.0.1
```

If the package is installed globally, the same commands are `atk --cwd
examples/minimal ...`.

## What to look at

- `state.json` is the only source of truth; `board.md` and `board.html` are
  derived.
- `ownership.json` maps path prefixes to roles; a path may not belong to two
  roles.
- `human-todos.json` is the one file an agent must never tick.

Generated files (`flow/board.html`, `artifacts/`) are ignored by
`examples/minimal/.gitignore`.
