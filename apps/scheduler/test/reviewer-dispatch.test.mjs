// m6.3 P1-8 at the Scheduler boundary: the claim the Scheduler sends must carry
// the task's execution identity (`function`/`role`), so the backend creates a
// REVIEWER Run for reviewer tasks instead of relying on an implicit default.
import assert from "node:assert/strict";
import test from "node:test";
import { planDispatch } from "@atk/scheduler-core";
import { createScheduler } from "../src/index.mjs";

const NOW_ISO = "2026-01-01T00:10:00.000Z";

function fakeClient(snapshotValue) {
  const claims = [];
  return {
    claims,
    async snapshot() {
      return snapshotValue;
    },
    async claim(taskId, body) {
      claims.push({ taskId, body });
      return { run: { id: `run-${claims.length}`, function: body.function } };
    },
    async heartbeat() {
      return { ok: true };
    },
  };
}

function snapshotWith(task) {
  return {
    version: 1,
    generatedAt: NOW_ISO,
    projects: [],
    tasks: [task],
    agents: [
      {
        id: "agent-qa-1",
        role: "QA",
        capabilities: ["REVIEWER"],
        status: "IDLE",
        version: 1,
        capacity: 1,
        lastHeartbeatAt: NOW_ISO,
      },
    ],
    runs: [],
    leases: [],
  };
}

function makeScheduler(t, client) {
  const scheduler = createScheduler({
    client,
    core: { planDispatch },
    policies: { maxConcurrentPerProject: 4, maxPerAgent: 1 },
    ownerId: "scheduler-1",
    logger: { info() {}, warn() {}, error() {} },
    now: () => new Date(NOW_ISO),
  });
  t.after(() => scheduler.stop());
  return scheduler;
}

const REVIEW_TASK = {
  id: "T-REVIEW",
  projectId: "P-1",
  status: "READY",
  version: 1,
  priority: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  roleRequired: "QA",
  functionRequired: "REVIEWER",
  deps: [],
  files: [],
};

test("the claim for a REVIEWER task carries function REVIEWER and the task role", async (t) => {
  const client = fakeClient(snapshotWith(REVIEW_TASK));
  const scheduler = makeScheduler(t, client);

  const result = await scheduler.runOnce();
  assert.equal(result.ok, true);
  assert.equal(client.claims.length, 1, JSON.stringify(result));
  assert.equal(client.claims[0].body.function, "REVIEWER", "claim must request a REVIEWER Run");
  assert.equal(client.claims[0].body.role, "QA");
  assert.equal(result.results[0].claimed, true);
});
