// M3 scheduling snapshot (m3-contracts §2): shape, consistent read model,
// MAX(events.seq) as the monotonic version, non-terminal run filter and the
// project filter. Runs against SQLite and the in-memory store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore } from "@atk/database";
import { advanceTask, projectDto, taskDto, useStore } from "./helpers.mjs";

const IMPLEMENTATIONS = ["sqlite", "memory"];

function makeStore(t, implementation) {
  if (implementation === "sqlite") return useStore(t).store;
  const store = createMemoryStore();
  t.after(() => store.close());
  return store;
}

function seedAgent(store) {
  return store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
}

test("empty store snapshot has the documented shape and version 0", (t) => {
  for (const implementation of IMPLEMENTATIONS) {
    const store = makeStore(t, implementation);
    const snapshot = store.schedulingSnapshot();
    assert.equal(typeof snapshot.generatedAt, "string", implementation);
    assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)), implementation);
    assert.equal(snapshot.version, 0, implementation);
    assert.deepEqual(snapshot.projects, [], implementation);
    assert.deepEqual(snapshot.tasks, [], implementation);
    assert.deepEqual(snapshot.agents, [], implementation);
    assert.deepEqual(snapshot.runs, [], implementation);
    assert.deepEqual(snapshot.leases, [], implementation);
  }
});

test("snapshot exposes policy, tasks/files, agents, non-terminal runs and leases", (t) => {
  for (const implementation of IMPLEMENTATIONS) {
    const store = makeStore(t, implementation);
    store.createProject(projectDto({ id: "p-1", policy: { maxConcurrentPerProject: 2 } }));
    store.createProject(projectDto({ id: "p-2", name: "Second" }));
    store.createTask(taskDto("p-1", { id: "TASK-A", files: ["src/a.mjs", "src/shared.mjs"] }));
    store.createTask(taskDto("p-1", { id: "TASK-B" }));
    store.createTask(taskDto("p-1", { id: "TASK-DONE" }));
    advanceTask(store, "TASK-DONE", "DONE");
    seedAgent(store);

    let snapshot = store.schedulingSnapshot();
    assert.deepEqual(snapshot.projects.map((project) => project.id), ["p-1", "p-2"], implementation);
    assert.deepEqual(snapshot.projects[0].policy, { maxConcurrentPerProject: 2 }, implementation);
    assert.deepEqual(snapshot.projects[1].policy, {}, `${implementation}: NULL policy -> {}`);
    assert.deepEqual(
      snapshot.tasks.map((task) => task.id).sort(),
      ["TASK-A", "TASK-B", "TASK-DONE"],
      implementation,
    );
    const taskA = snapshot.tasks.find((task) => task.id === "TASK-A");
    assert.deepEqual(taskA.files, ["src/a.mjs", "src/shared.mjs"], implementation);
    assert.equal(snapshot.tasks.find((task) => task.id === "TASK-DONE").status, "DONE", implementation);
    assert.deepEqual(snapshot.agents.map((agent) => agent.id), ["agent-1"], implementation);
    assert.deepEqual(snapshot.runs, [], implementation);
    assert.deepEqual(snapshot.leases, [], implementation);
    // Fixture DONE went through the approval gate: createApproval + decide each
    // append one approval.recorded event, so the baseline is no longer 0.
    assert.equal(snapshot.version, 2, implementation);

    const claimed = store.claimTask({
      taskId: "TASK-A",
      agentId: "agent-1",
      expectedTaskVersion: 0,
      policies: {},
      idempotencyKey: `snapshot-${implementation}`,
      workspacePolicy: { kind: "worktree" },
    });
    snapshot = store.schedulingSnapshot();
    assert.equal(snapshot.version, 4, `${implementation}: claim appends two events`);
    assert.equal(snapshot.version, store.latestSeq(), implementation);
    assert.equal(snapshot.runs.length, 1, implementation);
    assert.equal(snapshot.runs[0].id, claimed.run.id, implementation);
    assert.equal(snapshot.runs[0].status, "STARTING", implementation);
    assert.deepEqual(snapshot.runs[0].files, ["src/a.mjs", "src/shared.mjs"], implementation);
    assert.deepEqual(snapshot.leases, [], `${implementation}: claimTask itself owns no lease`);

    // A Host claim creates the run lease; the snapshot reports it for the
    // scheduler's "is this run actually being driven" question.
    const dispatch = store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 60_000 });
    assert.equal(dispatch.command.runId, claimed.run.id, implementation);
    snapshot = store.schedulingSnapshot();
    assert.equal(snapshot.version, 4, `${implementation}: dispatch claim writes no event`);
    assert.equal(snapshot.leases.length, 1, implementation);
    assert.equal(snapshot.leases[0].runId, claimed.run.id, implementation);
    assert.equal(snapshot.leases[0].ownerId, "host-1", implementation);
    assert.equal(snapshot.leases[0].generation, 1, implementation);
    assert.ok(!Number.isNaN(Date.parse(snapshot.leases[0].claimedUntil)), implementation);

    // Terminal runs disappear from the snapshot, but their lease row remains
    // (M2 decision: release = expire with monotonic generation).
    store.updateRunStatus(claimed.run.id, { status: "RUNNING" });
    assert.equal(store.schedulingSnapshot().version, 5, implementation);
    store.updateRunStatus(claimed.run.id, { status: "COMPLETED", exitCode: 0 });
    snapshot = store.schedulingSnapshot();
    assert.equal(snapshot.version, 6, implementation);
    assert.deepEqual(snapshot.runs, [], `${implementation}: only non-terminal runs are exposed`);
    assert.equal(snapshot.leases.length, 1, implementation);
    assert.equal(snapshot.tasks.find((task) => task.id === "TASK-A").status, "CLAIMED", implementation);
  }
});

test("version is strictly monotonic across claims and equals MAX(events.seq)", (t) => {
  for (const implementation of IMPLEMENTATIONS) {
    const store = makeStore(t, implementation);
    store.createProject(projectDto());
    store.createTask(taskDto("proj-1", { id: "TASK-1" }));
    store.createTask(taskDto("proj-1", { id: "TASK-2" }));
    seedAgent(store);
    const versions = [store.schedulingSnapshot().version];
    store.claimTask({ taskId: "TASK-1", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "v1" });
    versions.push(store.schedulingSnapshot().version);
    store.claimTask({ taskId: "TASK-2", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "v2" });
    versions.push(store.schedulingSnapshot().version);
    assert.deepEqual(versions, [0, 2, 4], implementation);
    for (let index = 1; index < versions.length; index += 1) {
      assert.ok(versions[index] > versions[index - 1], `${implementation}: version must strictly increase`);
    }
    assert.equal(store.schedulingSnapshot().version, store.latestSeq(), implementation);
  }
});

test("projectId filters projects/tasks/runs/leases consistently", (t) => {
  for (const implementation of IMPLEMENTATIONS) {
    const store = makeStore(t, implementation);
    store.createProject(projectDto({ id: "p-1" }));
    store.createProject(projectDto({ id: "p-2" }));
    store.createTask(taskDto("p-1", { id: "TASK-1" }));
    store.createTask(taskDto("p-2", { id: "TASK-2" }));
    seedAgent(store);
    store.claimTask({ taskId: "TASK-1", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "p1" });
    store.claimTask({ taskId: "TASK-2", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "p2" });
    store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 60_000 });

    const p1 = store.schedulingSnapshot({ projectId: "p-1" });
    assert.deepEqual(p1.projects.map((project) => project.id), ["p-1"], implementation);
    assert.deepEqual(p1.tasks.map((task) => task.id), ["TASK-1"], implementation);
    assert.equal(p1.runs.length, 1, implementation);
    assert.equal(p1.runs[0].taskId, "TASK-1", implementation);

    const p2 = store.schedulingSnapshot({ projectId: "p-2" });
    assert.deepEqual(p2.projects.map((project) => project.id), ["p-2"], implementation);
    assert.deepEqual(p2.tasks.map((task) => task.id), ["TASK-2"], implementation);
    assert.equal(p2.runs.length, 1, implementation);
    assert.equal(p2.runs[0].taskId, "TASK-2", implementation);

    const unknown = store.schedulingSnapshot({ projectId: "p-missing" });
    assert.deepEqual(unknown.projects, [], implementation);
    assert.deepEqual(unknown.tasks, [], implementation);
    assert.deepEqual(unknown.runs, [], implementation);
    assert.deepEqual(unknown.leases, [], implementation);

    assert.throws(
      () => store.schedulingSnapshot({ projectId: "not an id" }),
      (error) => error.code === "VALIDATION_ERROR",
      implementation,
    );
  }
});

test("sqlite and memory snapshots agree on the scheduling facts", (t) => {
  const { store: sqlite } = useStore(t);
  const memory = createMemoryStore();
  t.after(() => memory.close());
  const stores = [sqlite, memory];
  for (const store of stores) {
    store.createProject(projectDto({ id: "p-1", policy: { maxConcurrentPerProject: 3 } }));
    store.createTask(taskDto("p-1", { id: "TASK-1", files: ["src/a.mjs"], priority: 1 }));
    store.createTask(taskDto("p-1", { id: "TASK-2", priority: 2 }));
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    store.claimTask({
      taskId: "TASK-1",
      agentId: "agent-1",
      expectedTaskVersion: 0,
      idempotencyKey: "parity-1",
      policies: {},
      workspacePolicy: { kind: "worktree" },
    });
    store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 60_000 });
  }
  const normalize = (snapshot) => {
    const runTask = new Map(snapshot.runs.map((run) => [run.id, run.taskId]));
    return {
      version: snapshot.version,
      projects: snapshot.projects,
      tasks: snapshot.tasks.map((task) => ({
        id: task.id,
        status: task.status,
        version: task.version,
        priority: task.priority,
        files: task.files ?? [],
        deps: task.deps,
      })),
      agents: snapshot.agents.map((agent) => ({
        id: agent.id,
        role: agent.role,
        status: agent.status,
        capabilities: agent.capabilities,
      })),
      runs: snapshot.runs.map((run) => ({
        taskId: run.taskId,
        status: run.status,
        files: run.files ?? [],
      })),
      leases: snapshot.leases.map((lease) => ({
        taskId: runTask.get(lease.runId) ?? null,
        ownerId: lease.ownerId,
        generation: lease.generation,
      })),
    };
  };
  assert.deepEqual(normalize(memory.schedulingSnapshot()), normalize(sqlite.schedulingSnapshot()));
});
