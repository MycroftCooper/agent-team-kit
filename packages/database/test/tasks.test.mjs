// Task/project repository semantics: optimistic concurrency (CAS), the
// server-owned task status, dependency integrity and transaction rollback.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { projectDto, taskDto, useStore } from "./helpers.mjs";

function openProject(t) {
  const { store, file } = useStore(t);
  store.createProject(projectDto());
  return { store, file };
}

test("projects: create/get/list/update with CAS", (t) => {
  const { store } = openProject(t);
  const project = store.getProject("proj-1");
  assert.equal(project.name, "Demo project");
  assert.equal(project.version, 0);
  assert.equal(project.policyVersion, 0);
  assert.deepEqual(store.listProjects().map((entry) => entry.id), ["proj-1"]);

  const updated = store.updateProject("proj-1", {
    expectedVersion: 0,
    changes: { name: "Renamed" },
  });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.version, 1);
  assert.equal(updated.id, "proj-1");
  assert.equal(updated.repoPath, "E:\\CodeProject\\demo");

  assert.throws(
    () => store.updateProject("proj-1", { expectedVersion: 0, changes: { name: "Stale" } }),
    (error) =>
      error.code === "VERSION_CONFLICT" &&
      error.details.currentVersion === 1 &&
      error.details.expectedVersion === 0,
  );
  // The failed CAS must not change the row.
  assert.equal(store.getProject("proj-1").name, "Renamed");

  assert.throws(
    () => store.updateProject("proj-1", { expectedVersion: 1, changes: { bogus: 1 } }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.createProject(projectDto()),
    (error) => error.code === "VALIDATION_ERROR" && /already exists/.test(error.message),
  );
  assert.throws(
    () => store.createProject({ id: "proj-2" }),
    (error) => error.code === "VALIDATION_ERROR" && error.details.errors.length > 0,
  );
});

test("createTask forces READY, ignores client status and supports explicit ids", (t) => {
  const { store } = openProject(t);
  const generated = store.createTask(taskDto("proj-1", { status: "DONE" }));
  assert.match(generated.id, /^TASK-[A-Z0-9]+$/);
  assert.equal(generated.status, "READY");
  assert.equal(generated.version, 0);
  assert.deepEqual(generated.deps, []);
  assert.equal(store.getTask(generated.id).id, generated.id);

  const explicit = store.createTask(taskDto("proj-1", { id: "TASK-CUSTOM-1", title: "Custom" }));
  assert.equal(explicit.id, "TASK-CUSTOM-1");
  assert.equal(store.listTasks({ projectId: "proj-1" }).length, 2);

  assert.throws(
    () => store.createTask(taskDto("proj-1", { id: "TASK-CUSTOM-1" })),
    (error) => error.code === "VALIDATION_ERROR" && /already exists/.test(error.message),
  );
  assert.throws(
    () => store.createTask(taskDto("missing-project")),
    (error) => error.code === "NOT_FOUND" && error.details.id === "missing-project",
  );
  assert.throws(
    () => store.createTask(taskDto("proj-1", { functionRequired: "BUILDER" })),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.createTask(taskDto("proj-1", { priority: "high" })),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("dependencies: creation validates targets; patch rewrites them", (t) => {
  const { store } = openProject(t);
  const a = store.createTask(taskDto("proj-1", { id: "TASK-A", title: "A" }));
  const b = store.createTask(taskDto("proj-1", { id: "TASK-B", title: "B" }));
  const c = store.createTask(
    taskDto("proj-1", { id: "TASK-C", title: "C", deps: ["TASK-A", "TASK-B"] }),
  );
  assert.deepEqual(c.deps, ["TASK-A", "TASK-B"]);
  assert.deepEqual(store.getTask("TASK-C").deps, ["TASK-A", "TASK-B"]);

  assert.throws(
    () => store.createTask(taskDto("proj-1", { id: "TASK-D", deps: ["TASK-MISSING"] })),
    (error) =>
      error.code === "VALIDATION_ERROR" && assert.deepEqual(error.details.missingDeps, ["TASK-MISSING"]) === undefined,
  );
  assert.throws(
    () => store.createTask(taskDto("proj-1", { id: "TASK-SELF", deps: ["TASK-SELF"] })),
    (error) => error.code === "VALIDATION_ERROR" && /itself/.test(error.message),
  );

  const patched = store.patchTask("TASK-C", { expectedVersion: 0, changes: { deps: ["TASK-B"] } });
  assert.deepEqual(patched.deps, ["TASK-B"]);
  assert.equal(patched.version, 1);
  const cleared = store.patchTask("TASK-C", { expectedVersion: 1, changes: { deps: [] } });
  assert.deepEqual(cleared.deps, []);
  assert.deepEqual(store.getTask("TASK-A").deps, []);
  assert.equal(a.id, "TASK-A");
  assert.equal(b.id, "TASK-B");
});

test("patchTask is a real CAS: version conflict keeps the old version and data", (t) => {
  const { store } = openProject(t);
  const task = store.createTask(taskDto("proj-1", { id: "TASK-CAS", title: "before" }));
  const first = store.patchTask("TASK-CAS", {
    expectedVersion: task.version,
    changes: { title: "after-1" },
  });
  assert.equal(first.version, 1);
  assert.equal(first.title, "after-1");

  assert.throws(
    () => store.patchTask("TASK-CAS", { expectedVersion: task.version, changes: { title: "after-2" } }),
    (error) =>
      error.code === "TASK_VERSION_CONFLICT" &&
      error.details.taskId === "TASK-CAS" &&
      error.details.expectedVersion === 0 &&
      error.details.currentVersion === 1,
  );
  const current = store.getTask("TASK-CAS");
  assert.equal(current.version, 1);
  assert.equal(current.title, "after-1");

  assert.throws(
    () => store.patchTask("TASK-CAS", { expectedVersion: 1, changes: { status: "COMPLETED" } }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.patchTask("TASK-CAS", { expectedVersion: 1, changes: { notAField: true } }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.patchTask("TASK-CAS", { expectedVersion: 3, changes: { deps: "TASK-A" } }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.patchTask("TASK-CAS", { changes: { title: "no version" } }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.patchTask("TASK-MISSING", { expectedVersion: 0, changes: { title: "x" } }),
    (error) => error.code === "NOT_FOUND",
  );

  const status = store.patchTask("TASK-CAS", { expectedVersion: 1, changes: { status: "DONE" } });
  assert.equal(status.status, "DONE");
  assert.equal(status.version, 2);

  // An empty patch still bumps the version (a successful CAS touch).
  const touched = store.patchTask("TASK-CAS", { expectedVersion: 2, changes: {} });
  assert.equal(touched.version, 3);
  assert.equal(touched.status, "DONE");
});

test("listTasks filters, escapes LIKE wildcards and sorts by priority", (t) => {
  const { store } = openProject(t);
  store.createTask(taskDto("proj-1", { id: "TASK-LOW", title: "100% ready", priority: 3 }));
  store.createTask(taskDto("proj-1", { id: "TASK-HIGH", title: "100 ready", priority: 1 }));
  store.createTask(taskDto("proj-1", { id: "TASK-MID", title: "a_b task", priority: 2 }));
  store.createTask(
    taskDto("proj-1", { id: "TASK-QA", title: "review it", roleRequired: "QA", functionRequired: "REVIEWER" }),
  );
  store.patchTask("TASK-MID", { expectedVersion: 0, changes: { status: "BLOCKED" } });

  assert.deepEqual(
    store.listTasks({ projectId: "proj-1" }).map((task) => task.id),
    ["TASK-HIGH", "TASK-MID", "TASK-QA", "TASK-LOW"],
  );
  assert.deepEqual(store.listTasks({ projectId: "proj-1", limit: 2 }).map((task) => task.id), [
    "TASK-HIGH",
    "TASK-MID",
  ]);
  assert.deepEqual(store.listTasks({ projectId: "proj-1", status: "BLOCKED" }).map((task) => task.id), [
    "TASK-MID",
  ]);
  assert.deepEqual(store.listTasks({ projectId: "proj-1", roleRequired: "QA" }).map((task) => task.id), [
    "TASK-QA",
  ]);
  assert.deepEqual(
    store.listTasks({ projectId: "proj-1", functionRequired: "REVIEWER" }).map((task) => task.id),
    ["TASK-QA"],
  );
  // `%` and `_` must be literal in the q filter, not LIKE wildcards.
  assert.deepEqual(store.listTasks({ projectId: "proj-1", q: "%" }).map((task) => task.id), ["TASK-LOW"]);
  assert.deepEqual(store.listTasks({ projectId: "proj-1", q: "_" }).map((task) => task.id), ["TASK-MID"]);
  assert.deepEqual(store.listTasks({ projectId: "proj-1", q: "READY" }).map((task) => task.id), [
    "TASK-HIGH",
    "TASK-LOW",
  ]);
  assert.throws(
    () => store.listTasks({ projectId: "proj-1", status: "NOPE" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("a write that fails halfway is rolled back (transaction boundary)", (t) => {
  const { store, file } = openProject(t);
  store.createTask(taskDto("proj-1", { id: "TASK-A", title: "A" }));
  store.createTask(taskDto("proj-1", { id: "TASK-B", title: "B" }));

  // Failure injection: make the *second* write of createTask/patchTask fail,
  // after the task row was already written inside the same transaction.
  const raw = new DatabaseSync(file);
  raw.exec(
    "CREATE TRIGGER atk_fail_dep_insert BEFORE INSERT ON task_dependencies " +
      "BEGIN SELECT RAISE(ABORT, 'injected task_dependencies failure'); END",
  );
  try {
    assert.throws(
      () => store.createTask(taskDto("proj-1", { id: "TASK-C", deps: ["TASK-A"] })),
      (error) => error.code === "INTERNAL_ERROR",
    );
    assert.throws(
      () => store.getTask("TASK-C"),
      (error) => error.code === "NOT_FOUND",
    );

    assert.throws(
      () => store.patchTask("TASK-A", { expectedVersion: 0, changes: { deps: ["TASK-B"], title: "changed" } }),
      (error) => error.code === "INTERNAL_ERROR",
    );
    const a = store.getTask("TASK-A");
    assert.equal(a.version, 0);
    assert.equal(a.title, "A");
    assert.deepEqual(a.deps, []);
  } finally {
    raw.exec("DROP TRIGGER IF EXISTS atk_fail_dep_insert");
    raw.close();
  }

  // After removing the injected failure the same operation succeeds.
  const patched = store.patchTask("TASK-A", {
    expectedVersion: 0,
    changes: { deps: ["TASK-B"], title: "changed" },
  });
  assert.equal(patched.version, 1);
  assert.equal(patched.title, "changed");
  assert.deepEqual(patched.deps, ["TASK-B"]);
});

test("requirements are project-scoped", (t) => {
  const { store } = openProject(t);
  store.createProject(projectDto({ id: "proj-2", name: "Second" }));
  store.createRequirement({
    id: "REQ-1",
    projectId: "proj-1",
    description: "Build it",
    acceptance: "It works",
  });
  store.createRequirement({ id: "REQ-2", projectId: "proj-2", description: "Other" });
  assert.deepEqual(store.listRequirements({ projectId: "proj-1" }).map((row) => row.id), ["REQ-1"]);
  assert.equal(store.listRequirements({ projectId: "proj-2" }).length, 1);
  assert.equal(store.listRequirements({ projectId: "proj-1" })[0].acceptance, "It works");
  assert.throws(
    () => store.createRequirement({ id: "REQ-3", projectId: "nope", description: "x" }),
    (error) => error.code === "NOT_FOUND",
  );
  assert.throws(
    () => store.createRequirement({ id: "REQ-1", projectId: "proj-1", description: "dup" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});
