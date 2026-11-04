# External Agent Protocol v1

This protocol coordinates already-running local agents. It does not select a
model, launch an agent, forward a provider request or interpret terminal text.

## Authentication and lifecycle

Create an identity in the browser, bind its role/team, and save its one-time
credential outside the project. Requests use `Authorization: Bearer <credential>`.
Agent endpoints reject browser-origin calls. Browser session/CSRF endpoints do
not accept Agent credentials for human approvals.

Base URL: `http://127.0.0.1:1421/api/agent/v1`.

| Method and path            | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `POST /connect`            | Report identity online; get heartbeat/lease intervals        |
| `POST /heartbeat`          | Idle identity heartbeat                                      |
| `POST /claims`             | Atomically claim eligible planning, execution or review work |
| `GET /runs/:id`            | Reconcile your run status and last acknowledged result       |
| `POST /runs/:id/heartbeat` | Renew a run; observe stop requests                           |
| `POST /runs/:id/events`    | Progress/log/blocked/usage observations                      |
| `POST /runs/:id/plan`      | Submit ORCHESTRATOR planning output                          |
| `POST /runs/:id/result`    | Submit stopped execution and check evidence                  |
| `POST /runs/:id/review`    | Submit independent verdict bound to target hash              |
| `POST /runs/:id/stopped`   | Confirm a requested/quarantined execution stopped            |
| `GET /runs/:id/artifact`   | Read authorized project output on demand                     |
| `GET /plans/:id`           | Read an authorized previous plan during revision             |

Claims accept `{projectId?,taskId?,stage?,files?,waitMs?}`. `waitMs` is 0–30000.
Stage is checked against the identity: ORCHESTRATOR/PLANNING, WORKER/EXECUTION,
REVIEWER/REVIEW. Optional `files` must exactly match the approved full scope.
Without it the server uses that approved scope. No eligible work returns
`{run:null,waiting:[...],retryAfterMs:1000}`. Prefer another long poll, not a hot loop.

A successful claim contains `{run,spec,generation,leaseUntil}`. Follow `spec`:
it freezes the task/plan versions, function instructions, project root, file
scopes, dependencies, check requirements and output contract. Do not read other
projects or fetch entire histories as context.

Renew every 10 seconds with `{generation}`; the lease lasts 30 seconds. Stop
writing if renewal fails or returns `stopRequired:true`. Expired leases are not
automatically released. After external execution stops, acknowledge with
`{generation,stopped:true}`. A human can also confirm stopped from the UI.

## Planning receipt

```json
{
  "generation": 1,
  "idempotencyKey": "unique-stable-submission-key",
  "plan": {
    "summary": "Implement and validate the requested feature",
    "nodes": [
      {
        "key": "implementation",
        "title": "Implement the feature",
        "description": "What to build and what to leave alone",
        "acceptance": "Observable completion criteria",
        "executorType": "AGENT",
        "roleId": "role-dev",
        "files": ["src/feature.mjs", "test/feature.test.mjs"],
        "checks": [
          { "name": "unit", "command": "node --test test/feature.test.mjs" }
        ],
        "reviewPolicy": "INDEPENDENT",
        "reviewRoleId": "role-qa",
        "deps": [],
        "priority": 2
      },
      {
        "key": "human-confirmation",
        "title": "Confirm the business outcome",
        "description": "Review the demonstrated behavior",
        "acceptance": "Human confirms the outcome",
        "executorType": "HUMAN",
        "files": [],
        "checks": [],
        "reviewPolicy": "NONE",
        "deps": ["implementation"]
      }
    ]
  }
}
```

Keys must be unique. Dependencies refer to keys within this plan and cannot
contain cycles. Human approval happens separately in the web UI; a successful
submission does not grant execution permission. Read `revisionNote` and the
referenced previous plan when replanning.

File declarations are relative literal files or directories ending in `/`.
No globs, `..`, drive paths, `.git`, managed metadata, device names or alternate
streams. Use narrow scopes. `.` requests the whole project and serializes writers.

## Execution and review receipts

Stop all writes before submitting an execution result:

```json
{
  "generation": 1,
  "idempotencyKey": "stable-result-key",
  "outcome": "COMPLETED",
  "stopped": true,
  "summary": "Implemented the feature",
  "checks": [
    { "name": "unit", "passed": true, "exitCode": 0, "log": "1 test passed" }
  ],
  "usage": { "inputTokens": 1200, "outputTokens": 300, "cachedTokens": 400 }
}
```

`outcome` may also be FAILED or INTERRUPTED. All named mandatory checks must be
present, uniquely named and green for COMPLETED. No receipt may silently skip a
required check. Missing usage is unknown, never zero. Usage is externally reported.

Independent review:

```json
{
  "generation": 2,
  "idempotencyKey": "stable-review-key",
  "targetHash": "the hash returned in the review spec",
  "verdict": "PASS",
  "summary": "Output and checks meet the approved criteria",
  "findings": []
}
```

Other verdicts: CHANGES_REQUESTED or BLOCKED. Three failed/rework execution
attempts block automatic rework; explicit human intervention is then required.
The reviewer and PM author cannot be the execution author. A changed candidate
is refused even if the submitted target hash used to be valid.

Progress events use `{generation,events:[{eventId,type,message,usage?}]}`. Supported
types: progress, log, blocked, usage. Events are observations; emitting a message
that says "done" never completes a task. At most 100 events per batch, HTTP JSON
body limit 512 KiB. Reuse the same event IDs when retrying a batch.

## Durable acknowledgements and recovery

Only `{persisted:true}` acknowledges a final submission. Use the same submission
key and generation after a lost response; query the run status if uncertain.
Never assume a network failure means a result was rejected. Stop-confirmation
does not roll back files. The CLI writes pending submissions to an installation
client directory and `atk-agent replay` retries them.

Useful error codes include FILE_LOCKED, DEPENDENCIES, SCOPE_MISMATCH,
STALE_GENERATION, LEASE_EXPIRED, RUN_NOT_ACTIVE, REVIEW_STALE, APPROVAL_STALE and
VERSION_CONFLICT. The JSON envelope is `{error:{code,message,details}}`.

Clients must stop on revoked credentials, expired leases or uncertain ownership.
This protocol cannot forcibly stop an external writer. No provider credentials
belong in events, check logs, receipts, generated documentation or application logs.
