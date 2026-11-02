// M6.3 P0-2/P0-1: independent role credentials, registration, header
// assertions and the human approval boundary.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createFakeStore } from "./fake-store.mjs";
import { request, startServer } from "./helpers.mjs";

function storeFixture() {
  return createFakeStore({
    projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks: [
      {
        id: "TASK-1",
        projectId: "P-1",
        title: "Task",
        description: "d",
        functionRequired: "WORKER",
        roleRequired: "BE",
        priority: 2,
        deps: [],
        status: "READY",
        version: 0,
      },
    ],
    agents: [{ id: "agent-1", role: "BE", capabilities: ["WORKER"], status: "IDLE" }],
  });
}

async function withServer(t) {
  const ctx = await startServer({ store: storeFixture() });
  t.after(() => ctx.server.close());
  return ctx;
}

function internal(token, role) {
  return { "x-atk-internal": token, ...(role === undefined ? {} : { "x-atk-internal-role": role }) };
}

test("P0-2: scheduler and runtime-host tokens are independent and not interchangeable", async (t) => {
  const ctx = await withServer(t);
  const { scheduler, "runtime-host": host } = ctx.internalTokens;
  assert.equal(typeof scheduler, "string");
  assert.equal(typeof host, "string");
  assert.notEqual(scheduler, host, "each role gets its own token");

  // Scheduler token cannot claim the runtime-host role.
  const hostRoleWithSchedulerToken = await request(ctx.base, {
    path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=5000",
    headers: internal(host, "runtime-host"),
  });
  assert.ok([200, 204].includes(hostRoleWithSchedulerToken.status), hostRoleWithSchedulerToken.text);

  const schedulerTokenAsHostRole = await request(ctx.base, {
    path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=5000",
    headers: internal(scheduler, "runtime-host"),
  });
  assert.equal(schedulerTokenAsHostRole.status, 403, schedulerTokenAsHostRole.text);
  assert.equal(schedulerTokenAsHostRole.json.error.details.reason, "internal-role-forbidden");

  // Host token cannot claim the scheduler role.
  const hostTokenAsScheduler = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/tasks/TASK-1/claim",
    headers: internal(host, "scheduler"),
    body: { agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "p02-cross" },
  });
  assert.equal(hostTokenAsScheduler.status, 403, hostTokenAsScheduler.text);
  assert.equal(hostTokenAsScheduler.json.error.details.reason, "internal-role-forbidden");

  // Unknown/missing token is refused with the frozen reason codes.
  const unknown = await request(ctx.base, {
    path: "/internal/v1/dispatch/claim?owner=host-1",
    headers: internal("not-a-real-token", "runtime-host"),
  });
  assert.equal(unknown.status, 403, unknown.text);
  assert.equal(unknown.json.error.details.reason, "internal-token-invalid");

  const missing = await request(ctx.base, { path: "/internal/v1/dispatch/claim?owner=host-1" });
  assert.equal(missing.status, 403, missing.text);
  assert.equal(missing.json.error.details.reason, "internal-token-missing");
});

test("P0-2: a role header that contradicts the token binding is 403", async (t) => {
  const ctx = await withServer(t);
  const { scheduler, "runtime-host": host } = ctx.internalTokens;
  const mismatch = await request(ctx.base, {
    path: "/internal/v1/runs/RUN-1/reconcile",
    headers: internal(host, "scheduler"),
  });
  assert.equal(mismatch.status, 403, mismatch.text);
  assert.equal(mismatch.json.error.details.reason, "internal-role-forbidden");

  const schedulerEndpointWithSchedulerToken = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/tasks/TASK-1/claim",
    headers: internal(scheduler, "scheduler"),
    body: { agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "p02-ok" },
  });
  assert.equal(schedulerEndpointWithSchedulerToken.status, 200, schedulerEndpointWithSchedulerToken.text);
});

test("P0-2: any internal token is refused by human approval decide", async (t) => {
  const ctx = await withServer(t);
  const { scheduler, "runtime-host": host } = ctx.internalTokens;
  for (const [token, role] of [[scheduler, "scheduler"], [host, "runtime-host"]]) {
    const res = await request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals/APPROVAL-1/decide",
      headers: internal(token, role),
      body: { decision: "APPROVED", targetHash: "a".repeat(64) },
    });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.error.details.reason, "human-approval-requires-session");
  }
});

test("P0-1: runtime-host registers agents before heartbeats", async (t) => {  const { openStore } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "..", "..", "packages", "database", "src", "index.mjs")).href
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m63-register-"));
  const store = openStore({ file: path.join(dir, "atk.db"), migrate: true });
  store.createProject({ id: "P-1", name: "P", repoPath: ".", defaultBranch: "main" });
  const ctx = await startServer({ store });
  t.after(async () => {
    await ctx.server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const hostToken = ctx.internalTokens["runtime-host"];
  const register = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/runtime/register",
    headers: internal(hostToken, "runtime-host"),
    body: {
      hostId: "host-1",
      agents: [{ agentId: "host-1-agent", role: "DEV", function: "WORKER", capacity: 2 }],
    },
  });
  assert.equal(register.status, 200, register.text);
  assert.equal(register.json.hostId, "host-1");
  assert.deepEqual(register.json.agents.map((entry) => entry.agentId), ["host-1-agent"]);
  assert.equal(store.listAgents().find((agent) => agent.id === "host-1-agent")?.status, "IDLE");

  const heartbeat = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/runtime/heartbeat",
    headers: internal(hostToken, "runtime-host"),
    body: { hostId: "host-1", agentIds: ["host-1-agent"], capacity: 2 },
  });
  assert.equal(heartbeat.status, 200, heartbeat.text);
  assert.deepEqual(heartbeat.json.agents.map((entry) => entry.agentId), ["host-1-agent"]);
  assert.equal(heartbeat.json.agents[0].available, true, heartbeat.text);
  const registered = store.listAgents().find((agent) => agent.id === "host-1-agent");
  assert.equal(registered.hostId, "host-1");
  assert.equal(registered.capacity, 2);
  assert.ok(Number.isFinite(Date.parse(registered.lastHeartbeatAt)), "heartbeat timestamps the agent");

  const wrongRole = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/runtime/register",
    headers: internal(ctx.internalTokens.scheduler, "scheduler"),
    body: { hostId: "host-1", agents: [{ agentId: "x-agent", role: "DEV", function: "WORKER" }] },
  });
  assert.equal(wrongRole.status, 403, wrongRole.text);
  assert.equal(wrongRole.json.error.details.reason, "internal-role-forbidden");

  const invalidField = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/runtime/register",
    headers: internal(hostToken, "runtime-host"),
    body: { hostId: "host-2", agents: [{ agentId: "bad id!", role: "DEV", function: "WORKER" }] },
  });
  assert.equal(invalidField.status, 400, invalidField.text);
  assert.equal(invalidField.json.error.details.field, "agents[0].agentId");
});

test("P0-2: the runtime-host token still drives events and result normally", async (t) => {
  const ctx = await withServer(t);
  const { scheduler, "runtime-host": host } = ctx.internalTokens;
  const claimed = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/tasks/TASK-1/claim",
    headers: internal(scheduler, "scheduler"),
    body: { agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "p02-events" },
  });
  assert.equal(claimed.status, 200, claimed.text);
  const runId = claimed.json.run.id;

  const dispatched = await request(ctx.base, {
    path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=30000",
    headers: internal(host, "runtime-host"),
  });
  assert.equal(dispatched.status, 200, dispatched.text);
  const generation = dispatched.json.lease.generation;
  const at = new Date().toISOString();
  const events = await request(ctx.base, {
    method: "POST",
    path: `/internal/v1/runs/${runId}/events`,
    headers: internal(host, "runtime-host"),
    body: {
      generation,
      events: [
        { type: "session.started", sessionId: "S-1", at },
        { type: "session.ended", sessionId: "S-1", reason: "completed", exitCode: 0, at },
      ],
    },
  });
  assert.equal(events.status, 200, events.text);
  const result = await request(ctx.base, {
    method: "POST",
    path: `/internal/v1/dispatch/${dispatched.json.command.id}/result`,
    headers: internal(host, "runtime-host"),
    body: { ownerId: "host-1", generation, status: "DONE", exitCode: 0 },
  });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.command.status, "DONE");
});
