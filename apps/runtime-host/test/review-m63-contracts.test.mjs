// M6.3 stage B contract tests (P0-4 / P1-5 / P1-6 / P1-7 / P1-9 / P2-10).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockRuntime } from "@atk/runtime-sdk/mock";
import { createTaskExecutionSpec } from "@atk/contracts";
import { createHost } from "../src/host.mjs";
import { InternalApiError } from "../src/client.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function quietLogger() {
  const lines = [];
  return { lines, info: () => {}, warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

function specFor({ taskId = "TASK-1", workspace = { kind: "none" } } = {}) {
  return createTaskExecutionSpec({
    task: { id: taskId, version: 2, title: "Contract task", description: "Do the contract task.", acceptance: "green", files: [], deps: [], functionRequired: "DEV", roleRequired: "DEVELOPER" },
    project: { id: "proj-1", name: "Demo", repoPath: "C:/repo", defaultBranch: "main" },
    workspace,
    frozenAt: "2026-01-01T00:00:00.000Z",
  });
}

function claimOf({ runId = "run-1", commandId = "CMD-1", spec } = {}) {
  return {
    command: { id: commandId, runId, commandType: "RUN_TASK", attempts: 1, payload: { spec: spec ?? specFor() } },
    run: { id: runId, taskId: "TASK-1", status: "STARTING", workspace: { kind: "none", path: null, baseCommit: null, targetBranch: null } },
    lease: { ownerId: "host-a", generation: 7, claimedUntil: new Date(Date.now() + 30000).toISOString() },
  };
}

function fakeClient({ claims = [], heartbeat, onEvents, onResult, onReconcile } = {}) {
  const calls = { claim: 0, register: [], heartbeat: [], events: [], result: [], reconcile: [] };
  const queue = [...claims];
  return {
    calls,
    claim() {
      calls.claim += 1;
      return Promise.resolve(queue.length ? queue.shift() : null);
    },
    register({ hostId, agents }) {
      calls.register.push({ hostId, agents });
      const returned = (Array.isArray(agents) ? agents : []).map((agent) => ({ agentId: agent.agentId, role: agent.role, function: agent.function, capacity: agent.capacity ?? null }));
      return Promise.resolve({ hostId, agents: returned });
    },
    heartbeat(body) {
      calls.heartbeat.push(body);
      return heartbeat ? heartbeat(body, calls) : Promise.resolve({ agents: [{ agentId: "agent-a", available: true, reason: "ok" }] });
    },
    events(runId, body) {
      calls.events.push({ runId, ...body });
      return onEvents ? onEvents(runId, body, calls) : Promise.resolve({ appended: body.events });
    },
    renew(runId, body) {
      return Promise.resolve({ lease: { ...body, generation: body.generation + 1 } });
    },
    result(commandId, body) {
      calls.result.push({ commandId, ...body });
      return onResult ? onResult(commandId, body, calls) : Promise.resolve({ persisted: true });
    },
    reconcile(runId) {
      calls.reconcile.push(runId);
      return onReconcile ? onReconcile(runId, calls) : Promise.resolve({ run: { id: runId, status: "RUNNING" }, command: { status: "CLAIMED" } });
    },
  };
}

function waitFor(predicate, timeoutMs = 4000, label = "condition") {
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

function makeDirs() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m63-contract-"));
  return { dir, stateFile: path.join(dir, "host.json"), outboxFile: path.join(dir, "host.outbox.json") };
}

function makeHost({ client, runtime, dir, options = {} }) {
  return createHost({
    client,
    runtime,
    ownerId: "host-a",
    pollMs: 10000,
    flushMs: 5,
    heartbeatMs: 10000,
    stateFile: path.join(dir, "host.json"),
    outboxFile: path.join(dir, "host.outbox.json"),
    outboxRetryBaseMs: 5,
    outboxRetryMaxMs: 20,
    allowNoneWorkspace: true,
    logger: quietLogger(),
    ...options,
  });
}

test("P0-4: a terminal Run without a reconcile command must NOT clear the Outbox", async () => {
  const { dir } = makeDirs();
  const client = fakeClient({
    claims: [claimOf()],
    onResult: () => Promise.reject(new Error("socket hang up")),
    onReconcile: () => Promise.resolve({ run: { id: "run-1", status: "COMPLETED" }, lease: null }), // no command (current backend)
  });
  const host = makeHost({ client, runtime: createMockRuntime({ scenario: "complete" }), dir });
  await host.tick();
  await waitFor(() => client.calls.result.length >= 1 && client.calls.reconcile.length >= 1, 4000, "result+reconcile");
  assert.equal(host.outbox().length, 1, "a terminal Run without a command must keep the Outbox");
  assert.notEqual(host.mode(), "RUNNING");
  await host.stop();
});

test("P1-5: every forwarded event has a UUID eventId and monotonic sessionSeq; retries reuse them", async () => {
  const { dir } = makeDirs();
  let eventAttempts = 0;
  const client = fakeClient({
    claims: [claimOf()],
    onEvents: () => {
      eventAttempts += 1;
      if (eventAttempts === 1) return Promise.reject(new Error("ECONNRESET"));
      return Promise.resolve({ appended: [] });
    },
  });
  const steps = [...Array.from({ length: 100 }, () => ({ emit: { type: "output", stream: "stdout", text: "same-ms" } })), { end: { reason: "completed", exitCode: 0 } }];
  const runtime = createMockRuntime({ scenario: { steps } });
  const host = makeHost({ client, runtime, dir, options: { flushMs: 5000 } });
  await host.tick();
  await waitFor(() => eventAttempts >= 2 && host.outbox().length === 0, 6000, "event retry");
  const first = client.calls.events[0].events;
  const second = client.calls.events[1].events;
  assert.ok(first.length >= 100, `expected >=100 events, got ${first.length}`);
  for (const event of first) {
    assert.match(event.eventId, UUID_RE, `eventId must be UUID v4: ${event.eventId}`);
    assert.ok(Number.isInteger(event.sessionSeq) && event.sessionSeq >= 0);
  }
  assert.deepEqual(
    second.slice(0, first.length).map((event) => event.eventId),
    first.map((event) => event.eventId),
    "a retried batch must reuse the same eventIds",
  );
  assert.deepEqual(
    first.map((event) => event.sessionSeq),
    Array.from({ length: first.length }, (_, index) => index),
    "sessionSeq must be monotonic per session",
  );
  const all = client.calls.events.flatMap((batch) => batch.events);
  assert.equal(new Set(all.map((event) => event.eventId)).size, first.length, "retries must not create new event identities");
  await host.stop();
});

test("P1-6: host.stop aggregates a runtime.stop failure and enters FENCING_REQUIRED", async () => {
  const { dir } = makeDirs();
  const runtime = createMockRuntime({ scenario: "hang" });
  runtime.stop = async () => {
    throw new Error("runtime stop failed");
  };
  const client = fakeClient({ claims: [claimOf()] });
  const host = makeHost({ client, runtime, dir });
  await host.tick();
  await waitFor(() => host.activeSessions().length === 1, 3000, "active session");
  const result = await host.stop();
  assert.equal(result.fencingRequired, true);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /runtime stop failed/);
  assert.equal(host.mode(), "FENCING_REQUIRED");
  assert.equal(host.activeSessions().length, 1, "a failed stop must not release the session/write domain");
  assert.equal(client.calls.claim, 1, "no new claim may happen while fencing is required");
});

test("P1-7: a half-written main state falls back to the newest complete generation; no copyFileSync fallback", () => {
  const { dir, stateFile } = makeDirs();
  const previous = [{ runId: "run-previous", commandId: "CMD-P", ownerId: "h", generation: 1 }];
  writeFileSync(stateFile, JSON.stringify(previous));
  writeFileSync(`${stateFile}.bak`, JSON.stringify(previous));
  writeFileSync(stateFile, '{ "runId": "half'); // interrupted write
  const source = readFileSync(new URL("../src/host.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /copyFileSync\s*\(/, "the non-atomic copy fallback must be gone");
  assert.match(source, /\.next/);
  const newHost = createHost({
    client: fakeClient({ claims: [] }),
    runtime: createMockRuntime({ scenario: "complete" }),
    ownerId: "host-a",
    stateFile,
    outboxFile: path.join(dir, "host.outbox.json"),
    logger: quietLogger(),
  });
  assert.notEqual(newHost.mode(), "RECOVERY_REQUIRED", "a readable .bak generation must be selected");
});

test("P1-9: real (non-mock) execution with workspace.kind=none is rejected as WORKSPACE_REQUIRED", async () => {
  const { dir } = makeDirs();
  const runtime = {
    ...createMockRuntime({ scenario: "complete" }),
    kind: "dsh",
  };
  const starts = [];
  runtime.start = async (input) => {
    starts.push(input);
    return { sessionId: "real-session", startedAt: new Date().toISOString(), capabilities: {} };
  };
  const client = fakeClient({ claims: [claimOf({ spec: specFor({ workspace: { kind: "none" } }) })] });
  const host = makeHost({ client, runtime, dir, options: { allowNoneWorkspace: true } });
  await host.tick();
  await waitFor(() => client.calls.result.length >= 1 && host.outbox().length === 0, 3000, "none rejection");
  assert.equal(starts.length, 0, "a real runtime must never start in the process cwd");
  assert.match(JSON.stringify(client.calls.result[0]), /WORKSPACE_REQUIRED/);
});

test("P2-10: Host and tests import cross-package code by package name only", () => {
  const files = [
    "../src/host.mjs",
    "./host.test.mjs",
    "./reliability.test.mjs",
    "./workspace-binding.test.mjs",
    "./restart-recovery.test.mjs",
    "./fixtures/restart-worker.mjs",
  ];
  for (const relative of files) {
    const file = new URL(relative, import.meta.url);
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:\.\.\/)+(?:\.\.\/)*packages\//, `${relative} must not use a cross-package relative import`);
  }
});

test("P0-1: heartbeat payload uses hostId/agentIds/capacity and two failures stop claims", async () => {
  const { dir } = makeDirs();
  let failing = true;
  const client = fakeClient({
    claims: [claimOf()],
    heartbeat: () => (failing ? Promise.reject(new Error("backend down")) : Promise.resolve({ agents: [{ agentId: "agent-a", available: true, reason: "ok" }] })),
  });
  const host = makeHost({ client, runtime: createMockRuntime({ scenario: "complete" }), dir, options: { hostId: "host-1", agents: [{ agentId: "agent-a", role: "DEV", function: "WORKER" }], capacity: 2, heartbeatMs: 10 } });
  host.start();
  await waitFor(() => host.mode() === "HEARTBEAT_LOST", 3000, "HEARTBEAT_LOST");
  const claimsBefore = client.calls.claim;
  await host.tick();
  assert.equal(client.calls.claim, claimsBefore, "HEARTBEAT_LOST must block new claims");
  assert.deepEqual(client.calls.heartbeat[0], { hostId: "host-1", agentIds: ["agent-a"], capacity: 2 });
  failing = false;
  await host.heartbeat();
  assert.equal(host.heartbeatAvailable(), true);
  await host.tick();
  assert.ok(client.calls.claim > claimsBefore, "a recovered heartbeat may claim again");
  await host.stop();
});

test("P0-1: Agent runtime start receives a scrubbed env without internal credentials", async () => {
  const { dir } = makeDirs();
  process.env.ATK_INTERNAL_TOKEN = "internal-secret";
  process.env.ATK_HOST_STATE_FILE = "host-secret";
  const captured = [];
  const runtime = {
    ...createMockRuntime({ scenario: "complete" }),
    start: async (input) => {
      captured.push(input);
      return createMockRuntime({ scenario: "complete" }).start(input);
    },
  };
  const client = fakeClient({ claims: [claimOf()] });
  const host = makeHost({ client, runtime, dir });
  try {
    await host.tick();
    await waitFor(() => captured.length === 1, 3000, "runtime start");
    assert.ok(captured[0].env, "the adapter must receive an explicit env object");
    assert.equal(captured[0].env.ATK_INTERNAL_TOKEN, undefined);
    assert.equal(captured[0].env.ATK_HOST_STATE_FILE, undefined);
    assert.equal(Object.keys(captured[0].env).some((key) => key.startsWith("ATK_HOST_")), false);
  } finally {
    delete process.env.ATK_INTERNAL_TOKEN;
    delete process.env.ATK_HOST_STATE_FILE;
    await host.stop();
  }
});
test("P0-1: registration failure is RECOVERY_REQUIRED (no heartbeat, no claim)", async () => {
  const { dir } = makeDirs();
  const client = fakeClient({ claims: [claimOf()] });
  client.register = () => Promise.reject(new Error("register unavailable"));
  const host = makeHost({ client, runtime: createMockRuntime({ scenario: "complete" }), dir, options: { agents: [{ agentId: "agent-a", role: "DEV", function: "WORKER" }] } });
  host.start();
  await waitFor(() => host.mode() === "RECOVERY_REQUIRED", 3000, "RECOVERY_REQUIRED");
  const claimsBefore = client.calls.claim;
  await host.tick();
  assert.equal(client.calls.claim, claimsBefore);
  assert.equal(client.calls.heartbeat.length, 0, "no heartbeat may be sent before successful registration");
  await host.stop();
});