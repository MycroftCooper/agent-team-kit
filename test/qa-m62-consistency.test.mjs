// M6.2 QA-04: SQLite / Memory common-contract consistency.
//
// The M6.1/M6.2 core operations must be exercised on BOTH real stores. A gate
// that only passes on the in-memory fake is not evidence. This suite never
// imports apps/backend/test/fake-store.mjs.
//
// Node < 22.5 has no node:sqlite: the whole file skips (not passes).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);
let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

if (!hasSqlite) {
  test("qa-m62 consistency suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5" }, () => {});
} else {
  const { openStore, createMemoryStore } = await load("packages/database/src/index.mjs");
  const { INTERNAL } = await load("packages/database/src/internal.mjs");

  const NOW = "2026-11-02T00:00:00.000Z";
  const LATER = new Date(Date.parse(NOW) + 20_000).toISOString();

  function tempDir(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m62-consistency-"));
    t.after(() => { for (let attempt = 0; attempt < 5; attempt += 1) { try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* busy */ } } });
    return dir;
  }
  function stores(t) {
    const sqlite = openStore({ file: path.join(tempDir(t), "atk.db"), migrate: true });
    const memory = createMemoryStore();
    t.after(() => { try { sqlite.close(); } catch { /* closed */ } try { memory.close(); } catch { /* closed */ } });
    return [{ label: "sqlite", store: sqlite }, { label: "memory", store: memory }];
  }
  function projectDto() {
    return { id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" };
  }
  function taskDto(id, overrides = {}) {
    return {
      id,
      projectId: "P1",
      title: `task ${id}`,
      description: "d",
      functionRequired: "WORKER",
      roleRequired: "DEV",
      priority: 2,
      deps: [],
      acceptance: "x",
      ...overrides,
    };
  }
  function seed(store, taskId = "T1") {
    store.createProject(projectDto());
    store.createTask(taskDto(taskId));
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    if (typeof store.recordHeartbeat === "function") store.recordHeartbeat({ hostId: "qa-fixture", agentIds: ["agent-1"], capacity: 1, now: NOW });
    return store.getTask(taskId);
  }
  function normalizeSpec(spec) {
    return JSON.parse(JSON.stringify(spec, (key, value) => (key === "generatedAt" || key === "frozenAt" ? "<time>" : value)));
  }

  test("QA-04.1 claim + idempotent replay + frozen spec/workspace is equivalent on both stores", async (t) => {
    const results = [];
    for (const { label, store } of stores(t)) {
      const task = seed(store);
      const claimed = store.claimTask({
        taskId: "T1",
        agentId: "agent-1",
        expectedTaskVersion: task.version,
        idempotencyKey: "qa-m62-claim",
        workspace: { kind: "none" },
      });
      assert.equal(store.getTask("T1").status, "CLAIMED", label);
      assert.equal(claimed.spec.schemaVersion, 1, label);
      assert.deepEqual(claimed.run.workspace, { kind: "none", path: null, baseCommit: null, targetBranch: null }, label);
      assert.deepEqual(store.getRunSpec(claimed.run.id).spec, claimed.spec, label);
      const replay = store.claimTask({
        taskId: "T1",
        agentId: "agent-1",
        expectedTaskVersion: task.version,
        idempotencyKey: "qa-m62-claim",
        workspace: { kind: "none" },
      });
      assert.equal(replay.run.id, claimed.run.id, `${label}: replay returns the same Run`);
      assert.equal(replay.specHash, claimed.specHash, `${label}: replay returns the same spec`);
      assert.equal(store.listRuns({ taskId: "T1", limit: 100 }).length, 1, `${label}: one Run only`);
      results.push({ label, task: store.getTask("T1"), spec: normalizeSpec(claimed.spec), workspace: claimed.run.workspace });
    }
    assert.deepEqual(results[0].task.status, results[1].task.status);
    assert.deepEqual(results[0].spec, results[1].spec, "the frozen spec content must be identical");
    assert.deepEqual(results[0].workspace, results[1].workspace);
  });

  test("QA-04.2 heartbeat / availability is equivalent and never IDLE-alone", async (t) => {
    for (const { label, store } of stores(t)) {
      store.createProject(projectDto());
      store.upsertAgent({ id: "agent-hb", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
      assert.deepEqual(store.agentAvailability({ now: NOW, ttlMs: 10_000 }), { available: false, reason: "no-heartbeat" }, label);
      store.recordHeartbeat({ hostId: "host-1", agentIds: ["agent-hb"], capacity: 2, now: NOW });
      assert.deepEqual(store.agentAvailability({ now: NOW, ttlMs: 10_000 }), { available: true, reason: "ok" }, label);
      assert.deepEqual(store.agentAvailability({ now: LATER, ttlMs: 10_000 }), { available: false, reason: "stale-heartbeat" }, label);
      store.recordHeartbeat({ hostId: "host-1", agentIds: ["agent-hb"], capacity: 0, now: LATER });
      assert.deepEqual(store.agentAvailability({ now: LATER, ttlMs: 10_000 }), { available: false, reason: "no-capacity" }, label);
    }
  });

  test("QA-04.3 Review 鈫?integration 鈫?approval keeps the same status/event contract on both stores", async (t) => {
    const snapshots = [];
    for (const { label, store } of stores(t)) {
      seed(store);
      store[INTERNAL].setTaskStatus("T1", "RUNNING");
      const run = store.createRun({ taskId: "T1", agentId: "agent-1", function: "WORKER", role: "DEV" });
      store.updateRunStatus(run.id, { status: "RUNNING" });
      store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
      const review = store.createReview({ taskId: "T1", runId: run.id, assignedTo: "HUMAN" });
      assert.equal(store.getTask("T1").status, "REVIEWING", label);
      const submitted = store.submitReview({
        id: review.id,
        expectedVersion: review.version,
        verdict: "PASS",
        manifestHash: "a".repeat(64),
        evidence: { tests: { passed: 1, total: 1 } },
        actor: "HUMAN",
      });
      assert.equal(submitted.review.status, "PASS", label);
      assert.equal(store.getTask("T1").status, "INTEGRATING", label);
      const integrated = store.recordIntegration({ taskId: "T1", runId: run.id, commitSha: "b".repeat(40), manifestHash: "a".repeat(64), actor: "user-action" });
      assert.equal(integrated.task.status, "AWAITING_ACCEPTANCE", label);
      const approval = store.createApproval({ taskId: "T1", scope: "qa", targetHash: "a".repeat(64), actor: "HUMAN" });
      const decided = store.decideApproval({ id: approval.id, decision: "APPROVED", targetHash: "a".repeat(64), actor: "HUMAN" });
      assert.equal(decided.task.status, "DONE", label);
      const approvalEvent = store.listEvents({ aggregateId: approval.id, type: "approval.recorded", limit: 10 }).at(-1);
      assert.equal(approvalEvent.payload.principal, "HUMAN", label);
      snapshots.push({ label, task: store.getTask("T1"), review: submitted.review, event: approvalEvent.payload.principal });
    }
    assert.deepEqual(snapshots[0].task.status, snapshots[1].task.status);
    assert.equal(snapshots[0].event, snapshots[1].event);
  });

  test("QA-04.4 event batch is equivalent: one run.updated, logs, dedupe, all-or-nothing", async (t) => {
    const fingerprints = [];
    for (const { label, store } of stores(t)) {
      const task = seed(store);
      const claim = store.claimTask({ taskId: "T1", agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: "qa-m62-batch" });
      const claimed = store.claimDispatchCommand({ ownerId: "qa-host", leaseMs: 60000 });
      const generation = claimed.lease.generation;
      store.updateRunStatus(claim.run.id, { status: "RUNNING", generation });
      const batch = {
        runId: claim.run.id,
        generation,
        events: [
          { type: "run.log", payload: { line: "a" }, eventId: "EVT-A", sessionSeq: 1 },
          { type: "run.updated", payload: { status: "COMPLETED", exitCode: 0 }, eventId: "EVT-B", sessionSeq: 2 },
        ],
      };
      const first = store.applyRuntimeEventBatch(batch);
      assert.equal(first.applied.length, 2, label);
      const second = store.applyRuntimeEventBatch(batch);
      assert.equal(second.applied.length, 0, label);
      assert.equal(second.skipped, 2, label);
      assert.equal(store.getRun(claim.run.id).status, "COMPLETED", label);
      const before = JSON.stringify({ run: store.getRun(claim.run.id), events: store.listEvents({ aggregateId: claim.run.id, limit: 100 }) });
      await assert.rejects(
        async () => store.applyRuntimeEventBatch({ runId: claim.run.id, generation, events: [{ type: "run.log", payload: "bad", eventId: "EVT-BAD", sessionSeq: 3 }] }),
        (error) => error.code === "VALIDATION_ERROR" || error.name === "StoreError",
        label,
      );
      assert.equal(JSON.stringify({ run: store.getRun(claim.run.id), events: store.listEvents({ aggregateId: claim.run.id, limit: 100 }) }), before, `${label}: rejected batch must be zero-write`);
      fingerprints.push({ label, eventIds: store.listEvents({ aggregateId: claim.run.id, limit: 100 }).map((event) => event.eventId).filter(Boolean) });
    }
    assert.deepEqual(fingerprints[0].eventIds, fingerprints[1].eventIds);
  });

  test("QA-04.5 reconcile/renew/stale-generation contract is equivalent on both stores", async (t) => {
    for (const { label, store } of stores(t)) {
      const task = seed(store);
      const claim = store.claimTask({ taskId: "T1", agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: "qa-m62-reconcile" });
      const claimed = store.claimDispatchCommand({ ownerId: "qa-host", leaseMs: 60000 });
      const generation = claimed.lease.generation;
      const reconciled = store.reconcileRun({ runId: claim.run.id });
      assert.equal(reconciled.run.id, claim.run.id, label);
      assert.equal(reconciled.lease.generation, generation, label);
      const renewed = store.renewRunLease({ runId: claim.run.id, ownerId: "qa-host", generation, leaseMs: 60000 });
      assert.equal(renewed.generation, generation + 1, `${label}: a successful renew starts the next generation`);
      assert.throws(
        () => store.renewRunLease({ runId: claim.run.id, ownerId: "other-host", generation, leaseMs: 60000 }),
        (error) => error.code === "STALE_GENERATION",
        `${label}: a different owner must be fenced`,
      );
    }
  });

  test("QA-04.6 a failed SQLite transaction leaves no partial Task/event/run write", async (t) => {
    const dir = tempDir(t);
    const store = openStore({ file: path.join(dir, "atk.db"), migrate: true });
    t.after(() => { try { store.close(); } catch { /* closed */ } });
    store.createProject(projectDto());
    const before = {
      tasks: store.listTasks({ limit: 100 }).length,
      events: store.listEvents({ limit: 100 }).length,
    };
    assert.throws(() => store[INTERNAL].transaction(() => {
      store.createTask(taskDto("T-TX"));
      throw new Error("injected mid-transaction failure");
    }), /injected mid-transaction failure/);
    assert.equal(store.listTasks({ limit: 100 }).length, before.tasks, "no partial Task");
    assert.equal(store.listEvents({ limit: 100 }).length, before.events, "no partial event");
    assert.throws(() => store.getTask("T-TX"), (error) => error.code === "NOT_FOUND");
  });
}

