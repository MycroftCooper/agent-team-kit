// Append-only event log (seq monotonic, afterSeq replay) and the overview
// projection the Backend returns from GET /projects/:id/overview.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_SCHEMA_VERSION, validateEvent } from "@atk/contracts";
import { advanceTask, projectDto, taskDto, useStore } from "./helpers.mjs";

function openProject(t) {
  const { store } = useStore(t);
  store.createProject(projectDto());
  return store;
}

test("appendEvent assigns a monotonic seq and returns the contract envelope", (t) => {
  const store = openProject(t);
  assert.equal(store.latestSeq(), 0);

  const first = store.appendEvent({
    projectId: "proj-1",
    aggregateType: "project",
    aggregateId: "proj-1",
    type: "project.created",
    payload: { name: "Demo project" },
  });
  assert.equal(first.seq, 1);
  assert.equal(first.schemaVersion, EVENT_SCHEMA_VERSION);
  assert.equal(first.projectId, "proj-1");
  assert.equal(first.aggregateType, "project");
  assert.equal(first.aggregateId, "proj-1");
  assert.equal(first.type, "project.created");
  assert.deepEqual(first.payload, { name: "Demo project" });
  assert.equal(typeof first.happenedAt, "string");
  assert.deepEqual(validateEvent(first), { ok: true, errors: [] });

  const second = store.appendEvent({
    projectId: "proj-1",
    aggregateType: "task",
    aggregateId: "TASK-1",
    type: "task.updated",
    payload: { status: "DONE" },
  });
  const third = store.appendEvent({
    aggregateType: "system",
    aggregateId: "system",
    type: "system.resync-required",
    payload: {},
  });
  assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
  assert.equal(third.projectId, null);
  assert.equal(store.latestSeq(), 3);
});

test("listEvents is ascending, filters by afterSeq/project and applies limit", (t) => {
  const store = openProject(t);
  store.createProject(projectDto({ id: "proj-2", name: "Other" }));
  for (let index = 0; index < 5; index += 1) {
    store.appendEvent({
      projectId: index % 2 === 0 ? "proj-1" : "proj-2",
      aggregateType: "task",
      aggregateId: `TASK-${index}`,
      type: "task.created",
      payload: { index },
    });
  }
  assert.deepEqual(store.listEvents().map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.listEvents({ afterSeq: 3 }).map((event) => event.seq), [4, 5]);
  assert.deepEqual(store.listEvents({ projectId: "proj-1" }).map((event) => event.seq), [1, 3, 5]);
  assert.deepEqual(store.listEvents({ projectId: "proj-1", afterSeq: 3 }).map((event) => event.seq), [5]);
  assert.deepEqual(store.listEvents({ limit: 2 }).map((event) => event.seq), [1, 2]);
  assert.throws(
    () => store.listEvents({ afterSeq: -1 }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.listEvents({ limit: 0 }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("appendEvent validates type, aggregate and payload", (t) => {
  const store = openProject(t);
  assert.throws(
    () =>
      store.appendEvent({
        aggregateType: "task",
        aggregateId: "T-1",
        type: "task.exploded",
      }),
    (error) => error.code === "VALIDATION_ERROR" && error.details.type === "task.exploded",
  );
  assert.throws(
    () => store.appendEvent({ aggregateId: "T-1", type: "task.updated" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.appendEvent({ aggregateType: "task", aggregateId: "", type: "task.updated" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () =>
      store.appendEvent({
        aggregateType: "task",
        aggregateId: "T-1",
        type: "task.updated",
        payload: ["not", "an", "object"],
      }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  // Payload stays JSON-serialisable in the DB (objects in, object out).
  const event = store.appendEvent({
    aggregateType: "task",
    aggregateId: "T-1",
    type: "task.updated",
    payload: { nested: { ok: true }, list: [1, 2, 3] },
  });
  assert.deepEqual(store.listEvents()[0].payload, { nested: { ok: true }, list: [1, 2, 3] });
  assert.equal(event.seq, 1);
});

test("health counts events and latestSeq matches", (t) => {
  const store = openProject(t);
  store.appendEvent({ aggregateType: "task", aggregateId: "T-1", type: "task.updated" });
  store.appendEvent({ aggregateType: "task", aggregateId: "T-2", type: "task.updated" });
  assert.equal(store.health().counts.events, 2);
  assert.equal(store.latestSeq(), 2);
});

test("overview aggregates tasks, blocked/awaiting lists and recent events", (t) => {
  const store = openProject(t);
  const ready = store.createTask(taskDto("proj-1", { id: "TASK-READY", title: "ready" }));
  const blocked = store.createTask(
    taskDto("proj-1", { id: "TASK-BLOCKED", title: "blocked", priority: 1 }),
  );
  advanceTask(store, "TASK-BLOCKED", "BLOCKED");
  store.createTask(taskDto("proj-1", { id: "TASK-REVIEW", title: "reviewing" }));
  advanceTask(store, "TASK-REVIEW", "REVIEWING");
  store.createTask(taskDto("proj-1", { id: "TASK-ACCEPT", title: "accept" }));
  advanceTask(store, "TASK-ACCEPT", "AWAITING_ACCEPTANCE");
  store.createTask(taskDto("proj-1", { id: "TASK-DONE", title: "done" }));
  advanceTask(store, "TASK-DONE", "DONE");

  for (let index = 0; index < 25; index += 1) {
    store.appendEvent({
      projectId: "proj-1",
      aggregateType: "task",
      aggregateId: "TASK-READY",
      type: "task.updated",
      payload: { index },
    });
  }

  const overview = store.overview("proj-1");
  assert.equal(overview.project.id, "proj-1");
  assert.equal(overview.counts.tasksByStatus.READY, 1);
  assert.equal(overview.counts.tasksByStatus.BLOCKED, 1);
  assert.equal(overview.counts.tasksByStatus.REVIEWING, 1);
  assert.equal(overview.counts.tasksByStatus.AWAITING_ACCEPTANCE, 1);
  assert.equal(overview.counts.tasksByStatus.DONE, 1);
  assert.equal(overview.counts.tasksByStatus.DRAFT, 0);
  assert.equal(overview.counts.awaitingAcceptance, 1);
  assert.equal(overview.counts.runsRunning, 0);
  assert.equal(overview.counts.runsTotal, 0);
  assert.deepEqual(overview.blocked.map((task) => task.id), ["TASK-BLOCKED"]);
  assert.deepEqual(overview.awaitingAcceptance.map((task) => task.id), ["TASK-ACCEPT"]);
  assert.equal(overview.recentEvents.length, 20);
  assert.deepEqual(
    overview.recentEvents.map((event) => event.seq),
    [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6],
  );
  assert.equal(ready.status, "READY");

  assert.throws(
    () => store.overview("proj-missing"),
    (error) => error.code === "NOT_FOUND",
  );
});
