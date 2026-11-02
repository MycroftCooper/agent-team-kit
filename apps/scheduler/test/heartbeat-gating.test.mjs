// M6.2 F10 at the scheduler boundary: a fake store (the database stand-in) and
// the real planner. Proves the three states the m6.2 plan requires:
//   1. IDLE with no heartbeat -> no dispatch (the core F10 assertion);
//   2. heartbeat recovery      -> dispatch;
//   3. stale heartbeat         -> no dispatch until the next heartbeat.
// The refusal reason is part of the scheduling result, never silent.
import assert from "node:assert/strict";
import test from "node:test";
import { planDispatch } from "@atk/scheduler-core";
import { createScheduler } from "../src/index.mjs";

const TTL_MS = 50;
const START = "2026-01-01T00:10:00.000Z";

function fakeStore() {
  let now = START;
  const agents = [
    {
      id: "agent-dev-1",
      role: "DEV",
      capabilities: ["WORKER"],
      status: "IDLE",
      version: 1,
      capacity: 1,
      lastHeartbeatAt: undefined,
    },
  ];
  return {
    get now() {
      return now;
    },
    advance(ms) {
      now = new Date(Date.parse(now) + ms).toISOString();
    },
    listAgents() {
      return agents.map((agent) => ({ ...agent }));
    },
    recordHeartbeat({ capacity = 1 } = {}) {
      for (const agent of agents) {
        agent.lastHeartbeatAt = now;
        agent.capacity = capacity;
      }
      return { hostId: "host-1", agentIds: agents.map((agent) => agent.id), capacity, at: now };
    },
  };
}

/** Snapshot source for the scheduler client; also counts claims. */
function fakeClient(store) {
  const calls = { snapshot: 0, claim: [] };
  return {
    calls,
    async snapshot() {
      calls.snapshot += 1;
      return {
        version: calls.snapshot,
        generatedAt: store.now,
        projects: [],
        tasks: [
          {
            id: "T-READY",
            projectId: "P-1",
            status: "READY",
            version: 1,
            priority: 2,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            roleRequired: "DEV",
            functionRequired: "WORKER",
            deps: [],
          },
        ],
        agents: store.listAgents(),
        runs: [],
        leases: [],
      };
    },
    async claim(taskId) {
      calls.claim.push(taskId);
      return { run: { id: `run-${calls.claim.length}` } };
    },
    async heartbeat() {
      return { ok: true };
    },
  };
}

function makeScheduler(t, store) {
  const client = fakeClient(store);
  const scheduler = createScheduler({
    client,
    core: { planDispatch },
    policies: { maxConcurrentPerProject: 4, maxPerAgent: 1, heartbeatTtlMs: TTL_MS },
    ownerId: "scheduler-1",
    logger: { info() {}, warn() {}, error() {} },
    now: () => new Date(store.now),
  });
  t.after(() => scheduler.stop());
  return { scheduler, client };
}

test("IDLE with no heartbeat is not dispatched; a heartbeat makes it dispatchable", async (t) => {
  const store = fakeStore();
  const { scheduler, client } = makeScheduler(t, store);

  const refused = await scheduler.runOnce();
  assert.equal(refused.ok, true, "a refused agent is not a scheduler failure");
  assert.equal(refused.proposals, 0);
  assert.deepEqual(refused.results, []);
  assert.equal(client.calls.claim.length, 0, "nothing may be claimed without a heartbeat");
  assert.deepEqual(refused.unavailableAgents, [{ agentId: "agent-dev-1", reason: "no-heartbeat" }]);
  assert.equal(refused.heartbeatTtlMs, TTL_MS);

  // The host recovers: the next round dispatches the same task.
  store.recordHeartbeat();
  const dispatched = await scheduler.runOnce();
  assert.equal(dispatched.proposals, 1);
  assert.deepEqual(dispatched.results.map((entry) => entry.taskId), ["T-READY"]);
  assert.equal(dispatched.results[0].claimed, true);
  assert.equal(dispatched.unavailableAgents, undefined);
  assert.deepEqual(client.calls.claim, ["T-READY"]);
});

test("a stale heartbeat stops dispatch until the host checks in again", async (t) => {
  const store = fakeStore();
  const { scheduler, client } = makeScheduler(t, store);
  store.recordHeartbeat();

  await scheduler.runOnce();
  assert.equal(client.calls.claim.length, 1);

  store.advance(TTL_MS + 1);
  const stale = await scheduler.runOnce();
  assert.equal(stale.proposals, 0);
  assert.equal(client.calls.claim.length, 1, "an expired heartbeat must not dispatch");
  assert.deepEqual(stale.unavailableAgents, [{ agentId: "agent-dev-1", reason: "stale-heartbeat" }]);
  assert.equal(stale.skipped, 1, "the task is reported as skipped, not silently dropped");

  store.recordHeartbeat();
  const recovered = await scheduler.runOnce();
  assert.equal(recovered.proposals, 1);
  assert.equal(client.calls.claim.length, 2);
});
