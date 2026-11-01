// M2 internal API tests (m2-contracts §2): separate internal credential,
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

  // ADR-008 §5: the browser session token must never unlock the internal plane.
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
  // Pure status batches have no run.log events: the single run.updated is owned
  // by the store's updateRunStatus transaction (M2 responsibility split).
  assert.deepEqual(res.json.appended, []);

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
    assert.deepEqual(ended.json.appended, [], "status-only batch has no run.log batch");
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
  assert.equal(res.json.appended.length, 3, "state events do not append business events");
  const [stdout, log, truncated] = res.json.appended;
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
  // appended only counts the run.log batch; run.updated comes from the store.
  assert.equal(first.json.appended.length, 1);
  assert.equal(first.json.appended[0].type, "run.log");
  assert.equal(first.json.skipped, 0);
  const seqAfterFirst = store.latestSeq();

  const replay = await request(base, { method: "POST", path: "/internal/v1/runs/RUN-1/events", headers, body: batch });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.appended.length, 0);
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
  // The status update writes run.updated immediately before the fenced log batch.
  assert.equal(updated.frame.seq, events.json.appended[0].seq - 1);
  assert.equal(updated.frame.payload.runId, "RUN-1");
  assert.equal(updated.frame.payload.status, "RUNNING");

  const log = await waitForFrame(client, (frame) => frame.type === "run.log");
  assert.equal(log.frame.seq, events.json.appended[0].seq);
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
  assert.deepEqual(ok.json.appended, []);
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

