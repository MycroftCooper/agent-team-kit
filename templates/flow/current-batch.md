# Current batch (rolling, <= 60 lines)

> History lives in the archive; this page only carries "now". The source of
> truth is still `state.json` - run `atk state board` for the rendered view.
> Overwrite this page at the start of every batch.

## Batch

- **ID**: `{{BATCH_ID}}`
- **Goal**: one sentence, written by LEAD.
- **Stop condition**: what must be true before the batch stops.
- **Out of scope**: work explicitly deferred to a later batch.

## Progress

Slice status is not written here: read it from `state.json` (`batch.slices`)
or `atk state board`. After a receipt lands, run `atk evidence` to derive
`qaPassed` / `applied`.

## Rolling decisions (newest first; move older than 10 to the archive)

1. {{DATE}} - workflow initialised by `atk init`; role contracts and write
   scopes are in force.
2. {{DATE}} - LEAD owns `state.json`, `runtime.json` and the human-only todo
   list. Agents propose; LEAD records.

## Waiting on the user

1. Confirm the batch goal and stop condition.
2. Confirm that no in-flight work will be lost before the apply step.

## Batch close-out (record 4 numbers with `atk measure record`)

Entry reads, role rounds, gate duration, freeze -> QA interval.
