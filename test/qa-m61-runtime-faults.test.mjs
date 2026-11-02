// M6.1 independent QA-02: runtime fault injection.
//
// Landed: F02 Outbox/FINISHING, F03 store batch atomicity, F07 fencing, F09
// atomic recovery, F08 eventId dedupe. The HTTP batch-recovery route is still
// being wired by WP6; that scenario is explicitly skipped rather than passed.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

if (!hasSqlite) {
  test("qa-m61 runtime-fault suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5" }, () => {});
} else {
  const { openStore, createMemoryStore } = await load("packages/database/src/index.mjs");
  const { INTERNAL } = await load("packages/database/src/internal.mjs");
  const { createHost } = await load("apps/runtime-host/src/host.mjs");
  const { createMockRuntime } = await load("packages/runtime-sdk/src/mock.mjs");
  const { startServer, request, internalHeaders, TEST_INTERNAL_TOKEN } = await load("apps/backend/test/helpers.mjs");
  const { createInternalClient } = await load("apps/runtime-host/src/client.mjs");

  // M6.2 F05: a Host never starts without a valid frozen TaskExecutionSpec.
  // These are Host-side fault-injection fixtures, so the spec is constructed
  // explicitly (kind "none") instead of reaching into the database.
  const specOf = (runId, taskId = `TASK-${runId}`) => ({
    schemaVersion: 1,
    taskId,
    taskVersion: 2,
    title: "QA runtime-fault task",
    description: "exercise Outbox / fencing",
    acceptance: "ack is durable",
    files: [],
    deps: [],
    functionRequired: "WORKER",
    roleRequired: "DEV",
    project: { id: "P-QA", name: "qa", repoPath: ".", defaultBranch: "main" },
    workspace: { kind: "none", path: null, baseCommit: null, targetBranch: null },
    constraints: {},
    frozenAt: "2026-11-02T00:00:00.000Z",
  });
  const claimOf = ({ runId = "run-1", commandId = "CMD-1", spec } = {}) => {
    const taskId = spec?.taskId ?? `TASK-${runId}`;
    const value = spec ?? specOf(runId, taskId);
    return {
      command: { id: commandId, runId, commandType: "START_RUN", attempts: 1, payload: { prompt: "do it", spec: value } },
      run: { id: runId, taskId, status: "STARTING", workspace: value.workspace },
      lease: { ownerId: "host-a", generation: 7, claimedUntil: new Date(Date.now() + 30000).toISOString() },
      spec: value,
    };
  };
  function fakeClient({ claims = [], onEvents, onResult, onReconcile } = {}) {
    const calls = { claim: 0, events: [], result: [], renew: [], heartbeat: [], reconcile: [] };
    const queue = [...claims];
    return {
      calls,
      claim() { calls.claim += 1; return Promise.resolve(queue.length ? queue.shift() : null); },
      events(runId, body) { calls.events.push({ runId, ...body }); return onEvents ? onEvents(runId, body, calls) : Promise.resolve({ appended: body.events, skipped: 0 }); },
      renew(runId, body) { calls.renew.push({ runId, ...body }); return Promise.resolve({ lease: { ...body, generation: body.generation + 1 } }); },
      result(commandId, body) { calls.result.push({ commandId, ...body }); return onResult ? onResult(commandId, body, calls) : Promise.resolve({ persisted: true }); },
      heartbeat(body) { calls.heartbeat.push(body); return Promise.resolve({ ok: true }); },
      reconcile(runId) { calls.reconcile.push(runId); return onReconcile ? onReconcile(runId, calls) : Promise.resolve({ run: { id: runId, status: "RUNNING" }, command: { status: "CLAIMED" } }); },
    };
  }
  const logger = { info() {}, warn() {}, error() {} };
  function waitFor(predicate, timeoutMs = 3000, label = "condition") {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        let value;
        try { value = predicate(); } catch (error) { return reject(error); }
        if (value) return resolve(value);
        if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
        setTimeout(tick, 10);
      };
      tick();
    });
  }
  function tempDir(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m61-fault-"));
    t.after(() => { for (let attempt = 0; attempt < 5; attempt += 1) { try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* busy */ } } });
    return dir;
  }
  function hostFixture(t, options = {}) {
    const dir = tempDir(t);
    const stateFile = path.join(dir, "host.json");
    const outboxFile = path.join(dir, "host.outbox.json");
    const host = createHost({
      client: options.client ?? fakeClient({ claims: [claimOf()] }),
      runtime: options.runtime ?? createMockRuntime({ scenario: "complete", sessionIdFactory: () => "session-1" }),
      ownerId: "host-a",
      pollMs: 1000,
      flushMs: 5,
      heartbeatMs: 1000,
      stateFile,
      outboxFile,
      outboxRetryBaseMs: 5,
      outboxRetryMaxMs: 20,
      logger,
      ...options.hostOptions,
    });
    t.after(async () => { try { await host.stop(); } catch { /* ignore */ } });
    return { dir, stateFile, outboxFile, host };
  }
  function storeRunFixture(t, { running = true } = {}) {
    const dir = tempDir(t);
    const store = openStore({ file: path.join(dir, "atk.db"), migrate: true });
    t.after(() => { try { store.close(); } catch { /* closed */ } });
    store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const task = store.createTask({ id: "T-RUN", projectId: "P1", title: "run", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    const claim = store.claimTask({ taskId: task.id, agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: "qa-m61-http" });
    const claimed = store.claimDispatchCommand({ ownerId: "host-qa", leaseMs: 60000 });
    const generation = claimed.lease.generation;
    if (running) store.updateRunStatus(claim.run.id, { status: "RUNNING", generation });
    return { dir, store, task, claim, command: claimed.command, generation };
  }
  function fingerprint(store, runId) {
    return {
      run: store.getRun(runId),
      events: store.listEvents({ aggregateId: runId, limit: 1000 }).map((event) => ({ type: event.type, eventId: event.eventId ?? null, seq: event.seq })),
    };
  }

  test("QA-02.1 a malformed element in the middle of a batch leaves no partial writes", async (t) => {
    const f = storeRunFixture(t);
    const before = fingerprint(f.store, f.claim.run.id);
    await assert.rejects(
      async () => f.store.applyRuntimeEventBatch({
        runId: f.claim.run.id,
        generation: f.generation,
        events: [
          { type: "run.log", payload: { line: "first" }, eventId: "EVT-1", sessionSeq: 1 },
          { type: "run.log", payload: "invalid", eventId: "EVT-2", sessionSeq: 2 },
          { type: "run.log", payload: { line: "never" }, eventId: "EVT-3", sessionSeq: 3 },
        ],
      }),
      (error) => error.code === "VALIDATION_ERROR" || error.name === "StoreError",
    );
    assert.deepEqual(fingerprint(f.store, f.claim.run.id), before, "a failed batch must not leave half-applied state");
  });

  test("QA-02.1b a write-phase failure after a valid log rolls the whole batch back", async (t) => {
    // Input order matters: the log is written first, then the Run transition is
    // rejected. Without the batch transaction the log would survive; with it the
    // whole batch must disappear.
    const f = storeRunFixture(t, { running: false });
    await assert.rejects(
      async () => f.store.applyRuntimeEventBatch({
        runId: f.claim.run.id,
        generation: f.generation,
        events: [
          { type: "run.log", payload: { line: "must roll back" }, eventId: "EVT-LOG-BEFORE-FAIL", sessionSeq: 1 },
          { type: "run.updated", payload: { status: "COMPLETED" }, eventId: "EVT-BAD-TRANSITION", sessionSeq: 2 },
        ],
      }),
      (error) => error.code === "VALIDATION_ERROR" || error.code === "STALE_GENERATION" || error.name === "StoreError",
    );
    assert.equal(f.store.getRun(f.claim.run.id).status, "STARTING", "the failed transition must not change the Run");
    assert.equal(
      f.store.listEvents({ aggregateId: f.claim.run.id, limit: 1000 }).filter((event) => event.eventId === "EVT-LOG-BEFORE-FAIL").length,
      0,
      "the valid log written before the failing transition must be rolled back",
    );
  });

  test("QA-02.2 eventId dedupe: 100 same-ms distinct ids survive, triple submit stores one copy each", async (t) => {
    const f = storeRunFixture(t);
    const batch = {
      runId: f.claim.run.id,
      generation: f.generation,
      events: Array.from({ length: 100 }, (_, index) => ({ type: "run.log", payload: { index }, eventId: `EVT-${index}`, sessionSeq: index + 1 })),
    };
    const first = f.store.applyRuntimeEventBatch(batch);
    assert.ok(Array.isArray(first.applied), `applied must be the Event[] per the frozen contract, got ${typeof first.applied}`);
    assert.equal(first.applied.length, 100, "100 distinct eventIds must all be persisted");
    const afterFirst = fingerprint(f.store, f.claim.run.id);
    const second = f.store.applyRuntimeEventBatch(batch);
    const third = f.store.applyRuntimeEventBatch(batch);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 100);
    assert.equal(third.applied.length, 0);
    assert.deepEqual(fingerprint(f.store, f.claim.run.id), afterFirst, "replays must not add a single event");
    const ids = new Set(afterFirst.events.map((event) => event.eventId).filter(Boolean));
    assert.equal(ids.size, 100);
    assert.equal(afterFirst.events.filter((event) => event.eventId).length, 100, "exactly the 100 identified events are present (plus pre-existing events)");
  });

  test("QA-02.3 a stale generation is fenced before any write", async (t) => {
    const f = storeRunFixture(t);
    const before = fingerprint(f.store, f.claim.run.id);
    await assert.rejects(
      async () => f.store.applyRuntimeEventBatch({
        runId: f.claim.run.id,
        generation: f.generation + 1,
        events: [{ type: "run.log", payload: { line: "stale" }, eventId: "EVT-STALE", sessionSeq: 1 }],
      }),
      (error) => error.code === "STALE_GENERATION",
    );
    assert.deepEqual(fingerprint(f.store, f.claim.run.id), before, "a fenced batch must be zero-write");
  });

  test("QA-02.4 only one holder can claim a dispatch command", async (t) => {
    const f = storeRunFixture(t);
    const second = f.store.claimDispatchCommand({ ownerId: "host-other", leaseMs: 60000 });
    assert.equal(second, null, "a second host must not receive the same command");
    const run = f.store.getRun(f.claim.run.id);
    assert.equal(run.status, "RUNNING");
  });

  test("QA-02.4b the same batch/fence/dedupe contract holds on the Memory store", async (t) => {
    const dir = tempDir(t);
    const memory = createMemoryStore();
    t.after(() => { try { memory.close(); } catch { /* closed */ } });
    memory.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    memory.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const task = memory.createTask({ id: "T-MEM", projectId: "P1", title: "m", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    const claim = memory.claimTask({ taskId: task.id, agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: "qa02-memory" });
    const claimed = memory.claimDispatchCommand({ ownerId: "host-mem", leaseMs: 60000 });
    const generation = claimed.lease.generation;
    memory.updateRunStatus(claim.run.id, { status: "RUNNING", generation });
    const batch = {
      runId: claim.run.id,
      generation,
      events: [
        { type: "run.log", payload: { line: "mem" }, eventId: "MEM-EVT-1", sessionSeq: 1 },
        { type: "run.updated", payload: { status: "COMPLETED", exitCode: 0 }, eventId: "MEM-EVT-2", sessionSeq: 2 },
      ],
    };
    const first = memory.applyRuntimeEventBatch(batch);
    assert.equal(first.applied.length, 2);
    const second = memory.applyRuntimeEventBatch(batch);
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped, 2);
    const before = JSON.stringify({ run: memory.getRun(claim.run.id), events: memory.listEvents({ aggregateId: claim.run.id, limit: 100 }) });
    await assert.rejects(
      async () => memory.applyRuntimeEventBatch({ runId: claim.run.id, generation, events: [{ type: "run.log", payload: "bad", eventId: "MEM-BAD", sessionSeq: 3 }] }),
      (error) => error.code === "VALIDATION_ERROR" || error.name === "StoreError",
    );
    assert.equal(JSON.stringify({ run: memory.getRun(claim.run.id), events: memory.listEvents({ aggregateId: claim.run.id, limit: 100 }) }), before);
    assert.throws(
      () => memory.renewRunLease({ runId: claim.run.id, ownerId: "other", generation, leaseMs: 60000 }),
      (error) => error.code === "STALE_GENERATION",
    );
  });

  test("QA-02.5 F02: a transient result failure persists the fact and only counts completion after ack", async (t) => {
    let failures = 2;
    const client = fakeClient({
      claims: [claimOf()],
      onResult: () => {
        if (failures > 0) { failures -= 1; return Promise.reject(new Error("ECONNRESET")); }
        return Promise.resolve({ persisted: true });
      },
    });
    const f = hostFixture(t, { client });
    await f.host.tick();
    await waitFor(() => f.host.mode() === "FINISHING", 3000, "FINISHING");
    assert.equal(f.host.stats.completed, 0, "an unacknowledged result is not a completed Run");
    const persisted = JSON.parse(readFileSync(f.outboxFile, "utf8"));
    assert.equal(persisted.entries.length, 1, "the terminal fact must be durable in the outbox");
    assert.ok(persisted.entries[0].idempotencyKey, "outbox needs a stable idempotency key");
    assert.ok(JSON.parse(readFileSync(f.stateFile, "utf8")).some((record) => record.runId === "run-1"), "the in-flight record must survive a failed ack");
    await waitFor(() => f.host.outbox().length === 0, 4000, "outbox drained");
    assert.equal(f.host.stats.completed, 1);
    assert.ok(client.calls.result.length >= 3);
    assert.equal(new Set(client.calls.result.map((call) => call.idempotencyKey)).size, 1, "retries must reuse one idempotency key");
  });

  test("QA-02.6 F02: a lost response is reconciled, not blindly re-posted", async (t) => {
    let resultCalls = 0;
    const client = fakeClient({
      claims: [claimOf()],
      onResult: () => { resultCalls += 1; return Promise.reject(new Error("socket hang up")); },
      onReconcile: () => Promise.resolve({ run: { id: "run-1", status: "COMPLETED" }, command: { id: "CMD-1", status: "DONE" }, persisted: true }),
    });
    const f = hostFixture(t, { client });
    await f.host.tick();
    await waitFor(() => client.calls.reconcile.length >= 1, 3000, "reconcile");
    await waitFor(() => f.host.outbox().length === 0, 3000, "reconciled outbox");
    assert.equal(resultCalls, 1, "a reconcilable lost response must not be re-posted");
    assert.equal(f.host.stats.completed, 1);
    assert.deepEqual(JSON.parse(readFileSync(f.stateFile, "utf8")), []);
  });

  test("QA-02.7 F02: a 2xx without persisted:true is not an acknowledgement", async (t) => {
    const client = fakeClient({
      claims: [claimOf()],
      onResult: () => Promise.resolve({ command: { id: "CMD-1", status: "DONE" }, run: { id: "run-1", status: "COMPLETED" } }),
    });
    const f = hostFixture(t, { client });
    await f.host.tick();
    await waitFor(() => f.host.mode() === "MANUAL_REQUIRED", 3000, "MANUAL_REQUIRED");
    assert.equal(f.host.stats.completed, 0);
    assert.equal(f.host.outbox().length, 1, "the unconfirmed completion must stay in the outbox");
  });

  test("QA-02.8 F07: STALE_GENERATION stops the session; an unconfirmed stop blocks all new claims", async (t) => {
    let stopCalls = 0;
    const runtime = createMockRuntime({ scenario: "hang" });
    runtime.stop = async () => { stopCalls += 1; throw new Error("runtime process is gone"); };
    const client = fakeClient({
      claims: [claimOf()],
      onEvents: () => Promise.reject(Object.assign(new Error("stale"), { code: "STALE_GENERATION", details: { runId: "run-1" } })),
    });
    const f = hostFixture(t, { client, runtime });
    await f.host.tick();
    await waitFor(() => f.host.mode() === "FENCING_REQUIRED", 3000, "FENCING_REQUIRED");
    assert.equal(stopCalls, 1, "the runtime stop must be attempted");
    const claimsBefore = client.calls.claim;
    await f.host.tick();
    assert.equal(client.calls.claim, claimsBefore, "a host that cannot fence must not claim");
  });

  test("QA-02.9 F09: a corrupt recovery file means RECOVERY_REQUIRED, never empty", async (t) => {
    const f = hostFixture(t);
    writeFileSync(f.stateFile, '{ "runId": "run-1", "comm');
    const summary = await f.host.recover();
    assert.equal(summary.corrupt, true);
    assert.equal(f.host.mode(), "RECOVERY_REQUIRED");
    // The corrupt file must be preserved for investigation, never overwritten.
    assert.equal(readFileSync(f.stateFile, "utf8"), '{ "runId": "run-1", "comm');
    await f.host.tick();
    assert.equal(f.host.activeSessions().length, 0);
  });

  test("QA-02.10 real HTTP: a dispatch result is acknowledged once and replays idempotently", async (t) => {
    const dir = tempDir(t);
    const dbFile = path.join(dir, "data", "atk.db");
    const store = openStore({ file: dbFile, migrate: true });
    const project = store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    const task = store.createTask({ id: "T1", projectId: project.id, title: "t", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const claim = store.claimTask({ taskId: task.id, agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: "qa-m61-result" });
    const claimed = store.claimDispatchCommand({ ownerId: "host-qa", leaseMs: 60000 });
    store.updateRunStatus(claim.run.id, { status: "RUNNING", generation: claimed.lease.generation });
    const ctx = await startServer({ store, logger });
    t.after(async () => { await ctx.server.close().catch(() => {}); try { store.close(); } catch { /* closed */ } });
    const body = {
      ownerId: "host-qa",
      generation: claimed.lease.generation,
      status: "DONE",
      exitCode: 0,
      summary: "done",
      eventId: "EVT-ACK",
    };
    const headers = { ...internalHeaders(TEST_INTERNAL_TOKEN, "runtime-host"), "content-type": "application/json" };
    const first = await request(ctx.base, { method: "POST", path: `/internal/v1/dispatch/${claimed.command.id}/result`, headers, body });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.persisted, true);
    const afterFirst = fingerprint(store, claim.run.id);
    const replay = await request(ctx.base, { method: "POST", path: `/internal/v1/dispatch/${claimed.command.id}/result`, headers, body });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.persisted, true);
    assert.deepEqual(fingerprint(store, claim.run.id), afterFirst, "a replay must not duplicate the run.updated event");
    assert.equal(store[INTERNAL].getDispatchCommand(claimed.command.id)?.status, "DONE", "the command result must be durably recorded");
  });

  test("QA-02.11 real HTTP: duplicate batch retries are deduped by eventId", async (t) => {
    const f = storeRunFixture(t);
    const ctx = await startServer({ store: f.store, logger });
    t.after(async () => { await ctx.server.close().catch(() => {}); });
    const headers = { ...internalHeaders(TEST_INTERNAL_TOKEN, "runtime-host"), "content-type": "application/json" };
    const body = {
      generation: f.generation,
      events: [
        { type: "session.started", eventId: "EVT-START", sessionSeq: 1, at: new Date().toISOString(), sessionId: "session-1" },
        { type: "output", eventId: "EVT-LOG-1", sessionSeq: 2, at: new Date().toISOString(), sessionId: "session-1", stream: "stdout", text: "hello" },
      ],
    };
    const first = await request(ctx.base, { method: "POST", path: `/internal/v1/runs/${f.claim.run.id}/events`, headers, body });
    assert.equal(first.status, 200, first.text);
    const afterFirst = fingerprint(f.store, f.claim.run.id);
    const second = await request(ctx.base, { method: "POST", path: `/internal/v1/runs/${f.claim.run.id}/events`, headers, body });
    assert.equal(second.status, 200, second.text);
    assert.deepEqual(fingerprint(f.store, f.claim.run.id), afterFirst, "a retried batch must not duplicate events");
  });

  function listen(handler) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
    });
  }
  function readRequestBody(req) {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); }
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
      if (req.headers["x-atk-internal"] !== "internal-test" || req.headers["x-atk-internal-role"] !== "runtime-host") {
        return json(403, { error: { code: "NOT_AUTHORIZED", details: { reason: "internal-role-required" } } });
      }
      if (req.method === "GET" && url.pathname === "/internal/v1/dispatch/claim") {
        if (claimed) return json(204, null);
        claimed = true;
        return json(200, claimOf());
      }
      if (req.method === "POST" && /\/internal\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
        return json(200, { applied: (await readRequestBody(req))?.events ?? [], skipped: 0 });
      }
      if (req.method === "POST" && /\/internal\/v1\/runs\/[^/]+\/renew$/.test(url.pathname)) {
        const body = await readRequestBody(req);
        return json(200, { lease: { ...body, generation: body.generation + 1 } });
      }
      if (req.method === "POST" && url.pathname === "/internal/v1/runtime/heartbeat") {
        return json(200, { ok: true });
      }
      if (req.method === "GET" && /\/internal\/v1\/runs\/[^/]+\/reconcile$/.test(url.pathname)) {
        return json(200, await onReconcile());
      }
      if (req.method === "POST" && /\/internal\/v1\/dispatch\/[^/]+\/result$/.test(url.pathname)) {
        return onResult(await readRequestBody(req), req, json);
      }
      return json(404, { error: { code: "NOT_FOUND" } });
    };
  }

  test("QA-02.12 F02 over the real HTTP client: a lost response is reconciled, not blindly re-posted", async (t) => {
    const bodies = [];
    let reconciles = 0;
    const { server, base } = await listen(internalApiHandler({
      onResult: (body, req) => {
        bodies.push(body);
        req.socket.destroy(); // the request reached the backend, the response was lost
      },
      onReconcile: async () => {
        reconciles += 1;
        return { run: { id: "run-1", status: "COMPLETED" }, command: { id: "CMD-1", status: "DONE" }, persisted: true };
      },
    }));
    t.after(() => { try { server.close(); } catch { /* closed */ } });
    const client = createInternalClient({ baseUrl: base, token: "internal-test", timeoutMs: 2000 });
    const f = hostFixture(t, { client });
    await f.host.tick();
    await waitFor(() => bodies.length >= 1 && f.host.outbox().length === 0, 5000, "real-HTTP outbox reconcile");
    assert.equal(bodies.length, 1, "a reconcilable lost response must not be re-posted");
    assert.match(bodies[0].idempotencyKey, /^[0-9a-f-]{36}$/i, "the result must carry a stable idempotency key");
    assert.ok(reconciles >= 1, "the ambiguous failure must be reconciled over HTTP");
    assert.equal(f.host.stats.completed, 1);
  });

  test("QA-02.13 real HTTP: a rejected event batch is atomic on the server", async (t) => {
    const f = storeRunFixture(t);
    const ctx = await startServer({ store: f.store, logger });
    t.after(async () => { await ctx.server.close().catch(() => {}); });
    const before = fingerprint(f.store, f.claim.run.id);
    const headers = { ...internalHeaders(TEST_INTERNAL_TOKEN, "runtime-host"), "content-type": "application/json" };
    const rejected = await request(ctx.base, {
      method: "POST",
      path: `/internal/v1/runs/${f.claim.run.id}/events`,
      headers,
      body: { generation: f.generation, events: [{ type: "output", text: "not enough fields" }] },
    });
    assert.ok(rejected.status === 400 || rejected.status === 422, rejected.text);
    assert.deepEqual(fingerprint(f.store, f.claim.run.id), before, "a rejected batch must not change the Run or its events");
  });
}

