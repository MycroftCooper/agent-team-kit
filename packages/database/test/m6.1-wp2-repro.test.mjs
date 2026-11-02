// M6.1 WP2 phase B regression tests (converted from the phase-A red tests).
// Contract: docs/architecture/m6.1-contracts.md; runtime semantics are planned
// by the route, the store receives already-mapped events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathsOverlap, normalizeRepoPath } from "@atk/contracts";
import { filesIntersection } from "../src/model.mjs";
import { advanceTask, bothStores, taskDto } from "./helpers.mjs";

const NOW = "2026-11-02T00:00:00.000Z";

function makeRunWithLease(store, taskId = "TASK-SEED") {
  const run = store.createRun({ taskId, agentId: "agent-1", function: "WORKER", role: "DEV" });
  store.enqueueDispatchCommand({
    runId: run.id,
    commandType: "RUN_TASK",
    payload: {},
    idempotencyKey: `m61-${run.id}`,
  });
  store.claimDispatchCommand({ ownerId: "host-m61", leaseMs: 60_000 });
  return run;
}

function fingerprint(store) {
  return {
    runs: store.listRuns({ limit: 1000 }),
    events: store.listEvents({ limit: 1000 }),
    tasks: store.listTasks({ limit: 1000 }),
    reviews: store.listReviews({ limit: 1000 }),
  };
}

test("F03 applyRuntimeEventBatch is one transaction and failure rolls back", (t) => {
  for (const { label, store } of bothStores(t)) {
    // Old route-style flow still demonstrates why one store call is needed.
    const oldRun = makeRunWithLease(store);
    store.updateRunStatus(oldRun.id, { status: "RUNNING", generation: 1 });
    store.appendRunEvent({
      runId: oldRun.id,
      generation: 1,
      events: [{ type: "run.log", payload: { line: "step 1" } }],
    });
    assert.throws(() =>
      store.appendRunEvent({
        runId: oldRun.id,
        generation: 1,
        events: [{ type: "run.log", payload: "not-an-object" }],
      }),
    );
    assert.equal(store.getRun(oldRun.id).status, "RUNNING", label);
    assert.ok(store.listEvents({ limit: 1000 }).some((event) => event.type === "run.log"), label);

    // Happy path: one run.updated + one run.log in one call.
    const run = makeRunWithLease(store);
    const result = store.applyRuntimeEventBatch({
      runId: run.id,
      generation: 1,
      events: [
        { type: "run.updated", payload: { status: "RUNNING" }, eventId: "EVT-START" },
        { type: "run.log", payload: { runId: run.id, stream: "stdout", text: "hi" }, eventId: "EVT-LOG" },
      ],
      now: NOW,
    });
    assert.equal(result.ok, true, label);
    assert.equal(result.run.status, "RUNNING", label);
    assert.equal(result.applied.length, 2, label);
    assert.equal(result.stateChanged, true, label);
    const replay = store.applyRuntimeEventBatch({
      runId: run.id,
      generation: 1,
      events: [
        { type: "run.updated", payload: { status: "RUNNING" }, eventId: "EVT-START" },
        { type: "run.log", payload: { runId: run.id, stream: "stdout", text: "hi" }, eventId: "EVT-LOG" },
      ],
      now: NOW,
    });
    assert.equal(replay.applied.length, 0, label);
    assert.equal(replay.skipped, 2, label);
    assert.equal(replay.duplicate, 2, label);

    // Mid-write failure: the log event is inserted first, then the status event
    // is an illegal STARTING -> COMPLETED transition -> the batch must roll back.
    const failing = makeRunWithLease(store);
    const before = fingerprint(store);
    assert.throws(() =>
      store.applyRuntimeEventBatch({
        runId: failing.id,
        generation: 1,
        events: [
          { type: "run.log", payload: { runId: failing.id, text: "written first" }, eventId: "EVT-FIRST" },
          { type: "run.updated", payload: { status: "COMPLETED" }, eventId: "EVT-ILLEGAL" },
        ],
        now: NOW,
      }),
    );
    assert.deepEqual(fingerprint(store), before, `${label}: failed batch rolls back completely`);
    assert.equal(store.getRun(failing.id).status, "STARTING", label);
  }
});

test("F08 eventId dedupe keeps 100 same-ms events and replays idempotently", (t) => {
  const oldDedupeKey = (runId, event) => `${runId}|${event.sessionId}|${event.at}|${event.type}`;
  const sameMillisecond = Array.from({ length: 100 }, (_, index) => ({
    type: "run.log",
    payload: { runId: "RUN-1", sessionId: "SESSION-1", text: String(index) },
    eventId: `EVT-${index}`,
    sessionSeq: index,
  }));
  const uniqueUnderOldKey = new Set(sameMillisecond.map((event) => oldDedupeKey("RUN-1", { ...event, at: NOW }))).size;
  assert.equal(uniqueUnderOldKey, 1, "old composite key really does collapse 100 distinct events into 1");

  for (const { label, store } of bothStores(t)) {
    const run = makeRunWithLease(store);
    const batch = {
      runId: run.id,
      generation: 1,
      events: sameMillisecond.map((event) => ({ ...event, payload: { ...event.payload, runId: run.id } })),
      now: NOW,
    };
    const before = store.listEvents({ limit: 1000 }).length;
    const first = store.applyRuntimeEventBatch(batch);
    assert.equal(first.applied.length, 100, `${label}: all 100 eventIds must be retained`);
    assert.equal(first.skipped, 0, label);
    const replay = store.applyRuntimeEventBatch(batch);
    assert.equal(replay.applied.length, 0, `${label}: replay applies nothing`);
    assert.equal(replay.skipped, 100, `${label}: replay skips all 100 duplicates`);
    assert.equal(replay.duplicate, 100, label);
    const afterFirst = fingerprint(store);
    store.applyRuntimeEventBatch(batch);
    store.applyRuntimeEventBatch(batch);
    assert.deepEqual(fingerprint(store), afterFirst, `${label}: triple import stores exactly one copy`);
    assert.equal(store.listEvents({ limit: 1000 }).length, before + 100, label);
    assert.ok(
      store.listEvents({ limit: 1000 }).filter((event) => event.eventId).every((event) => event.sessionSeq !== undefined),
      `${label}: sessionSeq is persisted on event rows`,
    );
  }
});

test("F11 listReviewsPage filters before pagination and pages with an opaque cursor", (t) => {
  for (const { label, store } of bothStores(t)) {
    for (let index = 0; index < 60; index += 1) {
      const taskId = `TASK-R-${String(index).padStart(3, "0")}`;
      store.createTask(taskDto("proj-1", { id: taskId, title: taskId }));
      advanceTask(store, taskId, "REVIEWING");
      store.createReview({ taskId, actor: "HUMAN" });
    }
    const page = store.listReviewsPage({ status: "PENDING", limit: 20 });
    assert.equal(page.items.length, 20, `${label}: first page has 20 pending reviews`);
    assert.equal(page.hasMore, true, label);
    assert.equal(typeof page.nextCursor, "string", label);
    const secondPage = store.listReviewsPage({ status: "PENDING", limit: 20, cursor: page.nextCursor });
    assert.equal(secondPage.items.length, 20, label);
    const thirdPage = store.listReviewsPage({ status: "PENDING", limit: 20, cursor: secondPage.nextCursor });
    assert.equal(thirdPage.items.length, 20, `${label}: third page has the remaining 20`);
    assert.equal(thirdPage.hasMore, false, label);
    assert.equal("nextCursor" in thirdPage, false, label);
    const allIds = [...page.items, ...secondPage.items, ...thirdPage.items].map((review) => review.id);
    assert.equal(new Set(allIds).size, 60, `${label}: all 60 reviews are reachable exactly once`);
    // The filter runs before pagination: a non-matching status sees nothing.
    assert.equal(store.listReviewsPage({ status: "PASS", limit: 20 }).items.length, 0, label);
    assert.ok(Array.isArray(store.listReviews({ status: "PENDING", limit: 100 })), label);
    assert.throws(
      () => store.listReviewsPage({ cursor: "not-a-cursor" }),
      (error) => error.code === "VALIDATION_ERROR" && error.details.field === "cursor",
      label,
    );
  }
});

test("F13 database filesIntersection uses the shared @atk/contracts path rules", () => {
  const cases = [
    ["src", "src/a.ts", true],
    ["src/", "src/a.ts", true],
    ["src", "src2/a.ts", false],
    ["src\\a.ts", "./src/a.ts", true],
    ["src/a.ts", "src/A.ts", false],
    [" src ", "src/a.ts", true],
  ];
  for (const [left, right, expected] of cases) {
    const database = filesIntersection([left], [right]).length > 0;
    const shared = pathsOverlap(left, right);
    assert.equal(database, expected, `database: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    assert.equal(shared, expected, `contracts: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    assert.equal(database, shared, `database and contracts diverge on ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    assert.equal(normalizeRepoPath(` ${left} `), normalizeRepoPath(left), "shared trim rule");
  }
});

test("F03 one batch may carry several ordered run.updated transitions (m2-smoke regression)", (t) => {
  for (const { label, store } of bothStores(t)) {
    // session.started + session.ended mapped by the route = RUNNING then COMPLETED.
    const run = makeRunWithLease(store);
    const applied = store.applyRuntimeEventBatch({
      runId: run.id,
      generation: 1,
      events: [
        { type: "run.updated", payload: { status: "RUNNING" }, eventId: "EVT-RUNNING" },
        { type: "run.updated", payload: { status: "COMPLETED", exitCode: 0 }, eventId: "EVT-COMPLETED" },
      ],
      now: NOW,
    });
    assert.equal(applied.ok, true, label);
    assert.equal(applied.run.status, "COMPLETED", label);
    assert.equal(applied.applied.length, 2, `${label}: both run.updated events are persisted`);
    assert.equal(
      store.listEvents({ limit: 1000 }).filter((event) => event.eventId === "EVT-COMPLETED").length,
      1,
      label,
    );

    // A skipped step is rejected BEFORE any write, with the event index.
    const skipped = makeRunWithLease(store);
    const before = fingerprint(store);
    assert.throws(
      () =>
        store.applyRuntimeEventBatch({
          runId: skipped.id,
          generation: 1,
          events: [{ type: "run.updated", payload: { status: "COMPLETED" }, eventId: "EVT-SKIP" }],
          now: NOW,
        }),
      (error) =>
        error.code === "VALIDATION_ERROR" &&
        error.details.index === 0 &&
        error.details.field === "type" &&
        error.details.from === "STARTING" &&
        error.details.to === "COMPLETED",
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: illegal transition writes nothing`);
  }
});

test("F06 createReview is an assignment and enters REVIEWING atomically", (t) => {
  for (const { label, store } of bothStores(t)) {
    const taskId = "TASK-F06";
    store.createTask(taskDto("proj-1", { id: taskId }));
    advanceTask(store, taskId, "RUNNING");
    const run = makeRunWithLease(store, taskId);
    store.updateRunStatus(run.id, { status: "RUNNING", generation: 1 });
    store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0, generation: 1 });
    const reviewerRun = store.createRun({ taskId, agentId: "reviewer-agent-1", function: "REVIEWER", role: "QA" });
    const review = store.createReview({
      taskId,
      runId: run.id,
      reviewerRunId: reviewerRun.id,
      reviewerAgentId: "reviewer-agent-1",
      assignedTo: "AGENT",
      createdByRole: "scheduler",
    });
    assert.equal(review.status, "PENDING", label);
    assert.equal(review.assignedTo, "AGENT", label);
    assert.equal(review.reviewerAgentId, "reviewer-agent-1", label);
    assert.equal(store.getTask(taskId).status, "REVIEWING", `${label}: createReview enters REVIEWING`);

    // Self-review at assignment time.
    store.createTask(taskDto("proj-1", { id: "TASK-F06-SELF" }));
    advanceTask(store, "TASK-F06-SELF", "RUNNING");
    const ownRun = makeRunWithLease(store, "TASK-F06-SELF");
    store.updateRunStatus(ownRun.id, { status: "RUNNING", generation: 1 });
    store.updateRunStatus(ownRun.id, { status: "COMPLETED", exitCode: 0, generation: 1 });
    assert.throws(
      () =>
        store.createReview({
          taskId: "TASK-F06-SELF",
          runId: ownRun.id,
          reviewerAgentId: "agent-1",
          assignedTo: "AGENT",
          createdByRole: "scheduler",
        }),
      (error) => error.code === "SELF_REVIEW_FORBIDDEN",
      label,
    );

    // No COMPLETED run -> no-completed-run.
    store.createTask(taskDto("proj-1", { id: "TASK-F06-NORUN" }));
    advanceTask(store, "TASK-F06-NORUN", "RUNNING");
    assert.throws(
      () => store.createReview({ taskId: "TASK-F06-NORUN", actor: "HUMAN" }),
      (error) => error.code === "VALIDATION_ERROR" && error.details.reason === "no-completed-run",
      label,
    );
  }
});

test("F01 recordIntegration persists evidence and is idempotent per manifest", (t) => {
  for (const { label, store } of bothStores(t)) {
    const taskId = "TASK-INT";
    store.createTask(taskDto("proj-1", { id: taskId }));
    const hash = "a".repeat(64);
    store.patchTask(taskId, { expectedVersion: store.getTask(taskId).version, changes: { targetHash: hash } });
    advanceTask(store, taskId, "INTEGRATING");
    const run = makeRunWithLease(store, taskId);
    const first = store.recordIntegration({
      taskId,
      runId: run.id,
      commitSha: "0123456789abcdef",
      manifestHash: hash,
    });
    assert.equal(first.task.status, "AWAITING_ACCEPTANCE", label);
    assert.equal(first.integration.taskId, taskId, label);
    assert.equal(first.integration.manifestHash, hash, label);
    const second = store.recordIntegration({
      taskId,
      runId: run.id,
      commitSha: "0123456789abcdef",
      manifestHash: hash,
    });
    assert.equal(second.integration.id, first.integration.id, `${label}: idempotent per (task, manifest)`);
    assert.equal(store.getTask(taskId).status, "AWAITING_ACCEPTANCE", label);

    // A mismatching hash is APPROVAL_STALE and writes nothing.
    store.createTask(taskDto("proj-1", { id: "TASK-INT-BAD" }));
    store.patchTask("TASK-INT-BAD", {
      expectedVersion: store.getTask("TASK-INT-BAD").version,
      changes: { targetHash: hash },
    });
    advanceTask(store, "TASK-INT-BAD", "INTEGRATING");
    const badRun = makeRunWithLease(store, "TASK-INT-BAD");
    const before = fingerprint(store);
    assert.throws(
      () =>
        store.recordIntegration({
          taskId: "TASK-INT-BAD",
          runId: badRun.id,
          commitSha: "0123456789abcdef",
          manifestHash: "b".repeat(64),
        }),
      (error) => error.code === "APPROVAL_STALE",
      label,
    );
    assert.deepEqual(fingerprint(store), before, label);
  }
});

test("F06 self-review uses the reviewed producer, never the reviewer's active Run", (t) => {
  for (const { label, store } of bothStores(t)) {
    const taskId = "TASK-F06-PRODUCER";
    store.createTask(taskDto("proj-1", { id: taskId }));
    advanceTask(store, taskId, "RUNNING");
    const producer = makeRunWithLease(store, taskId);
    store.updateRunStatus(producer.id, { status: "RUNNING", generation: 1 });
    store.updateRunStatus(producer.id, { status: "COMPLETED", exitCode: 0, generation: 1 });
    const review = store.createReview({
      taskId,
      runId: producer.id,
      reviewerRunId: (() => {
        const reviewerRun = store.createRun({ taskId, agentId: "reviewer-1", function: "REVIEWER", role: "QA" });
        return reviewerRun.id;
      })(),
      reviewerAgentId: "reviewer-1",
      assignedTo: "AGENT",
      createdByRole: "scheduler",
    });
    // The reviewer's own active Run must NOT become the "author".
    store.createRun({ taskId, agentId: "reviewer-1", function: "REVIEWER", role: "QA" });
    const submitted = store.submitReview({
      id: review.id,
      expectedVersion: review.version,
      verdict: "PASS",
      manifestHash: "c".repeat(64),
      evidence: { tests: { passed: 1, total: 1 } },
      actor: "reviewer-1",
      reviewerAgentId: "reviewer-1",
    });
    assert.equal(submitted.review.status, "PASS", `${label}: reviewer may submit (producer is agent-1)`);
    assert.equal(submitted.task.status, "INTEGRATING", label);

    // reviewer == producer -> the assignment itself is refused.
    const selfTask = "TASK-F06-SELF-PRODUCER";
    store.createTask(taskDto("proj-1", { id: selfTask }));
    advanceTask(store, selfTask, "RUNNING");
    const selfRun = makeRunWithLease(store, selfTask);
    store.updateRunStatus(selfRun.id, { status: "RUNNING", generation: 1 });
    store.updateRunStatus(selfRun.id, { status: "COMPLETED", exitCode: 0, generation: 1 });
    const selfReviewerRun = store.createRun({ taskId: selfTask, agentId: "agent-1", function: "REVIEWER", role: "QA" });
    assert.throws(
      () =>
        store.createReview({
          taskId: selfTask,
          runId: selfRun.id,
          reviewerRunId: selfReviewerRun.id,
          reviewerAgentId: "agent-1",
          assignedTo: "AGENT",
          createdByRole: "scheduler",
        }),
      (error) => error.code === "SELF_REVIEW_FORBIDDEN",
      label,
    );

    // review.runId missing -> fall back to the latest COMPLETED producer.
    const legacyTask = "TASK-F06-LEGACY";
    store.createTask(taskDto("proj-1", { id: legacyTask }));
    advanceTask(store, legacyTask, "REVIEWING");
    const completed = makeRunWithLease(store, legacyTask);
    store.updateRunStatus(completed.id, { status: "RUNNING", generation: 1 });
    store.updateRunStatus(completed.id, { status: "COMPLETED", exitCode: 0, generation: 1 });
    const legacyReview = store.createReview({ taskId: legacyTask, actor: "HUMAN" });
    const legacySubmit = store.submitReview({
      id: legacyReview.id,
      expectedVersion: legacyReview.version,
      verdict: "PASS",
      manifestHash: "e".repeat(64),
      evidence: { tests: { passed: 1, total: 1 } },
      actor: "reviewer-legacy",
    });
    assert.equal(legacySubmit.review.status, "PASS", `${label}: completed producer fallback`);

    // review.runId missing and no COMPLETED producer -> review-run-unknown.
    const unknownTask = "TASK-F06-UNKNOWN";
    store.createTask(taskDto("proj-1", { id: unknownTask }));
    advanceTask(store, unknownTask, "REVIEWING");
    store.createRun({ taskId: unknownTask, agentId: "agent-1", function: "WORKER", role: "DEV" });
    const unknownReview = store.createReview({ taskId: unknownTask, actor: "HUMAN" });
    const before = fingerprint(store);
    assert.throws(
      () =>
        store.submitReview({
          id: unknownReview.id,
          expectedVersion: unknownReview.version,
          verdict: "PASS",
          manifestHash: "f".repeat(64),
          evidence: { tests: { passed: 1, total: 1 } },
          actor: "reviewer-unknown",
        }),
      (error) => error.code === "VALIDATION_ERROR" && error.details.reason === "review-run-unknown",
      label,
    );
    assert.deepEqual(fingerprint(store), before, label);
  }
});

test("F01 patchTask refuses direct execution-state transitions", (t) => {
  const transitions = [
    ["READY", "CLAIMED"],
    ["CLAIMED", "RUNNING"],
    ["RUNNING", "REVIEWING"],
    ["REVIEWING", "INTEGRATING"],
    ["INTEGRATING", "AWAITING_ACCEPTANCE"],
    ["AWAITING_ACCEPTANCE", "DONE"],
  ];
  for (const { label, store } of bothStores(t)) {
    for (const [from, to] of transitions) {
      const taskId = `TASK-F01-${from}`;
      store.createTask(taskDto("proj-1", { id: taskId }));
      if (from !== "READY") advanceTask(store, taskId, from);
      const task = store.getTask(taskId);
      const before = fingerprint(store);
      assert.throws(
        () => store.patchTask(taskId, { expectedVersion: task.version, changes: { status: to } }),
        (error) =>
          error.code === "TASK_VERSION_CONFLICT" &&
          error.details.reason === "execution-state-guard" &&
          error.details.requestedStatus === to,
        `${label}: patchTask must not allow ${from} -> ${to}`,
      );
      assert.deepEqual(fingerprint(store), before, `${label}: rejected ${from} -> ${to} writes nothing`);
    }
  }
});
