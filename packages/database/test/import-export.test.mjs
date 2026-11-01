// Legacy JSON import/export: dry-run purity, idempotency, duplicate/invalid
// detection, non-ASCII paths, path-escape rejection and export->import round-trip
// (ADR-006 samples).
import assert from "node:assert/strict";
import { test } from "node:test";
import { exportStateJson, importStateJson } from "@atk/database";
import { sampleOwnership, sampleRuntime, sampleState, taskDto, useStore } from "./helpers.mjs";

const CONFIG = { project: "demo-project" };

function openStoreFor(t) {
  const { store } = useStore(t);
  return store;
}

function importer(store) {
  return (state, extra = {}) =>
    importStateJson(store, {
      stateJson: state,
      ownership: sampleOwnership(),
      runtime: sampleRuntime(),
      config: CONFIG,
      ...extra,
    });
}

test("dryRun only counts: nothing is written and the report is honest", (t) => {
  const store = openStoreFor(t);
  const result = importer(store)(sampleState(), { dryRun: true });

  assert.equal(result.status, "PASS");
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.counts, {
    projects: 1,
    requirements: 1,
    tasks: 5,
    taskDependencies: 1,
    agents: 2,
    runs: 0,
    events: 0,
  });
  assert.deepEqual(result.skipped, { projects: 0, requirements: 0, tasks: 0, agents: 0 });
  assert.deepEqual(result.totals, {
    projects: 1,
    requirements: 1,
    tasks: 5,
    taskDependencies: 1,
    agents: 2,
    runs: 0,
    events: 0,
  });
  assert.deepEqual(store.health().counts, { projects: 0, tasks: 0, runs: 0, events: 0, agents: 0 });

  // Problems are reported but informational: non-ASCII repo-relative paths are
  // the ADR-006 sample and must import, not fail.
  const nonAscii = result.problems.filter((problem) => problem.code === "NON_ASCII_PATH");
  assert.ok(nonAscii.length >= 1);
  assert.ok(nonAscii.every((problem) => problem.level === "info"));
  assert.ok(result.problems.every((problem) => problem.level !== "error"));

  assert.equal(result.manifest.dryRun, true);
  assert.equal(result.manifest.project.id, "demo-project");
  assert.equal(result.manifest.runs.imported, 0);
  assert.match(result.manifest.runs.reason, /Run/);
  assert.match(result.manifest.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(result.manifest.ownership.rules, 2);
});

test("import maps packages/subitems/slices/agents and links dependencies", (t) => {
  const store = openStoreFor(t);
  const result = importer(store)(sampleState());
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.problems.filter((problem) => problem.level === "error"), []);

  const project = store.getProject("demo-project");
  assert.equal(project.name, "demo-project");
  assert.equal(project.repoPath, ".");
  assert.equal(project.defaultBranch, "main");

  const tasks = store.listTasks({ projectId: "demo-project", limit: 100 });
  assert.equal(tasks.length, 5);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  assert.equal(byId.get("DEMO-01").status, "AWAITING_ACCEPTANCE");
  assert.equal(byId.get("DEMO-01").priority, 1);
  assert.equal(byId.get("DEMO-01").roleRequired, "DEV");
  assert.equal(byId.get("DEMO-01").functionRequired, "WORKER");
  assert.equal(byId.get("DEMO-02").status, "READY");
  assert.equal(byId.get("DEMO-02").roleRequired, "QA");
  assert.equal(byId.get("DEMO-02").functionRequired, "REVIEWER");
  assert.deepEqual(byId.get("DEMO-02").deps, ["DEMO-01"]);
  assert.equal(byId.get("DEMO-03").status, "DONE");
  assert.equal(byId.get("DEMO-01-F01").status, "RUNNING");
  assert.equal(byId.get("SLICE-01").status, "RUNNING");
  assert.equal(byId.get("SLICE-01").title, "Greet helper");
  assert.equal(byId.get("SLICE-01").acceptance, "greet('Ada') returns 'Hello, Ada!'");

  const requirements = store.listRequirements({ projectId: "demo-project" });
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].id, "REQ-DEMO-R01");
  assert.match(requirements[0].description, /greet/);

  const agents = store.listAgents();
  assert.deepEqual(agents.map((agent) => agent.id), ["agent-dev-01", "agent-qa-01"]);
  assert.equal(agents[0].status, "BUSY");
  assert.equal(agents[1].status, "WAITING_APPROVAL");
  assert.deepEqual(agents[1].capabilities, ["REVIEWER"]);

  // Old files carry no Run records: the table is truthfully empty, and the
  // report says so explicitly instead of inventing rows.
  assert.deepEqual(store.listRuns(), []);
  assert.deepEqual(store.health().counts, { projects: 1, tasks: 5, runs: 0, events: 0, agents: 2 });
  assert.match(result.manifest.runs.reason, /truthfully empty/);
});

test("importing the same data again is idempotent (skip, not duplicate)", (t) => {
  const store = openStoreFor(t);
  const run = importer(store);
  run(sampleState());
  const before = { ...store.health().counts };
  const versions = new Map(
    store.listTasks({ projectId: "demo-project", limit: 100 }).map((task) => [task.id, task.version]),
  );

  const second = run(sampleState());
  assert.equal(second.status, "PASS");
  assert.deepEqual(second.counts, {
    projects: 0,
    requirements: 0,
    tasks: 0,
    taskDependencies: 0,
    agents: 0,
    runs: 0,
    events: 0,
  });
  assert.deepEqual(second.skipped, { projects: 1, requirements: 1, tasks: 5, agents: 2 });
  assert.deepEqual(store.health().counts, before);
  const after = new Map(
    store.listTasks({ projectId: "demo-project", limit: 100 }).map((task) => [task.id, task.version]),
  );
  assert.deepEqual(after, versions);
});

test("invalid input fails closed with contract problem codes", (t) => {
  const store = openStoreFor(t);
  const run = importer(store);

  const missingId = sampleState();
  delete missingId.packages[1].id;
  const missingResult = run(missingId);
  assert.equal(missingResult.status, "SKIPPED");
  assert.ok(missingResult.problems.some((problem) => problem.code === "INVALID_ID" && problem.level === "error"));
  assert.deepEqual(store.health().counts, { projects: 0, tasks: 0, runs: 0, events: 0, agents: 0 });

  const duplicate = sampleState();
  duplicate.packages.push({ ...duplicate.packages[0] });
  const duplicateResult = run(duplicate);
  assert.equal(duplicateResult.status, "SKIPPED");
  const duplicateProblem = duplicateResult.problems.find((problem) => problem.code === "DUPLICATE_ID");
  assert.equal(duplicateProblem.level, "error");
  assert.equal(duplicateProblem.detail.id, "DEMO-01");

  const unsupported = run(sampleState({ schemaVersion: 99 }));
  assert.equal(unsupported.status, "SKIPPED");
  assert.ok(unsupported.problems.some((problem) => problem.code === "UNSUPPORTED_SCHEMA_VERSION"));

  const missingState = run(null);
  assert.equal(missingState.status, "SKIPPED");
  assert.ok(missingState.problems.some((problem) => problem.code === "MISSING_INPUT"));
  assert.deepEqual(store.health().counts, { projects: 0, tasks: 0, runs: 0, events: 0, agents: 0 });
});

test("path traversal in legacy paths is rejected before any write", (t) => {
  const store = openStoreFor(t);
  const state = sampleState();
  state.packages[0].scope = "../../etc/passwd";
  const result = importer(store)(state);
  assert.equal(result.status, "SKIPPED");
  const escape = result.problems.find((problem) => problem.code === "PATH_ESCAPE");
  assert.equal(escape.level, "error");
  assert.equal(escape.detail.reason, "parent-segment");
  assert.deepEqual(store.health().counts, { projects: 0, tasks: 0, runs: 0, events: 0, agents: 0 });

  const absolute = sampleState();
  absolute.packages[0].evidence = "C:\\Windows\\system32";
  const absoluteResult = importer(store)(absolute);
  assert.equal(absoluteResult.status, "SKIPPED");
  assert.ok(absoluteResult.problems.some((problem) => problem.code === "PATH_ESCAPE"));
});

test("non-ASCII paths import successfully and are reported as info", (t) => {
  const store = openStoreFor(t);
  const result = importer(store)(sampleState());
  assert.equal(result.status, "PASS");
  const task = store.getTask("DEMO-01");
  assert.equal(task.description, "src/中文/greet.mjs");
  const info = result.problems.find((problem) => problem.code === "NON_ASCII_PATH");
  assert.equal(info.level, "info");
  assert.equal(info.detail.path, "src/中文/greet.mjs");
});

test("project id defaults are derived and recorded in the manifest", (t) => {
  const store = openStoreFor(t);
  const result = importStateJson(store, {
    stateJson: sampleState(),
    ownership: sampleOwnership(),
    runtime: sampleRuntime(),
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.manifest.project.id, "default");
  assert.equal(result.manifest.project.derived.id, true);
  assert.ok(result.problems.some((problem) => problem.code === "PROJECT_ID_DERIVED"));
  assert.equal(store.getProject("default").id, "default");
});

test("imports accept raw JSON strings (as a CLI reads the files)", (t) => {
  const store = openStoreFor(t);
  const result = importStateJson(store, {
    stateJson: JSON.stringify(sampleState()),
    ownership: JSON.stringify(sampleOwnership()),
    runtime: JSON.stringify(sampleRuntime()),
    config: JSON.stringify(CONFIG),
  });
  assert.equal(result.status, "PASS");
  assert.equal(store.listTasks({ projectId: "demo-project" }).length, 5);

  const broken = importStateJson(store, { stateJson: "{not json", dryRun: true });
  assert.equal(broken.status, "SKIPPED");
  assert.ok(broken.problems.some((problem) => problem.code === "INVALID_JSON"));
});

test("export round-trips the legacy structure and re-imports identically", (t) => {
  const store = openStoreFor(t);
  const state = sampleState();
  importer(store)(state);

  const { state: exported, manifest } = exportStateJson(store);
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.source, "test fixture");
  assert.deepEqual(exported.packages, state.packages);
  assert.deepEqual(exported.subitems, state.subitems);
  assert.deepEqual(exported.batch.slices, state.batch.slices);
  assert.equal(exported.counts.total, 5);
  assert.equal(exported.counts.byStage.done, 1);
  assert.equal(exported.project.id, "demo-project");
  assert.deepEqual(manifest.counts, {
    projects: 1,
    requirements: 1,
    tasks: 5,
    packages: 3,
    subitems: 1,
    slices: 1,
    runs: 0,
  });
  assert.match(manifest.contentHash, /^[a-f0-9]{64}$/);

  // Re-import the export into a fresh store: same ids, statuses, deps, priority.
  const fresh = openStoreFor(t);
  const reimport = importStateJson(fresh, {
    stateJson: exported,
    config: CONFIG,
    ownership: sampleOwnership(),
    runtime: sampleRuntime(),
  });
  assert.equal(reimport.status, "PASS");
  const keyOf = (tasks) =>
    tasks
      .map((task) => ({
        id: task.id,
        status: task.status,
        priority: task.priority,
        deps: task.deps,
        roleRequired: task.roleRequired,
        title: task.title,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    keyOf(fresh.listTasks({ projectId: "demo-project", limit: 100 })),
    keyOf(store.listTasks({ projectId: "demo-project", limit: 100 })),
  );
});

test("export synthesizes legacy entries for tasks created after migration", (t) => {
  const store = openStoreFor(t);
  store.createProject({ id: "p-api", name: "API project", repoPath: "E:\\demo", defaultBranch: "main" });
  store.createTask(taskDto("p-api", { id: "API-01", title: "First", priority: 1 }));
  const dependent = store.createTask(
    taskDto("p-api", { id: "API-02", title: "Second", priority: 2, deps: ["API-01"] }),
  );
  store.patchTask("API-02", {
    expectedVersion: dependent.version,
    changes: { status: "DONE" },
  });

  const { state } = exportStateJson(store, { projectId: "p-api" });
  assert.equal(state.packages.length, 2);
  const first = state.packages.find((item) => item.id === "API-01");
  const second = state.packages.find((item) => item.id === "API-02");
  assert.equal(first.stage, "todo");
  assert.equal(first.owner, "DEV");
  assert.equal(first.priority, "P1");
  assert.equal(second.stage, "done");
  assert.deepEqual(second.deps, ["API-01"]);
  assert.equal(state.counts.total, 2);
  assert.equal(state.counts.byStage.done, 1);

  const fresh = openStoreFor(t);
  const reimport = importStateJson(fresh, { stateJson: state, config: CONFIG });
  assert.equal(reimport.status, "PASS");
  const tasks = fresh.listTasks({ projectId: "demo-project" });
  assert.equal(tasks.length, 2);
  const again = tasks.find((task) => task.id === "API-02");
  assert.equal(again.status, "DONE");
  assert.deepEqual(again.deps, ["API-01"]);
  assert.equal(again.priority, 2);
});

test("cross-version runtime.json (schema v2, no instance ids) imports with warnings", (t) => {
  const store = openStoreFor(t);
  const result = importStateJson(store, {
    stateJson: { schemaVersion: 1 },
    runtime: { schemaVersion: 2, agents: [{ role: "DEV", status: "working" }] },
    config: CONFIG,
  });
  assert.equal(result.status, "PASS");
  const agents = store.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, "agent-dev-01");
  assert.deepEqual(agents[0].capabilities, ["WORKER"]);
  const codes = result.problems.map((problem) => problem.code);
  assert.ok(codes.includes("AGENT_ID_DERIVED"));
  assert.ok(codes.includes("CAPABILITIES_DERIVED"));
  assert.ok(result.problems.every((problem) => problem.level !== "error"));

  // Unknown legacy stages are reported and mapped to READY, not silently lost.
  const unknownStage = importStateJson(store, {
    stateJson: {
      schemaVersion: 1,
      packages: [{ id: "ODD-1", stage: "mystery", owner: "DEV", priority: "P2" }],
    },
    config: CONFIG,
  });
  assert.equal(unknownStage.status, "PASS");
  assert.ok(unknownStage.problems.some((problem) => problem.code === "STATUS_DERIVED"));
  assert.equal(store.getTask("ODD-1").status, "READY");
});

test("export requires a project when the store is ambiguous", (t) => {
  const store = openStoreFor(t);
  store.createProject({ id: "p-1", name: "One", repoPath: ".", defaultBranch: "main" });
  store.createProject({ id: "p-2", name: "Two", repoPath: ".", defaultBranch: "main" });
  assert.throws(
    () => exportStateJson(store),
    (error) => error.code === "VALIDATION_ERROR" && error.details.projectIds.length === 2,
  );
  const { state, manifest } = exportStateJson(store, { projectId: "p-1" });
  assert.equal(manifest.projectId, "p-1");
  assert.equal(state.batch.id, "p-1");
  assert.deepEqual(state.packages, []);
  assert.deepEqual(state.project, { id: "p-1", name: "One", repoPath: ".", defaultBranch: "main" });

  const empty = openStoreFor(t);
  assert.throws(
    () => exportStateJson(empty),
    (error) => error.code === "NOT_FOUND",
  );
});

test("export reflects post-import status changes in the legacy vocabulary", (t) => {
  const store = openStoreFor(t);
  importer(store)(sampleState());
  const slice = store.getTask("SLICE-01");
  store.patchTask(slice.id, { expectedVersion: slice.version, changes: { status: "DONE" } });
  const task = store.getTask("DEMO-02");
  store.patchTask(task.id, { expectedVersion: task.version, changes: { status: "CANCELLED" } });
  const { state } = exportStateJson(store);
  assert.equal(state.batch.slices[0].status, "done");
  assert.equal(state.counts.byStage.done, 2);
  assert.equal(state.packages.find((item) => item.id === "DEMO-02").stage, "cancelled");

  // A cancelled task survives an export -> import round-trip (no silent READY).
  const fresh = openStoreFor(t);
  importStateJson(fresh, { stateJson: state, config: CONFIG });
  assert.equal(fresh.getTask("DEMO-02").status, "CANCELLED");
});
