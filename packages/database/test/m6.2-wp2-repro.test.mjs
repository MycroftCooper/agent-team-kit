// M6.2 WP2 phase A reproduction tests (deliberately RED on the baseline).
// F04 run<->workspace columns/method; F05 frozen TaskExecutionSpec; F10
// heartbeat-based agent availability. Product code is untouched in phase A.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { advanceTask, bothStores, projectDto, taskDto, useStore } from "./helpers.mjs";

const NOW = "2026-11-02T00:00:00.000Z";

test("F05 run_specs.run_id stays NULL until a real Run binds it", (t) => {
  const { store, file } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1", { id: "TASK-BIND" }));
  const frozen = store.freezeTaskSpec("TASK-BIND", {
    now: NOW,
    workspace: { kind: "worktree", path: ".atk/worktrees/bind", baseCommit: "0123456789abcdef", targetBranch: "atk/bind" },
  });
  const readRows = () => {
    const raw = new DatabaseSync(file);
    try {
      return raw.prepare("SELECT run_id, task_id, spec_hash FROM run_specs ORDER BY frozen_at").all();
    } finally {
      raw.close();
    }
  };
  let rows = readRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, null, "an unbound freeze must not invent a run id");
  assert.equal(rows[0].task_id, "TASK-BIND");
  assert.equal(rows[0].spec_hash, frozen.specHash);
  const run = store.createRun({
    taskId: "TASK-BIND",
    agentId: "agent-1",
    function: "WORKER",
    role: "DEV",
    specHash: frozen.specHash,
    workspace: { kind: "worktree", path: ".atk/worktrees/bind", baseCommit: "0123456789abcdef", targetBranch: "atk/bind" },
  });
  rows = readRows();
  assert.equal(rows.length, 1, "binding updates the freeze row instead of duplicating it");
  assert.equal(rows[0].run_id, run.id);
  assert.deepEqual(store.getRunSpec(run.id).spec.workspace, {
    kind: "worktree",
    path: ".atk/worktrees/bind",
    baseCommit: "0123456789abcdef",
    targetBranch: "atk/bind",
  });
  assert.deepEqual(store.getRun(run.id).workspace, store.getRunSpec(run.id).spec.workspace);
  assert.throws(
    () => store.getRunSpec("PENDING:TASK-BIND"),
    (error) => error.code === "NOT_FOUND" && error.details.reason === "spec-not-frozen",
  );
});

test("F04 createRun persists the workspace and getRun returns it", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = store.createRun({
      taskId: "TASK-SEED",
      agentId: "agent-1",
      function: "WORKER",
      role: "DEV",
      workspace: {
        kind: "worktree",
        path: ".atk/worktrees/run-1",
        baseCommit: "0123456789abcdef",
        targetBranch: "atk/run-1",
      },
    });
    assert.deepEqual(run.workspace, {
      kind: "worktree",
      path: ".atk/worktrees/run-1",
      baseCommit: "0123456789abcdef",
      targetBranch: "atk/run-1",
    }, label);
    assert.deepEqual(store.getRun(run.id).workspace, run.workspace, label);
  }
});

test("F05 freezeTaskSpec persists a frozen spec that later task edits cannot change", (t) => {
  for (const { label, store } of bothStores(t)) {
    assert.equal(typeof store.freezeTaskSpec, "function", `${label}: freezeTaskSpec is missing`);
    assert.equal(typeof store.getRunSpec, "function", `${label}: getRunSpec is missing`);
    const taskId = "TASK-SPEC";
    store.createTask(taskDto("proj-1", { id: taskId, title: "original title", acceptance: "original acceptance" }));
    const frozen = store.freezeTaskSpec(taskId, { now: NOW });
    assert.equal(frozen.spec.taskId, taskId, label);
    assert.equal(frozen.spec.title, "original title", label);
    assert.equal(frozen.spec.schemaVersion, 1, label);
    assert.match(frozen.specHash, /^[0-9a-f]{64}$/, label);

    const run = store.createRun({
      taskId,
      agentId: "agent-1",
      function: "WORKER",
      role: "DEV",
      specHash: frozen.specHash,
      workspace: { kind: "worktree", path: ".atk/worktrees/spec", baseCommit: "0123456789abcdef", targetBranch: "atk/spec" },
    });
    // Editing the Task after freeze must not alter what the Run sees.
    store.patchTask(taskId, {
      expectedVersion: store.getTask(taskId).version,
      changes: { title: "edited after freeze", acceptance: "edited acceptance" },
    });
    const loaded = store.getRunSpec(run.id);
    assert.equal(loaded.specHash, frozen.specHash, label);
    assert.equal(loaded.spec.title, "original title", label);
    assert.equal(loaded.spec.acceptance, "original acceptance", label);
    assert.equal(loaded.frozenAt, NOW, label);
  }
});

test("F10 agent availability is heartbeat-based, never IDLE alone", (t) => {
  for (const { label, store } of bothStores(t)) {
    assert.equal(typeof store.recordHeartbeat, "function", `${label}: recordHeartbeat is missing`);
    assert.equal(typeof store.agentAvailability, "function", `${label}: agentAvailability is missing`);
    store.upsertAgent({ id: "agent-hb", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    // IDLE without a heartbeat is NOT available.
    assert.deepEqual(store.agentAvailability({ now: NOW, ttlMs: 10_000 }), {
      available: false,
      reason: "no-heartbeat",
    }, label);
    const recorded = store.recordHeartbeat({
      hostId: "host-1",
      agentIds: ["agent-hb"],
      capacity: 2,
      now: NOW,
    });
    assert.equal(recorded.hostId, "host-1", label);
    assert.deepEqual(store.agentAvailability({ now: NOW, ttlMs: 10_000 }), {
      available: true,
      reason: "ok",
    }, label);
    // TTL expiry makes it unavailable.
    const later = new Date(Date.parse(NOW) + 20_000).toISOString();
    assert.deepEqual(store.agentAvailability({ now: later, ttlMs: 10_000 }), {
      available: false,
      reason: "stale-heartbeat",
    }, label);
    // Capacity 0 blocks dispatch even with a fresh heartbeat.
    store.recordHeartbeat({ hostId: "host-1", agentIds: ["agent-hb"], capacity: 0, now: later });
    assert.deepEqual(store.agentAvailability({ now: later, ttlMs: 10_000 }), {
      available: false,
      reason: "no-capacity",
    }, label);
  }
});
