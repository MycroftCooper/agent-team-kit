// Contract-level tests for @atk/runtime-sdk: validators and constants.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_CAPABILITIES_FALSE,
  CAPABILITY_UNAVAILABLE,
  CapabilityUnavailableError,
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_END_REASONS,
  RUNTIME_EVENT_TYPES,
  assertCapabilities,
  isCapabilityUnavailableError,
  unsupportedCapabilities,
  validateAgentRuntime,
  validateCapabilities,
  validateRuntimeEvent,
  validateRuntimeHealth,
  validateRuntimeSessionHandle,
  validateStartRunInput,
} from "../src/index.mjs";

const ALL_TRUE = Object.freeze(Object.fromEntries(RUNTIME_CAPABILITY_KEYS.map((key) => [key, true])));

test("contract version and capability keys are the frozen spec §9.1 set", () => {
  assert.equal(RUNTIME_CONTRACT_VERSION, "1");
  assert.deepEqual([...RUNTIME_CAPABILITY_KEYS], [
    "canStart",
    "canSend",
    "canObserveStructuredEvents",
    "canStop",
    "canReconnect",
    "canSpecifySessionModel",
    "canRunRestricted",
  ]);
  assert.ok(Object.isFrozen(RUNTIME_CAPABILITY_KEYS));
  assert.deepEqual([...RUNTIME_EVENT_TYPES], ["session.started", "output", "state", "session.ended", "log"]);
  assert.deepEqual([...RUNTIME_END_REASONS], ["completed", "failed", "cancelled", "interrupted"]);
});

test("ALL_CAPABILITIES_FALSE is frozen and every capability is false", () => {
  assert.ok(Object.isFrozen(ALL_CAPABILITIES_FALSE));
  for (const key of RUNTIME_CAPABILITY_KEYS) assert.equal(ALL_CAPABILITIES_FALSE[key], false, key);
  assert.equal(validateCapabilities(ALL_CAPABILITIES_FALSE).ok, true);
});

test("validateCapabilities accepts a complete boolean snapshot", () => {
  const result = validateCapabilities({ ...ALL_TRUE });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateCapabilities rejects missing, non-boolean and unknown keys", () => {
  const missing = validateCapabilities({ ...ALL_TRUE, canStop: undefined });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /canStop must be a boolean/);

  const notBoolean = validateCapabilities({ ...ALL_TRUE, canStart: "true" });
  assert.equal(notBoolean.ok, false);
  assert.match(notBoolean.errors.join("\n"), /canStart must be a boolean/);

  const unknown = validateCapabilities({ ...ALL_TRUE, canFly: true });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join("\n"), /canFly is not part of the contract/);

  assert.equal(validateCapabilities(null).ok, false);
  assert.equal(validateCapabilities([]).ok, false);
});

test("validateStartRunInput accepts minimal and full inputs", () => {
  assert.deepEqual(validateStartRunInput({ runId: "run-1", taskId: "task-1", prompt: "go", cwd: "/work" }), {
    ok: true,
    errors: [],
  });
  const full = validateStartRunInput({
    runId: "run-1",
    taskId: "task-1",
    prompt: "go",
    cwd: "/work",
    model: "mock/model",
    env: { ATK_INTERNAL_TOKEN: "secret" },
    timeoutMs: 1000,
  });
  assert.deepEqual(full, { ok: true, errors: [] });
});

test("validateStartRunInput rejects missing fields, bad env/timeout and unknown keys", () => {
  const missing = validateStartRunInput({ runId: "run-1" });
  assert.equal(missing.ok, false);
  const text = missing.errors.join("\n");
  assert.match(text, /taskId must be an id string/);
  assert.match(text, /prompt must be a non-empty string/);
  assert.match(text, /cwd must be a non-empty string/);

  assert.match(validateStartRunInput({ runId: "run-1", taskId: "task-1", prompt: "   ", cwd: "/work" }).errors.join("\n"), /prompt must be a non-empty string/);
  assert.match(
    validateStartRunInput({ runId: "run-1", taskId: "task-1", prompt: "go", cwd: "/work", env: { A: 1 } }).errors.join("\n"),
    /env\.A must be a string/,
  );
  assert.match(
    validateStartRunInput({ runId: "run-1", taskId: "task-1", prompt: "go", cwd: "/work", timeoutMs: 0 }).errors.join("\n"),
    /timeoutMs must be a positive integer/,
  );
  assert.match(
    validateStartRunInput({ runId: "run-1", taskId: "task-1", prompt: "go", cwd: "/work", agent: "x" }).errors.join("\n"),
    /startInput\.agent is not part of the contract/,
  );
  assert.equal(validateStartRunInput(undefined).ok, false);
});

const HANDLE = {
  sessionId: "session-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  capabilities: { ...ALL_TRUE },
};

test("validateRuntimeSessionHandle accepts a valid handle", () => {
  assert.deepEqual(validateRuntimeSessionHandle(HANDLE), { ok: true, errors: [] });
  assert.deepEqual(validateRuntimeSessionHandle({ ...HANDLE, nativeSessionId: "native-1" }), { ok: true, errors: [] });
});

test("validateRuntimeSessionHandle rejects bad timestamps/capabilities/fields", () => {
  assert.equal(validateRuntimeSessionHandle({ ...HANDLE, startedAt: "not-a-date" }).ok, false);
  assert.equal(validateRuntimeSessionHandle({ ...HANDLE, capabilities: {} }).ok, false);
  assert.match(validateRuntimeSessionHandle({ ...HANDLE, extra: 1 }).errors.join("\n"), /sessionHandle\.extra/);
});

test("validateRuntimeHealth accepts ok and not-ok health reports", () => {
  assert.deepEqual(validateRuntimeHealth({ ok: true, kind: "mock", version: "1", detail: "ready", capabilities: ALL_TRUE }), {
    ok: true,
    errors: [],
  });
  assert.deepEqual(validateRuntimeHealth({ ok: false, kind: "dsh", detail: "unverified", capabilities: ALL_CAPABILITIES_FALSE }), {
    ok: true,
    errors: [],
  });
  assert.match(validateRuntimeHealth({ ok: "yes", kind: "mock", capabilities: ALL_TRUE }).errors.join("\n"), /health\.ok must be a boolean/);
  assert.match(validateRuntimeHealth({ ok: true, kind: "mock" }).errors.join("\n"), /capabilities must be an object/);
});

const AT = "2026-01-01T00:00:00.000Z";
const SESSION = "session-1";

test("validateRuntimeEvent accepts every variant of the union", () => {
  const events = [
    { type: "session.started", sessionId: SESSION, at: AT },
    { type: "output", sessionId: SESSION, stream: "stdout", text: "hi", at: AT },
    { type: "state", sessionId: SESSION, state: "running", at: AT },
    { type: "session.ended", sessionId: SESSION, at: AT, reason: "completed", exitCode: 0 },
    { type: "log", sessionId: SESSION, level: "info", message: "hello", at: AT },
  ];
  for (const event of events) assert.deepEqual(validateRuntimeEvent(event), { ok: true, errors: [] }, event.type);
});

test("validateRuntimeEvent rejects unknown and missing discriminator data", () => {
  const unknown = validateRuntimeEvent({ type: "session.paused", sessionId: SESSION, at: AT });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join("\n"), /not a RuntimeEvent type/);

  const missing = validateRuntimeEvent({ type: "output", sessionId: "", at: "nope" });
  const text = missing.errors.join("\n");
  assert.match(text, /sessionId must be a non-empty string/);
  assert.match(text, /event\.at must be an ISO-8601 timestamp/);
  assert.match(text, /event\.stream must be one of/);
  assert.match(text, /event\.text must be a string/);
});

test("validateRuntimeEvent rejects bad variant fields and invented fields", () => {
  assert.match(validateRuntimeEvent({ type: "state", sessionId: SESSION, at: AT, state: "sleeping" }).errors.join("\n"), /event\.state must be one of/);
  assert.match(
    validateRuntimeEvent({ type: "session.ended", sessionId: SESSION, at: AT, reason: "done", exitCode: 0 }).errors.join("\n"),
    /event\.reason must be one of/,
  );
  assert.match(
    validateRuntimeEvent({ type: "session.ended", sessionId: SESSION, at: AT, reason: "completed", exitCode: "0" }).errors.join("\n"),
    /event\.exitCode must be an integer or null/,
  );
  assert.match(validateRuntimeEvent({ type: "log", sessionId: SESSION, at: AT, level: "fatal", message: "x" }).errors.join("\n"), /event\.level must be one of/);
  assert.match(validateRuntimeEvent({ type: "log", sessionId: SESSION, at: AT, level: "info", message: "  " }).errors.join("\n"), /event\.message must be a non-empty string/);
  assert.match(validateRuntimeEvent({ type: "session.started", sessionId: SESSION, at: AT, extra: true }).errors.join("\n"), /event\.extra is not part of the contract/);
  assert.equal(validateRuntimeEvent("session.started").ok, false);
});

test("unsupportedCapabilities only treats a literal true as supported", () => {
  assert.deepEqual([...unsupportedCapabilities(ALL_TRUE)], []);
  assert.deepEqual([...unsupportedCapabilities({ ...ALL_TRUE, canStop: false })], ["canStop"]);
  assert.deepEqual([...unsupportedCapabilities({ ...ALL_TRUE, canStart: "true" })], ["canStart"]);
  assert.deepEqual([...unsupportedCapabilities(undefined)], [...RUNTIME_CAPABILITY_KEYS]);
  assert.ok(Object.isFrozen(unsupportedCapabilities({})));
});

test("assertCapabilities throws CAPABILITY_UNAVAILABLE with the missing key", () => {
  assert.doesNotThrow(() => assertCapabilities(ALL_TRUE, ["canStart", "canSend"]));
  assert.throws(
    () => assertCapabilities({ ...ALL_TRUE, canStop: false }, ["canStop"]),
    (error) => error.code === CAPABILITY_UNAVAILABLE && /canStop/.test(error.message) && error.capability === "canStop",
  );
});

test("CapabilityUnavailableError is code-tagged and detectable", () => {
  const error = new CapabilityUnavailableError("start is not supported", { capability: "canStart", adapterKind: "dsh" });
  assert.equal(error.code, CAPABILITY_UNAVAILABLE);
  assert.equal(error.name, "CapabilityUnavailableError");
  assert.match(error.message, /^CAPABILITY_UNAVAILABLE: start is not supported/);
  assert.equal(error.capability, "canStart");
  assert.equal(error.adapterKind, "dsh");
  assert.equal(isCapabilityUnavailableError(error), true);
  assert.equal(isCapabilityUnavailableError(new Error("other")), false);
  assert.equal(isCapabilityUnavailableError(undefined), false);
});

test("validateAgentRuntime accepts a complete object and rejects missing methods", () => {
  const complete = {
    kind: "mock",
    probe: async () => {},
    capabilities: async () => {},
    start: async () => {},
    send: async () => {},
    stop: async () => {},
    reconnect: async () => {},
    subscribe: async () => {},
  };
  assert.deepEqual(validateAgentRuntime(complete), { ok: true, errors: [] });
  const broken = { ...complete, stop: undefined };
  const result = validateAgentRuntime(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /runtime\.stop must be a function/);
  assert.equal(validateAgentRuntime(null).ok, false);
});
