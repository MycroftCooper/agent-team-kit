// In-memory Store: same contract, same behaviour as SQLite (contracts 搂1 says
// backend/QA may use it without a database file).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore, exportStateJson, importStateJson } from "@atk/database";
import { createMemoryStore as memoryDirect } from "@atk/database/memory";
import { projectDto, sampleOwnership, sampleRuntime, sampleState, taskDto, useStore } from "./helpers.mjs";

const CONFIG = { project: "demo-project" };

test("memory store exposes the same API shape with no file", (t) => {
  const store = memoryDirect();
  assert.equal(createMemoryStore, memoryDirect);
  assert.deepEqual(store.health(), {
    ok: true,
    file: null,
    schemaVersion: 5,
    counts: { projects: 0, tasks: 0, runs: 0, events: 0, agents: 0 },
  });
  assert.deepEqual(store.listProjects(), []);
  assert.deepEqual(store.listTasks(), []);
  assert.deepEqual(store.listRuns(), []);
  assert.deepEqual(store.listAgents(), []);
  assert.deepEqual(store.listReviews(), []);
  assert.deepEqual(store.listApprovals(), []);
  assert.equal(store.latestSeq(), 0);
  assert.throws(
    () => store.getProject("nope"),
    (error) => error.code === "NOT_FOUND",
  );
});

test("memory store reproduces CAS conflicts and validation errors", (t) => {
  const store = memoryDirect();
  const project = store.createProject(projectDto());
  assert.equal(project.version, 0);
  assert.equal(store.updateProject("proj-1", { expectedVersion: 0, changes: { name: "x" } }).version, 1);
  assert.throws(
    () => store.updateProject("proj-1", { expectedVersion: 0, changes: { name: "y" } }),
    (error) => error.code === "VERSION_CONFLICT" && error.details.currentVersion === 1,
  );

  const task = store.createTask(taskDto("proj-1", { id: "TASK-1", status: "DONE" }));
  assert.equal(task.status, "READY");
  const patched = store.patchTask("TASK-1", { expectedVersion: 0, changes: { title: "new" } });
  assert.equal(patched.version, 1);
  assert.throws(
    () => store.patchTask("TASK-1", { expectedVersion: 0, changes: { title: "stale" } }),
    (error) => error.code === "TASK_VERSION_CONFLICT" && error.details.currentVersion === 1,
  );
  assert.throws(
    () => store.patchTask("TASK-1", { expectedVersion: 1, changes: { status: "COMPLETED" } }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.createTask(taskDto("proj-1", { deps: ["TASK-MISSING"] })),
    (error) =>
      error.code === "VALIDATION_ERROR" && assert.deepEqual(error.details.missingDeps, ["TASK-MISSING"]) === undefined,
  );
  assert.throws(
    () => store.createTask(taskDto("missing-project")),
    (error) => error.code === "NOT_FOUND",
  );
});

test("memory store returns defensive copies", (t) => {
  const store = memoryDirect();
  store.createProject(projectDto());
  const task = store.createTask(taskDto("proj-1", { id: "TASK-1" }));
  task.title = "mutated by caller";
  task.deps.push("TASK-2");
  const again = store.getTask("TASK-1");
  assert.equal(again.title, "Task title");
  assert.deepEqual(again.deps, []);
});

test("memory and SQLite agree on events, overview and ordering", (t) => {
  const { store: sqlite } = useStore(t);
  const stores = [sqlite, memoryDirect()];
  for (const store of stores) {
    store.createProject(projectDto());
    store.createTask(taskDto("proj-1", { id: "TASK-LOW", title: "low", priority: 3 }));
    store.createTask(taskDto("proj-1", { id: "TASK-HIGH", title: "high", priority: 0 }));
    store.createTask(taskDto("proj-1", { id: "TASK-BLOCK", title: "block", priority: 1 }));
    store.patchTask("TASK-BLOCK", { expectedVersion: 0, changes: { status: "BLOCKED", deps: ["TASK-HIGH"] } });
    store.appendEvent({
      projectId: "proj-1",
      aggregateType: "task",
      aggregateId: "TASK-BLOCK",
      type: "task.blocked",
      payload: { reason: "dependency" },
    });
    store.appendEvent({
      projectId: "proj-1",
      aggregateType: "task",
      aggregateId: "TASK-HIGH",
      type: "task.updated",
      payload: {},
    });
  }

  const [a, b] = stores;
  assert.deepEqual(a.listTasks({ projectId: "proj-1" }).map((task) => task.id), ["TASK-HIGH", "TASK-BLOCK", "TASK-LOW"]);
  assert.deepEqual(
    a.listTasks({ projectId: "proj-1" }).map((task) => task.id),
    b.listTasks({ projectId: "proj-1" }).map((task) => task.id),
  );
  assert.deepEqual(
    a.listEvents().map((event) => [event.seq, event.type, event.payload]),
    b.listEvents().map((event) => [event.seq, event.type, event.payload]),
  );
  assert.equal(a.latestSeq(), b.latestSeq());
  const overviewA = a.overview("proj-1");
  const overviewB = b.overview("proj-1");
  assert.deepEqual(overviewA.counts, overviewB.counts);
  assert.deepEqual(overviewA.blocked.map((task) => task.id), overviewB.blocked.map((task) => task.id));
  assert.deepEqual(
    overviewA.recentEvents.map((event) => event.seq),
    overviewB.recentEvents.map((event) => event.seq),
  );
  assert.equal(overviewA.counts.tasksByStatus.BLOCKED, 1);
  assert.equal(overviewA.counts.tasksByStatus.READY, 2);
});

test("memory store runs the migration import/export path identically", (t) => {
  const { store: sqlite } = useStore(t);
  const memory = memoryDirect();
  const state = sampleState();
  const options = {
    stateJson: state,
    ownership: sampleOwnership(),
    runtime: sampleRuntime(),
    config: CONFIG,
  };
  const sqliteResult = importStateJson(sqlite, options);
  const memoryResult = importStateJson(memory, options);
  assert.deepEqual(memoryResult.counts, sqliteResult.counts);
  assert.equal(memoryResult.status, "PASS");
  assert.equal(sqliteResult.status, "PASS");

  const sqliteExport = exportStateJson(sqlite, { projectId: "demo-project" });
  const memoryExport = exportStateJson(memory, { projectId: "demo-project" });
  assert.deepEqual(memoryExport.state.packages, sqliteExport.state.packages);
  assert.deepEqual(memoryExport.state.subitems, sqliteExport.state.subitems);
  assert.deepEqual(memoryExport.state.batch.slices, sqliteExport.state.batch.slices);
  assert.deepEqual(memoryExport.manifest.counts, sqliteExport.manifest.counts);

  // Idempotent on both backends.
  assert.deepEqual(
    importStateJson(memory, options).counts,
    importStateJson(sqlite, options).counts,
  );
  assert.deepEqual(memory.health().counts, sqlite.health().counts);
});


