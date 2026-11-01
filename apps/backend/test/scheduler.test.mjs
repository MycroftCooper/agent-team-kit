// M3 Scheduler backend tests (m3-contracts §2): scheduling snapshot, atomic
// task claim with the 7-step contract-layer validation, idempotent replay,
// real concurrency, scheduler heartbeat and SSE for task.updated/run.created.
import assert from "node:assert/strict";
import test from "node:test";

import { validateErrorBody } from "@atk/contracts";

import { createFakeStore } from "./fake-store.mjs";
import {
  TEST_INTERNAL_TOKEN,
  TEST_TOKEN,
  closeSse,
  internalHeaders,
  openSse,
  readHeaders,
  request,
  startServer,
  waitForFrame,
} from "./helpers.mjs";

const ACTIVE = ["QUEUED", "STARTING", "RUNNING"];

function readyTask(overrides = {}) {
  return {
    id: "TASK-1",
    projectId: "P-1",
    title: "Implement feature",
    description: "do the thing",
    functionRequired: "WORKER",
    roleRequired: "BE",
    priority: 2,
    deps: [],
    status: "READY",
    version: 0,
    ...overrides,
  };
}

function idleAgent(overrides = {}) {
  return { id: "agent-1", role: "BE", capabilities: ["WORKER"], status: "IDLE", ...overrides };
}

function createStore({ tasks = [readyTask()], agents = [idleAgent()], runs = [], projects } = {}) {
  return createFakeStore({
    projects: projects ?? [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks,
    agents,
    runs,
  });
}

function claimBody(overrides = {}) {
  return {
    agentId: "agent-1",
    expectedTaskVersion: 0,
    function: "WORKER",
    role: "BE",
    workspacePolicy: { kind: "none" },
    policies: { maxConcurrentPerProject: 4, maxPerAgent: 1 },
    idempotencyKey: "idem-TASK-1-v0",
    ...overrides,
  };
}

function assertErrorEnvelope(res, expectedCode, expectedStatus) {
  assert.equal(res.status, expectedStatus, `expected HTTP ${expectedStatus}, body: ${res.text}`);
  assert.ok(res.json, `expected a JSON error body, got: ${res.text}`);
  assert.deepEqual(validateErrorBody(res.json), { ok: true, errors: [] });
  assert.equal(res.json.error.code, expectedCode);
  assert.equal(res.headers["x-request-id"], res.json.error.requestId);
}

async function withServer(t, options = {}) {
  const store = createStore(options);
  const ctx = await startServer({ store });
  t.after(() => ctx.server.close());
  return { ...ctx, store };
}

function claim(ctx, taskId = "TASK-1", body = claimBody()) {
  return request(ctx.base, {
    method: "POST",
    path: `/internal/v1/tasks/${taskId}/claim`,
    headers: internalHeaders(),
    body,
  });
}

test("scheduling snapshot requires the internal credential (browser token rejected)", async (t) => {
  const ctx = await withServer(t);

  assertErrorEnvelope(await request(ctx.base, { path: "/internal/v1/scheduling/snapshot" }), "NOT_AUTHORIZED", 403);
  const browser = await request(ctx.base, {
    path: "/internal/v1/scheduling/snapshot",
    headers: readHeaders(TEST_TOKEN),
  });
  assertErrorEnvelope(browser, "NOT_AUTHORIZED", 403);
  assert.equal(browser.json.error.details.reason, "internal-token-missing");

  const snapshot = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  assert.equal(snapshot.status, 200);
  assert.equal(Number.isInteger(snapshot.json.version), true);
  assert.ok(snapshot.json.version >= 1);
  assert.equal(Date.parse(snapshot.json.generatedAt), Date.parse(snapshot.json.generatedAt));
  assert.deepEqual(Object.keys(snapshot.json).sort(), ["agents", "generatedAt", "leases", "projects", "runs", "tasks", "version"]);
  assert.deepEqual(snapshot.json.projects.map((project) => project.id), ["P-1"]);
  assert.ok(Array.isArray(snapshot.json.leases));
  assert.equal(snapshot.text.includes(TEST_INTERNAL_TOKEN), false);
});

test("claim creates one Run + dispatch command, marks the Task CLAIMED and bumps the snapshot version", async (t) => {
  const ctx = await withServer(t);
  const before = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });

  const res = await claim(ctx);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.run.status, "STARTING");
  assert.equal(res.json.run.taskId, "TASK-1");
  assert.equal(res.json.run.agentId, "agent-1");
  assert.equal(res.json.run.function, "WORKER");
  assert.equal(res.json.run.role, "BE");
  assert.equal(res.json.command.status, "PENDING");
  assert.equal(res.json.command.idempotencyKey, "idem-TASK-1-v0");
  assert.equal(res.json.command.runId, res.json.run.id);
  assert.equal(res.json.task.status, "CLAIMED");
  assert.equal(res.json.task.version, 1);
  assert.equal(res.text.includes(TEST_INTERNAL_TOKEN), false);

  const after = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  assert.equal(after.json.version, before.json.version + 1, "version is monotonic per successful claim");
  assert.equal(after.json.runs.length, 1);
  assert.equal(after.json.tasks[0].status, "CLAIMED");

  // Both contract events are persisted and visible to the browser API.
  const events = await request(ctx.base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
  assert.deepEqual(events.json.items.map((event) => event.type).sort(), ["run.created", "task.updated"]);
});

test("claim validates the request body (400 VALIDATION_ERROR with field details)", async (t) => {
  const ctx = await withServer(t);

  for (const [label, body] of [
    ["missing agentId", claimBody({ agentId: undefined })],
    ["missing expectedTaskVersion", claimBody({ expectedTaskVersion: undefined })],
    ["missing idempotencyKey", claimBody({ idempotencyKey: undefined })],
    ["bad function", claimBody({ function: "NOPE" })],
    ["bad role", claimBody({ role: "be" })],
    ["bad policies", claimBody({ policies: { maxPerAgent: 0 } })],
  ]) {
    const res = await claim(ctx, "TASK-1", body);
    assertErrorEnvelope(res, "VALIDATION_ERROR", 400);
    assert.ok(Array.isArray(res.json.error.details.errors), label);
  }
  // Nothing was created by any rejected request.
  const snapshot = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  assert.equal(snapshot.json.runs.length, 0);
  assert.equal(snapshot.json.tasks[0].status, "READY");
});

test("claim rejects an unknown task with 404 NOT_FOUND", async (t) => {
  const ctx = await withServer(t);
  const res = await claim(ctx, "TASK-NOPE");
  assertErrorEnvelope(res, "NOT_FOUND", 404);
});

test("claim step 1: version mismatch and non-READY tasks are TASK_VERSION_CONFLICT", async (t) => {
  const ctx = await withServer(t);
  const wrongVersion = await claim(ctx, "TASK-1", claimBody({ expectedTaskVersion: 99 }));
  assertErrorEnvelope(wrongVersion, "TASK_VERSION_CONFLICT", 409);
  assert.equal(wrongVersion.json.error.details.currentVersion, 0);
  assert.equal(wrongVersion.json.error.details.expectedVersion, 99);

  const doneStore = createStore({ tasks: [readyTask({ status: "DONE", version: 2 })] });
  const doneCtx = await startServer({ store: doneStore });
  t.after(() => doneCtx.server.close());
  const notReady = await request(doneCtx.base, {
    method: "POST",
    path: "/internal/v1/tasks/TASK-1/claim",
    headers: internalHeaders(),
    body: claimBody({ expectedTaskVersion: 2 }),
  });
  assertErrorEnvelope(notReady, "TASK_VERSION_CONFLICT", 409);
  assert.equal(notReady.json.error.details.status, "DONE");
  assert.equal(notReady.json.error.details.currentVersion, 2);
});

test("claim step 2: unfinished dependencies are TASK_DEPENDENCY_BLOCKED with blockingTaskIds", async (t) => {
  const blocked = createStore({
    tasks: [readyTask({ deps: ["TASK-2", "TASK-3"] }), readyTask({ id: "TASK-2", status: "READY" }), readyTask({ id: "TASK-3", status: "DONE" })],
  });
  const ctx = await startServer({ store: blocked });
  t.after(() => ctx.server.close());

  const res = await claim(ctx);
  assertErrorEnvelope(res, "TASK_DEPENDENCY_BLOCKED", 409);
  assert.deepEqual(res.json.error.details.blockingTaskIds, ["TASK-2"]);

  // Once the dependency is DONE the same claim succeeds.
  const ok = createStore({
    tasks: [readyTask({ deps: ["TASK-2"] }), readyTask({ id: "TASK-2", status: "DONE" })],
  });
  const okCtx = await startServer({ store: ok });
  t.after(() => okCtx.server.close());
  const claimed = await claim(okCtx);
  assert.equal(claimed.status, 200, claimed.text);
});

test("claim step 3: missing/busy/wrong-role agent is CAPABILITY_UNAVAILABLE", async (t) => {
  for (const [label, agents, body] of [
    ["missing agent", [], claimBody()],
    ["busy agent", [idleAgent({ status: "BUSY" })], claimBody()],
    ["wrong role", [idleAgent({ role: "QA" })], claimBody()],
    ["missing function capability", [idleAgent({ capabilities: ["REVIEWER"] })], claimBody()],
  ]) {
    const ctx = await withServer(t, { agents });
    const res = await claim(ctx, "TASK-1", body);
    assertErrorEnvelope(res, "CAPABILITY_UNAVAILABLE", 409);
    assert.equal(res.json.error.details.reason, "capability-mismatch", label);
    assert.equal(res.json.error.details.agentId, "agent-1", label);
    assert.equal(res.json.error.details.requiredRole, "BE", label);
    assert.equal(res.json.error.details.requiredFunction, "WORKER", label);
  }
});

test("claim step 4: an active Run blocks a second claim with TASK_VERSION_CONFLICT + activeRunId", async (t) => {
  const ctx = await withServer(t, {
    runs: [{ id: "RUN-EXISTING", taskId: "TASK-1", agentId: "agent-1", function: "WORKER", status: "RUNNING", attempt: 1 }],
  });
  const res = await claim(ctx);
  assertErrorEnvelope(res, "TASK_VERSION_CONFLICT", 409);
  assert.equal(res.json.error.details.activeRunId, "RUN-EXISTING");
  assert.equal(res.json.error.details.currentVersion, 0);
});

test("claim step 5: project and agent capacity produce CAPABILITY_UNAVAILABLE reason capacity", async (t) => {
  const tasks = [
    readyTask(),
    readyTask({ id: "TASK-2" }),
  ];
  const busyRun = { id: "RUN-BUSY", taskId: "TASK-2", agentId: "agent-other", function: "WORKER", status: "RUNNING", attempt: 1 };

  const projectCtx = await withServer(t, { tasks, runs: [busyRun] });
  const project = await claim(projectCtx, "TASK-1", claimBody({ policies: { maxConcurrentPerProject: 1, maxPerAgent: 5 } }));
  assertErrorEnvelope(project, "CAPABILITY_UNAVAILABLE", 409);
  assert.deepEqual(
    { reason: project.json.error.details.reason, scope: project.json.error.details.scope, limit: project.json.error.details.limit, current: project.json.error.details.current },
    { reason: "capacity", scope: "project", limit: 1, current: 1 },
  );

  const agentCtx = await withServer(t, {
    tasks,
    runs: [{ ...busyRun, agentId: "agent-1" }],
  });
  const agent = await claim(agentCtx, "TASK-1", claimBody({ policies: { maxConcurrentPerProject: 5, maxPerAgent: 1 } }));
  assertErrorEnvelope(agent, "CAPABILITY_UNAVAILABLE", 409);
  assert.deepEqual(
    { reason: agent.json.error.details.reason, scope: agent.json.error.details.scope, limit: agent.json.error.details.limit, current: agent.json.error.details.current },
    { reason: "capacity", scope: "agent", limit: 1, current: 1 },
  );
});

test("claim step 6: overlapping declared write scope is CAPABILITY_UNAVAILABLE with the file list", async (t) => {
  const ctx = await withServer(t, {
    tasks: [readyTask({ files: ["src/a.js", "src/shared.js"] }), readyTask({ id: "TASK-2", files: ["src/shared.js", "src/b.js"] })],
    runs: [{ id: "RUN-SCOPE", taskId: "TASK-2", agentId: "agent-2", function: "WORKER", status: "RUNNING", attempt: 1 }],
  });
  const res = await claim(ctx);
  assertErrorEnvelope(res, "CAPABILITY_UNAVAILABLE", 409);
  assert.equal(res.json.error.details.reason, "write-scope-conflict");
  assert.equal(res.json.error.details.conflictingRunId, "RUN-SCOPE");
  assert.deepEqual(res.json.error.details.files, ["src/shared.js"]);
});

test("idempotent replay returns the same run/command and never creates a second Run", async (t) => {
  const ctx = await withServer(t);
  const first = await claim(ctx);
  assert.equal(first.status, 200, first.text);
  const snapshotAfterFirst = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  const eventsAfterFirst = await request(ctx.base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });

  // Same key, same body. The Task version is now 1, so a non-idempotent
  // implementation would answer 409 — the replay must return the first result.
  const replay = await claim(ctx);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.run.id, first.json.run.id);
  assert.equal(replay.json.command.id, first.json.command.id);
  assert.equal(replay.json.task.version, first.json.task.version);

  const snapshotAfterReplay = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  assert.equal(snapshotAfterReplay.json.runs.length, snapshotAfterFirst.json.runs.length, "no second Run");
  const eventsAfterReplay = await request(ctx.base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
  assert.equal(eventsAfterReplay.json.items.length, eventsAfterFirst.json.items.length, "no duplicate events");
});

test("two truly concurrent claims for the same Task: exactly one wins", async (t) => {
  const ctx = await withServer(t);
  const [first, second] = await Promise.all([
    claim(ctx, "TASK-1", claimBody({ idempotencyKey: "idem-concurrent-a" })),
    claim(ctx, "TASK-1", claimBody({ idempotencyKey: "idem-concurrent-b" })),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], `one winner expected, got ${first.status}/${second.status}: ${first.text} :: ${second.text}`);
  const winner = first.status === 200 ? first : second;
  const loser = first.status === 200 ? second : first;
  assert.equal(winner.json.run.taskId, "TASK-1");
  assert.equal(loser.json.error.code, "TASK_VERSION_CONFLICT");

  const snapshot = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  const runsForTask = snapshot.json.runs.filter((run) => run.taskId === "TASK-1");
  assert.equal(runsForTask.length, 1, "exactly one active Run after the race");
});

test("SSE receives task.updated and run.created after a successful claim", async (t) => {
  const ctx = await withServer(t);
  const client = await openSse(ctx.base, { token: TEST_TOKEN });
  t.after(() => closeSse(client));
  await waitForFrame(client, (frame) => String(frame.comment ?? "").startsWith("connected"));

  const res = await claim(ctx);
  assert.equal(res.status, 200, res.text);

  const runCreated = await waitForFrame(client, (frame) => frame.type === "run.created");
  const taskUpdated = await waitForFrame(client, (frame) => frame.type === "task.updated");
  assert.equal(runCreated.frame.payload.runId, res.json.run.id);
  assert.equal(taskUpdated.frame.payload.taskId, "TASK-1");
  assert.equal(taskUpdated.frame.payload.status, "CLAIMED");
  assert.equal(client.frames.filter((frame) => frame.type === "run.created").length, 1);
  assert.equal(client.frames.filter((frame) => frame.type === "task.updated").length, 1);
  assert.equal(client.frames.some((frame) => JSON.stringify(frame).includes(TEST_INTERNAL_TOKEN)), false);
});

test("scheduler heartbeat is recorded in-process and validated", async (t) => {
  const ctx = await withServer(t);
  const first = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/scheduler/heartbeat",
    headers: internalHeaders(),
    body: { ownerId: "scheduler-1", status: "RUNNING", details: { rounds: 3 } },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.ownerId, "scheduler-1");
  assert.equal(Number.isNaN(Date.parse(first.json.receivedAt)), false);
  assert.equal(ctx.server.stats().schedulerHeartbeat.ownerId, "scheduler-1");
  assert.deepEqual(ctx.server.stats().schedulerHeartbeat.details, { rounds: 3 });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/scheduler/heartbeat",
    headers: internalHeaders(),
    body: { ownerId: "scheduler-2" },
  });
  assert.equal(second.status, 200);
  assert.equal(ctx.server.stats().schedulerHeartbeat.ownerId, "scheduler-2");
  assert.ok(Date.parse(ctx.server.stats().schedulerHeartbeat.receivedAt) >= Date.parse(first.json.receivedAt));

  assertErrorEnvelope(
    await request(ctx.base, { method: "POST", path: "/internal/v1/scheduler/heartbeat", headers: internalHeaders(), body: {} }),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(
    await request(ctx.base, {
      method: "POST",
      path: "/internal/v1/scheduler/heartbeat",
      headers: internalHeaders(),
      body: { ownerId: "scheduler-1", details: "nope" },
    }),
    "VALIDATION_ERROR",
    400,
  );
});

test("claim without policies skips the capacity check (documented default)", async (t) => {
  const ctx = await withServer(t, {
    tasks: [readyTask(), readyTask({ id: "TASK-2" })],
    runs: [{ id: "RUN-BUSY", taskId: "TASK-2", agentId: "agent-1", function: "WORKER", status: "RUNNING", attempt: 1 }],
  });
  const res = await claim(ctx, "TASK-1", claimBody({ policies: undefined }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.run.status, "STARTING");
});

test("snapshot survives a failing store.schedulingSnapshot() by composing the read model", async (t) => {
  const store = createStore();
  store.schedulingSnapshot = () => {
    throw new Error("simulated store snapshot failure");
  };
  const ctx = await startServer({ store });
  t.after(() => ctx.server.close());

  const snapshot = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  assert.equal(snapshot.status, 200, snapshot.text);
  assert.deepEqual(snapshot.json.tasks.map((task) => task.id), ["TASK-1"]);
  assert.deepEqual(snapshot.json.projects, [{ id: "P-1", policy: null }]);
  assert.ok(Array.isArray(snapshot.json.leases));
  assert.equal(snapshot.json.version, store.latestSeq(), "fallback version is latestSeq()");
});

test("claim refuses a non-atomic fallback when store.claimTask is missing", async (t) => {
  const store = createStore();
  delete store.claimTask;
  const ctx = await startServer({ store });
  t.after(() => ctx.server.close());

  const res = await claim(ctx);
  assertErrorEnvelope(res, "INTERNAL_ERROR", 500);
  // Nothing was created by the failed claim.
  const after = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  assert.equal(after.json.runs.length, 0);
  assert.equal(after.json.tasks[0].status, "READY");
});

test("reusing an idempotencyKey for a different task is rejected without creating anything", async (t) => {
  const ctx = await withServer(t, { tasks: [readyTask(), readyTask({ id: "TASK-2" })] });
  const first = await claim(ctx);
  assert.equal(first.status, 200, first.text);

  const reused = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/tasks/TASK-2/claim",
    headers: internalHeaders(),
    body: claimBody({ idempotencyKey: "idem-TASK-1-v0" }),
  });
  assertErrorEnvelope(reused, "VALIDATION_ERROR", 400);
  const snapshot = await request(ctx.base, { path: "/internal/v1/scheduling/snapshot", headers: internalHeaders() });
  assert.equal(snapshot.json.runs.length, 1);
  assert.equal(snapshot.json.tasks.find((task) => task.id === "TASK-2").status, "READY");
});
