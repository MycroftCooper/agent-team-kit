// M6.1 reliability tests (phase A: written against the FIXED behaviour; run these
// against the old host first to see them fail).
//
//   F02 - a terminal result is a durable fact: persist an Outbox entry before the
//         upload, retry transient failures with the same idempotency key, and
//         reconcile "request was sent but the response was lost".
//   F07 - STALE_GENERATION must stop the runtime session and confirm the stop;
//         an unconfirmed stop means FENCING_REQUIRED and no more claims.
//   F09 - a corrupt recovery file is not "no in-flight runs"; writes are atomic
//         with a .bak, and corruption means RECOVERY_REQUIRED before any claim.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockRuntime } from "@atk/runtime-sdk/mock";
import { createTaskExecutionSpec } from "../../../packages/contracts/src/execution-spec.mjs";
import { createInternalClient, InternalApiError } from "../src/client.mjs";
import { createHost } from "../src/host.mjs";

function quietLogger() {
  const lines = [];
  return { lines, info: () => {}, warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

function claimOf({ runId = "run-1", commandId = "CMD-1", attempts = 1 } = {}) {
  const spec = createTaskExecutionSpec({
    task: {
      id: `TASK-${runId}`,
      version: 1,
      title: "Reliability task",
      description: "A frozen task for the reliability tests.",
      acceptance: "green",
      files: [],
      deps: [],
      functionRequired: "DEV",
      roleRequired: "DEVELOPER",
    },
    project: { id: "proj-1", name: "Demo", repoPath: "C:/repo", defaultBranch: "main" },
    workspace: { kind: "none", path: null, baseCommit: null, targetBranch: null },
    frozenAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    command: { id: commandId, runId, commandType: "START_RUN", attempts, payload: { prompt: "do it", spec } },
    run: { id: runId, taskId: `TASK-${runId}`, status: "STARTING", workspace: { kind: "none", path: null, baseCommit: null, targetBranch: null } },
    lease: { ownerId: "host-a", generation: 7, claimedUntil: new Date(Date.now() + 30000).toISOString() },
  };
}

function makeDirs() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-host-rel-"));
  return { dir, stateFile: path.join(dir, "host.json"), outboxFile: path.join(dir, "host.outbox.json") };
}

/** A tiny fake backend with per-test behaviours for result/events/renew/reconcile. */
function fakeClient({ claims = [], onEvents, onResult, onRenew, onReconcile } = {}) {
  const calls = { claim: 0, events: [], result: [], renew: [], heartbeat: [], reconcile: [] };
  const queue = [...claims];
  return {
    calls,
    claim() {
      calls.claim += 1;
      return Promise.resolve(queue.length ? queue.shift() : null);
    },
    events(runId, body) {
      calls.events.push({ runId, ...body });
      return onEvents ? onEvents(runId, body, calls) : Promise.resolve({ appended: body.events, skipped: 0 });
    },
    renew(runId, body) {
      calls.renew.push({ runId, ...body });
      return onRenew ? onRenew(runId, body, calls) : Promise.resolve({ lease: { ...body, generation: body.generation + 1 } });
    },
    result(commandId, body) {
      calls.result.push({ commandId, ...body });
      return onResult ? onResult(commandId, body, calls) : Promise.resolve({ persisted: true });
    },
    heartbeat(body) {
      calls.heartbeat.push(body);
      return Promise.resolve({ ok: true });
    },
    reconcile(runId) {
      calls.reconcile.push(runId);
      return onReconcile ? onReconcile(runId, calls) : Promise.resolve({ run: { id: runId, status: "RUNNING" }, command: { status: "CLAIMED" } });
    },
  };
}

function waitFor(predicate, timeoutMs = 3000, label = "condition") {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        return reject(error);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("F02: a transient result failure persists a FINISHING outbox entry and retries with one idempotency key", async () => {
  const { stateFile, outboxFile } = makeDirs();
  let failures = 2;
  const client = fakeClient({
    claims: [claimOf()],
    onResult: () => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("ECONNRESET"));
      }
      return Promise.resolve({ persisted: true });
    },
  });
  const runtime = createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-1" });
  const host = createHost({
    client,
    runtime,
    ownerId: "host-a",
    pollMs: 1000,
    flushMs: 5,
    heartbeatMs: 1000,
    stateFile,
    outboxFile,
    outboxRetryBaseMs: 5,
    outboxRetryMaxMs: 20,
    logger: quietLogger(),
  });
  await host.tick();
  await waitFor(() => host.mode() === "FINISHING", 3000, "FINISHING");
  assert.equal(host.stats.completed, 0, "an unacknowledged terminal fact must not count as a completed Run");
  const persistedOutbox = JSON.parse(readFileSync(outboxFile, "utf8"));
  assert.equal(persistedOutbox.entries.length, 1, "the terminal fact must be on disk before the upload");
  assert.ok(persistedOutbox.entries[0].idempotencyKey, "outbox entries need a stable idempotency key");
  assert.ok(JSON.parse(readFileSync(stateFile, "utf8")).some((record) => record.runId === "run-1"), "the in-flight record must survive a failed result");

  await waitFor(() => host.outbox().length === 0, 4000, "outbox drained");
  assert.ok(client.calls.result.length >= 3, `expected retries, got ${client.calls.result.length}`);
  assert.equal(new Set(client.calls.result.map((call) => call.idempotencyKey)).size, 1, "every retry must reuse the same idempotency key");
  assert.equal(host.mode(), "RUNNING");
  assert.equal(host.activeSessions().length, 0);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), []);
  await host.stop();
});

test("F02: a lost response is reconciled, not blindly retried as a new completion", async () => {
  const { stateFile, outboxFile } = makeDirs();
  let resultCalls = 0;
  const client = fakeClient({
    claims: [claimOf()],
    onResult: () => {
      resultCalls += 1;
      // The backend committed the result, but the response never reached us.
      return Promise.reject(new Error("socket hang up"));
    },
    onReconcile: () => Promise.resolve({ run: { id: "run-1", status: "COMPLETED" }, command: { id: "CMD-1", status: "DONE" }, persisted: true }),
  });
  const host = createHost({
    client,
    runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-2" }),
    ownerId: "host-a",
    pollMs: 1000,
    flushMs: 5,
    heartbeatMs: 1000,
    stateFile,
    outboxFile,
    outboxRetryBaseMs: 5,
    outboxRetryMaxMs: 20,
    logger: quietLogger(),
  });
  await host.tick();
  await waitFor(() => client.calls.reconcile.length >= 1, 3000, "reconcile");
  await waitFor(() => host.outbox().length === 0, 3000, "reconciled outbox");
  assert.equal(resultCalls, 1, "a reconcilable lost response must not be re-posted blindly");
  assert.equal(host.stats.completed, 1);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), []);
  await host.stop();
});

test("F02: a permanent 4xx result failure keeps the fact and stops retrying (manual required)", async () => {
  const { stateFile, outboxFile } = makeDirs();
  const client = fakeClient({
    claims: [claimOf()],
    onResult: () => Promise.reject(new InternalApiError(400, "VALIDATION_ERROR", { field: "exitCode" }, "bad result")),
  });
  const host = createHost({
    client,
    runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-3" }),
    ownerId: "host-a",
    pollMs: 1000,
    flushMs: 5,
    heartbeatMs: 1000,
    stateFile,
    outboxFile,
    outboxRetryBaseMs: 5,
    outboxRetryMaxMs: 20,
    logger: quietLogger(),
  });
  await host.tick();
  await waitFor(() => host.mode() === "MANUAL_REQUIRED", 3000, "MANUAL_REQUIRED");
  assert.equal(client.calls.result.length, 1, "a non-idempotent 4xx must not be retried in a loop");
  assert.equal(host.outbox().length, 1, "the unacknowledged fact must stay in the outbox");
  const claimsBefore = client.calls.claim;
  await host.tick();
  assert.equal(client.calls.claim, claimsBefore, "no new claims while a terminal fact is unacknowledged");
  await host.stop();
});

test("F02: a non-stale 409 is a permanent error (MANUAL_REQUIRED, outbox kept, no retry loop)", async () => {
  const { stateFile, outboxFile } = makeDirs();
  const client = fakeClient({
    claims: [claimOf()],
    onResult: () => Promise.reject(new InternalApiError(409, "VERSION_CONFLICT", { reason: "command-already-closed" }, "conflict")),
  });
  const host = createHost({
    client,
    runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-conflict" }),
    ownerId: "host-a",
    pollMs: 1000,
    flushMs: 5,
    heartbeatMs: 1000,
    stateFile,
    outboxFile,
    outboxRetryBaseMs: 5,
    outboxRetryMaxMs: 20,
    logger: quietLogger(),
  });
  await host.tick();
  await waitFor(() => client.calls.result.length >= 1 && host.mode() === "MANUAL_REQUIRED", 3000, "non-stale 409");
  assert.equal(client.calls.result.length, 1, "a non-stale 409 must not be retried in a loop");
  assert.equal(host.outbox().length, 1, "the unacknowledged fact must stay in the outbox");
  await host.stop();
});

test("F02: a 2xx without body.persisted:true is not an acknowledgement", async () => {
  const { stateFile, outboxFile } = makeDirs();
  const client = fakeClient({
    claims: [claimOf()],
    onResult: () => Promise.resolve({ command: { id: "CMD-1", status: "DONE" }, run: { id: "run-1", status: "COMPLETED" } }),
  });
  const host = createHost({
    client,
    runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-noack" }),
    ownerId: "host-a",
    pollMs: 1000,
    flushMs: 5,
    heartbeatMs: 1000,
    stateFile,
    outboxFile,
    logger: quietLogger(),
  });
  await host.tick();
  await waitFor(() => client.calls.result.length >= 1 && host.mode() === "MANUAL_REQUIRED", 3000, "unconfirmed 2xx");
  assert.equal(host.outbox().length, 1, "a 2xx that did not confirm persistence must keep the outbox entry");
  assert.equal(host.stats.completed, 0, "an unconfirmed response must not count as completed");
  await host.stop();
});

test("F02: retries are capped; the outbox keeps the fact and records nextAttemptAt", async () => {
  const { stateFile, outboxFile } = makeDirs();
  const client = fakeClient({
    claims: [claimOf()],
    onResult: () => Promise.reject(new Error("ECONNRESET")),
    onReconcile: () => Promise.resolve({ run: { id: "run-1", status: "RUNNING" }, command: { id: "CMD-1", status: "CLAIMED" } }),
  });
  const host = createHost({
    client,
    runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-cap" }),
    ownerId: "host-a",
    pollMs: 1000,
    flushMs: 5,
    heartbeatMs: 1000,
    stateFile,
    outboxFile,
    outboxRetryBaseMs: 5,
    outboxRetryMaxMs: 20,
    outboxMaxAttempts: 3,
    logger: quietLogger(),
  });
  await host.tick();
  await waitFor(() => host.mode() === "MANUAL_REQUIRED" && client.calls.result.length >= 3, 4000, "retry cap");
  assert.equal(client.calls.result.length, 3, "the cap must stop retries");
  assert.equal(host.stats.outboxExhausted, 1);
  const persisted = JSON.parse(readFileSync(outboxFile, "utf8"));
  assert.equal(persisted.entries.length, 1, "the terminal fact must stay in the outbox after the cap");
  assert.equal(persisted.entries[0].attempts, 3);
  assert.equal(typeof persisted.entries[0].nextAttemptAt, "string", "the outbox must record when the next retry was due");
  const callsAtCap = client.calls.result.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.calls.result.length, callsAtCap, "no retry may fire after the attempt cap");
  await host.stop();
});

test("F07: a 409 with reason generation-mismatch is fencing even without the code", async () => {
  const { stateFile, outboxFile } = makeDirs();
  let stopCalls = 0;
  const runtime = createMockRuntime({ scenario: "hang" });
  runtime.stop = async () => {
    stopCalls += 1;
  };
  const client = fakeClient({
    claims: [claimOf()],
    onEvents: () => Promise.reject(new InternalApiError(409, "VERSION_CONFLICT", { reason: "generation-mismatch" }, "fenced")),
  });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 1000, flushMs: 5, heartbeatMs: 1000, stateFile, outboxFile, logger: quietLogger() });
  await host.tick();
  await waitFor(() => stopCalls === 1, 3000, "fencing by reason");
  await waitFor(() => host.mode() !== "FENCING", 3000, "fencing to finish");
  assert.equal(host.mode(), "RUNNING");
  await host.stop();
});

test("F07: STALE_GENERATION stops the session and waits for the runtime stop before continuing", async () => {
  const { stateFile, outboxFile } = makeDirs();
  let stopCalls = 0;
  let resolveStop;
  const runtime = createMockRuntime({ scenario: "hang" });
  runtime.stop = () => {
    stopCalls += 1;
    return new Promise((resolve) => {
      resolveStop = () => resolve({ ok: true });
    });
  };
  const client = fakeClient({
    claims: [claimOf()],
    onEvents: () => Promise.reject(new InternalApiError(409, "STALE_GENERATION", { runId: "run-1" }, "stale")),
  });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 1000, flushMs: 5, heartbeatMs: 1000, stateFile, outboxFile, logger: quietLogger() });
  await host.tick();
  await waitFor(() => stopCalls === 1, 3000, "runtime.stop");
  assert.equal(host.mode(), "FENCING", "the host must expose that fencing is in progress");
  const claimsBefore = client.calls.claim;
  await host.tick();
  assert.equal(client.calls.claim, claimsBefore, "a fencing host must not claim new work");
  resolveStop();
  await waitFor(() => host.mode() !== "FENCING", 3000, "fencing to finish");
  assert.equal(host.activeSessions().length, 0);
  assert.equal(client.calls.result.length, 0, "a stale host must not report a result");
  await host.stop();
});

test("F07: an unconfirmed runtime stop becomes FENCING_REQUIRED (no more claims)", async () => {
  const { stateFile, outboxFile } = makeDirs();
  const runtime = createMockRuntime({ scenario: "hang" });
  runtime.stop = async () => {
    throw new Error("runtime process is gone");
  };
  const client = fakeClient({
    claims: [claimOf()],
    onEvents: () => Promise.reject(new InternalApiError(409, "STALE_GENERATION", { runId: "run-1" }, "stale")),
  });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 1000, flushMs: 5, heartbeatMs: 1000, stateFile, outboxFile, logger: quietLogger() });
  await host.tick();
  await waitFor(() => host.mode() === "FENCING_REQUIRED", 3000, "FENCING_REQUIRED");
  const claimsBefore = client.calls.claim;
  await host.tick();
  assert.equal(client.calls.claim, claimsBefore, "FENCING_REQUIRED must block all new claims");
  await host.stop();
});

test("F07: a transient network error is not a fencing event (do not stop the session)", async () => {
  const { stateFile, outboxFile } = makeDirs();
  let stopCalls = 0;
  const runtime = createMockRuntime({ scenario: "hang" });
  runtime.stop = async () => {
    stopCalls += 1;
  };
  const client = fakeClient({ claims: [claimOf()], onEvents: () => Promise.reject(new Error("ECONNREFUSED")) });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 1000, flushMs: 5, heartbeatMs: 1000, stateFile, outboxFile, logger: quietLogger() });
  await host.tick();
  await waitFor(() => host.stats.errors >= 1, 3000, "event upload error");
  assert.equal(stopCalls, 0, "a temporary network error must not be treated as lost authority");
  assert.notEqual(host.mode(), "FENCING_REQUIRED");
  await host.stop();
});

test("F09: a corrupt recovery file means RECOVERY_REQUIRED, never 'no runs'", async () => {
  const { stateFile, outboxFile } = makeDirs();
  writeFileSync(stateFile, '{ "runId": "run-1", "comm'); // half-written JSON
  const client = fakeClient({ claims: [claimOf()] });
  const host = createHost({
    client,
    runtime: createMockRuntime({ scenario: "complete" }),
    ownerId: "host-a",
    pollMs: 1000,
    flushMs: 5,
    heartbeatMs: 1000,
    stateFile,
    outboxFile,
    logger: quietLogger(),
  });
  const summary = await host.recover();
  assert.equal(summary.corrupt, true, "recover must report the corruption instead of pretending the file was empty");
  assert.equal(host.mode(), "RECOVERY_REQUIRED");
  const claimsBefore = client.calls.claim;
  await host.tick();
  assert.equal(client.calls.claim, claimsBefore, "a host that needs recovery must not claim work");
  assert.equal(readFileSync(stateFile, "utf8"), '{ "runId": "run-1", "comm', "the corrupt file must be preserved for investigation");
  await host.stop();
});

test("F09: recovery records are written atomically and keep the previous complete copy as .bak", async () => {
  const { stateFile, outboxFile } = makeDirs();
  const client = fakeClient({ claims: [claimOf(), claimOf({ runId: "run-2", commandId: "CMD-2" })] });
  const runtime = createMockRuntime({ scenario: "hang" });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 1000, flushMs: 1000, heartbeatMs: 1000, stateFile, outboxFile, logger: quietLogger() });
  await host.tick();
  await host.tick();
  const current = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(current.length, 2);
  const backupFile = `${stateFile}.bak`;
  assert.ok(existsSync(backupFile), "every atomic replace must keep the previous complete file as .bak");
  const backup = JSON.parse(readFileSync(backupFile, "utf8"));
  assert.equal(backup.length, 1, ".bak must be the previous complete generation, not a truncated write");
  await host.stop();
});

// ---------------------------------------------------------------------------
// Real HTTP fault injection through createInternalClient (not a fake client):
// a dropped response and a 500 must both end with the same durable outbox entry
// and a single idempotency key.
// ---------------------------------------------------------------------------
function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(text || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

function internalApiHandler({ onResult, onReconcile }) {
  let claimed = false;
  return async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // m6.1-contracts §2: the Host must assert its internal role on every call.
    if (req.headers["x-atk-internal"] !== "internal-test" || req.headers["x-atk-internal-role"] !== "runtime-host") {
      return json(403, { error: { code: "NOT_AUTHORIZED", details: { reason: "internal-role-required" } } });
    }
    if (req.method === "GET" && url.pathname === "/internal/v1/dispatch/claim") {
      if (claimed) return json(204, null);
      claimed = true;
      return json(200, claimOf());
    }
    if (req.method === "POST" && /\/internal\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      return json(200, { appended: (await readBody(req))?.events ?? [], skipped: 0 });
    }
    if (req.method === "POST" && /\/internal\/v1\/runs\/[^/]+\/renew$/.test(url.pathname)) {
      const body = await readBody(req);
      return json(200, { lease: { ...body, generation: body.generation + 1 } });
    }
    if (req.method === "GET" && /\/internal\/v1\/runs\/[^/]+\/reconcile$/.test(url.pathname)) {
      return json(200, await onReconcile());
    }
    if (req.method === "POST" && /\/internal\/v1\/dispatch\/[^/]+\/result$/.test(url.pathname)) {
      const body = await readBody(req);
      return onResult(body, req, json);
    }
    return json(404, { error: { code: "NOT_FOUND" } });
  };
}

test("F02 real HTTP: a dropped result response is reconciled and the outbox is cleared without a blind re-post", async () => {
  const { stateFile, outboxFile } = makeDirs();
  const resultBodies = [];
  let reconcileCalls = 0;
  const { server, base } = await listen(
    internalApiHandler({
      onResult: (body, req) => {
        resultBodies.push(body);
        req.socket.destroy(); // request reached the backend; response never came back
      },
      onReconcile: async () => {
        reconcileCalls += 1;
        return { run: { id: "run-1", status: "COMPLETED" }, command: { id: "CMD-1", status: "DONE" }, persisted: true };
      },
    }),
  );
  try {
    const host = createHost({
      client: createInternalClient({ baseUrl: base, token: "internal-test", timeoutMs: 2000 }),
      runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-http-1" }),
      ownerId: "host-a",
      pollMs: 1000,
      flushMs: 5,
      heartbeatMs: 1000,
      stateFile,
      outboxFile,
      outboxRetryBaseMs: 5,
      outboxRetryMaxMs: 20,
      logger: quietLogger(),
    });
    await host.tick();
    await waitFor(() => resultBodies.length >= 1 && host.outbox().length === 0, 5000, "reconciled real-HTTP outbox");
    assert.equal(resultBodies.length, 1, "a reconciled lost response must not be re-posted blindly");
    assert.match(resultBodies[0].idempotencyKey, /^[0-9a-f-]{36}$/i, "the result must carry a stable idempotency key");
    assert.ok(reconcileCalls >= 1, "the ambiguous failure must be reconciled");
    assert.equal(host.stats.completed, 1);
    await host.stop();
  } finally {
    server.close();
  }
});

test("F02 real HTTP: a 500 keeps retrying with the same idempotency key until acknowledged", async () => {
  const { stateFile, outboxFile } = makeDirs();
  const resultBodies = [];
  const { server, base } = await listen(
    internalApiHandler({
      onResult: (body, req, json) => {
        resultBodies.push(body);
        if (resultBodies.length < 3) return json(500, { error: { code: "INTERNAL_ERROR", message: "boom" } });
        return json(200, { persisted: true });
      },
      onReconcile: async () => ({ run: { id: "run-1", status: "RUNNING" }, command: { id: "CMD-1", status: "CLAIMED" } }),
    }),
  );
  try {
    const host = createHost({
      client: createInternalClient({ baseUrl: base, token: "internal-test", timeoutMs: 2000 }),
      runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-http-2" }),
      ownerId: "host-a",
      pollMs: 1000,
      flushMs: 5,
      heartbeatMs: 1000,
      stateFile,
      outboxFile,
      outboxRetryBaseMs: 5,
      outboxRetryMaxMs: 20,
      logger: quietLogger(),
    });
    await host.tick();
    await waitFor(() => resultBodies.length >= 3 && host.outbox().length === 0, 5000, "retried real-HTTP outbox");
    assert.equal(resultBodies.length, 3, `expected 3 result attempts, got ${resultBodies.length}`);
    assert.equal(new Set(resultBodies.map((body) => body.idempotencyKey)).size, 1, "the retry must reuse the same idempotency key");
    assert.equal(host.stats.completed, 1);
    await host.stop();
  } finally {
    server.close();
  }
});
