// M6 (task-37): event aggregate filters/pagination + JSON -> SQLite switch
// support (merge/replace, atomic replace rollback, readiness gate).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createMemoryStore,
  exportStateJson,
  importStateJson,
  verifySwitchReadiness,
} from "@atk/database";
import { INTERNAL } from "../src/internal.mjs";
import { bothStores, projectDto, sampleState, taskDto, useStore } from "./helpers.mjs";

const T = "2026-11-02T00:00:00.000Z";

function appendSampleEvents(store, count = 5) {
  for (let index = 0; index < count; index += 1) {
    store.appendEvent({
      projectId: index % 2 === 0 ? "proj-1" : null,
      aggregateType: index % 2 === 0 ? "task" : "run",
      aggregateId: `AGG-${index % 3}`,
      type: index % 2 === 0 ? "task.updated" : "run.updated",
      payload: { index },
    });
  }
}

function normalizeEvents(events) {
  return events.map((event) => ({
    seq: event.seq,
    projectId: event.projectId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    type: event.type,
    payload: event.payload,
  }));
}

function storeFingerprint(store) {
  return {
    schemaVersion: store.health().schemaVersion,
    counts: store.health().counts,
    projects: store.listProjects(),
    tasks: store.listTasks({ limit: 1000 }),
    agents: store.listAgents(),
    events: store.listEvents({ limit: 1000 }),
  };
}

test("listEvents filters by aggregate/type/afterSeq with ascending pages", (t) => {
  for (const { label, store } of bothStores(t)) {
    appendSampleEvents(store, 6);
    assert.deepEqual(store.listEvents().map((event) => event.seq), [1, 2, 3, 4, 5, 6], label);

    const byAggregate = store.listEvents({ aggregateId: "AGG-1" });
    assert.deepEqual(byAggregate.map((event) => event.seq), [2, 5], label);
    const byAggregateType = store.listEvents({ aggregateType: "run" });
    assert.deepEqual(byAggregateType.map((event) => event.seq), [2, 4, 6], label);
    const byType = store.listEvents({ type: "task.updated" });
    assert.deepEqual(byType.map((event) => event.seq), [1, 3, 5], label);
    const combined = store.listEvents({ aggregateType: "task", type: "task.updated", afterSeq: 2 });
    assert.deepEqual(combined.map((event) => event.seq), [3, 5], label);
    const projectOnly = store.listEvents({ projectId: "proj-1", afterSeq: 1 });
    assert.deepEqual(projectOnly.map((event) => event.seq), [3, 5], label);

    // afterSeq is strictly greater (not >=).
    assert.deepEqual(store.listEvents({ afterSeq: 6 }).map((event) => event.seq), [], label);
    // Legacy array compatibility + page metadata on the same value.
    assert.ok(Array.isArray(byAggregate), label);
    assert.deepEqual(byAggregate.items, [...byAggregate], label);
    assert.equal(byAggregate.hasMore, false, label);
    assert.equal(byAggregate.nextAfterSeq, undefined, label);
  }
});

test("listEvents paginates with afterSeq and reports hasMore/nextAfterSeq", (t) => {
  for (const { label, store } of bothStores(t)) {
    appendSampleEvents(store, 105);
    const first = store.listEventsPage();
    assert.equal(first.items.length, 100, `${label}: default limit is 100`);
    assert.equal(first.hasMore, true, label);
    assert.equal(first.nextAfterSeq, first.items[99].seq, label);
    assert.equal(first.items[0].seq, 1, label);
    const second = store.listEventsPage({ afterSeq: first.nextAfterSeq });
    assert.equal(second.items.length, 5, label);
    assert.equal(second.hasMore, false, label);
    assert.equal(second.nextAfterSeq, undefined, label);
    assert.deepEqual(
      [...first.items, ...second.items].map((event) => event.seq),
      Array.from({ length: 105 }, (_, index) => index + 1),
      `${label}: pagination covers every event exactly once`,
    );
    // Cap: >1000 requested is clamped to 1000, still lossless via afterSeq.
    const capped = store.listEventsPage({ limit: 5000 });
    assert.equal(capped.items.length, 105, `${label}: 105 events fit in the 1000 cap`);
    const explicitCap = store.listEventsPage({ afterSeq: 0, limit: 1000 });
    assert.equal(explicitCap.items.length, 105, label);
    assert.equal(explicitCap.hasMore, false, `${label}: 105 < 1000`);
    // Legacy listEvents honours the same cap/default.
    assert.equal(store.listEvents({ afterSeq: 0, limit: 1000 }).length, 105, label);
  }
});

test("listEvents validates filters and caps the limit", (t) => {
  for (const { label, store } of bothStores(t)) {
    appendSampleEvents(store, 3);
    for (const bad of [
      { afterSeq: -1 },
      { afterSeq: "1" },
      { limit: 0 },
      { limit: -5 },
      { aggregateId: "" },
      { aggregateType: 7 },
      { type: "   " },
      { projectId: "bad id" },
    ]) {
      assert.throws(() => store.listEvents(bad), (error) => error.code === "VALIDATION_ERROR", `${label}: ${JSON.stringify(bad)}`);
    }
    assert.equal(store.listEventsPage({ limit: 1000 }).items.length, 3, label);
  }
});

test("1000-event filtered page stays under the 20ms budget on SQLite", (t) => {
  const { store } = useStore(t);
  store.createProject(projectDto());
  for (let index = 0; index < 1005; index += 1) {
    store.appendEvent({
      projectId: "proj-1",
      aggregateType: index % 2 === 0 ? "task" : "run",
      aggregateId: `AGG-${index % 10}`,
      type: index % 2 === 0 ? "task.updated" : "run.updated",
      payload: { index },
    });
  }
  const startedAt = process.hrtime.bigint();
  const page = store.listEventsPage({ aggregateType: "task", limit: 1000 });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.equal(page.items.length, 503);
  assert.ok(elapsedMs < 20, `filtered 1000-row page took ${elapsedMs.toFixed(2)}ms`);
});

test("memory and SQLite return the same event pages", (t) => {
  const { store: sqlite } = useStore(t);
  const memory = createMemoryStore();
  t.after(() => memory.close());
  for (const store of [sqlite, memory]) appendSampleEvents(store, 6);
  const filters = [{}, { aggregateId: "AGG-0" }, { aggregateType: "run", afterSeq: 2 }, { limit: 2 }];
  for (const filter of filters) {
    assert.deepEqual(normalizeEvents(memory.listEvents(filter)), normalizeEvents(sqlite.listEvents(filter)));
    assert.deepEqual(memory.listEventsPage(filter).hasMore, sqlite.listEventsPage(filter).hasMore);
  }
});

test("export -> import(merge) -> export is stable", (t) => {
  for (const { label, store } of bothStores(t)) {
    importStateJson(store, { stateJson: sampleState(), now: T, projectId: "proj-1" });
    const first = exportStateJson(store, { projectId: "proj-1", now: T });
    const imported = importStateJson(store, {
      stateJson: first.state,
      runtime: first.state.project ? { schemaVersion: 3, agents: [] } : undefined,
      mode: "merge",
      now: T,
      projectId: "proj-1",
    });
    assert.equal(imported.status, "PASS", label);
    const second = exportStateJson(store, { projectId: "proj-1", now: T });
    assert.deepEqual(second.state, first.state, `${label}: exported state is stable`);
    assert.equal(second.manifest.contentHash, first.manifest.contentHash, label);
  }
});

test("replace clears old data, is idempotent and reports mode", (t) => {
  for (const { label, store } of bothStores(t)) {
    const beforeSchemaVersion = store.health().schemaVersion;
    const nextState = sampleState({
      project: { id: "proj-1", name: "Replaced", repoPath: ".", defaultBranch: "main" },
      packages: [
        {
          id: "NEW-01",
          type: "feature",
          owner: "DEV",
          module: "m",
          scope: "src/new.mjs",
          stage: "todo",
          priority: "P1",
          deps: [],
          archived: false,
          verification: {},
        },
      ],
      subitems: [],
      batch: { ...sampleState().batch, slices: [] },
    });
    const replaced = importStateJson(store, {
      stateJson: nextState,
      runtime: { schemaVersion: 3, agents: [] },
      mode: "replace",
      now: T,
      projectId: "proj-1",
    });
    assert.equal(replaced.status, "PASS", label);
    assert.equal(replaced.mode, "replace", label);
    assert.throws(() => store.getTask("TASK-SEED"), (error) => error.code === "NOT_FOUND", label);
    assert.equal(store.getTask("NEW-01").status, "READY", label);
    assert.deepEqual(store.health().counts, { projects: 1, tasks: 1, runs: 0, events: 0, agents: 0 }, label);
    assert.equal(store.health().schemaVersion, beforeSchemaVersion, label);

    // Repeating the same replace must not duplicate anything.
    const again = importStateJson(store, {
      stateJson: nextState,
      runtime: { schemaVersion: 3, agents: [] },
      mode: "replace",
      now: T,
      projectId: "proj-1",
    });
    assert.equal(again.status, "PASS", label);
    assert.deepEqual(store.health().counts, { projects: 1, tasks: 1, runs: 0, events: 0, agents: 0 }, label);
  }
});

test("replace is one transaction: a failing write restores the old database", (t) => {
  for (const { label, store } of bothStores(t)) {
    // Add an agent + event to the fingerprint: replace must restore all tables,
    // not just tasks.
    store.upsertAgent({ id: "agent-keep", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    store.appendEvent({ projectId: "proj-1", aggregateType: "task", aggregateId: "TASK-SEED", type: "task.updated" });
    const before = storeFingerprint(store);
    const nextState = sampleState({
      project: { id: "proj-1", name: "Replaced", repoPath: ".", defaultBranch: "main" },
      packages: [
        { id: "BOOM-01", type: "feature", owner: "DEV", module: "m", scope: "a", stage: "todo", priority: "P1", deps: [], archived: false, verification: {} },
        { id: "BOOM-02", type: "feature", owner: "DEV", module: "m", scope: "b", stage: "todo", priority: "P1", deps: [], archived: false, verification: {} },
      ],
      subitems: [],
      batch: { ...sampleState().batch, slices: [] },
    });

    const originalCreateTask = store.createTask;
    let calls = 0;
    store.createTask = (...args) => {
      calls += 1;
      // Fail *after* clearBusinessTables() and the project/requirement writes.
      if (calls === 2) throw new Error("injected write failure");
      return originalCreateTask.apply(store, args);
    };
    let report;
    try {
      report = importStateJson(store, {
        stateJson: nextState,
        runtime: { schemaVersion: 3, agents: [] },
        mode: "replace",
        now: T,
        projectId: "proj-1",
      });
    } finally {
      store.createTask = originalCreateTask;
    }
    assert.equal(report.status, "SKIPPED", label);
    assert.ok(report.problems.some((problem) => problem.code === "IMPORT_WRITE_FAILED"), label);
    // Everything is byte-for-byte identical: projects/tasks/agents/events and
    // the migration ledger are all restored by the rollback.
    assert.deepEqual(storeFingerprint(store), before, `${label}: full state restored after mid-write failure`);
    assert.throws(() => store.getTask("BOOM-01"), (error) => error.code === "NOT_FOUND", label);
  }
});

test("QA-007: every unknown non-empty legacy collection is rejected before any clear", (t) => {
  const { store: sqlite, file } = useStore(t);
  const memory = createMemoryStore();
  t.after(() => memory.close());
  const stores = [
    { label: "sqlite", store: sqlite },
    { label: "memory", store: memory },
  ];
  const migrationRows = () => {
    const raw = new DatabaseSync(file);
    try {
      return Number(raw.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get().c);
    } finally {
      raw.close();
    }
  };
  const fingerprint = (store) => ({
    schemaVersion: store.health().schemaVersion,
    migrationRows: store === sqlite ? migrationRows() : null,
    counts: store.health().counts,
    projects: store.listProjects(),
    tasks: store.listTasks({ limit: 1000 }),
    agents: store.listAgents(),
    events: store.listEvents({ limit: 1000 }),
  });
  const baseState = () => ({
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "qa-007",
    project: { id: "P", name: "P", repoPath: ".", defaultBranch: "main" },
    batch: {
      id: "B",
      goal: "g",
      stopCondition: "s",
      devClosedByUser: false,
      applyMode: "local-tree",
      openQuestions: [],
      slices: [],
    },
    counts: { total: 0, byStage: {} },
    packages: [],
    subitems: [],
  });
  const setPath = (obj, dotted, value) => {
    const parts = dotted.split(".");
    let cursor = obj;
    for (const part of parts.slice(0, -1)) {
      if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts.at(-1)] = value;
  };
  const duplicateTasks = [{ id: "DUP", status: "READY" }, { id: "DUP", status: "READY" }];
  const cases = [
    ["batch.tasks", duplicateTasks],
    ["tasks", duplicateTasks],
    ["requirements", [{ id: "R1" }]],
    ["batch.requirements", [{ id: "R1" }]],
    ["Tasks", duplicateTasks],
    ["batch.Tasks", duplicateTasks],
    ["agents", [{ id: "A1" }]],
    ["batch.nested.tasks", duplicateTasks],
    ["runs", [{ id: "RUN-1" }]],
    ["events", [{ seq: 1 }]],
    ["slices", [{ id: "S1" }]],
  ];
  for (const { label, store } of stores) {
    store.createProject(projectDto());
    store.createTask(taskDto("proj-1", { id: "TASK-SEED" }));
    store.upsertAgent({ id: "agent-keep", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    store.appendEvent({ projectId: "proj-1", aggregateType: "task", aggregateId: "TASK-SEED", type: "task.updated" });
    const before = fingerprint(store);
    for (const [path, value] of cases) {
      const state = baseState();
      setPath(state, path, value);
      const report = importStateJson(store, {
        stateJson: state,
        runtime: { schemaVersion: 3, agents: [] },
        mode: "replace",
        now: T,
      });
      assert.equal(report.status, "SKIPPED", `${label}: ${path}`);
      // Nested unknown containers report the top unknown key as the collection
      // (QA-007 A3 expects `batch.nested`) and the array as `path`.
      const expectedCollection = path === "batch.nested.tasks" ? "batch.nested" : path;
      const problem = report.problems.find(
        (candidate) => candidate.code === "IMPORT_WRITE_FAILED" && candidate.detail?.collection === expectedCollection,
      );
      assert.ok(problem, `${label}: ${path}: problems=${JSON.stringify(report.problems)}`);
      assert.equal(problem.detail.path, path, `${label}: ${path}`);
      assert.ok(problem.detail.count >= 1, `${label}: ${path}`);
      assert.deepEqual(fingerprint(store), before, `${label}: ${path} must leave the whole DB untouched`);
    }
    assert.equal(store.getProject("proj-1").id, "proj-1", label);
    assert.equal(store.getTask("TASK-SEED").id, "TASK-SEED", label);

    // Empty unknown arrays carry no data, and batch.openQuestions is a known
    // array: neither must trip the whitelist.
    const accepted = baseState();
    accepted.futureMetadata = [];
    accepted.batch.openQuestions = ["is this allowed?"];
    const ok = importStateJson(store, {
      stateJson: accepted,
      runtime: { schemaVersion: 3, agents: [] },
      mode: "replace",
      now: T,
      projectId: "proj-1",
    });
    assert.equal(ok.status, "PASS", `${label}: empty unknown arrays / openQuestions are allowed`);
  }
});

test("replace never clears schema_migrations (reopen does not re-migrate)", (t) => {
  const { store, open } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1", { id: "TASK-SEED" }));
  importStateJson(store, {
    stateJson: sampleState({ project: { id: "proj-1", name: "P", repoPath: ".", defaultBranch: "main" } }),
    runtime: { schemaVersion: 3, agents: [] },
    mode: "replace",
    now: T,
    projectId: "proj-1",
  });
  assert.equal(store.health().schemaVersion, 5);
  store.close();
  const reopened = open();
  assert.equal(reopened.health().schemaVersion, 5);
  assert.equal(reopened.getProject("proj-1").id, "proj-1");
  const warnings = reopened[INTERNAL].migrationWarnings();
  assert.deepEqual(warnings, [], "reopening a replaced database must not re-run migrations");
  reopened.close();
});

test("verifySwitchReadiness blocks active Runs/leases and clears when idle", (t) => {
  for (const { label, store } of bothStores(t)) {
    const idle = verifySwitchReadiness(store);
    assert.equal(idle.ok, true, label);
    assert.deepEqual(idle.blockers, [], label);
    assert.equal(idle.schemaVersion, 5, label);
    assert.ok(idle.counts.tasks >= 1, label);

    const run = store.createRun({ taskId: "TASK-SEED", agentId: "agent-1", function: "WORKER", role: "DEV" });
    store.enqueueDispatchCommand({ runId: run.id, commandType: "RUN_TASK", payload: {}, idempotencyKey: `readiness-${label}` });
    store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 });
    const blocked = verifySwitchReadiness(store);
    assert.equal(blocked.ok, false, label);
    assert.ok(blocked.blockers.some((entry) => entry.code === "active-run" && entry.runId === run.id), label);
    assert.ok(blocked.blockers.some((entry) => entry.code === "active-lease" && entry.runId === run.id), label);

    store.updateRunStatus(run.id, { status: "FAILED", exitCode: 1 });
    const recovered = verifySwitchReadiness(store);
    assert.equal(recovered.ok, true, label);
    assert.deepEqual(recovered.blockers, [], label);
  }
});
