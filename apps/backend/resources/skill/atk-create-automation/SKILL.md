---
name: atk-create-automation
description: Design or configure an ATK automation pipeline for a workspace, including CLI steps, manual, local Git and timed triggers, and run progress. Use for CI, smoke tests, packaging, or other repeatable project commands.
---

# Create an ATK automation pipeline

1. Identify the explicit registered project ID. Inspect its scripts, instructions and release policy, then use `atk-agent automation list --project <id>` and `show <workflowId>` to read existing definitions and revisions. Agent credentials can configure and run their own project's automations; use the Agent API, not a private browser session.
2. Prepare a schemaVersion 1 JSON definition. Save through `automation apply`, which writes `<project>/.atk/automations/<id>.json`. Use a stable lowercase ID, name, typed parameters with defaults or required:true, and sequential steps with `id`, `name`, `cli`, `args`. UI forms and JSON editing write the same files. Do not write managed run/state files yourself.
3. Keep executable and arguments separate: `cli: "node"`, `args: ["scripts/check.mjs", "--mode", "${params.mode}"]`. Use `${step.dir}/output` or the injected `ATK_OUTPUT_DIR` for unique output. ATK does not implicitly invoke a shell. Windows .cmd/.bat tools need a project Node adapter or an explicit interpreter file entry. Put pipelines and platform differences in scripts, never concatenate untrusted parameter text into shell source. Use `env` entries with `value` or `fromEnv` for machine configuration; ATK_* names are reserved.
4. Declare exports with id, path, kind (file/directory), required. Paths are project-relative or `${step.dir}/output/...`; managed exports must come from this step's output directory. Prefer unique outputs: unchanged fixed-path files cannot prove freshness. Set `result: {"protocol":"exit-code"}` for ordinary commands. For rich results, reference a required file export using `{"protocol":"atk-ci-result/v1","exportId":"report"}`. Its JSON must contain schemaVersion:1, this ATK_RUN_ID, this ATK_STEP_ID and status:passed/failed; optional checks contain unique IDs, names and passed/failed/skipped statuses. A missing/invalid report or a nonzero exit never succeeds.
5. For live UI progress emit complete UTF-8 stdout lines, reporting only observed facts:

       ::atk::{"schemaVersion":1,"type":"progress","percent":40,"current":"rust-test"}
       ::atk::{"schemaVersion":1,"type":"heartbeat"}
       ::atk::{"schemaVersion":1,"type":"info","values":{"testsPassed":12}}

   Percentage is optional when unknown. Heartbeats keep the UI informed without claiming progress. Keep the CLI in the foreground and wait for its children; detached background work is terminated with the managed process tree.
6. Use `automation validate --file draft.json --project <id>` first; it validates without running CI. Apply with `--create` or `--revision <sha256>` to avoid overwriting concurrent edits. Do not commit version control automatically. For Git-triggered checks set `trigger: {"type":"git-commit","branch":"dev","parameters":{...}}`; the first observed commit is the baseline and later commits require a matching clean checkout. Prefer manual triggers for publishing unless the user requested automatic publishing.
7. Run with `automation run <workflowId> --revision <sha256> --project <id>` and optionally repeated `--param name=value`, `--params-file params.json`, or `--wait`. Keep the request ID for retries. All runs return one runId also visible in the UI. Inspect `status`, `logs --follow`, and archived reports under `.atk/runs/<runId>/`. Disconnecting the Agent does not stop CI; use `stop <runId>` explicitly. Only humans can confirm a recovery-required process stopped. Creating a release definition does not authorize publishing it.

For timed CI add an optional `schedules` array to the same definition. One or more
absolute timestamps use `{"id":"dates","type":"at","times":["2026-12-01T09:00:00+08:00"],"parameters":{...}}`.
Fixed repeats use `{"id":"repeat","type":"interval","startAt":"2026-12-01T09:00:00+08:00","everySeconds":3600,"count":5,"parameters":{...}}`;
omit count for ongoing intervals. IDs are stable and unique per workflow;
enabled defaults to true, and enabled:false pauses the plan. Use at most 32 plans,
1–100 distinct at-times, intervals of 60–31622400 integer seconds and an optional
count of 1–1000000 slots including the first. Parameters use the same declared
defaults/types, and every required parameter must be supplied. Use explicit UTC
offsets or Z; unzoned local timestamps are rejected. Intervals are elapsed time,
not calendar/cron rules. Read `automation schedules <workflowId> --project <id>`
for nextAt, latest dispatch, linked runId and local scheduling errors. Apply the
full definition with its revision to change, pause, enable or remove a plan.

Plans run only while the local ATK backend is running. First discovery or changes
skip expired slots; missed or busy slots are consumed without queues or replay.
Count means scheduled slots, including skips. A crash with uncertain dispatch
does not blindly retry. Keep publishing parameters at their declared defaults
unless automatic publishing was explicitly authorized. Configuring a workflow
does not authorize scheduling real publishing. Scheduled runs use source
`{"type":"schedule","scheduleId":"...","scheduledAt":"...Z"}` and the same
per-run project archives; schedule cursors and decisions live in ignored
`.atk/local/<machineId>/`. Do not write those managed files yourself.

Minimal definition (the project supplies scripts/check.mjs):

```json
{
  "schemaVersion": 1,
  "id": "local-check",
  "name": "Local checks",
  "parameters": { "mode": { "type": "string", "enum": ["quick", "local"], "default": "quick" } },
  "trigger": { "type": "manual" },
  "steps": [{
    "id": "checks",
    "name": "Project checks",
    "cli": "node",
    "args": ["scripts/check.mjs", "--mode", "${params.mode}"],
    "timeoutMs": 900000,
    "exports": [],
    "result": { "protocol": "exit-code" }
  }]
}
```

For a typed report add an export like `{"id":"report","path":"${step.dir}/output/result.json","kind":"file","required":true}`
and set the step result to `{"protocol":"atk-ci-result/v1","exportId":"report"}`. Missing or invalid reports fail rather than silently falling back to the exit code.
