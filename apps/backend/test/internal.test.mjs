// M2 internal API tests (m2-contracts 搂2): separate internal credential,
// dispatch claim/result, lease renewal with generation fencing, RuntimeEvent
// mapping to Run state + business events, reconcile shape and the SSE producer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateErrorBody } from "@atk/contracts";

import { createServer } from "../src/server.mjs";
import { createFakeStore } from "./fake-store.mjs";
import {
  TEST_INTERNAL_TOKEN,
  TEST_TOKEN,
  closeSse,
  delay,
  internalHeaders,
  openSse,
  readHeaders,
  recordingLogger,
  request,
  startServer,
  waitForFrame,
  writeHeaders,
} from "./helpers.mjs";

const AT = "2026-11-02T03:00:00.000Z";

function assertErrorEnvelope(res, expectedCode, expectedStatus) {
  assert.equal(res.status, expectedStatus, `expected HTTP ${expectedStatus}, body: ${res.text}`);
  assert.ok(res.json, `expected JSON error body, got: ${res.text}`);
  assert.deepEqual(validateErrorBody(res.json), { ok: true, errors: [] });
  assert.equal(res.json.error.code, expectedCode);
  assert.equal(res.headers["x-request-id"], res.json.error.requestId);
}

/** Fresh M2 scenario: project + task + STARTING run + one PENDING command. */
function createScenario({ enqueue = true } = {}) {
  const store = createFakeStore({
    projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks: [
      {
        id: "TASK-1",
        projectId: "P-1",
        title: "Do work",
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
  const run = store.createRun({ id: "RUN-1", taskId: "TASK-1", agentId: "agent-1", function: "WORKER", attempt: 1 });
  if (enqueue) {
    store.enqueueDispatchCommand({
      runId: run.id,
      commandType: "start_run",
      payload: { prompt: "hello" },
      idempotencyKey: "idem-1",
    });
  }
  return { store, run };
}

/** Scenario started on a random port, already claiming one command; cleans up with `t`. */
async function claimedScenario(t, options = {}) {
  const scenario = createScenario({ enqueue: options.enqueue ?? true });
  const ctx = await startServer({ store: scenario.store, ...options });
  t.after(async () => {
    await ctx.server.close();
    scenario.store.close();
  });
  let claim = null;
  if (options.claim !== false) {
    const response = await request(ctx.base, {
      path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=5000",
      headers: internalHeaders(),
    });
    assert.equal(response.status, 200, response.text);
    claim = response.json;
  }
  return { ...scenario, ...ctx, claim };
}

test("internal routes require x-atk-internal and reject the browser token", async (t) => {
  const { store } = createScenario();
  const { server, base } = await startServer({ store });
  t.after(() => server.close());

  assertErrorEnvelope(
    await request(base, { method: "POST", path: "/internal/v1/runtime/heartbeat", body: heartbeatBody() }),
    "NOT_AUTHORIZED",
    403,
  );
  const missing = await request(base, { method: "POST", path: "/internal/v1/runtime/heartbeat", body: heartbeatBody() });
  assert.equal(missing.json.error.details.reason, "internal-token-missing");

  const wrong = await request(base, {
    method: "POST",
    path: "/internal/v1/runtime/heartbeat",
    headers: internalHeaders("not-the-internal-token"),
    body: heartbeatBody(),
  });
  assertErrorEnvelope(wrong, "NOT_AUTHORIZED", 403);
  assert.equal(wrong.json.error.details.reason, "internal-token-invalid");

  // ADR-008 搂5: the browser session token must never unlock the internal plane.
  const browserToken = await request(base, {
    method: "POST",
    path: "/internal/v1/runtime/heartbeat",
    headers: readHeaders(TEST_TOKEN),
    body: heartbeatBody(),
  });
  assertErrorEnvelope(browserToken, "NOT_AUTHORIZED", 403);
  assert.equal(browserToken.json.error.details.reason, "internal-token-missing");

  // ...and the internal token must never unlock the browser API.
  const internalOnBrowserApi = await request(base, {
    path: "/api/v1/tasks",
    headers: internalHeaders(),
  });
  assertErrorEnvelope(internalOnBrowserApi, "NOT_AUTHORIZED", 403);
  assert.equal(internalOnBrowserApi.json.error.details.reason, "token-missing");

  // Host is still validated for internal calls.
  const badHost = await request(base, {
    method: "POST",
    path: "/internal/v1/runtime/heartbeat",
    headers: { ...internalHeaders(), Host: "evil.example:1421" },
    body: heartbeatBody(),
  });
  assertErrorEnvelope(badHost, "NOT_AUTHORIZED", 403);
  assert.equal(badHost.json.error.details.reason, "host-not-loopback");
});

test("the internal token is never returned by any HTTP response", async (t) => {  const { store } = createScenario();
  const { server, base } = await startServer({ store });
  t.after(() => server.close());

  const responses = [
    await request(base, { path: "/api/v1/system/health" }),
    await request(base, { path: "/api/v1/session" }),
    await request(base, { method: "POST", path: "/internal/v1/runtime/heartbeat", headers: internalHeaders(), body: heartbeatBody() }),
    await request(base, { path: "/internal/v1/dispatch/claim?owner=host-1", headers: internalHeaders() }),
    await request(base, { path: "/internal/v1/runtime/heartbeat", headers: internalHeaders("wrong") }),
    await request(base, { path: "/internal/v1/does-not-exist", headers: internalHeaders() }),
  ];
  for (const res of responses) {
    const headerDump = JSON.stringify(res.headers);
    assert.equal(res.text.includes(TEST_INTERNAL_TOKEN), false, `body leaked the internal token: ${res.text}`);
    assert.equal(headerDump.includes(TEST_INTERNAL_TOKEN), false, `headers leaked the internal token: ${headerDump}`);
  }
  // Server exposes it in-process for the CLI/env handoff only.
  assert.equal(server.internalToken, TEST_INTERNAL_TOKEN);
});

test("the internal token is process-only: not the session token, not persisted, not logged", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atk-internal-token-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "session-token");
  const logger = recordingLogger();
  const server = createServer({
    store: createScenario().store,
    token: "session-token-value",
    csrf: "csrf-value",
    tokenFile,
    persistToken: true,
    logger,
  });
  t.after(() => server.close());

  assert.notEqual(server.internalToken, "session-token-value");
  assert.notEqual(server.internalToken, server.session.token);
  assert.match(server.internalToken, /^[A-Za-z0-9_-]{40,}$/, "32 random bytes, base64url");

  // Only the browser session token touches disk; the internal credential does not.
  const persisted = fs.readFileSync(tokenFile, "utf8");
  assert.equal(persisted.trim(), "session-token-value");
  assert.equal(persisted.includes(server.internalToken), false);
  assert.equal(JSON.stringify(logger.lines).includes(server.internalToken), false, "never logged");
});

test("dispatch claim returns 204 when there is no pending command", async (t) => {
  const { store } = createScenario({ enqueue: false });
  const { server, base } = await startServer({ store });
  t.after(() => server.close());

  const res = await request(base, {
    path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=5000",
    headers: internalHeaders(),
  });
  assert.equal(res.status, 204);
  assert.equal(res.text, "");
});

test("dispatch claim returns command/run/task/lease and marks the command CLAIMED", async (t) => {
  const { store } = createScenario();
  const { server, base } = await startServer({ store });
  t.after(() => server.close());

  const res = await request(base, {
    path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=5000",
    headers: internalHeaders(),
  });
  assert.equal(res.status, 200, res.text);
  const { command, run, task, lease } = res.json;
  assert.equal(command.status, "CLAIMED");
  assert.equal(command.ownerId, "host-1");
  assert.equal(command.generation, 1);
  assert.equal(run.id, "RUN-1");
  assert.equal(run.status, "STARTING");
  assert.deepEqual(Object.keys(task).sort(), ["functionRequired", "id", "priority", "roleRequired", "status", "title"]);
  assert.equal(lease.ownerId, "host-1");
  assert.equal(lease.generation, 1);
  assert.ok(Date.parse(lease.claimedUntil) > Date.now());
  assert.equal(res.text.includes(TEST_INTERNAL_TOKEN), false);

  // The command is now claimed: a second poll has nothing to hand out.
  const second = await request(base, {
    path: "/internal/v1/dispatch/claim?owner=host-2&leaseMs=5000",
    headers: internalHeaders(),
  });
  assert.equal(second.status, 204);
});

test("dispatch claim validates owner and leaseMs", async (t) => {
  const { store } = createScenario();
  const { server, base } = await startServer({ store });
  t.after(() => server.close());

  assertErrorEnvelope(
    await request(base, { path: "/internal/v1/dispatch/claim", headers: internalHeaders() }),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(
    await request(base, { path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=abc", headers: internalHeaders() }),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(
    await request(base, { path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=10", headers: internalHeaders() }),
    "VALIDATION_ERROR",
    400,
  );
});

test("dispatch result is idempotent and fences stale generations", async (t) => {
  const { claim, base } = await claimedScenario(t);

  const commandId = claim.command.id;
  const body = { ownerId: "host-1", generation: 1, status: "DONE", exitCode: 0, summary: "finished" };
  const first = await request(base, { method: "POST", path: `/internal/v1/dispatch/${commandId}/result`, headers: internalHeaders(), body });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.command.status, "DONE");
  assert.equal(first.json.run.id, "RUN-1");

  const replay = await request(base, { method: "POST", path: `/internal/v1/dispatch/${commandId}/result`, headers: internalHeaders(), body });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.command.status, "DONE");

  // A second, independently claimed command shows the stale-generation path.
  const scenario2 = createScenario();
  const ctx2 = await startServer({ store: scenario2.store });
  t.after(() => ctx2.server.close());
  const claim2 = await request(ctx2.base, {
    path: "/internal/v1/dispatch/claim?owner=host-9&leaseMs=5000",
    headers: internalHeaders(),
  });
  const stale = await request(ctx2.base, {
    method: "POST",
    path: `/internal/v1/dispatch/${claim2.json.command.id}/result`,
    headers: internalHeaders(),
    body: { ownerId: "host-9", generation: 99, status: "DONE" },
  });
  assertErrorEnvelope(stale, "STALE_GENERATION", 409);
  assert.equal(stale.json.error.details.commandId, claim2.json.command.id);
  assert.equal(stale.json.error.details.generation, 99);
  assert.equal(stale.json.error.details.currentGeneration, 1);
  assert.equal(stale.json.error.details.reason, "generation-mismatch");

  assertErrorEnvelope(
    await request(base, { method: "POST", path: `/internal/v1/dispatch/${commandId}/result`, headers: internalHeaders(), body: { ownerId: "host-1", status: "DONE" } }),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(
    await request(base, { method: "POST", path: "/internal/v1/dispatch/CMD-NOPE/result", headers: internalHeaders(), body: { ownerId: "host-1", generation: 1, status: "DONE" } }),
    "NOT_FOUND",
    404,
  );
});

test("renew bumps the generation and rejects stale/expired leases", async (t) => {
  const { base } = await claimedScenario(t);

  const renewBody = { ownerId: "host-1", generation: 1, leaseMs: 5000 };
  const renewed = await request(base, { method: "POST", path: "/internal/v1/runs/RUN-1/renew", headers: internalHeaders(), body: renewBody });
  assert.equal(renewed.status, 200, renewed.text);
  assert.equal(renewed.json.lease.generation, 2);
  assert.equal(renewed.json.lease.ownerId, "host-1");

  const stale = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/renew",
    headers: internalHeaders(),
    body: renewBody,
  });
  assertErrorEnvelope(stale, "STALE_GENERATION", 409);
  assert.deepEqual(stale.json.error.details, {
    runId: "RUN-1",
    generation: 1,
    currentGeneration: 2,
    reason: "generation-mismatch",
  });

  const wrongOwner = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/renew",
    headers: internalHeaders(),
    body: { ownerId: "host-2", generation: 2, leaseMs: 5000 },
  });
  assertErrorEnvelope(wrongOwner, "STALE_GENERATION", 409);
  assert.equal(wrongOwner.json.error.details.runId, "RUN-1");
  assert.equal(wrongOwner.json.error.details.generation, 2);
  assert.equal(wrongOwner.json.error.details.currentGeneration, 2);
  assert.equal(wrongOwner.json.error.details.reason, "generation-mismatch");

  // Expired lease: claim with a 1ms lease directly, then renew after it lapsed.
  const scenario = createScenario();
  const expiredCtx = await startServer({ store: scenario.store });
  t.after(() => expiredCtx.server.close());
  scenario.store.claimDispatchCommand({ ownerId: "host-3", leaseMs: 1 });
  await delay(20);
  const expired = await request(expiredCtx.base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/renew",
    headers: internalHeaders(),
    body: { ownerId: "host-3", generation: 1, leaseMs: 5000 },
  });
  assertErrorEnvelope(expired, "STALE_GENERATION", 409);
  assert.equal(expired.json.error.details.reason, "lease-expired");
  assert.equal(expired.json.error.details.generation, 1);
  assert.equal(expired.json.error.details.currentGeneration, 1);

  // An unknown run has no lease either: the store fences it as stale rather
  // than leaking existence (database renewRunLease reports lease-missing).
  const unknown = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-NOPE/renew",
    headers: internalHeaders(),
    body: renewBody,
  });
  assertErrorEnvelope(unknown, "STALE_GENERATION", 409);
  assert.equal(unknown.json.error.details.runId, "RUN-NOPE");
  assert.equal(unknown.json.error.details.generation, 1);
  assert.equal(unknown.json.error.details.currentGeneration, null);
  assert.equal(unknown.json.error.details.reason, "lease-missing");
});

test("session.started advances STARTING -> RUNNING and the store persists run.updated", async (t) => {
  const { base } = await claimedScenario(t);

  const res = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers: internalHeaders(),
    body: { generation: 1, events: [{ type: "session.started", sessionId: "S-1", at: AT }] },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.run.status, "RUNNING");
  assert.equal(res.json.run.version, 1);
  // The batch's applied list carries the store-written run.updated event; a
  // pure status batch has no run.log event.
  assert.deepEqual(res.json.applied.map((event) => event.type), ["run.updated"]);

  const events = await request(base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
  assert.equal(events.status, 200);
  assert.deepEqual(events.json.items.map((event) => event.type), ["run.created", "run.updated"]);
  const updated = events.json.items[1];
  assert.equal(updated.payload.runId, "RUN-1");
  assert.equal(updated.payload.status, "RUNNING");
  assert.equal(updated.payload.previousStatus, "STARTING");
  assert.equal(updated.payload.version, 1);
});

test("session.ended maps every reason to its terminal Run status", async (t) => {
  const expected = {
    completed: "COMPLETED",
    failed: "FAILED",
    cancelled: "CANCELLED",
    interrupted: "INTERRUPTED",
  };
  for (const [reason, status] of Object.entries(expected)) {
    const { base } = await claimedScenario(t);
    const headers = internalHeaders();
    const started = await request(base, {
      method: "POST",
      path: "/internal/v1/runs/RUN-1/events",
      headers,
      body: { generation: 1, events: [{ type: "session.started", sessionId: "S-1", at: AT }] },
    });
    assert.equal(started.status, 200, started.text);
    const ended = await request(base, {
      method: "POST",
      path: "/internal/v1/runs/RUN-1/events",
      headers,
      body: {
        generation: 1,
        events: [{ type: "session.ended", sessionId: "S-1", at: "2026-11-02T03:01:00.000Z", reason, exitCode: reason === "completed" ? 0 : 1 }],
      },
    });
    assert.equal(ended.status, 200, ended.text);
    assert.equal(ended.json.run.status, status, reason);
    assert.deepEqual(ended.json.applied.map((event) => event.type), ["run.updated"], "status-only batch writes run.updated");
    assert.ok(ended.json.run.endedAt, "terminal run has endedAt");

    const events = await request(base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
    const last = events.json.items.at(-1);
    assert.equal(last.type, "run.updated");
    assert.equal(last.payload.status, status, reason);
    assert.equal(last.payload.previousStatus, "RUNNING", reason);
  }
});

test("output and log events become run.log payloads (8 KiB truncation)", async (t) => {
  const { base } = await claimedScenario(t);
  const headers = internalHeaders();
  await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers,
    body: { generation: 1, events: [{ type: "session.started", sessionId: "S-1", at: AT }] },
  });

  const huge = "x".repeat(9000);
  const res = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers,
    body: {
      generation: 1,
      events: [
        { type: "output", sessionId: "S-1", stream: "stdout", text: "hello", at: "2026-11-02T03:00:01.000Z" },
        { type: "log", sessionId: "S-1", level: "warn", message: "careful", at: "2026-11-02T03:00:02.000Z" },
        { type: "output", sessionId: "S-1", stream: "stderr", text: huge, at: "2026-11-02T03:00:03.000Z" },
        { type: "state", sessionId: "S-1", state: "idle", at: "2026-11-02T03:00:04.000Z" },
      ],
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.applied.length, 3, "state events do not append business events");
  const [stdout, log, truncated] = res.json.applied;
  assert.deepEqual(stdout.payload, { runId: "RUN-1", sessionId: "S-1", stream: "stdout", text: "hello" });
  assert.deepEqual(log.payload, { runId: "RUN-1", sessionId: "S-1", stream: "log", level: "warn", message: "careful" });
  assert.equal(truncated.type, "run.log");
  assert.equal(truncated.payload.truncated, true);
  assert.equal(truncated.payload.bytes, 9000);
  assert.ok(Buffer.byteLength(truncated.payload.text, "utf8") <= 8 * 1024);
  assert.equal(res.json.run.status, "RUNNING", "logs never advance Run status");
});

test("invalid RuntimeEvents are rejected without persisting anything", async (t) => {
  const { store, base } = await claimedScenario(t);
  const before = store.latestSeq();

  const res = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers: internalHeaders(),
    body: {
      generation: 1,
      events: [
        { type: "output", sessionId: "S-1", stream: "pipe", text: "nope", at: AT },
        { type: "session.ended", sessionId: "S-1", reason: "exploded", exitCode: "x", at: AT },
      ],
    },
  });
  assertErrorEnvelope(res, "VALIDATION_ERROR", 400);
  assert.ok(res.json.error.details.errors.length >= 3);
  assert.equal(store.latestSeq(), before, "no partial event write");

  assertErrorEnvelope(
    await request(base, { method: "POST", path: "/internal/v1/runs/RUN-1/events", headers: internalHeaders(), body: { generation: 1, events: "nope" } }),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(
    await request(base, {
      method: "POST",
      path: "/internal/v1/runs/RUN-1/events",
      headers: internalHeaders(),
      body: { generation: 1, events: Array.from({ length: 1001 }, () => ({ type: "state", sessionId: "S-1", state: "idle", at: AT })) },
    }),
    "VALIDATION_ERROR",
    400,
  );
});

test("stale generation is 409 STALE_GENERATION and never touches the run", async (t) => {
  const { store, base } = await claimedScenario(t);
  const seqBefore = store.latestSeq();

  const res = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers: internalHeaders(),
    body: { generation: 7, events: [{ type: "session.started", sessionId: "S-1", at: AT }] },
  });
  assertErrorEnvelope(res, "STALE_GENERATION", 409);
  assert.deepEqual(res.json.error.details, {
    runId: "RUN-1",
    generation: 7,
    currentGeneration: 1,
    reason: "generation-mismatch",
  });
  assert.equal(store.getRun("RUN-1").status, "STARTING");
  assert.equal(store.latestSeq(), seqBefore, "fenced-out report writes nothing");
});

test("retried event batches are deduped by (runId, sessionId, at, type)", async (t) => {
  const { store, base } = await claimedScenario(t);
  const headers = internalHeaders();
  const batch = {
    generation: 1,
    events: [
      { type: "session.started", sessionId: "S-1", at: AT },
      { type: "output", sessionId: "S-1", stream: "stdout", text: "once", at: "2026-11-02T03:00:01.000Z" },
    ],
  };
  const first = await request(base, { method: "POST", path: "/internal/v1/runs/RUN-1/events", headers, body: batch });
  assert.equal(first.status, 200, first.text);
  // The applied list is everything the single transaction wrote: the status
  // transition's run.updated plus the run.log event.
  assert.equal(first.json.applied.length, 2);
  assert.deepEqual(first.json.applied.map((event) => event.type), ["run.updated", "run.log"]);
  assert.equal(first.json.skipped, 0);
  const seqAfterFirst = store.latestSeq();

  const replay = await request(base, { method: "POST", path: "/internal/v1/runs/RUN-1/events", headers, body: batch });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.applied.length, 0);
  assert.equal(replay.json.skipped, 2);
  assert.equal(store.latestSeq(), seqAfterFirst, "duplicate batch writes nothing");
  assert.equal(replay.json.run.status, "RUNNING");
});

test("runtime heartbeat validates its payload and acknowledges", async (t) => {
  const { store } = createScenario();
  const { server, base } = await startServer({ store });
  t.after(() => server.close());

  const ok = await request(base, { method: "POST", path: "/internal/v1/runtime/heartbeat", headers: internalHeaders(), body: heartbeatBody() });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.ownerId, "host-1");
  assert.equal(ok.json.status, "BUSY");
  assert.equal(Number.isNaN(Date.parse(ok.json.receivedAt)), false);

  assertErrorEnvelope(
    await request(base, { method: "POST", path: "/internal/v1/runtime/heartbeat", headers: internalHeaders(), body: { ownerId: "host-1" } }),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(
    await request(base, {
      method: "POST",
      path: "/internal/v1/runtime/heartbeat",
      headers: internalHeaders(),
      body: { ownerId: "host-1", status: "SLEEPY", capabilities: {}, sessions: [] },
    }),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(
    await request(base, {
      method: "POST",
      path: "/internal/v1/runtime/heartbeat",
      headers: internalHeaders(),
      body: { ownerId: "host-1", status: "IDLE", capabilities: {}, sessions: [1] },
    }),
    "VALIDATION_ERROR",
    400,
  );
});

test("reconcile returns the authoritative run, lease and known sessions", async (t) => {
  const { base } = await claimedScenario(t);

  const res = await request(base, { path: "/internal/v1/runs/RUN-1/reconcile", headers: internalHeaders() });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.run.id, "RUN-1");
  assert.equal(res.json.run.status, "STARTING");
  assert.deepEqual(res.json.lease, {
    ownerId: "host-1",
    generation: 1,
    claimedUntil: res.json.lease.claimedUntil,
  });
  assert.ok(Array.isArray(res.json.sessions));

  assertErrorEnvelope(
    await request(base, { path: "/internal/v1/runs/RUN-NOPE/reconcile", headers: internalHeaders() }),
    "NOT_FOUND",
    404,
  );
});

test("unknown internal routes are 404 only after authentication", async (t) => {
  const { store } = createScenario();
  const { server, base } = await startServer({ store });
  t.after(() => server.close());

  const unauthenticated = await request(base, { path: "/internal/v1/nope" });
  assertErrorEnvelope(unauthenticated, "NOT_AUTHORIZED", 403);

  const authenticated = await request(base, { path: "/internal/v1/nope", headers: internalHeaders() });
  assertErrorEnvelope(authenticated, "NOT_FOUND", 404);
});

test("SSE receives business run.updated and run.log frames produced by the internal API", async (t) => {
  const scenario = createScenario();
  const { server, base } = await startServer({ store: scenario.store });
  t.after(() => server.close());

  // Internal token must not open the browser SSE stream.
  const wrongStream = await request(base, { path: "/api/v1/events/stream", headers: internalHeaders() });
  assertErrorEnvelope(wrongStream, "NOT_AUTHORIZED", 403);

  const claim = await request(base, {
    path: "/internal/v1/dispatch/claim?owner=host-1&leaseMs=5000",
    headers: internalHeaders(),
  });
  assert.equal(claim.status, 200, claim.text);

  const client = await openSse(base, { token: TEST_TOKEN });
  t.after(() => closeSse(client));
  await waitForFrame(client, (frame) => String(frame.comment ?? "").startsWith("connected"));

  const events = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers: internalHeaders(),
    body: {
      generation: 1,
      events: [
        { type: "session.started", sessionId: "S-1", at: AT },
        { type: "output", sessionId: "S-1", stream: "stdout", text: "live output", at: "2026-11-02T03:00:01.000Z" },
      ],
    },
  });
  assert.equal(events.status, 200, events.text);

  const updated = await waitForFrame(client, (frame) => frame.type === "run.updated");
  const updatedEvent = events.json.applied.find((event) => event.type === "run.updated");
  const logEvent = events.json.applied.find((event) => event.type === "run.log");
  assert.equal(updated.frame.seq, updatedEvent.seq);
  assert.equal(updated.frame.payload.runId, "RUN-1");
  assert.equal(updated.frame.payload.status, "RUNNING");

  const log = await waitForFrame(client, (frame) => frame.type === "run.log");
  assert.equal(log.frame.seq, logEvent.seq);
  assert.equal(log.frame.payload.text, "live output");
  assert.equal(client.frames.filter((frame) => frame.type === "run.updated").length, 1, "no duplicate run.updated frame");
  assert.equal(client.frames.some((frame) => JSON.stringify(frame).includes(TEST_INTERNAL_TOKEN)), false);
});

test("an empty events batch is a real generation fence (QA MINOR-1)", async (t) => {
  const { store, base } = await claimedScenario(t);
  const seqBefore = store.latestSeq();

  const ok = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers: internalHeaders(),
    body: { generation: 1, events: [] },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.applied, []);
  assert.equal(ok.json.skipped, 0);
  assert.equal(ok.json.run.id, "RUN-1");
  assert.equal(ok.json.run.status, "STARTING");
  assert.equal(store.latestSeq(), seqBefore, "pure fence writes nothing");

  const stale = await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers: internalHeaders(),
    body: { generation: 7, events: [] },
  });
  assertErrorEnvelope(stale, "STALE_GENERATION", 409);
  assert.deepEqual(stale.json.error.details, {
    runId: "RUN-1",
    generation: 7,
    currentGeneration: 1,
    reason: "generation-mismatch",
  });
  assert.equal(store.latestSeq(), seqBefore, "rejected pure fence writes nothing");
});

test("D3 crash window: sweep derives command DONE from a COMPLETED Run (MAJOR-2)", async (t) => {
  const { store, claim, base } = await claimedScenario(t);
  const headers = internalHeaders();

  // Host pushed the Run to COMPLETED but "crashes" before POSTing the result.
  await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers,
    body: { generation: 1, events: [{ type: "session.started", sessionId: "S-1", at: AT }] },
  });
  await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers,
    body: { generation: 1, events: [{ type: "session.ended", sessionId: "S-1", reason: "completed", exitCode: 0, at: "2026-11-02T03:01:00.000Z" }] },
  });
  assert.equal(store.getRun("RUN-1").status, "COMPLETED");
  assert.equal(store._getDispatchCommand(claim.command.id).status, "CLAIMED", "D3: command is stuck CLAIMED");

  // Unauthenticated sweep is rejected.
  assertErrorEnvelope(await request(base, { method: "POST", path: "/internal/v1/dispatch/sweep" }), "NOT_AUTHORIZED", 403);

  const sweep = await request(base, { method: "POST", path: "/internal/v1/dispatch/sweep", headers });
  assert.equal(sweep.status, 200, sweep.text);
  assert.deepEqual(Object.keys(sweep.json).sort(), ["closed", "count"]);
  assert.equal(sweep.json.count, 1);
  assert.deepEqual(sweep.json.closed, [{ commandId: claim.command.id, runId: "RUN-1", status: "DONE" }]);

  const command = store._getDispatchCommand(claim.command.id);
  assert.equal(command.status, "DONE");
  assert.deepEqual(command.result, { derivedFrom: "run-terminal", runStatus: "COMPLETED" });
  assert.equal(Number.isNaN(Date.parse(command.completedAt)), false);

  // Idempotent: a second sweep closes nothing.
  const second = await request(base, { method: "POST", path: "/internal/v1/dispatch/sweep", headers });
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, { closed: [], count: 0 });
});

test("sweep maps FAILED/INTERRUPTED/CANCELLED Runs to a FAILED command", async (t) => {
  for (const reason of ["failed", "interrupted", "cancelled"]) {
    const { store, claim, base } = await claimedScenario(t);
    const headers = internalHeaders();
    await request(base, {
      method: "POST",
      path: "/internal/v1/runs/RUN-1/events",
      headers,
      body: { generation: 1, events: [{ type: "session.started", sessionId: "S-1", at: AT }] },
    });
    await request(base, {
      method: "POST",
      path: "/internal/v1/runs/RUN-1/events",
      headers,
      body: { generation: 1, events: [{ type: "session.ended", sessionId: "S-1", reason, exitCode: 1, at: "2026-11-02T03:01:00.000Z" }] },
    });
    const sweep = await request(base, { method: "POST", path: "/internal/v1/dispatch/sweep", headers });
    assert.equal(sweep.status, 200, sweep.text);
    assert.deepEqual(sweep.json.closed, [{ commandId: claim.command.id, runId: "RUN-1", status: "FAILED" }]);
    assert.equal(store._getDispatchCommand(claim.command.id).status, "FAILED");
  }
});

test("a claim poll sweeps stuck commands before trying to claim", async (t) => {
  const scenario = createScenario();
  const { server, base } = await startServer({ store: scenario.store });
  t.after(() => server.close());
  const headers = internalHeaders();

  // Host claims the command, completes the Run, then never reports the result.
  const claimed = scenario.store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 5000 });
  await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers,
    body: { generation: 1, events: [{ type: "session.started", sessionId: "S-1", at: AT }] },
  });
  await request(base, {
    method: "POST",
    path: "/internal/v1/runs/RUN-1/events",
    headers,
    body: { generation: 1, events: [{ type: "session.ended", sessionId: "S-1", reason: "completed", exitCode: 0, at: "2026-11-02T03:01:00.000Z" }] },
  });
  assert.equal(scenario.store._getDispatchCommand(claimed.command.id).status, "CLAIMED");

  const poll = await request(base, { path: "/internal/v1/dispatch/claim?owner=host-2&leaseMs=5000", headers });
  assert.equal(poll.status, 204, poll.text);
  assert.equal(scenario.store._getDispatchCommand(claimed.command.id).status, "DONE", "claim-start sweep closed it");
});

test("sweep degrades to a logged no-op when the store has no sweepDispatchCommands", async (t) => {
  const scenario = createScenario();
  delete scenario.store.sweepDispatchCommands;
  const logger = recordingLogger();
  const { server, base } = await startServer({ store: scenario.store, logger });
  t.after(() => server.close());

  const sweep = await request(base, { method: "POST", path: "/internal/v1/dispatch/sweep", headers: internalHeaders() });
  assert.equal(sweep.status, 200, sweep.text);
  assert.deepEqual(sweep.json, { closed: [], count: 0 });
  assert.ok(logger.lines.warn.some((line) => line.includes("sweepDispatchCommands is unavailable")));

  // Claim polling still works and does not 500.
  const poll = await request(base, { path: "/internal/v1/dispatch/claim?owner=host-2&leaseMs=5000", headers: internalHeaders() });
  assert.equal(poll.status, 200, poll.text);
  assert.equal(poll.json.command.status, "CLAIMED");
});

function heartbeatBody() {
  return {
    ownerId: "host-1",
    status: "BUSY",
    capabilities: { canStart: true, canSend: true },
    sessions: ["S-1"],
  };
}

// ---------------------------------------------------------------------------
// M6.1 phase A: failure reproducers.
//
// These assert the behaviour the reliability fixes promise; they are expected
// to fail on the frozen implementation and turn green with the fix. Fault
// injection wraps store methods, so no production code is stubbed.
// ---------------------------------------------------------------------------

const EVENTS_PATH = "/internal/v1/runs/RUN-1/events";

function postEvents(base, generation, events) {
  return request(base, {
    method: "POST",
    path: EVENTS_PATH,
    headers: internalHeaders(),
    body: { generation, events },
  });
}

test("F03: runtime events are committed by one atomic store batch (no multi-write flow)", async (t) => {
  const { store, base } = await claimedScenario(t);
  const calls = { batch: 0, updateStatus: 0, append: 0 };
  const originalBatch = store.applyRuntimeEventBatch;
  const originalUpdate = store.updateRunStatus;
  const originalAppend = store.appendRunEvent;
  store.applyRuntimeEventBatch = (args) => {
    calls.batch += 1;
    return originalBatch(args);
  };
  store.updateRunStatus = (...args) => {
    calls.updateStatus += 1;
    return originalUpdate(...args);
  };
  store.appendRunEvent = (...args) => {
    calls.append += 1;
    return originalAppend(...args);
  };
  t.after(() => {
    store.applyRuntimeEventBatch = originalBatch;
    store.updateRunStatus = originalUpdate;
    store.appendRunEvent = originalAppend;
  });

  const res = await postEvents(base, 1, [
    { type: "session.started", sessionId: "S-1", at: AT },
    { type: "output", sessionId: "S-1", at: AT, stream: "stdout", text: "hello" },
  ]);
  assert.equal(res.status, 200, res.text);
  assert.equal(calls.batch, 1, "the whole batch is one store call");
  assert.equal(calls.updateStatus, 0, "no separate status transaction");
  assert.equal(calls.append, 0, "no separate log transaction");
  assert.equal(res.json.run.status, "RUNNING");
  assert.deepEqual(res.json.applied.map((event) => event.type), ["run.updated", "run.log"]);
});

test("F03: a failure inside the batch rolls back the status and every event", async (t) => {
  const { store, base } = await claimedScenario(t);
  const before = {
    status: store.getRun("RUN-1").status,
    events: store.listEvents({ aggregateId: "RUN-1" }).length,
    seq: store.latestSeq(),
  };
  store._setBatchFaultAfter(1);
  t.after(() => store._setBatchFaultAfter(null));

  const failed = await postEvents(base, 1, [
    { type: "session.started", sessionId: "S-1", at: AT },
    { type: "output", sessionId: "S-1", at: AT, stream: "stdout", text: "hello" },
  ]);
  assert.ok(failed.status >= 500, `a mid-batch store failure must be 5xx, got ${failed.status}: ${failed.text}`);
  assert.equal(store.getRun("RUN-1").status, before.status, "the status transition must be rolled back");
  assert.equal(store.listEvents({ aggregateId: "RUN-1" }).length, before.events, "no event may survive the failed batch");
  assert.equal(store.latestSeq(), before.seq, "the sequence must not advance");

  store._setBatchFaultAfter(null);
  const retried = await postEvents(base, 1, [
    { type: "session.started", sessionId: "S-1", at: AT },
    { type: "output", sessionId: "S-1", at: AT, stream: "stdout", text: "hello" },
  ]);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(store.getRun("RUN-1").status, "RUNNING");
  assert.equal(retried.json.applied.length, 2);
});

test("F03: one batch may carry several run.updated transitions, applied in order", async (t) => {
  const { store, base } = await claimedScenario(t);

  // The real Host flushes session.started + session.ended in one batch; the
  // route maps both transitions and the store applies them sequentially.
  const res = await postEvents(base, 1, [
    { type: "session.started", sessionId: "S-1", at: AT },
    { type: "session.ended", sessionId: "S-1", at: "2026-11-02T03:01:00.000Z", reason: "completed", exitCode: 0 },
  ]);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.run.status, "COMPLETED");
  assert.deepEqual(res.json.applied.map((event) => event.type), ["run.updated", "run.updated"]);
  const updates = store.listEvents({ aggregateId: "RUN-1", type: "run.updated" });
  assert.deepEqual(updates.map((event) => event.payload.status), ["RUNNING", "COMPLETED"]);
});

test("F03: a skipped transition is a 400 with zero writes (the store names the index)", async (t) => {
  const { store, base } = await claimedScenario(t);
  const before = {
    status: store.getRun("RUN-1").status,
    events: store.listEvents({ aggregateId: "RUN-1" }).length,
  };

  // Route-level state machine: STARTING -> COMPLETED without RUNNING is illegal.
  const res = await postEvents(base, 1, [
    { type: "session.ended", sessionId: "S-1", at: "2026-11-02T03:01:00.000Z", reason: "completed", exitCode: 0 },
  ]);
  assertErrorEnvelope(res, "VALIDATION_ERROR", 400);
  assert.equal(store.getRun("RUN-1").status, before.status, "a rejected batch writes nothing");
  assert.equal(store.listEvents({ aggregateId: "RUN-1" }).length, before.events);

  // Store contract: inside a multi-update batch the illegal step is reported by
  // its index and the whole transaction rolls back.
  assert.throws(
    () =>
      store.applyRuntimeEventBatch({
        runId: "RUN-1",
        generation: 1,
        events: [
          { type: "run.updated", at: "2026-11-02T03:00:00.000Z", payload: { status: "RUNNING" } },
          { type: "run.updated", at: "2026-11-02T03:00:01.000Z", payload: { status: "COMPLETED" } },
          { type: "run.updated", at: "2026-11-02T03:00:02.000Z", payload: { status: "RUNNING" } },
        ],
      }),
    (error) => error.code === "VALIDATION_ERROR" && error.details?.index === 2,
  );
  assert.equal(store.getRun("RUN-1").status, before.status, "the illegal step rolls back the legal ones");
  assert.equal(store.listEvents({ aggregateId: "RUN-1" }).length, before.events);
});

// Real-store (SQLite) coverage for F03: the fake store must not be the only
// place the atomic batch contract is exercised. `@atk/database` is an optional
// dependency of this suite (same pattern as backup.test.mjs).
let realDatabase = null;
try {
  realDatabase = await import("@atk/database");
} catch {
  realDatabase = null;
}
const REAL_DB_SKIP =
  realDatabase === null || typeof realDatabase.openStore !== "function"
    ? "@atk/database is not available in this checkout"
    : false;

test("F03 real store: sequential transitions, rollback and retry dedupe over HTTP", { skip: REAL_DB_SKIP }, async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "atk-internal-real-"));
  const store = realDatabase.openStore({ file: path.join(dir, "wp6.db"), migrate: true });

  store.createProject({ id: "P-1", name: "WP6 real store", repoPath: "C:\\repo", defaultBranch: "main" });
  store.createTask({
    id: "TASK-1",
    projectId: "P-1",
    title: "Do work",
    description: "d",
    functionRequired: "WORKER",
    roleRequired: "BE",
    priority: 2,
    deps: [],
  });
  const seedRun = (runId, idempotencyKey) => {
    store.createRun({ id: runId, taskId: "TASK-1", agentId: "agent-1", function: "WORKER", role: "BE", attempt: 1 });
    store.enqueueDispatchCommand({ runId, commandType: "RUN_TASK", payload: {}, idempotencyKey });
  };
  const claimNext = () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const claimed = store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 60_000 });
      if (claimed?.command) return claimed;
    }
    if (typeof store.sweepDispatchCommands === "function") {
      store.sweepDispatchCommands({ now: new Date().toISOString() });
      const claimed = store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 60_000 });
      if (claimed?.command) return claimed;
    }
    throw new Error("could not claim a dispatch command from the real store");
  };

  seedRun("RUN-1", "wp6-idem-1");
  seedRun("RUN-2", "wp6-idem-2");
  seedRun("RUN-3", "wp6-idem-3");
  const lease1 = claimNext().lease;
  const lease2 = claimNext().lease;
  const lease3 = claimNext().lease;

  const { server, base } = await startServer({ store });
  t.after(async () => {
    await server.close();
    store.close();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  const headers = internalHeaders(TEST_INTERNAL_TOKEN, "runtime-host");
  const postEvents = (runId, generation, events) =>
    request(base, { method: "POST", path: `/internal/v1/runs/${runId}/events`, headers, body: { generation, events } });

  // 1) session.started + session.ended in ONE batch: two sequential transitions.
  const at = new Date().toISOString();
  const sameBatch = await postEvents("RUN-1", lease1.generation, [
    { type: "session.started", sessionId: "S-1", at },
    { type: "session.ended", sessionId: "S-1", reason: "completed", exitCode: 0, at },
  ]);
  assert.equal(sameBatch.status, 200, sameBatch.text);
  assert.equal(sameBatch.json.run.status, "COMPLETED");
  assert.deepEqual(sameBatch.json.applied.map((event) => event.type), ["run.updated", "run.updated"]);
  assert.deepEqual(
    store.listEvents({ aggregateId: "RUN-1", type: "run.updated" }).map((event) => event.payload.status),
    ["RUNNING", "COMPLETED"],
  );

  // 2) A skipped transition is a 400 and writes nothing.
  const skip = await postEvents("RUN-2", lease2.generation, [
    { type: "session.ended", sessionId: "S-2", reason: "completed", exitCode: 0, at },
  ]);
  assertErrorEnvelope(skip, "VALIDATION_ERROR", 400);
  assert.equal(store.getRun("RUN-2").status, "STARTING");
  assert.equal(store.listEvents({ aggregateId: "RUN-2", type: "run.updated" }).length, 0);

  // 3) The same batch sent three times persists exactly one copy.
  const batch = Array.from({ length: 5 }, (_, index) => ({
    type: "log",
    sessionId: "S-3",
    at,
    level: "info",
    message: `line-${index}`,
    eventId: `wp6-evt-${index}`,
    sessionSeq: index + 1,
  }));
  const first = await postEvents("RUN-3", lease3.generation, batch);
  const replay = await postEvents("RUN-3", lease3.generation, batch);
  const third = await postEvents("RUN-3", lease3.generation, batch);
  assert.deepEqual(
    [first.json.applied.length, replay.json.applied.length, third.json.applied.length],
    [5, 0, 0],
  );
  assert.deepEqual([replay.json.skipped, third.json.skipped], [5, 5]);
  assert.equal(store.listEvents({ aggregateId: "RUN-3", type: "run.log" }).length, 5);
});

test("F08: same-millisecond distinct events must be deduped by eventId, not by (runId,sessionId,at,type)", async (t) => {
  const { store, base } = await claimedScenario(t);
  const batch = (prefix) =>
    Array.from({ length: 100 }, (_, index) => ({
      type: "log",
      sessionId: "S-1",
      at: AT, // all 100 events share one millisecond
      level: "info",
      message: `${prefix}-${index}`,
      eventId: `${prefix}-evt-${index}`,
      sessionSeq: index + 1,
    }));

  const first = await postEvents(base, 1, batch("a"));
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.applied.length, 100, "the first 100 same-ms events must all persist");

  const replay = await postEvents(base, 1, batch("a"));
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.applied.length, 0, "a byte-identical retry is deduped");
  assert.equal(replay.json.skipped, 100);

  const distinct = await postEvents(base, 1, batch("b"));
  assert.equal(distinct.status, 200, distinct.text);
  assert.equal(distinct.json.applied.length, 100, "different eventIds are different events even in the same millisecond");
  assert.equal(distinct.json.skipped, 0);

  const logs = store.listEvents({ aggregateId: "RUN-1", type: "run.log" });
  assert.equal(logs.filter((event) => event.payload.message.startsWith("a-")).length, 100);
  assert.equal(logs.filter((event) => event.payload.message.startsWith("b-")).length, 100);
});

test("F02: dispatch result confirms persistence, replays idempotently and keeps the Outbox on store failure", async (t) => {
  const success = await claimedScenario(t);
  const commandId = success.claim.command.id;
  const body = { ownerId: "host-1", generation: 1, status: "DONE", exitCode: 0, summary: "finished", eventId: "evt-result-1" };
  const post = (target, payload) =>
    request(target.base, {
      method: "POST",
      path: `/internal/v1/dispatch/${target.claim.command.id}/result`,
      headers: internalHeaders(),
      body: payload,
    });

  const first = await post(success, body);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.persisted, true, "a 2xx result must confirm durable persistence for the Outbox");
  const resultPayload = first.json.result ?? first.json.command?.result ?? {};
  assert.equal(resultPayload.eventId, "evt-result-1", "the result payload carries the eventId for reconciliation");

  const replay = await post(success, body);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.persisted, true, "an idempotent replay still confirms the persisted result");
  assert.equal(replay.json.command.id, commandId);
  assert.equal(replay.json.command.status, "DONE");
  assert.deepEqual(replay.json.command.result, first.json.command.result);
  assert.equal(
    success.store.listEvents({ aggregateId: "RUN-1", type: "run.updated" }).length,
    0,
    "an idempotent replay must not write a second run.updated",
  );

  // Store 5xx: the Host must keep its Outbox entry, so the response must stay
  // 5xx and the command must not be finalized. Only STALE_GENERATION is a 409.
  const failure = await claimedScenario(t);
  const originalComplete = failure.store.completeDispatchCommand;
  failure.store.completeDispatchCommand = () => {
    const error = new Error("simulated database write failure");
    error.code = "DATABASE_ERROR";
    throw error;
  };
  t.after(() => {
    failure.store.completeDispatchCommand = originalComplete;
  });
  const failedBody = { ownerId: "host-1", generation: 1, status: "DONE", exitCode: 0, eventId: "evt-result-2" };
  const failed = await post(failure, failedBody);
  assert.ok(failed.status >= 500, `a store 5xx must stay 5xx, got ${failed.status}: ${failed.text}`);
  assert.equal(
    failure.store._getDispatchCommand(failure.claim.command.id).status,
    "CLAIMED",
    "a failed result must not finalize the command",
  );

  failure.store.completeDispatchCommand = originalComplete;
  const retried = await post(failure, failedBody);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.persisted, true);
});

test("F02: reconcile passes a pendingResult through when the store exposes one", async (t) => {
  const { store, base } = await claimedScenario(t);
  const original = store.reconcileRun;
  store.reconcileRun = ({ runId }) => ({
    ...original({ runId }),
    pendingResult: { commandId: "CMD-1", eventId: "evt-9", status: "DONE" },
  });
  t.after(() => {
    store.reconcileRun = original;
  });

  const res = await request(base, { path: "/internal/v1/runs/RUN-1/reconcile", headers: internalHeaders() });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.pendingResult, { commandId: "CMD-1", eventId: "evt-9", status: "DONE" });
  assert.equal(res.json.run.id, "RUN-1");
});

test("F08: invalid eventId/sessionSeq get a field-naming 400; legacy events are marked, not dropped", async (t) => {
  const { store, base } = await claimedScenario(t);

  const invalidId = await postEvents(base, 1, [
    { type: "log", sessionId: "S-1", at: AT, level: "info", message: "ok" },
    { type: "log", sessionId: "S-1", at: AT, level: "info", message: "bad", eventId: "" },
  ]);
  assertErrorEnvelope(invalidId, "VALIDATION_ERROR", 400);
  assert.match(JSON.stringify(invalidId.json.error.details), /events\[1\]\.eventId/);

  const invalidSeq = await postEvents(base, 1, [
    { type: "log", sessionId: "S-1", at: AT, level: "info", message: "bad", sessionSeq: -1 },
  ]);
  assertErrorEnvelope(invalidSeq, "VALIDATION_ERROR", 400);
  assert.match(JSON.stringify(invalidSeq.json.error.details), /events\[0\]\.sessionSeq/);

  // A host that does not send an eventId still gets the legacy compatibility
  // path: the event is written and marked, never silently discarded.
  const legacy = await postEvents(base, 1, [
    { type: "log", sessionId: "S-1", at: AT, level: "info", message: "legacy line" },
  ]);
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(legacy.json.applied.length, 1);
  const [stored] = store.listEvents({ aggregateId: "RUN-1", type: "run.log" });
  assert.equal(stored.payload.message, "legacy line");
  assert.equal(stored.eventId, undefined);
  assert.equal(stored.legacy, true, "a legacy event is marked, not silently dropped");
});

test("F08: a duplicate eventId inside one batch is skipped instead of written twice", async (t) => {
  const { store, base } = await claimedScenario(t);
  const event = { type: "log", sessionId: "S-1", at: AT, level: "info", message: "once", eventId: "dup-1", sessionSeq: 1 };
  const res = await postEvents(base, 1, [event, { ...event }]);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.applied.length, 1);
  assert.equal(res.json.skipped, 1);
  assert.equal(store.listEvents({ aggregateId: "RUN-1", type: "run.log" }).length, 1);
});

test("F08: submitting the same 100-event batch three times stores exactly one copy", async (t) => {
  const { store, base } = await claimedScenario(t);
  const events = Array.from({ length: 100 }, (_, index) => ({
    type: "log",
    sessionId: "S-1",
    at: AT,
    level: "info",
    message: `line-${index}`,
    eventId: `triple-${index}`,
    sessionSeq: index + 1,
  }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await postEvents(base, 1, events);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.applied.length, attempt === 0 ? 100 : 0, `attempt ${attempt + 1}`);
    assert.equal(res.json.skipped, attempt === 0 ? 0 : 100, `attempt ${attempt + 1}`);
  }
  assert.equal(store.listEvents({ aggregateId: "RUN-1", type: "run.log" }).length, 100);
});

test("internal endpoints enforce the frozen role matrix (missing / forbidden / accepted)", async (t) => {
  const { base } = await claimedScenario(t);

  // An empty explicit role stays empty (helpers.request only defaults when the
  // header is absent), so this exercises the real "role missing" path.
  const missing = await request(base, {
    path: "/internal/v1/runs/RUN-1/reconcile",
    headers: internalHeaders(TEST_INTERNAL_TOKEN, ""),
  });
  assertErrorEnvelope(missing, "NOT_AUTHORIZED", 403);
  assert.equal(missing.json.error.details.reason, "internal-role-required");
  assert.deepEqual(missing.json.error.details.allowed, ["runtime-host"]);

  const wrong = await request(base, {
    path: "/internal/v1/runs/RUN-1/reconcile",
    headers: internalHeaders(TEST_INTERNAL_TOKEN, "scheduler"),
  });
  assertErrorEnvelope(wrong, "NOT_AUTHORIZED", 403);
  assert.equal(wrong.json.error.details.reason, "internal-role-forbidden");
  assert.equal(wrong.json.error.details.role, "scheduler");

  const unknown = await request(base, {
    path: "/internal/v1/runs/RUN-1/reconcile",
    headers: internalHeaders(TEST_INTERNAL_TOKEN, "admin"),
  });
  assertErrorEnvelope(unknown, "NOT_AUTHORIZED", 403);
  assert.equal(unknown.json.error.details.reason, "internal-role-forbidden");

  const accepted = await request(base, {
    path: "/internal/v1/runs/RUN-1/reconcile",
    headers: internalHeaders(TEST_INTERNAL_TOKEN, "runtime-host"),
  });
  assert.equal(accepted.status, 200, accepted.text);

  const schedulerOnly = await request(base, {
    path: "/internal/v1/dispatch/claim?owner=host-2&leaseMs=5000",
    headers: internalHeaders(TEST_INTERNAL_TOKEN, "scheduler"),
  });
  assertErrorEnvelope(schedulerOnly, "NOT_AUTHORIZED", 403);
  assert.equal(schedulerOnly.json.error.details.reason, "internal-role-forbidden");
  assert.deepEqual(schedulerOnly.json.error.details.allowed, ["runtime-host"]);
});

function integrationScenario() {
  const store = createFakeStore({
    projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks: [
      {
        id: "TASK-1",
        projectId: "P-1",
        title: "Do work",
        description: "d",
        functionRequired: "WORKER",
        roleRequired: "BE",
        priority: 2,
        deps: [],
        status: "INTEGRATING",
        version: 3,
        targetHash: "B".repeat(64),
      },
    ],
    agents: [{ id: "agent-1", role: "BE", capabilities: ["WORKER"], status: "IDLE" }],
  });
  store.createRun({ id: "RUN-1", taskId: "TASK-1", agentId: "agent-1", function: "WORKER", attempt: 1 });
  store.updateRunStatus("RUN-1", { status: "RUNNING" });
  store.updateRunStatus("RUN-1", { status: "COMPLETED", exitCode: 0, endedAt: "2026-11-02T03:01:00.000Z" });
  return { store };
}

test("integration endpoint records INTEGRATING -> AWAITING_ACCEPTANCE with role and hash binding", async (t) => {
  const scenario = integrationScenario();
  const { server, base } = await startServer({ store: scenario.store });
  t.after(() => server.close());

  const body = { taskId: "TASK-1", runId: "RUN-1", commitSha: "c".repeat(40), manifestHash: "B".repeat(64) };
  const integrationPath = "/internal/v1/tasks/TASK-1/integration";
  const integrationRequest = (role, payload = body) =>
    request(base, {
      method: "POST",
      path: integrationPath,
      headers: internalHeaders(TEST_INTERNAL_TOKEN, role),
      body: payload,
    });

  const missing = await request(base, {
    method: "POST",
    path: integrationPath,
    headers: internalHeaders(TEST_INTERNAL_TOKEN, ""),
    body,
  });
  assertErrorEnvelope(missing, "NOT_AUTHORIZED", 403);
  assert.equal(missing.json.error.details.reason, "internal-role-required");

  const forbidden = await integrationRequest("runtime-host");
  assertErrorEnvelope(forbidden, "NOT_AUTHORIZED", 403);
  assert.equal(forbidden.json.error.details.reason, "internal-role-forbidden");

  const stale = await integrationRequest("user-action", { ...body, manifestHash: "C".repeat(64) });
  assertErrorEnvelope(stale, "APPROVAL_STALE", 409);
  assert.equal(scenario.store.getTask("TASK-1").status, "INTEGRATING", "a stale hash must not move the task");
  assert.deepEqual(scenario.store._listIntegrations(), []);

  const ok = await integrationRequest("scheduler");
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.task.status, "AWAITING_ACCEPTANCE");
  assert.equal(ok.json.integration.taskId, "TASK-1");
  assert.equal(ok.json.integration.runId, "RUN-1");
  assert.equal(ok.json.integration.manifestHash, body.manifestHash);
  assert.equal(scenario.store._listIntegrations().length, 1);

  const taskEvents = scenario.store.listEvents({ aggregateId: "TASK-1", type: "task.updated" });
  assert.equal(taskEvents.at(-1).payload.reason, "integration");
  assert.equal(scenario.store.listEvents({ type: "integration.updated" }).length, 1);
});

test("F12: /events pagination rejects malformed afterSeq/limit by field; internal reconcile is not paginated", async (t) => {
  const { base } = await claimedScenario(t);
  await postEvents(base, 1, [{ type: "session.started", sessionId: "S-1", at: AT }]);

  const page = await request(base, { path: "/api/v1/events?aggregateId=RUN-1&afterSeq=0&limit=1", headers: readHeaders() });
  assert.equal(page.status, 200, page.text);
  assert.ok(Array.isArray(page.json.items));
  assert.equal(typeof page.json.hasMore, "boolean");
  if (page.json.hasMore) assert.equal(page.json.nextAfterSeq, page.json.items.at(-1).seq);

  for (const [pathname, field] of [
    ["/api/v1/events?afterSeq=abc", "afterSeq"],
    ["/api/v1/events?afterSeq=-1", "afterSeq"],
    ["/api/v1/events?afterSeq=1.5", "afterSeq"],
    ["/api/v1/events?limit=0", "limit"],
    ["/api/v1/events?limit=1001", "limit"],
    ["/api/v1/events?aggregateId=bad!id", "aggregateId"],
  ]) {
    const res = await request(base, { path: pathname, headers: readHeaders() });
    assertErrorEnvelope(res, "VALIDATION_ERROR", 400);
    assert.equal(res.json.error.details.field, field, `${pathname} must name ${field} in details.field`);
  }

  // m2-contracts 搂2: reconcile returns `{ run, lease, sessions }` and has no
  // pagination parameter. Passing afterSeq/limit must not turn it into one.
  const reconciled = await request(base, {
    path: "/internal/v1/runs/RUN-1/reconcile?afterSeq=0&limit=1",
    headers: internalHeaders(),
  });
  assert.equal(reconciled.status, 200, reconciled.text);
  assert.deepEqual(Object.keys(reconciled.json).sort(), ["lease", "run", "sessions"]);
});

