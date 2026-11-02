// Dispatch tests: scoring, agent matching, write-scope conflicts and the
// deterministic planDispatch contract (including whole-DAG cycle rejection).
import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIORITY_WEIGHT,
  SKIP_REASON_VALUES,
  SKIP_REASONS,
  assertDeterministic,
  detectConflicts,
  matchAgents,
  planDispatch,
  resolveOwner,
  scoreAndSort,
} from "../src/index.mjs";
import { NOW, POLICIES, agent, permutations, run, snapshot, task } from "./helpers.mjs";

const plan = (snapshotValue, options = {}) =>
  planDispatch({ snapshot: snapshotValue, policies: options.policies ?? POLICIES, now: options.now ?? NOW });

// ---------------------------------------------------------------------------
// scoreAndSort
// ---------------------------------------------------------------------------

test("scoreAndSort computes waiting time and score from the injected clock", () => {
  const rows = scoreAndSort([task("T-1", { priority: 2 })], { now: NOW });
  assert.deepEqual(rows, [{ taskId: "T-1", priority: 2, waitingMs: 600_000, score: 2 * PRIORITY_WEIGHT - 600_000 }]);
});

test("scoreAndSort orders by priority, then by longer waiting, then by id", () => {
  const tasks = [
    task("T-C", { priority: 2, createdAt: "2026-01-01T00:00:00.000Z" }),
    task("T-B", { priority: 2, createdAt: "2026-01-01T00:00:00.000Z" }),
    task("T-A", { priority: 2, createdAt: "2026-01-01T00:05:00.000Z" }),
    task("T-URGENT", { priority: 0, createdAt: "2026-01-01T00:09:00.000Z" }),
  ];
  assert.deepEqual(scoreAndSort(tasks, { now: NOW }).map((row) => row.taskId), ["T-URGENT", "T-B", "T-C", "T-A"]);
});

test("scoreAndSort clamps future createdAt to zero wait and defaults priority to NORMAL", () => {
  const rows = scoreAndSort([task("T-1", { priority: undefined, createdAt: "2027-01-01T00:00:00.000Z" })], { now: NOW });
  assert.equal(rows[0].priority, 2);
  assert.equal(rows[0].waitingMs, 0);
  assert.equal(rows[0].score, 2 * PRIORITY_WEIGHT);
});

test("scoreAndSort ignores malformed tasks and requires an injected clock", () => {
  const rows = scoreAndSort([task("T-1"), { id: "" }, null, { title: "no id" }, task("T-2")], { now: NOW });
  assert.deepEqual(rows.map((row) => row.taskId), ["T-1", "T-2"]);
  assert.throws(() => scoreAndSort([task("T-1")], {}), /now must be a valid/);
  assert.throws(() => scoreAndSort([], { now: "not-a-date" }), /now must be a valid/);
});

test("scoreAndSort output is independent of input order", () => {
  const tasks = [task("T-3", { priority: 1 }), task("T-1"), task("T-2", { createdAt: "2025-12-31T23:00:00.000Z" })];
  const results = permutations(tasks).map((value) => scoreAndSort(value, { now: NOW }));
  for (const result of results) assert.deepEqual(result, results[0]);
});

// ---------------------------------------------------------------------------
// matchAgents
// ---------------------------------------------------------------------------

test("matchAgents returns idle agents with the exact role and required capability", () => {
  const result = matchAgents({ task: task("T-1"), agents: [agent("A-2"), agent("A-1")], now: NOW });
  assert.deepEqual(result.candidates.map((entry) => entry.id), ["A-1", "A-2"]);
  assert.deepEqual(result.excluded, []);
});

test("matchAgents excludes non-idle, wrong-role and missing-capability agents with reasons", () => {
  const result = matchAgents({
    task: task("T-1", { functionRequired: "WORKER", roleRequired: "DEV" }),
    agents: [
      agent("A-BUSY", { status: "BUSY" }),
      agent("A-ROLE", { role: "QA" }),
      agent("A-FUNCTION", { capabilities: ["REVIEWER"] }),
      agent("A-OK"),
    ],
    now: NOW,
  });
  assert.deepEqual(result.candidates.map((entry) => entry.id), ["A-OK"]);
  assert.deepEqual(result.excluded, [
    { agentId: "A-BUSY", reason: "not-idle" },
    { agentId: "A-FUNCTION", reason: "function-missing" },
    { agentId: "A-ROLE", reason: "role-mismatch" },
  ]);
});

test("matchAgents tolerates empty input and requires the injected clock", () => {
  // the injected clock is mandatory (m6.2 F10): no a-la-carte "no heartbeat check"
  assert.throws(() => matchAgents({}), /now must be a valid/);
  assert.deepEqual(matchAgents({ task: task("T-1"), agents: [], now: NOW }), { candidates: [], excluded: [] });
});

// ---------------------------------------------------------------------------
// detectConflicts / resolveOwner
// ---------------------------------------------------------------------------

test("detectConflicts reports overlapping files with an active run", () => {
  const result = detectConflicts({
    task: task("T-1", { files: ["src/a.ts"] }),
    activeRuns: [run("R-1", { files: ["src/a.ts"] })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 1);
  assert.equal(result.reasons[0].kind, SKIP_REASONS.WRITE_SCOPE_CONFLICT);
  assert.match(result.reasons[0].detail, /src\/a\.ts/);
  assert.match(result.reasons[0].detail, /R-1/);
});

test("detectConflicts passes when there is no overlap or no declared scope", () => {
  assert.deepEqual(detectConflicts({ task: task("T-1", { files: ["src/a.ts"] }), activeRuns: [run("R-1", { files: ["src/b.ts"] })] }), {
    ok: true,
    reasons: [],
  });
  assert.deepEqual(detectConflicts({ task: task("T-1"), activeRuns: [run("R-1", { files: ["src/a.ts"] })] }), { ok: true, reasons: [] });
  assert.deepEqual(detectConflicts({}), { ok: true, reasons: [] });
});

test("detectConflicts normalises path separators and directory scopes", () => {
  const separator = detectConflicts({
    task: task("T-1", { files: ["src\\a.ts"] }),
    activeRuns: [run("R-1", { files: ["src/a.ts"] })],
  });
  assert.equal(separator.ok, false);
  const directory = detectConflicts({
    task: task("T-1", { files: ["src"] }),
    activeRuns: [run("R-1", { files: ["src/a.ts"] })],
  });
  assert.equal(directory.ok, false);
});

test("detectConflicts ignores terminal runs", () => {
  const result = detectConflicts({
    task: task("T-1", { files: ["src/a.ts"] }),
    activeRuns: [run("R-1", { status: "COMPLETED", files: ["src/a.ts"] })],
  });
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("resolveOwner uses the longest matching ownership prefix and is deterministic", () => {
  const ownership = {
    rules: [
      { prefix: "src", role: "DEV" },
      { prefix: "src/api", role: "API" },
      { prefix: "src/../lib", role: "LIB" },
    ],
  };
  assert.deepEqual(resolveOwner(ownership, "src/a.ts"), { role: "DEV", prefix: "src" });
  assert.deepEqual(resolveOwner(ownership, "src/api/v1.ts"), { role: "API", prefix: "src/api" });
  assert.deepEqual(resolveOwner(ownership, "lib/x.ts"), { role: "LIB", prefix: "lib" });
  assert.equal(resolveOwner(ownership, "docs/readme.md"), null);
  assert.equal(resolveOwner(null, "src/a.ts"), null);
});

test("detectConflicts treats one ownership region as a write domain when ownership is supplied", () => {
  const ownership = { rules: [{ prefix: "src", role: "DEV" }] };
  const withoutOwnership = detectConflicts({
    task: task("T-1", { files: ["src/a.ts"] }),
    activeRuns: [run("R-1", { files: ["src/b.ts"] })],
  });
  assert.equal(withoutOwnership.ok, true);
  const withOwnership = detectConflicts({
    task: task("T-1", { files: ["src/a.ts"] }),
    activeRuns: [run("R-1", { files: ["src/b.ts"] })],
    ownership,
  });
  assert.equal(withOwnership.ok, false);
  assert.match(withOwnership.reasons[0].detail, /ownership DEV:src/);
});

// ---------------------------------------------------------------------------
// planDispatch — happy paths and ordering
// ---------------------------------------------------------------------------

test("planDispatch proposes one deterministic dispatch for a ready task", () => {
  const result = plan(snapshot({ tasks: [task("T-1", { version: 3 })], agents: [agent("A-1")] }));
  assert.deepEqual(result, {
    proposals: [
      {
        taskId: "T-1",
        agentId: "A-1",
        expectedTaskVersion: 3,
        workspacePolicy: { kind: "none" },
        reason: "priority=2; waitingMs=600000",
        idempotencyKey: "claim-T-1-3",
      },
    ],
    skipped: [],
  });
});

test("planDispatch falls back to expectedTaskVersion 0 when version is missing", () => {
  const t = task("T-1");
  delete t.version;
  const result = plan(snapshot({ tasks: [t], agents: [agent("A-1")] }));
  assert.equal(result.proposals[0].expectedTaskVersion, 0);
  assert.equal(result.proposals[0].idempotencyKey, "claim-T-1-0");
});

test("planDispatch proposes higher priority first regardless of input order", () => {
  const result = plan(
    snapshot({
      tasks: [task("T-LOW", { priority: 3 }), task("T-HIGH", { priority: 0 })],
      agents: [agent("A-2"), agent("A-1")],
    }),
  );
  assert.deepEqual(result.proposals.map((proposal) => proposal.taskId), ["T-HIGH", "T-LOW"]);
});

test("planDispatch respects an injected workspacePolicy and project overrides", () => {
  const fromPolicies = plan(snapshot({ tasks: [task("T-1")], agents: [agent("A-1")] }), {
    policies: { ...POLICIES, workspacePolicy: { kind: "worktree", branch: "main" } },
  });
  assert.deepEqual(fromPolicies.proposals[0].workspacePolicy, { kind: "worktree", branch: "main" });

  const fromProject = plan(
    snapshot({
      tasks: [task("T-1")],
      agents: [agent("A-1")],
      projects: [{ id: "P-1", policy: { workspacePolicy: { kind: "none" } } }],
    }),
    { policies: { ...POLICIES, workspacePolicy: { kind: "worktree" } } },
  );
  assert.deepEqual(fromProject.proposals[0].workspacePolicy, { kind: "none" });
});

// ---------------------------------------------------------------------------
// planDispatch — dependency rules
// ---------------------------------------------------------------------------

test("planDispatch never proposes a task whose dependency is not DONE", () => {
  const result = plan(
    snapshot({ tasks: [task("A"), task("B", { deps: ["A"] })], agents: [agent("A-1"), agent("A-2")] }),
  );
  assert.deepEqual(result.proposals.map((proposal) => proposal.taskId), ["A"]);
  assert.deepEqual(result.skipped, [{ taskId: "B", reason: SKIP_REASONS.DEPS_INCOMPLETE }]);
});

test("planDispatch proposes the dependent once the dependency is DONE", () => {
  const result = plan(
    snapshot({
      tasks: [task("A", { status: "DONE" }), task("B", { deps: ["A"] })],
      agents: [agent("A-1")],
    }),
  );
  assert.deepEqual(result.proposals.map((proposal) => proposal.taskId), ["B"]);
  assert.deepEqual(result.skipped, []);
});

test("planDispatch reports a missing dependency as deps-incomplete", () => {
  const result = plan(snapshot({ tasks: [task("T-1", { deps: ["MISSING"] })], agents: [agent("A-1")] }));
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.DEPS_INCOMPLETE }]);
});

test("planDispatch treats a task without a deps field as dependency-free", () => {
  const t = task("T-1");
  delete t.deps;
  const result = plan(snapshot({ tasks: [t], agents: [agent("A-1")] }));
  assert.deepEqual(result.proposals.map((proposal) => proposal.taskId), ["T-1"]);
});

// ---------------------------------------------------------------------------
// planDispatch — matching and capacity
// ---------------------------------------------------------------------------

test("planDispatch skips with no-idle-agent when every agent is busy or absent", () => {
  const busy = plan(snapshot({ tasks: [task("T-1")], agents: [agent("A-1", { status: "BUSY" })] }));
  assert.deepEqual(busy.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.NO_IDLE_AGENT }]);
  const none = plan(snapshot({ tasks: [task("T-1")], agents: [] }));
  assert.deepEqual(none.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.NO_IDLE_AGENT }]);
});

test("planDispatch distinguishes capability mismatch from no idle agent", () => {
  const roleMismatch = plan(snapshot({ tasks: [task("T-1")], agents: [agent("A-1", { role: "QA" })] }));
  assert.deepEqual(roleMismatch.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.CAPABILITY_MISMATCH }]);
  const functionMissing = plan(snapshot({ tasks: [task("T-1")], agents: [agent("A-1", { capabilities: ["REVIEWER"] })] }));
  assert.deepEqual(functionMissing.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.CAPABILITY_MISMATCH }]);
});

test("planDispatch enforces maxConcurrentPerProject from policies", () => {
  const result = plan(
    snapshot({
      tasks: [task("T-0", { status: "RUNNING" }), task("T-1")],
      agents: [agent("A-1"), agent("A-2")],
      runs: [run("R-0", { taskId: "T-0", agentId: "A-2" })],
    }),
    { policies: { maxConcurrentPerProject: 1, maxPerAgent: 2 } },
  );
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.CAPACITY }]);
});

test("planDispatch enforces project policy overrides", () => {
  const result = plan(
    snapshot({
      tasks: [task("T-0", { status: "RUNNING" }), task("T-1")],
      agents: [agent("A-1"), agent("A-2")],
      runs: [run("R-0", { taskId: "T-0", agentId: "A-2" })],
      projects: [{ id: "P-1", policy: { maxConcurrentPerProject: 1 } }],
    }),
    { policies: { maxConcurrentPerProject: 5, maxPerAgent: 2 } },
  );
  assert.deepEqual(result.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.CAPACITY }]);
});

test("planDispatch enforces maxPerAgent", () => {
  const result = plan(
    snapshot({
      tasks: [task("T-1"), task("T-2")],
      agents: [agent("A-1")],
    }),
    { policies: { maxConcurrentPerProject: 5, maxPerAgent: 1 } },
  );
  assert.deepEqual(result.proposals.map((proposal) => proposal.taskId), ["T-1"]);
  assert.deepEqual(result.skipped, [{ taskId: "T-2", reason: SKIP_REASONS.CAPACITY }]);
});

test("planDispatch applies no limit when policies omit capacities", () => {
  const result = plan(
    snapshot({ tasks: [task("T-1"), task("T-2")], agents: [agent("A-1"), agent("A-2")] }),
    { policies: {} },
  );
  assert.equal(result.proposals.length, 2);
  assert.deepEqual(result.skipped, []);
});

test("planDispatch scopes the snapshot to policies.projectId", () => {
  const result = plan(
    snapshot({
      tasks: [task("T-1", { projectId: "P-1" }), task("T-2", { projectId: "P-2" })],
      agents: [agent("A-1"), agent("A-2")],
    }),
    { policies: { ...POLICIES, projectId: "P-1" } },
  );
  assert.deepEqual(result.proposals.map((proposal) => proposal.taskId), ["T-1"]);
  assert.deepEqual(result.skipped, []);
});

// ---------------------------------------------------------------------------
// planDispatch — write scope
// ---------------------------------------------------------------------------

test("planDispatch skips a task whose files overlap an active run", () => {
  const result = plan(
    snapshot({
      tasks: [task("T-0", { status: "RUNNING", files: ["src/a.ts"] }), task("T-1", { files: ["src/a.ts"] })],
      agents: [agent("A-1")],
      runs: [run("R-0", { taskId: "T-0", agentId: "A-2", files: ["src/a.ts"] })],
    }),
  );
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.skipped, [{ taskId: "T-1", reason: SKIP_REASONS.WRITE_SCOPE_CONFLICT }]);
});

test("planDispatch never proposes two conflicting tasks in the same plan", () => {
  const result = plan(
    snapshot({
      tasks: [task("T-1", { files: ["src/shared.ts"] }), task("T-2", { files: ["src/shared.ts"] })],
      agents: [agent("A-1"), agent("A-2")],
    }),
    { policies: { maxConcurrentPerProject: 5, maxPerAgent: 2 } },
  );
  assert.deepEqual(result.proposals.map((proposal) => proposal.taskId), ["T-1"]);
  assert.deepEqual(result.skipped, [{ taskId: "T-2", reason: SKIP_REASONS.WRITE_SCOPE_CONFLICT }]);
});

// ---------------------------------------------------------------------------
// planDispatch — cycles, empty input, determinism
// ---------------------------------------------------------------------------

test("planDispatch rejects the whole plan when any cycle exists", () => {
  const result = plan(
    snapshot({
      tasks: [task("A", { deps: ["B"] }), task("B", { deps: ["A"] }), task("C")],
      agents: [agent("A-1")],
    }),
  );
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.skipped, [
    { taskId: "A", reason: SKIP_REASONS.CYCLE },
    { taskId: "B", reason: SKIP_REASONS.CYCLE },
    { taskId: "C", reason: SKIP_REASONS.CYCLE },
  ]);
});

test("planDispatch returns an empty plan for empty or non-ready snapshots", () => {
  assert.deepEqual(plan(snapshot({})), { proposals: [], skipped: [] });
  assert.deepEqual(
    plan(snapshot({ tasks: [task("T-1", { status: "DRAFT" }), task("T-2", { status: "DONE" })], agents: [agent("A-1")] })),
    { proposals: [], skipped: [] },
  );
});

test("planDispatch only emits machine-readable skip reasons", () => {
  const result = plan(
    snapshot({
      tasks: [
        task("A", { deps: ["B"] }),
        task("B", { deps: ["A"] }),
        task("C", { deps: ["MISSING"] }),
        task("D"),
      ],
      agents: [agent("A-1", { status: "BUSY" })],
    }),
  );
  assert.deepEqual(
    result.skipped.map((entry) => entry.reason).sort(),
    ["cycle", "cycle", "cycle", "cycle"],
  );
  for (const entry of result.skipped) assert.ok(SKIP_REASON_VALUES.includes(entry.reason));
  for (const entry of plan(snapshot({ tasks: [task("T-1", { deps: ["MISSING"] })], agents: [agent("A-1")] })).skipped) {
    assert.ok(SKIP_REASON_VALUES.includes(entry.reason));
  }
});

test("planDispatch is byte-identical for the same snapshot", () => {
  const value = snapshot({
    tasks: [task("T-1", { priority: 0 }), task("T-2", { deps: ["T-1"] }), task("T-3", { priority: 1 })],
    agents: [agent("A-1"), agent("A-2", { status: "BUSY" })],
  });
  assert.deepEqual(plan(value), plan(value));
  assert.equal(JSON.stringify(plan(value)), JSON.stringify(plan(value)));
  assertDeterministic(plan(value), plan(value));
});

test("planDispatch is independent of task/agent/run array order", () => {
  const base = snapshot({
    tasks: [task("T-1", { priority: 0 }), task("T-2", { deps: ["T-1"] }), task("T-3", { priority: 1 })],
    agents: [agent("A-1"), agent("A-2")],
    runs: [run("R-0", { taskId: "T-0", agentId: "A-3" })],
  });
  const results = [];
  for (const tasks of permutations(base.tasks)) {
    for (const agents of permutations(base.agents)) {
      for (const runs of permutations(base.runs)) {
        results.push(JSON.stringify(plan({ ...base, tasks, agents, runs })));
      }
    }
  }
  for (const result of results) assert.equal(result, results[0]);
});

test("planDispatch validates its inputs instead of guessing", () => {
  assert.throws(() => planDispatch({}), /snapshot must be an object/);
  assert.throws(() => planDispatch({ snapshot: {}, policies: { maxConcurrentPerProject: 0 }, now: NOW }), /positive integer/);
  assert.throws(() => planDispatch({ snapshot: {}, policies: {}, now: "nope" }), /now must be a valid/);
});

// ---------------------------------------------------------------------------
// Determinism at the spec's adversarial scale (20 agents / 100 tasks)
// ---------------------------------------------------------------------------

function bigSnapshot({ withCycle = false } = {}) {
  const tasks = [];
  for (let index = 1; index <= 100; index += 1) {
    const id = `T-${String(index).padStart(3, "0")}`;
    const deps = index % 10 === 0 ? [`T-${String(index - 1).padStart(3, "0")}`] : [];
    if (withCycle && index === 5) deps.push("T-006");
    if (withCycle && index === 6) deps.push("T-005");
    tasks.push(task(id, { priority: index % 4, deps }));
  }
  const agents = [];
  for (let index = 1; index <= 20; index += 1) {
    agents.push(agent(`A-${String(index).padStart(2, "0")}`, { role: index % 2 === 0 ? "DEV" : "QA" }));
  }
  return snapshot({ tasks, agents, runs: [run("R-1", { taskId: "T-000", agentId: "A-20" })] });
}

test("planDispatch is deterministic on a 100-task / 20-agent snapshot", () => {
  const value = bigSnapshot();
  const first = plan(value, { policies: { maxConcurrentPerProject: 4, maxPerAgent: 1 } });
  const second = plan(value, { policies: { maxConcurrentPerProject: 4, maxPerAgent: 1 } });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const shuffled = plan(
    { ...value, tasks: [...value.tasks].reverse(), agents: [...value.agents].reverse(), runs: [...value.runs].reverse() },
    { policies: { maxConcurrentPerProject: 4, maxPerAgent: 1 } },
  );
  assert.equal(JSON.stringify(shuffled), JSON.stringify(first));
});

test("planDispatch rejects a 100-task snapshot that contains one cycle", () => {
  const value = bigSnapshot({ withCycle: true });
  const result = plan(value, { policies: { maxConcurrentPerProject: 4, maxPerAgent: 1 } });
  assert.deepEqual(result.proposals, []);
  assert.equal(result.skipped.length, 100);
  for (const entry of result.skipped) assert.equal(entry.reason, SKIP_REASONS.CYCLE);
});


test("assertDeterministic passes equal values and throws on drift", () => {
  const value = plan(snapshot({ tasks: [task("T-1")], agents: [agent("A-1")] }));
  assert.equal(assertDeterministic(value, structuredClone(value)), value);
  assert.throws(() => assertDeterministic(value, { proposals: [], skipped: [] }), /not deterministic/);
});
