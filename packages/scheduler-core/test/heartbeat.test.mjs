// M6.2 F10: an IDLE agent is not automatically dispatchable. A fresh heartbeat
// (within an injected TTL) and positive capacity are required, and a refused
// agent is reported with a machine-readable reason instead of silently skipped.
// The core assertion: IDLE + no heartbeat → no dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import { SKIP_REASONS, matchAgents, planDispatch } from "../src/index.mjs";
import { NOW, NOW_MS, agent, snapshot, task } from "./helpers.mjs";

const TTL = 50;
const at = (offsetMs) => new Date(NOW_MS + offsetMs).toISOString();

function plan(tasks, agents, policies = { heartbeatTtlMs: TTL }) {
  return planDispatch({ snapshot: snapshot({ tasks, agents }), policies, now: NOW });
}

test("IDLE without a heartbeat is not dispatched, and the reason is visible", () => {
  const result = plan([task("T-1")], [agent("A-1", { lastHeartbeatAt: undefined })]);
  assert.deepEqual(result.proposals, [], "an IDLE agent without a heartbeat must not be proposed");
  assert.deepEqual(result.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.NO_IDLE_AGENT }]);
  assert.deepEqual(result.unavailableAgents, [{ agentId: "A-1", reason: "no-heartbeat" }]);
  assert.equal(result.heartbeatTtlMs, TTL);
});

test("a stale heartbeat skips the agent; a fresh heartbeat allows the dispatch", () => {
  const stale = plan([task("T-1")], [agent("A-1", { lastHeartbeatAt: at(-TTL - 1) })]);
  assert.deepEqual(stale.proposals, []);
  assert.deepEqual(stale.unavailableAgents, [{ agentId: "A-1", reason: "stale-heartbeat" }]);
  assert.deepEqual(stale.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.NO_IDLE_AGENT }]);

  // The boundary is inclusive, exactly like the database rule (+ttl >= now).
  const boundary = plan([task("T-1")], [agent("A-1", { lastHeartbeatAt: at(-TTL) })]);
  assert.deepEqual(boundary.proposals.map((proposal) => proposal.taskId), ["T-1"]);

  // Heartbeat recovery: the very next round dispatches.
  const recovered = plan([task("T-1")], [agent("A-1", { lastHeartbeatAt: at(-TTL + 1) })]);
  assert.deepEqual(recovered.proposals.map((proposal) => proposal.agentId), ["A-1"]);
  assert.equal(recovered.unavailableAgents, undefined, "nothing unavailable means no diagnostic field");
});

test("an agent with no capacity is refused even with a fresh heartbeat", () => {
  const result = plan([task("T-1")], [agent("A-1", { lastHeartbeatAt: NOW, capacity: 0 })]);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.unavailableAgents, [{ agentId: "A-1", reason: "no-capacity" }]);
  assert.deepEqual(result.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.NO_IDLE_AGENT }]);
});

test("planDispatch prefers the available agent and reports the refused one", () => {
  const result = plan(
    [task("T-1")],
    [agent("A-1", { lastHeartbeatAt: undefined }), agent("A-2")],
  );
  assert.deepEqual(result.proposals.map((proposal) => proposal.agentId), ["A-2"]);
  assert.deepEqual(result.unavailableAgents, [{ agentId: "A-1", reason: "no-heartbeat" }]);
});

test("matchAgents requires the injected clock and reports heartbeat exclusions", () => {
  // No hidden Date.now(): without an injected clock the availability rule cannot
  // be evaluated, so callers must supply it (same rule as planDispatch).
  assert.throws(() => matchAgents({ task: task("T-1"), agents: [agent("A-1")] }), /now must be a valid/);

  const result = matchAgents({
    task: task("T-1"),
    agents: [agent("A-1", { lastHeartbeatAt: undefined }), agent("A-2")],
    now: NOW,
  });
  assert.deepEqual(result.candidates.map((entry) => entry.id), ["A-2"]);
  assert.deepEqual(result.excluded, [{ agentId: "A-1", reason: "no-heartbeat" }]);
});
