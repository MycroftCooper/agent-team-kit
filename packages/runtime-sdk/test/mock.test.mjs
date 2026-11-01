// Behavioural tests for the deterministic MockRuntime.
import assert from "node:assert/strict";
import test from "node:test";

import { createMockRuntime } from "../src/mock.mjs";
import {
  CAPABILITY_UNAVAILABLE,
  RUNTIME_CAPABILITY_KEYS,
  validateAgentRuntime,
  validateCapabilities,
  validateRuntimeHealth,
  validateRuntimeSessionHandle,
} from "../src/index.mjs";
import { VALID_INPUT, collectEvents, sleep, stripTiming, waitEnded, waitFor } from "./helpers.mjs";

const SESSION = "mock-session-1";

async function runToEnd(runtime, input = VALID_INPUT) {
  const handle = await runtime.start(input);
  const { events, unsubscribe } = await collectEvents(runtime, handle.sessionId);
  await waitEnded(events);
  unsubscribe();
  return { handle, events };
}

test("defaults: kind mock, default capabilities all true, probe healthy, contract-complete", async () => {
  const runtime = createMockRuntime();
  assert.equal(runtime.kind, "mock");
  assert.deepEqual(validateAgentRuntime(runtime), { ok: true, errors: [] });
  const capabilities = await runtime.capabilities();
  for (const key of RUNTIME_CAPABILITY_KEYS) assert.equal(capabilities[key], true, key);
  assert.deepEqual(validateCapabilities(capabilities), { ok: true, errors: [] });

  const health = await runtime.probe();
  assert.equal(health.ok, true);
  assert.equal(health.kind, "mock");
  assert.equal(health.version, "0.1.0-mock");
  assert.deepEqual(validateRuntimeHealth(health), { ok: true, errors: [] });
});

test("probe reports configured failure details", async () => {
  const runtime = createMockRuntime({ probeOk: false, probeDetail: "injected probe failure" });
  const health = await runtime.probe();
  assert.equal(health.ok, false);
  assert.equal(health.detail, "injected probe failure");
  assert.equal(validateRuntimeHealth(health).ok, true);
});

test("start returns a validated, stable handle", async () => {
  const runtime = createMockRuntime({ scenario: "hang" });
  const handle = await runtime.start(VALID_INPUT);
  assert.equal(handle.sessionId, SESSION);
  assert.equal(Number.isNaN(Date.parse(handle.startedAt)), false);
  assert.deepEqual(validateRuntimeSessionHandle(handle), { ok: true, errors: [] });
  assert.ok(Object.isFrozen(handle));
  runtime._dispose();
});

test("start rejects invalid StartRunInput with a readable error", async () => {
  const runtime = createMockRuntime();
  await assert.rejects(runtime.start({ runId: "run-1" }), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.message, /invalid StartRunInput/);
    assert.match(error.message, /prompt must be a non-empty string/);
    assert.ok(Array.isArray(error.errors));
    return true;
  });
});

test("start rejects with CAPABILITY_UNAVAILABLE when canStart is false", async () => {
  const runtime = createMockRuntime({ capabilities: { canStart: false } });
  await assert.rejects(runtime.start(VALID_INPUT), (error) => {
    assert.equal(error.code, CAPABILITY_UNAVAILABLE);
    assert.equal(error.capability, "canStart");
    return true;
  });
});

test("sessionIdFactory makes session ids deterministic and duplicates fail", async () => {
  const factory = (input, sequence) => `session-${input.runId}-${sequence}`;
  const first = await createMockRuntime({ scenario: "hang", sessionIdFactory: factory }).start(VALID_INPUT);
  const second = await createMockRuntime({ scenario: "hang", sessionIdFactory: factory }).start(VALID_INPUT);
  assert.equal(first.sessionId, "session-run-1-1");
  assert.equal(second.sessionId, "session-run-1-1");

  const duplicateRuntime = createMockRuntime({ scenario: "hang", sessionIdFactory: () => "always-the-same" });
  await duplicateRuntime.start(VALID_INPUT);
  await assert.rejects(duplicateRuntime.start(VALID_INPUT), /duplicate sessionId/);
  duplicateRuntime._dispose();
});

test("complete preset emits started → output → idle → ended(completed, 0)", async () => {
  const runtime = createMockRuntime({ scenario: "complete" });
  const { handle, events } = await runToEnd(runtime);
  assert.deepEqual(stripTiming(events), [
    { type: "session.started", sessionId: handle.sessionId },
    { type: "output", sessionId: handle.sessionId, stream: "stdout", text: "mock:complete" },
    { type: "state", sessionId: handle.sessionId, state: "idle" },
    { type: "session.ended", sessionId: handle.sessionId, reason: "completed", exitCode: 0 },
  ]);
  assert.equal(runtime._pendingTimers, 0);
  runtime._dispose();
});

test("fail preset ends failed with a stderr output and an error log", async () => {
  const runtime = createMockRuntime({ scenario: "fail" });
  const { handle, events } = await runToEnd(runtime);
  const stripped = stripTiming(events);
  assert.deepEqual(stripped[0], { type: "session.started", sessionId: handle.sessionId });
  assert.deepEqual(stripped[1], { type: "output", sessionId: handle.sessionId, stream: "stderr", text: "mock:fail" });
  assert.deepEqual(stripped[2], { type: "log", sessionId: handle.sessionId, level: "error", message: "mock: injected failure" });
  assert.deepEqual(stripped[3], { type: "session.ended", sessionId: handle.sessionId, reason: "failed", exitCode: 1 });
  runtime._dispose();
});

test("crash preset ends interrupted with exitCode null", async () => {
  const runtime = createMockRuntime({ scenario: "crash" });
  const { handle, events } = await runToEnd(runtime);
  const stripped = stripTiming(events);
  assert.equal(stripped.at(-1).reason, "interrupted");
  assert.equal(stripped.at(-1).exitCode, null);
  assert.equal(stripped.length, 3);
  assert.equal(stripped[1].text, "mock:crash");
  runtime._dispose();
});

test("hang preset never ends on its own and stop() produces ended(cancelled)", async () => {
  const runtime = createMockRuntime({ scenario: "hang" });
  const handle = await runtime.start(VALID_INPUT);
  const { events } = await collectEvents(runtime, handle.sessionId);
  await waitFor(() => events.find((event) => event.type === "state"), { label: "running state" });
  await sleep(40);
  assert.equal(events.some((event) => event.type === "session.ended"), false);
  await runtime.stop(handle.sessionId);
  const ended = await waitEnded(events);
  assert.equal(ended.reason, "cancelled");
  assert.equal(ended.exitCode, null);
  assert.equal(runtime._pendingTimers, 0);
  runtime._dispose();
});

test("custom scenario DSL preserves step order", async () => {
  const scenario = {
    steps: [
      { emit: { type: "log", level: "info", message: "first" } },
      { delayMs: 1, emit: { type: "output", stream: "stdout", text: "second" } },
      { emit: { type: "state", state: "waiting_input" } },
      { end: { reason: "failed", exitCode: 2 } },
    ],
  };
  const runtime = createMockRuntime({ scenario });
  const { handle, events } = await runToEnd(runtime);
  assert.deepEqual(
    stripTiming(events).map((event) => event.type),
    ["session.started", "log", "output", "state", "session.ended"],
  );
  assert.equal(stripTiming(events).at(-1).exitCode, 2);
  runtime._dispose();
});

test("custom scenario validates its steps at construction time", () => {
  assert.throws(() => createMockRuntime({ scenario: { steps: [] } }), /non-empty array/);
  assert.throws(() => createMockRuntime({ scenario: { steps: [{ emit: { type: "nope" } }] } }), /not a RuntimeEvent/);
  assert.throws(() => createMockRuntime({ scenario: { steps: [{ end: { reason: "done", exitCode: 0 } }] } }), /end is invalid/);
  assert.throws(() => createMockRuntime({ scenario: { steps: [{ delayMs: -1 }] } }), /delayMs/);
  assert.throws(() => createMockRuntime({ scenario: "unknown-preset" }), /unknown scenario preset/);
});

test("neverEnds suppresses automatic ends but keeps observable output", async () => {
  const runtime = createMockRuntime({ scenario: "complete", neverEnds: true });
  const handle = await runtime.start(VALID_INPUT);
  const { events } = await collectEvents(runtime, handle.sessionId);
  await waitFor(() => events.find((event) => event.type === "state"), { label: "idle state" });
  await sleep(40);
  assert.equal(events.some((event) => event.type === "session.ended"), false);
  // stop() is still allowed and is the only way this run can end.
  await runtime.stop(handle.sessionId);
  const ended = await waitEnded(events);
  assert.equal(ended.reason, "cancelled");
  runtime._dispose();
});

test("ignoreStop makes stop() a no-op", async () => {
  const runtime = createMockRuntime({ scenario: "hang", ignoreStop: true });
  const handle = await runtime.start(VALID_INPUT);
  const { events } = await collectEvents(runtime, handle.sessionId);
  await waitFor(() => events.find((event) => event.type === "state"), { label: "running state" });
  await runtime.stop(handle.sessionId);
  await sleep(30);
  assert.equal(events.some((event) => event.type === "session.ended"), false);
  runtime._dispose();
});

test("crashAfterMs preempts a later normal end", async () => {
  const runtime = createMockRuntime({
    scenario: { steps: [{ delayMs: 60, emit: { type: "output", stream: "stdout", text: "too-late" } }, { end: { reason: "completed", exitCode: 0 } }] },
    crashAfterMs: 5,
  });
  const { handle, events } = await runToEnd(runtime);
  const stripped = stripTiming(events);
  assert.equal(stripped.length, 2);
  assert.equal(stripped[1].type, "session.ended");
  assert.equal(stripped[1].reason, "interrupted");
  assert.equal(stripped[1].exitCode, null);
  await sleep(80);
  assert.equal(events.some((event) => event.text === "too-late"), false);
  assert.equal(runtime._pendingTimers, 0);
  assert.equal(handle.sessionId, SESSION);
  runtime._dispose();
});

test("slowStartMs delays start but still yields a valid handle", async () => {
  const runtime = createMockRuntime({ scenario: "hang", slowStartMs: 20 });
  const startedAt = Date.now();
  const handle = await runtime.start(VALID_INPUT);
  assert.ok(Date.now() - startedAt >= 10, "start() should wait for slowStartMs");
  assert.equal(validateRuntimeSessionHandle(handle).ok, true);
  runtime._dispose();
});

test("startFails rejects with a readable error (boolean, string and Error forms)", async () => {
  await assert.rejects(createMockRuntime({ startFails: true }).start(VALID_INPUT), (error) => {
    assert.equal(error.code, "MOCK_START_FAILED");
    assert.match(error.message, /start failed: injected start failure/);
    return true;
  });
  await assert.rejects(createMockRuntime({ startFails: "boom" }).start(VALID_INPUT), /start failed: boom/);
  const original = new Error("driver exploded");
  await assert.rejects(createMockRuntime({ startFails: original }).start(VALID_INPUT), (error) => error === original);
});

test("send() emits a second turn of events on the same session", async () => {
  const runtime = createMockRuntime({ scenario: "hang" });
  const handle = await runtime.start(VALID_INPUT);
  const { events } = await collectEvents(runtime, handle.sessionId);
  await waitFor(() => events.find((event) => event.type === "state"), { label: "running state" });

  await runtime.send(handle.sessionId, "second prompt");
  const firstPair = stripTiming(events).slice(2);
  assert.deepEqual(firstPair, [
    { type: "output", sessionId: handle.sessionId, stream: "stdout", text: "second prompt" },
    { type: "state", sessionId: handle.sessionId, state: "idle" },
  ]);

  await runtime.send(handle.sessionId, "third prompt");
  const secondPair = stripTiming(events).slice(4);
  assert.deepEqual(secondPair, [
    { type: "output", sessionId: handle.sessionId, stream: "stdout", text: "third prompt" },
    { type: "state", sessionId: handle.sessionId, state: "idle" },
  ]);
  runtime._dispose();
});

test("send() rejects after the session ended and when unsupported", async () => {
  const runtime = createMockRuntime({ scenario: "complete" });
  const { handle } = await runToEnd(runtime);
  await assert.rejects(runtime.send(handle.sessionId, "late"), (error) => error.code === "MOCK_SESSION_ENDED");
  runtime._dispose();

  const noSend = createMockRuntime({ scenario: "hang", capabilities: { canSend: false } });
  const handle2 = await noSend.start(VALID_INPUT);
  await assert.rejects(noSend.send(handle2.sessionId, "x"), (error) => error.code === CAPABILITY_UNAVAILABLE && error.capability === "canSend");
  noSend._dispose();
});

test("unsubscribe stops delivery without leaving timers behind", async () => {
  const runtime = createMockRuntime({ scenario: "hang" });
  const handle = await runtime.start(VALID_INPUT);
  const { events, unsubscribe } = await collectEvents(runtime, handle.sessionId);
  await waitFor(() => events.find((event) => event.type === "state"), { label: "running state" });
  unsubscribe();
  const countAtUnsubscribe = events.length;
  await runtime.stop(handle.sessionId);
  await sleep(20);
  assert.equal(events.length, countAtUnsubscribe);
  assert.equal(runtime._pendingTimers, 0);
  runtime._dispose();
});

test("stop() clears pending timers and delivers nothing afterwards", async () => {
  const runtime = createMockRuntime({ scenario: { steps: [{ delayMs: 30, emit: { type: "output", stream: "stdout", text: "late" } }] } });
  const handle = await runtime.start(VALID_INPUT);
  const { events } = await collectEvents(runtime, handle.sessionId);
  await sleep(3);
  await runtime.stop(handle.sessionId);
  assert.equal(runtime._pendingTimers, 0);
  await sleep(50);
  assert.equal(events.some((event) => event.type === "output"), false);
  assert.equal(events.at(-1).reason, "cancelled");
  runtime._dispose();
});

test("unknown sessions and unsupported operations fail with readable codes", async () => {
  const runtime = createMockRuntime({ scenario: "hang" });
  const handle = await runtime.start(VALID_INPUT);
  await assert.rejects(runtime.stop("missing"), (error) => error.code === "MOCK_UNKNOWN_SESSION");
  await assert.rejects(runtime.send("missing", "x"), (error) => error.code === "MOCK_UNKNOWN_SESSION");
  await assert.rejects(runtime.subscribe("missing", () => {}), (error) => error.code === "MOCK_UNKNOWN_SESSION");
  assert.equal(await runtime.reconnect("missing"), null);
  assert.equal(await runtime.reconnect(handle.sessionId), handle);

  const noReconnect = createMockRuntime({ scenario: "hang", capabilities: { canReconnect: false } });
  await assert.rejects(noReconnect.reconnect("x"), (error) => error.code === CAPABILITY_UNAVAILABLE && error.capability === "canReconnect");
  noReconnect._dispose();
  runtime._dispose();
});

test("capability overrides are applied on top of the all-true default", async () => {
  const runtime = createMockRuntime({ capabilities: { canSpecifySessionModel: false, canRunRestricted: false } });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.canSpecifySessionModel, false);
  assert.equal(capabilities.canRunRestricted, false);
  for (const key of RUNTIME_CAPABILITY_KEYS.filter((name) => !["canSpecifySessionModel", "canRunRestricted"].includes(name))) {
    assert.equal(capabilities[key], true, key);
  }
  runtime._dispose();
});

test("_dispose() clears every timer and session", async () => {
  const runtime = createMockRuntime({ scenario: "hang", ignoreStop: true });
  const handle = await runtime.start(VALID_INPUT);
  const { events } = await collectEvents(runtime, handle.sessionId);
  await waitFor(() => events.find((event) => event.type === "state"), { label: "running state" });
  const count = events.length;
  runtime._dispose();
  assert.equal(runtime._pendingTimers, 0);
  assert.equal(runtime._sessionCount, 0);
  await sleep(20);
  assert.equal(events.length, count);
});

test("diagnostics use underscore members and stay outside the AgentRuntime contract", async () => {
  const runtime = createMockRuntime({ scenario: "hang" });
  // Diagnostic surface: underscore-prefixed, explicitly not interface methods.
  assert.equal(typeof runtime._pendingTimers, "number");
  assert.equal(typeof runtime._sessionCount, "number");
  assert.equal(typeof runtime._dispose, "function");
  // The un-prefixed names must not exist, so nobody confuses them with the contract.
  for (const stale of ["pendingTimers", "sessionCount", "dispose"]) {
    assert.equal(stale in runtime, false, `${stale} must not be a public member`);
  }
  // validateAgentRuntime judges only kind + the seven AgentRuntime methods; the
  // `_`-prefixed diagnostics must be ignored rather than rejected.
  assert.deepEqual(validateAgentRuntime(runtime), { ok: true, errors: [] });
  runtime._dispose();
});

test("same scenario twice produces the identical event sequence", async () => {
  const first = await runToEnd(createMockRuntime({ scenario: "complete" }));
  const second = await runToEnd(createMockRuntime({ scenario: "complete" }));
  assert.deepEqual(stripTiming(first.events), stripTiming(second.events));
  assert.deepEqual(first.events.map((event) => event.sessionId), ["mock-session-1", "mock-session-1", "mock-session-1", "mock-session-1"]);
});

test("invalid options fail loudly", () => {
  assert.throws(() => createMockRuntime({ kind: "" }), /kind must be a non-empty string/);
  assert.throws(() => createMockRuntime({ capabilities: { canFly: true } }), /invalid capabilities/);
  assert.throws(() => createMockRuntime({ slowStartMs: -1 }), /slowStartMs/);
  assert.throws(() => createMockRuntime({ crashAfterMs: -5 }), /crashAfterMs/);
  assert.throws(() => createMockRuntime({ sessionIdFactory: "nope" }), /sessionIdFactory must be a function/);
  assert.throws(() => createMockRuntime({ probeOk: "yes" }), /probeOk must be a boolean/);
});

test("_dispose during slowStart rejects the pending start and clears timers", async () => {
  const runtime = createMockRuntime({ scenario: "hang", slowStartMs: 5000 });
  const starting = runtime.start(VALID_INPUT);
  await sleep(5);
  runtime._dispose();
  await assert.rejects(starting, /disposed during start/);
  assert.equal(runtime._pendingTimers, 0);
});
