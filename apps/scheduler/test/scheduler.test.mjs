// Scheduler tests: a fake internal client and a fake core, so this suite tests
// the scheduler's own behaviour (planning is scheduler-core's job and has its own
// suite).
import assert from "node:assert/strict";
import test from "node:test";
import { createScheduler } from "../src/index.mjs";

function quietLogger() {
  const lines = [];
  return { lines, info: () => {}, warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

function fakeClient({ snapshot = { version: 1, tasks: [], agents: [], runs: [], leases: [] }, claimResults = {} } = {}) {
  const calls = { snapshot: 0, claim: [], heartbeat: [] };
  return {
    calls,
    snapshot() {
      calls.snapshot += 1;
      return Promise.resolve(snapshot);
    },
    claim(taskId, body) {
      calls.claim.push({ taskId, body });
      const outcome = claimResults[taskId];
      if (outcome === "missing-deps") {
        return Promise.reject(Object.assign(new Error("dependency blocked"), { code: "TASK_DEPENDENCY_BLOCKED" }));
      }
      if (outcome === "conflict") {
        return Promise.reject(Object.assign(new Error("version conflict"), { code: "TASK_VERSION_CONFLICT" }));
      }
      return Promise.resolve({ run: { id: `run-for-${taskId}` }, command: { id: `cmd-${taskId}` }, task: { id: taskId } });
    },
    heartbeat(body) {
      calls.heartbeat.push(body);
      return Promise.resolve({ ok: true });
    },
  };
}

function coreWith(proposals, skipped = []) {
  const seen = [];
  return {
    seen,
    planDispatch({ snapshot, policies }) {
      seen.push({ snapshot, policies });
      return { proposals, skipped };
    },
  };
}

test("a round plans from the snapshot and claims every proposal", async () => {
  const client = fakeClient();
  const core = coreWith([
    { taskId: "T-1", agentId: "agent-a", expectedTaskVersion: 2, workspacePolicy: { kind: "none" } },
    { taskId: "T-2", agentId: "agent-b", expectedTaskVersion: 1 },
  ]);
  const scheduler = createScheduler({ client, core, policies: { maxConcurrentPerProject: 2, maxPerAgent: 1 }, ownerId: "s1", logger: quietLogger() });
  const result = await scheduler.runOnce();

  assert.equal(result.ok, true);
  assert.equal(result.proposals, 2);
  assert.equal(client.calls.claim.length, 2);
  assert.deepEqual(client.calls.claim.map((call) => call.taskId), ["T-1", "T-2"]);
  assert.equal(client.calls.claim[0].body.expectedTaskVersion, 2);
  assert.equal(scheduler.stats.claimed, 2);
  assert.equal(scheduler.stats.skipped, 0);
  await scheduler.stop();
});

test("the planner receives the snapshot and the configured policies", async () => {
  const client = fakeClient({ snapshot: { version: 7, tasks: [{ id: "T-1" }], agents: [], runs: [], leases: [] } });
  const core = coreWith([]);
  const policies = { maxConcurrentPerProject: 3, maxPerAgent: 2 };
  const scheduler = createScheduler({ client, core, policies, ownerId: "s1", logger: quietLogger() });
  await scheduler.runOnce();
  assert.equal(core.seen.length, 1);
  assert.equal(core.seen[0].snapshot.version, 7);
  assert.deepEqual(core.seen[0].policies, policies);
  assert.equal(scheduler.stats.lastVersion, 7);
  await scheduler.stop();
});

test("a failed claim is recorded and does not stop the other proposals", async () => {
  const client = fakeClient({ claimResults: { "T-2": "missing-deps" } });
  const core = coreWith([
    { taskId: "T-1", agentId: "agent-a", expectedTaskVersion: 1 },
    { taskId: "T-2", agentId: "agent-b", expectedTaskVersion: 1 },
  ]);
  const scheduler = createScheduler({ client, core, policies: {}, ownerId: "s1", logger: quietLogger() });
  const result = await scheduler.runOnce();

  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].claimed, true);
  assert.equal(result.results[1].claimed, false);
  assert.equal(result.results[1].code, "TASK_DEPENDENCY_BLOCKED");
  assert.equal(scheduler.stats.claimed, 1);
  assert.equal(scheduler.stats.failed, 1);
  assert.equal(scheduler.failures().length, 1);
  await scheduler.stop();
});

test("a snapshot failure backs off instead of crashing", async () => {
  const client = fakeClient();
  client.snapshot = () => Promise.reject(new Error("backend down"));
  const scheduler = createScheduler({ client, core: coreWith([]), policies: {}, ownerId: "s1", logger: quietLogger() });
  const first = await scheduler.runOnce();
  assert.equal(first.ok, false);
  assert.ok(first.backoffMs >= 1000);
  const second = await scheduler.runOnce();
  assert.ok(second.backoffMs >= first.backoffMs, "backoff must not shrink while the backend is down");
  await scheduler.stop();
});

test("skipped proposals do not produce claims", async () => {
  const client = fakeClient();
  const core = coreWith([], [{ taskId: "T-9", reason: "deps-incomplete" }, { taskId: "T-8", reason: "cycle" }]);
  const scheduler = createScheduler({ client, core, policies: {}, ownerId: "s1", logger: quietLogger() });
  const result = await scheduler.runOnce();
  assert.equal(result.proposals, 0);
  assert.equal(result.skipped, 2);
  assert.equal(client.calls.claim.length, 0);
  await scheduler.stop();
});

test("start() runs rounds and heartbeat; stop() halts both", async () => {
  const client = fakeClient();
  const core = coreWith([{ taskId: "T-1", agentId: "agent-a", expectedTaskVersion: 1 }]);
  const scheduler = createScheduler({ client, core, policies: {}, ownerId: "s1", pollMs: 10, heartbeatMs: 10, logger: quietLogger() });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await scheduler.stop();
  assert.ok(client.calls.snapshot >= 1);
  assert.ok(client.calls.claim.length >= 1);
  assert.ok(client.calls.heartbeat.length >= 1);
  const snapshotsAtStop = client.calls.snapshot;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(client.calls.snapshot <= snapshotsAtStop + 1, "rounds must stop after stop()");
});

test("the scheduler proposes identical work for an unchanged snapshot (no hidden state)", async () => {
  const snapshot = { version: 3, tasks: [{ id: "T-1" }], agents: [], runs: [], leases: [] };
  const proposals = [{ taskId: "T-1", agentId: "agent-a", expectedTaskVersion: 1 }];
  const client = fakeClient({ snapshot });
  const core = coreWith(proposals);
  const scheduler = createScheduler({ client, core, policies: {}, ownerId: "s1", logger: quietLogger() });
  await scheduler.runOnce();
  const first = client.calls.claim.map((call) => call.body);
  await scheduler.runOnce();
  const second = client.calls.claim.slice(first.length).map((call) => call.body);
  assert.deepEqual(second, first, "a stateless scheduler must propose the same thing for the same snapshot");
  await scheduler.stop();
});
