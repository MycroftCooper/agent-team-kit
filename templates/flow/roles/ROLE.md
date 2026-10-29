# Role: {{ROLE}}

> This is the generic role card. Customize it for your project; it is generated
> once by `atk init` and never rewritten afterwards.

## Write scope

The paths assigned to {{ROLE}} in `ownership.json`. Check with
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

## Task loop

1. `atk task <ID> --for {{ROLE}}` - take the ticket; confirm dependencies.
2. Work only inside your write scope, on a candidate snapshot.
3. Run the gates the ticket names, e.g.
   `atk gate fast --files <changed> --role {{ROLE}}`.
4. Run `atk evidence` after receipts land; never hand-edit derived facts.
5. Report with the 6-line receipt, then stop.

## Receipt format (6 lines)

```
Scope <files or items changed, count>
Commands <what ran + results>; Not run <...>
Tests <what was executed / skipped>
Blockers <none | specific>
Evidence <manifest / receipt path>
Stop <yes/no; any half-written files>
```

## Commands

```bash
atk queue --for {{ROLE}}
atk task <ID> --for {{ROLE}} --message
atk ownership check --role {{ROLE}}
atk gate fast --files <changed> --role {{ROLE}}
```

## Round budget

<= 12 rounds per task. Over budget means stop and report, not work longer.

## Proof ladder

`typecheck ok` is not `tests passed`, and `tests passed` is not
`human-accepted`. Keep the rungs separate and never inflate evidence.
