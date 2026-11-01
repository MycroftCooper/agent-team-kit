// The DSH placeholder must stay honest: all seven capabilities false, every
// operation rejected with CAPABILITY_UNAVAILABLE. These tests lock the boundary
// that keeps a real-machine adapter from being enabled by accident in M2.
import assert from "node:assert/strict";
import test from "node:test";

import { createDshRuntimeStub, DSH_UNSUPPORTED_DETAIL } from "../src/dsh-unsupported.mjs";
import { createMockRuntime } from "../src/mock.mjs";
import {
  ALL_CAPABILITIES_FALSE,
  CAPABILITY_UNAVAILABLE,
  RUNTIME_CAPABILITY_KEYS,
  isCapabilityUnavailableError,
  unsupportedCapabilities,
  validateAgentRuntime,
  validateCapabilities,
  validateRuntimeHealth,
} from "../src/index.mjs";

const INPUT = { runId: "run-1", taskId: "task-1", prompt: "go", cwd: process.cwd() };

test("stub capabilities are exactly the seven false flags", async () => {
  const stub = createDshRuntimeStub();
  const capabilities = await stub.capabilities();
  assert.deepEqual(capabilities, ALL_CAPABILITIES_FALSE);
  assert.deepEqual(Object.keys(capabilities).sort(), [...RUNTIME_CAPABILITY_KEYS].sort());
  for (const key of RUNTIME_CAPABILITY_KEYS) assert.equal(capabilities[key], false, key);
  assert.ok(Object.isFrozen(capabilities));
  assert.equal(validateCapabilities(capabilities).ok, true);
  assert.deepEqual([...unsupportedCapabilities(capabilities)], [...RUNTIME_CAPABILITY_KEYS]);
});

test("stub probe reports not-ok with the RT-P07/P08 detail", async () => {
  const stub = createDshRuntimeStub();
  const health = await stub.probe();
  assert.equal(health.ok, false);
  assert.equal(health.kind, "dsh");
  assert.equal(health.detail, "experimental: RT-P07/P08 unverified");
  assert.equal(health.detail, DSH_UNSUPPORTED_DETAIL);
  assert.equal(health.version, undefined);
  assert.deepEqual(health.capabilities, ALL_CAPABILITIES_FALSE);
  assert.deepEqual(validateRuntimeHealth(health), { ok: true, errors: [] });
  assert.deepEqual(validateAgentRuntime(stub), { ok: true, errors: [] });
});

test("stub start() rejects with CAPABILITY_UNAVAILABLE", async () => {
  const stub = createDshRuntimeStub();
  await assert.rejects(stub.start(INPUT), (error) => {
    assert.equal(error.code, CAPABILITY_UNAVAILABLE);
    assert.equal(error.capability, "canStart");
    assert.equal(error.adapterKind, "dsh");
    assert.match(error.message, /^CAPABILITY_UNAVAILABLE: start is unavailable: experimental: RT-P07\/P08 unverified/);
    assert.equal(isCapabilityUnavailableError(error), true);
    return true;
  });
});

test("every stub operation is honest about being unavailable", async () => {
  const stub = createDshRuntimeStub();
  const cases = [
    ["send", () => stub.send("s1", "prompt")],
    ["stop", () => stub.stop("s1")],
    ["reconnect", () => stub.reconnect("s1")],
    ["subscribe", () => stub.subscribe("s1", () => {})],
  ];
  for (const [name, call] of cases) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.code, CAPABILITY_UNAVAILABLE, name);
      assert.equal(isCapabilityUnavailableError(error), true, name);
      return true;
    });
  }
});

test("the stub stays false even though the mock defaults to all true", async () => {
  const stubCapabilities = await createDshRuntimeStub().capabilities();
  const mockCapabilities = await createMockRuntime().capabilities();
  assert.notEqual(stubCapabilities, mockCapabilities);
  assert.deepEqual(stubCapabilities, ALL_CAPABILITIES_FALSE);
  for (const key of RUNTIME_CAPABILITY_KEYS) {
    assert.equal(stubCapabilities[key], false, `stub.${key}`);
    assert.equal(mockCapabilities[key], true, `mock.${key}`);
  }
});

test("stub kind/detail are configurable and validated", async () => {
  const stub = createDshRuntimeStub({ kind: "dsh-experimental", detail: "experimental: RT-P06 partial" });
  assert.equal(stub.kind, "dsh-experimental");
  const health = await stub.probe();
  assert.equal(health.kind, "dsh-experimental");
  assert.equal(health.detail, "experimental: RT-P06 partial");
  assert.throws(() => createDshRuntimeStub({ kind: "" }), /kind must be a non-empty string/);
  assert.throws(() => createDshRuntimeStub({ detail: " " }), /detail must be a non-empty string/);
});
