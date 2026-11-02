// M6.2 F10 unit tests for the pure availability rule. It mirrors the database
// store's `agentAvailability({now, ttlMs})` exactly: freshness first, then
// capacity, with machine-readable reasons.
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_AVAILABILITY_REASONS,
  DEFAULT_HEARTBEAT_TTL_MS,
  agentAvailability,
} from "../src/index.mjs";

const NOW = "2026-01-01T00:10:00.000Z";
const NOW_MS = Date.parse(NOW);
const at = (offsetMs) => new Date(NOW_MS + offsetMs).toISOString();

test("the default heartbeat TTL is a fixed 30s constant", () => {
  assert.equal(DEFAULT_HEARTBEAT_TTL_MS, 30_000);
  assert.deepEqual(Object.values(AGENT_AVAILABILITY_REASONS).sort(), [
    "no-capacity",
    "no-heartbeat",
    "ok",
    "stale-heartbeat",
  ]);
});

test("agentAvailability: missing heartbeat is never available", () => {
  for (const heartbeat of [undefined, null, ""]) {
    assert.deepEqual(agentAvailability({ id: "A-1", lastHeartbeatAt: heartbeat, capacity: 1 }, { now: NOW }), {
      available: false,
      reason: "no-heartbeat",
    });
  }
  assert.deepEqual(agentAvailability(null, { now: NOW }), { available: false, reason: "no-heartbeat" });
});

test("agentAvailability: stale heartbeat is refused, the inclusive boundary is fresh", () => {
  const base = { id: "A-1", capacity: 1 };
  assert.deepEqual(agentAvailability({ ...base, lastHeartbeatAt: at(-DEFAULT_HEARTBEAT_TTL_MS - 1) }, { now: NOW }), {
    available: false,
    reason: "stale-heartbeat",
  });
  assert.deepEqual(agentAvailability({ ...base, lastHeartbeatAt: at(-DEFAULT_HEARTBEAT_TTL_MS) }, { now: NOW }), {
    available: true,
    reason: "ok",
  });
  // An unparsable heartbeat is stale, never "available" (same as the database).
  assert.deepEqual(agentAvailability({ ...base, lastHeartbeatAt: "not-a-date" }, { now: NOW }), {
    available: false,
    reason: "stale-heartbeat",
  });
});

test("agentAvailability: fresh heartbeat still needs positive capacity", () => {
  assert.deepEqual(agentAvailability({ id: "A-1", lastHeartbeatAt: NOW, capacity: 0 }, { now: NOW }), {
    available: false,
    reason: "no-capacity",
  });
  assert.deepEqual(agentAvailability({ id: "A-1", lastHeartbeatAt: NOW }, { now: NOW }), {
    available: false,
    reason: "no-capacity",
  });
  assert.deepEqual(agentAvailability({ id: "A-1", lastHeartbeatAt: NOW, capacity: 3 }, { now: NOW }), {
    available: true,
    reason: "ok",
  });
});

test("agentAvailability requires a valid clock and a positive TTL", () => {
  assert.throws(() => agentAvailability({ id: "A-1", lastHeartbeatAt: NOW, capacity: 1 }, {}), /now must be a valid/);
  for (const ttlMs of [0, -1, 1.5, "50"]) {
    assert.throws(
      () => agentAvailability({ id: "A-1", lastHeartbeatAt: NOW, capacity: 1 }, { now: NOW, ttlMs }),
      /ttlMs/,
      `ttlMs ${JSON.stringify(ttlMs)}`,
    );
  }
});
