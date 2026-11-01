// M3 atomic task claim (m3-contracts §2): the 7 ordered checks, single
// transaction rollback, idempotent replay and real cross-connection concurrency.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createMemoryStore } from "@atk/database";
import { advanceTask, projectDto, taskDto, useStore } from "./helpers.mjs";

const WORKER_URL = new URL("./claim-task-worker.mjs", import.meta.url);

function makeStore(t, implementation) {
  if (implementation === "sqlite") return useStore(t).store;
  const store = createMemoryStore();
  t.after(() => store.close());
  return store;
}

const IMPLEMENTATIONS = ["sqlite", "memory"];

function seedProject(store, policy = {}) {
  return store.createProject(projectDto({ policy }));
}

function seedTask(store, overrides = {}) {
  return store.createTask(taskDto("proj-1", overrides));
}

function seedAgent(store, overrides = {}) {
  return store.upsertAgent({
    id: "agent-1",
    role: "DEV",
    capabilities: ["WORKER"],
    status: "IDLE",
    ...overrides,
  });
}

function fingerprint(store) {
  return {
    snapshotVersion: store.schedulingSnapshot().version,
    tasks: store.listTasks({ limit: 1000 }),
    runs: store.listRuns({ limit: 1000 }),
    agents: store.listAgents(),
    events: store.listEvents({ limit: 1000 }),
  };
}

function claimArgs(store, overrides = {}) {
  const task = overrides.task ?? store.listTasks({ limit: 1000 }).find((entry) => entry.status === "READY");
  return {
    taskId: overrides.taskId ?? task.id,
    agentId: overrides.agentId ?? "agent-1",
    expectedTaskVersion: overrides.expectedTaskVersion ?? task.version,
    policies: overrides.policies ?? {},
    idempotencyKey: overrides.idempotencyKey ?? `claim-${task.id}-${task.version}`,
    workspacePolicy: overrides.workspacePolicy ?? { kind: "worktree" },
  };
}

test("claimTask commits run STARTING + command PENDING + task CLAIMED + two events", (t) => {
  for (const implementation of IMPLEMENTATIONS) {
    const store = makeStore(t, implementation);
    seedProject(store);
    const first = seedTask(store, { id: "TASK-A", title: "A", files: ["src/a.mjs"] });
    seedTask(store, { id: "TASK-B", title: "B", deps: ["TASK-A"] });
    seedAgent(store);
    const versionBefore = store.schedulingSnapshot().version;
    assert.equal(versionBefore, 0, implementation);

    const claimed = store.claimTask(claimArgs(store));
    assert.equal(claimed.task.id, "TASK-A", implementation);
    assert.equal(claimed.task.status, "CLAIMED", implementation);
    assert.equal(claimed.task.version, first.version + 1, implementation);
    assert.equal(claimed.run.taskId, "TASK-A", implementation);
    assert.equal(claimed.run.agentId, "agent-1", implementation);
    assert.equal(claimed.run.status, "STARTING", implementation);
    assert.equal(claimed.run.attempt, 1, implementation);
    assert.deepEqual(claimed.run.files, ["src/a.mjs"], `${implementation}: run snapshots task files`);
    assert.equal(claimed.command.status, "PENDING", implementation);
    assert.equal(claimed.command.runId, claimed.run.id, implementation);
    assert.equal(claimed.command.idempotencyKey, "claim-TASK-A-0", implementation);
    assert.deepEqual(claimed.command.payload.files, ["src/a.mjs"], implementation);
    assert.deepEqual(claimed.command.payload.workspacePolicy, { kind: "worktree" }, implementation);

    const events = store.listEvents({ limit: 1000 });
    assert.deepEqual(events.map((event) => event.type), ["run.created", "task.updated"], implementation);
    assert.equal(events[0].aggregateId, claimed.run.id, implementation);
    assert.equal(events[1].aggregateId, "TASK-A", implementation);
    assert.equal(events[1].payload.runId, claimed.run.id, implementation);

    const snapshot = store.schedulingSnapshot();
    assert.equal(snapshot.version, versionBefore + 2, `${implementation}: claim appends exactly two events`);
    assert.equal(snapshot.runs.length, 1, implementation);
    assert.equal(snapshot.runs[0].id, claimed.run.id, implementation);
    assert.equal(snapshot.runs[0].status, "STARTING", implementation);
    assert.deepEqual(snapshot.leases, [], `${implementation}: claimTask does not create the Host lease`);
    const snapshotTask = snapshot.tasks.find((task) => task.id === "TASK-A");
    assert.equal(snapshotTask.status, "CLAIMED", implementation);
    assert.deepEqual(snapshotTask.files, ["src/a.mjs"], implementation);
  }
});

test("claimTask rejects each of the 7 checks and leaves the DB byte-for-byte unchanged", (t) => {
  const CASES = [
    {
      name: "1a task does not exist",
      setup: (store) => {
        seedProject(store);
        seedAgent(store);
        return { args: { taskId: "TASK-MISSING", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-1a" } };
      },
      check: (error) =>
        error.code === "TASK_VERSION_CONFLICT" &&
        error.details.reason === "task-not-found" &&
        error.details.currentVersion === null,
    },
    {
      name: "1b task is not READY",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A" });
        seedAgent(store);
        advanceTask(store, "TASK-A", "BLOCKED");
        return { args: { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 1, idempotencyKey: "k-1b" } };
      },
      check: (error) =>
        error.code === "TASK_VERSION_CONFLICT" && error.details.reason === "not-ready" && error.details.status === "BLOCKED",
    },
    {
      name: "1c expectedTaskVersion is stale",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A" });
        seedAgent(store);
        return { args: { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 7, idempotencyKey: "k-1c" } };
      },
      check: (error) =>
        error.code === "TASK_VERSION_CONFLICT" &&
        error.details.reason === "version-mismatch" &&
        error.details.currentVersion === 0 &&
        error.details.expectedVersion === 7,
    },
    {
      name: "2 dependency is not DONE",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-DEP" });
        seedTask(store, { id: "TASK-A", deps: ["TASK-DEP"] });
        seedAgent(store);
        return { args: { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-2" } };
      },
      check: (error) =>
        error.code === "TASK_DEPENDENCY_BLOCKED" &&
        assert.deepEqual(error.details.blockingTaskIds, ["TASK-DEP"]) === undefined,
    },
    {
      name: "2b dependency task is missing",
      setup: (store) => {
        seedProject(store);
        // A dangling dep row cannot be created through createTask (validated),
        // so simulate the "missing dependency" case with an unknown id via patch.
        const dep = seedTask(store, { id: "TASK-DEP" });
        const task = seedTask(store, { id: "TASK-A" });
        store.patchTask("TASK-A", { expectedVersion: task.version, changes: { deps: [dep.id] } });
        // Remove the dependency by deleting? Not supported; use a fresh task with
        // a dep that is archived/cancelled instead.
        const cancelled = seedTask(store, { id: "TASK-OLD" });
        advanceTask(store, "TASK-OLD", "CANCELLED");
        const dependent = seedTask(store, { id: "TASK-C", deps: ["TASK-OLD"] });
        seedAgent(store);
        return { args: { taskId: dependent.id, agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-2b" } };
      },
      check: (error) =>
        error.code === "TASK_DEPENDENCY_BLOCKED" &&
        assert.deepEqual(error.details.blockingTaskIds, ["TASK-OLD"]) === undefined,
    },
    {
      name: "3a agent does not exist",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A" });
        return { args: { taskId: "TASK-A", agentId: "agent-ghost", expectedTaskVersion: 0, idempotencyKey: "k-3a" } };
      },
      check: (error) => error.code === "CAPABILITY_UNAVAILABLE" && error.details.reason === "agent-not-found",
    },
    {
      name: "3b agent is not IDLE",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A" });
        seedAgent(store, { status: "BUSY" });
        return { args: { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-3b" } };
      },
      check: (error) => error.code === "CAPABILITY_UNAVAILABLE" && error.details.reason === "agent-not-idle",
    },
    {
      name: "3c agent role mismatches",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A" });
        seedAgent(store, { role: "QA", capabilities: ["REVIEWER"] });
        return { args: { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-3c" } };
      },
      check: (error) => error.code === "CAPABILITY_UNAVAILABLE" && error.details.reason === "role-mismatch",
    },
    {
      name: "3d agent lacks the required Function",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A", functionRequired: "REVIEWER" });
        seedAgent(store, { role: "DEV", capabilities: ["WORKER"] });
        return { args: { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-3d" } };
      },
      check: (error) =>
        error.code === "CAPABILITY_UNAVAILABLE" && error.details.reason === "function-mismatch",
    },
    {
      name: "4 task already has an active run",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A" });
        seedAgent(store);
        const run = store.createRun({ taskId: "TASK-A", agentId: "agent-1", function: "WORKER", role: "DEV" });
        return {
          args: { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-4" },
          runId: run.id,
        };
      },
      check: (error) =>
        error.code === "TASK_VERSION_CONFLICT" && error.details.reason === "active-run" && typeof error.details.activeRunId === "string",
    },
    {
      name: "5a project capacity reached",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A" });
        seedTask(store, { id: "TASK-B" });
        seedAgent(store);
        store.claimTask({ taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-5a-first" });
        return {
          args: {
            taskId: "TASK-B",
            agentId: "agent-1",
            expectedTaskVersion: 0,
            policies: { maxConcurrentPerProject: 1 },
            idempotencyKey: "k-5a",
          },
        };
      },
      check: (error) =>
        error.code === "CAPABILITY_UNAVAILABLE" &&
        error.details.reason === "capacity" &&
        error.details.scope === "project" &&
        error.details.active === 1 &&
        error.details.limit === 1,
    },
    {
      name: "5b agent capacity reached",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A" });
        seedTask(store, { id: "TASK-B" });
        seedAgent(store);
        store.claimTask({ taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-5b-first" });
        return {
          args: {
            taskId: "TASK-B",
            agentId: "agent-1",
            expectedTaskVersion: 0,
            policies: { maxPerAgent: 1 },
            idempotencyKey: "k-5b",
          },
        };
      },
      check: (error) =>
        error.code === "CAPABILITY_UNAVAILABLE" &&
        error.details.reason === "capacity" &&
        error.details.scope === "agent" &&
        error.details.active === 1 &&
        error.details.limit === 1,
    },
    {
      name: "6 write-scope conflict with an active run",
      setup: (store) => {
        seedProject(store);
        seedTask(store, { id: "TASK-A", files: ["src/shared.mjs", "src/a.mjs"] });
        seedTask(store, { id: "TASK-B", files: ["src/shared.mjs"] });
        seedAgent(store);
        const claimed = store.claimTask({
          taskId: "TASK-A",
          agentId: "agent-1",
          expectedTaskVersion: 0,
          idempotencyKey: "k-6-first",
        });
        return {
          args: { taskId: "TASK-B", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k-6" },
          activeRunId: claimed.run.id,
        };
      },
      check: (error, context) =>
        error.code === "CAPABILITY_UNAVAILABLE" &&
        error.details.reason === "write-scope-conflict" &&
        assert.deepEqual(error.details.files, ["src/shared.mjs"]) === undefined &&
        assert.deepEqual(error.details.activeRunIds, [context.activeRunId]) === undefined,
    },
  ];

  for (const implementation of IMPLEMENTATIONS) {
    for (const scenario of CASES) {
      const store = makeStore(t, implementation);
      const prepared = scenario.setup(store) ?? {};
      const before = fingerprint(store);
      assert.throws(
        () => store.claimTask(prepared.args),
        (error) => scenario.check(error, prepared),
        `${implementation}: ${scenario.name}`,
      );
      assert.deepEqual(fingerprint(store), before, `${implementation}: ${scenario.name} must roll back completely`);
    }
  }
});

test("claimTask replays the same idempotencyKey without creating a second run", (t) => {
  for (const implementation of IMPLEMENTATIONS) {
    const store = makeStore(t, implementation);
    seedProject(store);
    seedTask(store, { id: "TASK-A" });
    seedTask(store, { id: "TASK-B" });
    seedAgent(store);
    const args = {
      taskId: "TASK-A",
      agentId: "agent-1",
      expectedTaskVersion: 0,
      idempotencyKey: "replay-1",
      policies: {},
      workspacePolicy: { kind: "worktree" },
    };
    const first = store.claimTask(args);
    const snapshotAfterFirst = store.schedulingSnapshot();
    const tasksAfterFirst = store.listTasks({ limit: 1000 });
    const second = store.claimTask(args);
    assert.deepEqual(second, first, `${implementation}: replay returns the original result`);
    const snapshotAfterReplay = store.schedulingSnapshot();
    assert.equal(snapshotAfterReplay.version, snapshotAfterFirst.version, implementation);
    assert.deepEqual(snapshotAfterReplay.tasks, snapshotAfterFirst.tasks, implementation);
    assert.deepEqual(snapshotAfterReplay.runs, snapshotAfterFirst.runs, implementation);
    assert.deepEqual(store.listTasks({ limit: 1000 }), tasksAfterFirst, implementation);
    assert.equal(store.listRuns({ taskId: "TASK-A" }).length, 1, implementation);

    // Same key for a different task is a programming error, not a silent alias.
    assert.throws(
      () =>
        store.claimTask({
          taskId: "TASK-B",
          agentId: "agent-1",
          expectedTaskVersion: 0,
          idempotencyKey: "replay-1",
        }),
      (error) => error.code === "VALIDATION_ERROR" && /idempotencyKey/.test(error.message),
      implementation,
    );
  }
});

test("claimTask rejects invalid arguments", (t) => {
  for (const implementation of IMPLEMENTATIONS) {
    const store = makeStore(t, implementation);
    seedProject(store);
    seedTask(store, { id: "TASK-A" });
    seedAgent(store);
    for (const args of [
      { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: -1, idempotencyKey: "k" },
      { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: "0", idempotencyKey: "k" },
      { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "" },
      { taskId: "TASK-A", agentId: "bad agent", expectedTaskVersion: 0, idempotencyKey: "k" },
      { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k", policies: { maxPerAgent: -1 } },
      { taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "k", workspacePolicy: "nope" },
    ]) {
      assert.throws(() => store.claimTask(args), (error) => error.code === "VALIDATION_ERROR", implementation);
    }
    assert.deepEqual(store.listRuns(), [], implementation);
  }
});

test("two concurrent connections claiming the same task: exactly one wins", async (t) => {
  const { store, file } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1", { id: "TASK-RACE" }));
  store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
  assert.equal(store.schedulingSnapshot().version, 0);

  const barrier = new SharedArrayBuffer(4);
  const startWorker = (idempotencyKey) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { file, taskId: "TASK-RACE", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey, barrier },
    });
    return {
      worker,
      ready: new Promise((resolve, reject) => {
        worker.once("message", (message) => {
          if (message.ready) resolve();
          else reject(new Error(`worker not ready: ${JSON.stringify(message)}`));
        });
        worker.once("error", reject);
      }),
      finished: new Promise((resolve, reject) => {
        worker.on("message", (message) => {
          if (!message.ready) resolve(message);
        });
        worker.on("error", reject);
      }),
    };
  };
  const workers = [startWorker("race-a"), startWorker("race-b")];
  await Promise.all(workers.map((entry) => entry.ready));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const outcomes = await Promise.all(workers.map((entry) => entry.finished));
  for (const entry of workers) entry.worker.terminate();

  const winners = outcomes.filter((outcome) => outcome.result !== undefined && outcome.error === undefined);
  const losers = outcomes.filter((outcome) => outcome.error !== undefined);
  assert.equal(winners.length, 1, `exactly one claim may win: ${JSON.stringify(outcomes)}`);
  assert.equal(losers.length, 1, `the other must fail cleanly: ${JSON.stringify(outcomes)}`);
  assert.equal(losers[0].error.code, "TASK_VERSION_CONFLICT");
  assert.equal(winners[0].result.taskStatus, "CLAIMED");
  assert.equal(winners[0].result.taskVersion, 1);
  assert.equal(winners[0].result.commandStatus, "PENDING");
  assert.equal(winners[0].result.runStatus, "STARTING");

  // Database agrees: one task claim, one run, one command, exactly two events.
  const task = store.getTask("TASK-RACE");
  assert.equal(task.status, "CLAIMED");
  assert.equal(task.version, 1);
  const runs = store.listRuns({ taskId: "TASK-RACE" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "STARTING");
  assert.equal(runs[0].id, winners[0].result.runId);
  assert.equal(store.schedulingSnapshot().runs.length, 1);
  assert.equal(store.schedulingSnapshot().version, 2);
  const types = store
    .listEvents({ limit: 1000 })
    .filter((event) => event.aggregateId === "TASK-RACE" || event.aggregateId === runs[0].id)
    .map((event) => event.type);
  assert.deepEqual(types, ["run.created", "task.updated"]);
});
