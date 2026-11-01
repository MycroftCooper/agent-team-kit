// Run lifecycle (ATK-202 / m2-contracts §2/§3): createRun, the Run state
// machine, run.created/run.updated events and the read paths over both stores.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_STATUSES } from "@atk/contracts";
import {
  RUN_TERMINAL_STATUSES,
  allowedRunTransitionsFrom,
  canTransitionRun,
  runStatusMachine,
} from "../src/model.mjs";
import { bothStores, seedDispatch, seedRun } from "./helpers.mjs";

const EXPECTED_RUN_TRANSITIONS = {
  QUEUED: ["STARTING"],
  STARTING: ["RUNNING", "FAILED", "INTERRUPTED"],
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
};

function runEvents(store) {
  return store.listEvents({ projectId: "proj-1", limit: 1000 }).filter((event) => event.type === "run.created" || event.type === "run.updated");
}

test("Run state machine is a pure total function with the documented table", () => {
  assert.deepEqual([...RUN_TERMINAL_STATUSES], ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]);
  assert.equal(runStatusMachine.canTransition, canTransitionRun);
  assert.equal(runStatusMachine.allowedTransitions, allowedRunTransitionsFrom);
  for (const from of RUN_STATUSES) {
    assert.deepEqual(allowedRunTransitionsFrom(from), EXPECTED_RUN_TRANSITIONS[from], `allowed(${from})`);
    for (const to of RUN_STATUSES) {
      const expected = from === to || EXPECTED_RUN_TRANSITIONS[from].includes(to);
      assert.equal(canTransitionRun(from, to), expected, `canTransitionRun(${from}, ${to})`);
    }
  }
  for (const status of RUN_STATUSES) assert.equal(canTransitionRun(status, status), true);
  assert.equal(canTransitionRun("NOPE", "RUNNING"), false);
  assert.equal(canTransitionRun("RUNNING", "NOPE"), false);
  // A runtime that never started a session cannot "complete".
  assert.equal(canTransitionRun("STARTING", "COMPLETED"), false);
  // Terminal runs are history: no way out.
  for (const terminal of RUN_TERMINAL_STATUSES) {
    assert.deepEqual(allowedRunTransitionsFrom(terminal), []);
  }
});

test("createRun validates the task and starts at STARTING with an auto attempt", (t) => {
  for (const { label, store } of bothStores(t)) {
    assert.throws(
      () => store.createRun({ taskId: "TASK-MISSING", agentId: "agent-dev-01", function: "WORKER", role: "DEV" }),
      (error) => error.code === "NOT_FOUND" && error.details.entity === "task",
      label,
    );
    for (const dto of [
      { taskId: "TASK-SEED", agentId: "agent-dev-01", function: "BUILDER", role: "DEV" },
      { taskId: "TASK-SEED", agentId: "agent-dev-01", function: "WORKER", role: "dev" },
      { taskId: "TASK-SEED", agentId: "bad agent", function: "WORKER", role: "DEV" },
      { taskId: "TASK-SEED", agentId: "agent-dev-01", function: "WORKER", role: "DEV", attempt: 0 },
    ]) {
      assert.throws(() => store.createRun(dto), (error) => error.code === "VALIDATION_ERROR", label);
    }

    const first = seedRun(store, { workspaceId: "ws-1" });
    assert.equal(first.status, "STARTING");
    assert.equal(first.version, 0);
    assert.equal(first.attempt, 1);
    assert.equal(first.role, "DEV");
    assert.equal(first.workspaceId, "ws-1");
    assert.equal(first.taskId, "TASK-SEED");
    assert.equal(first.startedAt, undefined);
    assert.equal(first.endedAt, undefined);

    const second = seedRun(store);
    assert.equal(second.attempt, 2, `${label}: attempt auto-increments per task`);
    assert.equal(store.getRun(first.id).id, first.id);
    assert.throws(() => store.getRun("RUN-MISSING"), (error) => error.code === "NOT_FOUND");
    assert.throws(
      () => store.createRun({ id: first.id, taskId: "TASK-SEED", agentId: "agent-dev-01", function: "WORKER", role: "DEV" }),
      (error) => error.code === "VALIDATION_ERROR" && /already exists/.test(error.message),
    );

    const created = store.listEvents({ projectId: "proj-1", limit: 1000 }).filter((event) => event.type === "run.created");
    assert.equal(created.length, 2, label);
    const payload = created[0].payload;
    assert.equal(payload.runId, first.id);
    assert.equal(payload.taskId, "TASK-SEED");
    assert.equal(payload.attempt, 1);
    assert.equal(payload.status, "STARTING");
    assert.equal(created[0].aggregateType, "run");
    assert.equal(created[0].aggregateId, first.id);
    assert.equal(store.health().counts.runs, 2);
  }
});

test("updateRunStatus walks the legal transitions and appends run.updated", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const beforeEvents = runEvents(store).length;

    const running = store.updateRunStatus(run.id, { status: "RUNNING" });
    assert.equal(running.status, "RUNNING", label);
    assert.equal(running.version, 1, label);
    assert.ok(typeof running.startedAt === "string", `${label}: RUNNING sets startedAt`);

    const completed = store.updateRunStatus(run.id, {
      status: "COMPLETED",
      exitCode: 0,
      endedAt: "2026-11-02T10:00:00.000Z",
    });
    assert.equal(completed.status, "COMPLETED", label);
    assert.equal(completed.version, 2, label);
    assert.equal(completed.exitCode, 0, label);
    assert.equal(completed.endedAt, "2026-11-02T10:00:00.000Z", label);

    // Each legal transition produced exactly one run.updated event.
    const updated = runEvents(store).filter((event) => event.type === "run.updated");
    assert.equal(updated.length, 2, label);
    assert.deepEqual(
      updated.map((event) => [event.payload.runId, event.payload.status, event.payload.version]),
      [
        [run.id, "RUNNING", 1],
        [run.id, "COMPLETED", 2],
      ],
      label,
    );
    assert.equal(updated[1].payload.previousStatus, "RUNNING", label);

    // Same status is an idempotent no-op: no version bump, no duplicate event.
    const again = store.updateRunStatus(run.id, { status: "COMPLETED" });
    assert.equal(again.version, completed.version, label);
    assert.equal(runEvents(store).length, beforeEvents + 2, label);

    // STARTING may fail or be interrupted directly (session never started);
    // RUNNING may be cancelled.
    const failedRun = seedRun(store);
    const failed = store.updateRunStatus(failedRun.id, { status: "FAILED", exitCode: 1 });
    assert.equal(failed.status, "FAILED", label);
    assert.ok(typeof failed.endedAt === "string", label);
    const interrupted = seedRun(store);
    assert.equal(store.updateRunStatus(interrupted.id, { status: "INTERRUPTED" }).status, "INTERRUPTED", label);
    const cancelledRun = seedRun(store);
    store.updateRunStatus(cancelledRun.id, { status: "RUNNING" });
    assert.equal(store.updateRunStatus(cancelledRun.id, { status: "CANCELLED" }).status, "CANCELLED", label);
  }
});

test("illegal Run transitions are VALIDATION_ERROR and change nothing", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const before = store.getRun(run.id);
    const eventsBefore = runEvents(store).length;

    for (const [from, to] of [
      ["STARTING", "COMPLETED"],
      ["STARTING", "CANCELLED"],
      ["STARTING", "QUEUED"],
    ]) {
      assert.throws(
        () =>
          store.updateRunStatus(run.id, {
            status: to,
            exitCode: 3,
            endedAt: "2026-11-02T10:00:00.000Z",
          }),
        (error) =>
          error.code === "VALIDATION_ERROR" &&
          error.details.from === from &&
          error.details.to === to &&
          assert.deepEqual(error.details.allowed, EXPECTED_RUN_TRANSITIONS[from]) === undefined,
        `${label}: ${from} -> ${to}`,
      );
    }
    const unchanged = store.getRun(run.id);
    assert.deepEqual(unchanged, before, label);
    assert.equal(runEvents(store).length, eventsBefore, label);

    // Backwards and terminal-out transitions are refused once the run has moved.
    store.updateRunStatus(run.id, { status: "RUNNING" });
    assert.throws(
      () => store.updateRunStatus(run.id, { status: "STARTING" }),
      (error) => error.code === "VALIDATION_ERROR" && error.details.from === "RUNNING",
    );
    const completed = store.updateRunStatus(run.id, { status: "COMPLETED" });
    const done = store.getRun(run.id);
    for (const to of ["RUNNING", "STARTING", "CANCELLED", "INTERRUPTED"]) {
      assert.throws(
        () => store.updateRunStatus(run.id, { status: to }),
        (error) =>
          error.code === "VALIDATION_ERROR" &&
          error.details.from === "COMPLETED" &&
          error.details.allowed.length === 0,
        `${label}: COMPLETED -> ${to}`,
      );
    }
    assert.deepEqual(store.getRun(run.id), done, label);
    assert.equal(completed.status, "COMPLETED", label);

    // Validation of the payload itself: task-style "DONE" is not a Run status,
    // and endedAt is only meaningful on a terminal transition.
    assert.throws(
      () => store.updateRunStatus(run.id, { status: "DONE" }),
      (error) =>
        error.code === "VALIDATION_ERROR" && assert.deepEqual(error.details.allowed, RUN_STATUSES) === undefined,
    );
    const runningRun = seedRun(store);
    store.updateRunStatus(runningRun.id, { status: "RUNNING" });
    assert.throws(
      () => store.updateRunStatus(runningRun.id, { status: "RUNNING", endedAt: "2026-11-02T10:00:00.000Z" }),
      (error) => error.code === "VALIDATION_ERROR" && /endedAt/.test(error.message),
    );
    assert.throws(
      () => store.updateRunStatus("RUN-MISSING", { status: "RUNNING" }),
      (error) => error.code === "NOT_FOUND",
    );
  }
});

test("overview and listRuns see the real runs", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    let overview = store.overview("proj-1");
    assert.equal(overview.counts.runsRunning, 1, label);
    assert.equal(overview.counts.runsTotal, 1, label);

    store.updateRunStatus(run.id, { status: "RUNNING" });
    overview = store.overview("proj-1");
    assert.equal(overview.counts.runsRunning, 1, label);

    store.updateRunStatus(run.id, { status: "COMPLETED" });
    overview = store.overview("proj-1");
    assert.equal(overview.counts.runsRunning, 0, label);
    assert.equal(overview.counts.runsTotal, 1, label);
    assert.ok(
      overview.recentEvents.some((event) => event.type === "run.updated"),
      `${label}: overview.recentEvents must include run.updated`,
    );

    const second = seedRun(store);
    assert.deepEqual(
      store.listRuns({ taskId: "TASK-SEED" }).map((entry) => entry.id),
      [second.id, run.id],
      `${label}: newest first`,
    );
    assert.deepEqual(
      store.listRuns({ status: "COMPLETED" }).map((entry) => entry.id),
      [run.id],
      label,
    );
  }
});

test("updateRunStatus honours optional generation fencing (M2 integration)", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const updatedEvents = () => runEvents(store).filter((event) => event.type === "run.updated").length;
    const stateBefore = store.getRun(run.id);
    const eventsBefore = updatedEvents();

    // No lease yet: a generation-fenced report is a stale host, never a write.
    assert.throws(
      () => store.updateRunStatus(run.id, { status: "RUNNING", generation: 1 }),
      (error) => error.code === "STALE_GENERATION" && error.details.reason === "lease-missing",
      label,
    );
    assert.deepEqual(store.getRun(run.id), stateBefore, label);
    assert.equal(updatedEvents(), eventsBefore, label);

    // A real claim creates generation 1; the fenced state change goes through
    // and produces exactly one run.updated — the single event for session.started.
    seedDispatch(store, run.id, { idempotencyKey: `state-fence-${label}` });
    const claimed = store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 });
    store.appendRunEvent({
      runId: run.id,
      generation: claimed.lease.generation,
      events: [{ type: "run.log", payload: { sessionId: "s-1", stream: "stdout", text: "started" } }],
    });
    const running = store.updateRunStatus(run.id, {
      status: "RUNNING",
      generation: claimed.lease.generation,
    });
    assert.equal(running.status, "RUNNING", label);
    assert.equal(running.version, 1, label);
    const runEventsOfType = (type) =>
      store.listEvents({ projectId: "proj-1", limit: 1000 }).filter((event) => event.aggregateId === run.id && event.type === type);
    assert.equal(runEventsOfType("run.updated").length, 1, `${label}: exactly one run.updated`);
    assert.equal(runEventsOfType("run.log").length, 1, label);
    assert.equal(runEventsOfType("run.created").length, 1, label);

    // Stale generation (after a renewal the lease is at 2) changes nothing.
    const snapshot = store.getRun(run.id);
    const eventsAfter = updatedEvents();
    const renewed = store.renewRunLease({ runId: run.id, ownerId: "host-a", generation: 1, leaseMs: 60_000 });
    assert.equal(renewed.generation, 2, label);
    assert.throws(
      () => store.updateRunStatus(run.id, { status: "COMPLETED", generation: 1 }),
      (error) =>
        error.code === "STALE_GENERATION" &&
        error.details.currentGeneration === 2 &&
        error.details.reason === "generation-mismatch",
      label,
    );
    assert.deepEqual(store.getRun(run.id), snapshot, label);
    assert.equal(updatedEvents(), eventsAfter, label);

    // The current generation still works and still writes exactly one event.
    const completed = store.updateRunStatus(run.id, { status: "COMPLETED", generation: 2 });
    assert.equal(completed.status, "COMPLETED", label);
    assert.equal(completed.version, 2, label);
    assert.equal(runEventsOfType("run.updated").length, 2, label);
  }
});
