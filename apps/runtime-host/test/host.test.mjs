// Runtime Host tests: a fake internal client (no HTTP) plus the real MockRuntime,
// so the host's own logic is what is under test.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockRuntime } from "@atk/runtime-sdk/mock";
import { createHost } from "../src/host.mjs";
import { InternalApiError } from "../src/client.mjs";

function quietLogger() {
  const lines = [];
  return { lines, info: () => {}, warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

/** In-memory backend: one queued claim, records every call. */
function fakeClient({ claims = [], staleOnEvents = false, staleOnRenew = false } = {}) {
  const calls = { claim: 0, result: [], events: [], renew: [], heartbeat: [] };
  const queue = [...claims];
  return {
    calls,
    claim() {
      calls.claim += 1;
      return Promise.resolve(queue.length ? queue.shift() : null);
    },
    events(runId, body) {
      if (staleOnEvents) {
        return Promise.reject(new InternalApiError(409, "STALE_GENERATION", { runId }, "stale"));
      }
      calls.events.push({ runId, ...body });
      return Promise.resolve({ run: { id: runId }, appended: body.events, skipped: 0 });
    },
    renew(runId, body) {
      if (staleOnRenew) return Promise.reject(new InternalApiError(409, "STALE_GENERATION", { runId }, "stale"));
      calls.renew.push({ runId, ...body });
      return Promise.resolve({ lease: { ...body, generation: body.generation + 1, claimedUntil: new Date(Date.now() + 30000).toISOString() } });
    },
    result(commandId, body) {
      calls.result.push({ commandId, ...body });
      return Promise.resolve({ command: { id: commandId }, run: { id: "run-1" } });
    },
    heartbeat(body) {
      calls.heartbeat.push(body);
      return Promise.resolve({ ok: true });
    },
    reconcile() {
      return Promise.resolve({ run: { id: "run-1", status: "RUNNING" }, lease: null, sessions: [] });
    },
  };
}

function claimOf({ attempts = 1 } = {}) {
  return {
    command: { id: "CMD-1", runId: "run-1", commandType: "START_RUN", attempts, payload: { prompt: "do it" } },
    run: { id: "run-1", taskId: "TASK-1", status: "STARTING" },
    lease: { ownerId: "host-a", generation: 1, claimedUntil: new Date(Date.now() + 30000).toISOString() },
  };
}

test("recover() reconciles persisted runs and never guesses (ADR-010 decision 7)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-host-recover-"));
  const stateFile = path.join(dir, "host.json");
  writeFileSync(
    stateFile,
    JSON.stringify([
      { runId: "run-terminal", commandId: "CMD-1", ownerId: "host-a", generation: 1 },
      { runId: "run-lost", commandId: "CMD-2", ownerId: "host-a", generation: 1 },
    ]),
  );
  const seen = [];
  const client = fakeClient({ claims: [] });
  client.reconcile = (runId) => {
    seen.push(runId);
    const status = runId === "run-terminal" ? "COMPLETED" : "RUNNING";
    return Promise.resolve({ run: { id: runId, status }, lease: null, sessions: [] });
  };
  const host = createHost({ client, runtime: createMockRuntime({ scenario: "complete" }), ownerId: "host-a", logger: quietLogger(), stateFile });
  const summary = await host.recover();

  assert.deepEqual(seen.sort(), ["run-lost", "run-terminal"], "every persisted run must be reconciled");
  assert.equal(summary.terminal.length, 1);
  assert.equal(summary.lost.length, 1);
  assert.equal(summary.lost[0].runId, "run-lost");
  const remaining = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.deepEqual(remaining.map((record) => record.runId), ["run-lost"], "terminal runs are forgotten, lost ones are kept for the reclaim path");
  await host.stop();
});

test("a started run is recorded on disk so a crash can be reconciled later", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-host-state-"));
  const stateFile = path.join(dir, "host.json");
  const client = fakeClient({ claims: [claimOf()] });
  const runtime = createMockRuntime({ scenario: "hang", ignoreStop: true });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 1000, flushMs: 1000, heartbeatMs: 1000, logger: quietLogger(), stateFile });
  await host.tick();
  const records = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, "run-1");
  assert.equal(records[0].commandId, "CMD-1");
  await host.stop();
});

function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("a claimed run is started, its events forwarded, and the command completed", async () => {
  const client = fakeClient({ claims: [claimOf()] });
  const runtime = createMockRuntime({ scenario: "complete", sessionIdFactory: () => "mock-1" });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 10, flushMs: 5, heartbeatMs: 10, logger: quietLogger() });

  await host.tick();
  await waitFor(() => client.calls.result.length === 1);

  const sentTypes = client.calls.events.flatMap((call) => call.events.map((event) => event.type));
  assert.ok(sentTypes.includes("session.started"), `expected session.started, got ${sentTypes.join(",")}`);
  assert.ok(sentTypes.includes("session.ended"), "expected session.ended to be forwarded");
  const result = client.calls.result[0];
  assert.equal(result.status, "DONE");
  assert.equal(result.generation, 1);
  assert.equal(host.activeSessions().length, 0);
  await host.stop();
});

test("a failed session closes the command as FAILED", async () => {
  const client = fakeClient({ claims: [claimOf()] });
  const runtime = createMockRuntime({ scenario: "fail", sessionIdFactory: () => "mock-2" });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 10, flushMs: 5, heartbeatMs: 10, logger: quietLogger() });
  await host.tick();
  await waitFor(() => client.calls.result.length === 1);
  assert.equal(client.calls.result[0].status, "FAILED");
  await host.stop();
});

test("a reclaimed command is never restarted; it is reported interrupted", async () => {
  const client = fakeClient({ claims: [claimOf({ attempts: 2 })] });
  let started = 0;
  const runtime = createMockRuntime({ scenario: "complete" });
  const originalStart = runtime.start.bind(runtime);
  runtime.start = async (input) => {
    started += 1;
    return originalStart(input);
  };
  const host = createHost({ client, runtime, ownerId: "host-b", pollMs: 10, flushMs: 5, heartbeatMs: 10, logger: quietLogger() });
  await host.tick();
  await waitFor(() => client.calls.result.length === 1);

  assert.equal(started, 0, "a reclaimed command must NOT start a second session");
  const ended = client.calls.events.flatMap((call) => call.events).find((event) => event.type === "session.ended");
  assert.equal(ended?.reason, "interrupted");
  assert.equal(client.calls.result[0].status, "FAILED");
  assert.equal(client.calls.result[0].error, "reclaimed-after-lost-lease");
  assert.equal(client.calls.result[0].summary, "reclaimed-after-lost-lease");
  assert.equal(client.calls.result[0].ownerId, "host-b", "the result must identify the holder (QA-003)");
  assert.equal(host.stats.interrupted, 1);
  assert.equal(host.stats.errors, 0, "no error may be swallowed on the reclaim path");
  await host.stop();
});

test("STALE_GENERATION on an event upload stops the session instead of retrying", async () => {
  const client = fakeClient({ claims: [claimOf()], staleOnEvents: true });
  const runtime = createMockRuntime({ scenario: "complete" });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 10, flushMs: 5, heartbeatMs: 10, logger: quietLogger() });
  await host.tick();
  await waitFor(() => host.stats.errors >= 1);
  assert.equal(client.calls.result.length, 0, "a fenced host must not complete the command");
  await host.stop();
});

test("renewing the lease advances the generation used by the next upload", async () => {
  const client = fakeClient({ claims: [claimOf()] });
  const runtime = createMockRuntime({ scenario: "hang" }); // never ends on its own
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 1000, flushMs: 5, heartbeatMs: 1000, leaseMs: 3000, logger: quietLogger() });
  await host.tick();
  await waitFor(() => client.calls.renew.length >= 1, 5000);
  assert.ok(client.calls.renew[0].generation >= 1);
  await host.stop();
});

test("heartbeat is sent with the owner and an idle/busy status", async () => {
  const client = fakeClient({ claims: [] });
  const runtime = createMockRuntime({ scenario: "complete" });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 1000, flushMs: 1000, heartbeatMs: 5, logger: quietLogger() });
  host.start();
  await waitFor(() => client.calls.heartbeat.length >= 1);
  assert.equal(client.calls.heartbeat[0].ownerId, "host-a");
  assert.ok(["IDLE", "BUSY"].includes(client.calls.heartbeat[0].status));
  await host.stop();
});

test("stop() is idempotent and leaves no running timers", async () => {
  const client = fakeClient({ claims: [] });
  const runtime = createMockRuntime({ scenario: "complete" });
  const host = createHost({ client, runtime, ownerId: "host-a", pollMs: 5, flushMs: 5, heartbeatMs: 5, logger: quietLogger() });
  host.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await host.stop();
  await host.stop();
  const claimsAtStop = client.calls.claim;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(client.calls.claim <= claimsAtStop + 1, "claims must not continue after stop");
});
