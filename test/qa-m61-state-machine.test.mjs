// M6.1 independent QA-01: cross-module state-machine adversarial suite.
//
// Landed on the M6.1 branch: F01 backend + store execution-state guards, F03
// store batch atomicity. Pending (explicitly skipped, never "passed"): the
// service-only entries that still need WP2 createReview/recordIntegration and
// the F06 human approval principal; those tests are written as expectations and
// enabled when the implementation lands.
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
  test("qa-m61 state-machine suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5" }, () => {});
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { openStore, createMemoryStore } = await load("packages/database/src/index.mjs");
  const { INTERNAL } = await load("packages/database/src/internal.mjs");
  const { startServer, request, writeHeaders, internalHeaders, TEST_INTERNAL_TOKEN } = await load("apps/backend/test/helpers.mjs");

  const EXECUTION_TARGETS = ["CLAIMED", "RUNNING", "REVIEWING", "INTEGRATING", "AWAITING_ACCEPTANCE", "DONE"];
  const EXECUTION_EDGES = [
    ["READY", "CLAIMED"],
    ["CLAIMED", "RUNNING"],
    ["RUNNING", "REVIEWING"],
    ["REVIEWING", "INTEGRATING"],
    ["INTEGRATING", "AWAITING_ACCEPTANCE"],
    ["AWAITING_ACCEPTANCE", "DONE"],
  ];

  function tempDir(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m61-state-"));
    t.after(() => { for (let attempt = 0; attempt < 5; attempt += 1) { try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* busy */ } } });
    return dir;
  }
  function setStatus(file, taskId, status) {
    const raw = new DatabaseSync(file);
    try { raw.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId); } finally { raw.close(); }
  }
  function dbFingerprint(file) {
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const tasks = raw.prepare("SELECT id, status, version, target_hash AS targetHash FROM tasks ORDER BY id").all();
      const events = Number(raw.prepare("SELECT COUNT(*) AS c FROM events").get().c);
      const reviews = Number(raw.prepare("SELECT COUNT(*) AS c FROM reviews").get().c);
      return { tasks, events, reviews };
    } finally { raw.close(); }
  }
  function createTask(store, projectId, id) {
    return store.createTask({ id, projectId, title: id, description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
  }

  async function backendFixture(t) {
    const dir = tempDir(t);
    const dbFile = path.join(dir, "data", "atk.db");
    const store = openStore({ file: dbFile, migrate: true });
    const project = store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    for (const id of ["T1", "T-EXEC", "T-DRAFT", "T-REJECTED", "T-BLOCKED", "T-READY", "T-ILLEGAL", "DONE-NOAPPROVAL"]) createTask(store, project.id, id);
    setStatus(dbFile, "T-DRAFT", "DRAFT");
    setStatus(dbFile, "T-REJECTED", "REJECTED");
    setStatus(dbFile, "T-BLOCKED", "BLOCKED");
    setStatus(dbFile, "DONE-NOAPPROVAL", "AWAITING_ACCEPTANCE");
    const ctx = await startServer({ store, logger: { info() {}, warn() {}, error() {} } });
    t.after(async () => { await ctx.server.close().catch(() => {}); try { store.close(); } catch { /* closed */ } });
    return { dir, dbFile, store, ctx, project, task: store.getTask("T1") };
  }
  const patch = (ctx, id, status, expectedVersion) => request(ctx.base, {
    method: "PATCH",
    path: `/api/v1/tasks/${id}`,
    headers: writeHeaders(ctx.base),
    body: { expectedVersion, changes: { status } },
  });

  test("QA-01.1 generic PATCH refuses all six execution targets, with zero writes", async (t) => {
    const f = await backendFixture(t);
    for (const target of EXECUTION_TARGETS) {
      const before = dbFingerprint(f.dbFile);
      const task = f.store.getTask("T-EXEC");
      const response = await patch(f.ctx, "T-EXEC", target, task.version);
      assert.equal(response.status, 409, `${target}: ${response.text}`);
      assert.equal(response.json.error.code, "TASK_VERSION_CONFLICT");
      assert.equal(response.json.error.details.reason, "execution-state-guard", target);
      assert.equal(response.json.error.details.requestedStatus, target);
      assert.ok(Array.isArray(response.json.error.details.allowedTransitions), "allowedTransitions must name the public set");
      assert.deepEqual(dbFingerprint(f.dbFile), before, `${target}: a refused PATCH must leave tasks/events/reviews unchanged`);
    }
  });

  test("QA-01.2 generic PATCH allows the non-execution set and idempotent no-op", async (t) => {
    const f = await backendFixture(t);
    const cases = [
      ["T-DRAFT", "READY", "READY"],
      ["T-REJECTED", "READY", "READY"],
      ["T-BLOCKED", "READY", "READY"],
      ["T-READY", "BLOCKED", "BLOCKED"],
      ["T-READY", "CANCELLED", "CANCELLED"],
    ];
    for (const [id, target, expected] of cases) {
      const task = f.store.getTask(id);
      const response = await patch(f.ctx, id, target, task.version);
      assert.equal(response.status, 200, `${id} -> ${target}: ${response.text}`);
      assert.equal(response.json.status, expected);
    }
    const ready = f.store.getTask("T-EXEC");
    const noop = await patch(f.ctx, "T-EXEC", "READY", ready.version);
    assert.equal(noop.status, 200);
    assert.equal(noop.json.status, "READY");
    assert.equal(noop.json.version, ready.version, "same-status is a true no-op");
  });

  test("QA-01.3 store patchTask has the same F01 guard in sqlite and memory", async (t) => {
    const dir = tempDir(t);
    const sqlite = openStore({ file: path.join(dir, "atk.db"), migrate: true });
    const memory = createMemoryStore();
    t.after(() => { try { sqlite.close(); } catch { /* closed */ } try { memory.close(); } catch { /* closed */ } });
    for (const [label, store] of [["sqlite", sqlite], ["memory", memory]]) {
      store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
      for (const [from, to] of EXECUTION_EDGES) {
        const id = `T-${label}-${from}`;
        createTask(store, "P1", id);
        if (from !== "READY") store[INTERNAL].setTaskStatus(id, from);
        const before = store.getTask(id);
        assert.throws(
          () => store.patchTask(id, { expectedVersion: before.version, changes: { status: to } }),
          (error) => error.code === "TASK_VERSION_CONFLICT" && error.details?.reason === "execution-state-guard",
          `${label}: ${from} -> ${to} must be service-only`,
        );
        const after = store.getTask(id);
        assert.equal(after.status, from, `${label}: rejected store transition must not write`);
        assert.equal(after.version, before.version, `${label}: rejected store transition must not bump version`);
      }
      const allowedId = `T-${label}-DRAFT`;
      createTask(store, "P1", allowedId);
      store[INTERNAL].setTaskStatus(allowedId, "DRAFT");
      const draft = store.getTask(allowedId);
      assert.equal(store.patchTask(allowedId, { expectedVersion: draft.version, changes: { status: "READY" } }).status, "READY", `${label}: DRAFT -> READY is allowed`);
    }
  });

  test("QA-01.4 illegal jumps and DONE without approval are refused with zero writes", async (t) => {
    const f = await backendFixture(t);
    const cases = [
      ["T-DRAFT", "DONE"],
      ["T-ILLEGAL", "REVIEWING"], // READY -> REVIEWING is an execution edge
      ["T-ILLEGAL", "AWAITING_ACCEPTANCE"],
      ["T-READY", "INTEGRATING"],
      ["DONE-NOAPPROVAL", "DONE"],
    ];
    for (const [id, target] of cases) {

      const before = dbFingerprint(f.dbFile);
      const task = f.store.getTask(id);
      const response = await patch(f.ctx, id, target, task.version);
      assert.equal(response.status, 409, `${id} -> ${target}: ${response.text}`);
      assert.equal(response.json.error.code, "TASK_VERSION_CONFLICT");
      assert.deepEqual(dbFingerprint(f.dbFile), before, `${id} -> ${target}: rejected transition wrote something`);
    }
  });

  test("QA-01.5 an invalid runtime-event batch leaves Run/Task/events unchanged", async (t) => {
    const dir = tempDir(t);
    const store = openStore({ file: path.join(dir, "atk.db"), migrate: true });
    t.after(() => { try { store.close(); } catch { /* closed */ } });
    store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const task = createTask(store, "P1", "T-RUN");
    const claim = store.claimTask({ taskId: task.id, agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: "qa-m61-batch" });
    const claimed = store.claimDispatchCommand({ ownerId: "host-qa", leaseMs: 60000 });
    const generation = claimed.lease.generation;
    store.updateRunStatus(claim.run.id, { status: "RUNNING", generation });
    const before = { run: store.getRun(claim.run.id), task: store.getTask(task.id), events: store.listEvents({ aggregateId: claim.run.id, limit: 1000 }) };
    // Contract (unified 2026-11-02): a rejected batch throws StoreError; the
    // all-or-nothing assertion is still the point of this test.
    await assert.rejects(
      async () => store.applyRuntimeEventBatch({
        runId: claim.run.id,
        generation,
        events: [
          { type: "run.log", payload: { line: "ok" }, eventId: "EVT-1", sessionSeq: 1 },
          { type: "run.log", payload: "not-an-object", eventId: "EVT-2", sessionSeq: 2 },
          { type: "run.log", payload: { line: "never" }, eventId: "EVT-3", sessionSeq: 3 },
        ],
      }),
      (error) => error.code === "VALIDATION_ERROR" || error.name === "StoreError",
    );
    assert.deepEqual(store.getRun(claim.run.id), before.run, "Run must not change on a failed batch");
    assert.deepEqual(store.getTask(task.id), before.task, "Task must not change on a failed batch");
    assert.deepEqual(store.listEvents({ aggregateId: claim.run.id, limit: 1000 }), before.events, "no partial events may be written");
  });

  const MANIFEST = "a".repeat(64);
  const PASS_EVIDENCE = { tests: { passed: 1, total: 1 } };
  function passBody(review) {
    return { expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE };
  }
  function makeCompletedRun(f, agentId = "agent-1") {
    const run = f.store.createRun({ taskId: f.task.id, agentId, function: "WORKER", role: "DEV" });
    f.store.updateRunStatus(run.id, { status: "RUNNING" });
    f.store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    return run;
  }
  async function createReview(f, runId) {
    f.store[INTERNAL].setTaskStatus(f.task.id, "RUNNING");
    return request(f.ctx.base, {
      method: "POST",
      path: "/api/v1/reviews",
      headers: writeHeaders(f.ctx.base),
      body: { taskId: f.task.id, runId },
    });
  }
  async function reviewToIntegrating(f) {
    const run = makeCompletedRun(f);
    const created = await createReview(f, run.id);
    assert.equal(created.status, 201, created.text);
    const submitted = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/reviews/${created.json.id}/submit`,
      headers: writeHeaders(f.ctx.base),
      body: passBody(created.json),
    });
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(f.store.getTask(f.task.id).status, "INTEGRATING");
    return { run, review: created.json };
  }

  test("QA-01.6 REVIEWING requires a COMPLETED Run and transitions atomically", async (t) => {
    const f = await backendFixture(t);
    const run = f.store.createRun({ taskId: f.task.id, agentId: "agent-1", function: "WORKER", role: "DEV" });
    const refused = await request(f.ctx.base, {
      method: "POST",
      path: "/api/v1/reviews",
      headers: writeHeaders(f.ctx.base),
      body: { taskId: f.task.id, runId: run.id },
    });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.error.code, "TASK_VERSION_CONFLICT");
    assert.equal(refused.json.error.details.reason, "completed-run-required");
    assert.equal(f.store.getTask(f.task.id).status, "READY");
    f.store.updateRunStatus(run.id, { status: "RUNNING" });
    f.store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    const created = await createReview(f, run.id);
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.status, "PENDING");
    assert.equal(f.store.getTask(f.task.id).status, "REVIEWING");
  });

  test("QA-01.7 PASS is the only public entry into INTEGRATING", async (t) => {
    const f = await backendFixture(t);
    const run = makeCompletedRun(f);
    const created = await createReview(f, run.id);
    assert.equal(created.status, 201, created.text);
    const current = f.store.getTask(f.task.id);
    const patch = await request(f.ctx.base, {
      method: "PATCH",
      path: `/api/v1/tasks/${f.task.id}`,
      headers: writeHeaders(f.ctx.base),
      body: { expectedVersion: current.version, changes: { status: "INTEGRATING" } },
    });
    assert.equal(patch.status, 409);
    assert.equal(patch.json.error.details.reason, "execution-state-guard");
    assert.equal(f.store.getTask(f.task.id).status, "REVIEWING");
    const submitted = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/reviews/${created.json.id}/submit`,
      headers: writeHeaders(f.ctx.base),
      body: passBody(created.json),
    });
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(f.store.getTask(f.task.id).status, "INTEGRATING");
  });

  test("QA-01.8 AWAITING_ACCEPTANCE requires an integration record", async (t) => {
    const f = await backendFixture(t);
    const { run } = await reviewToIntegrating(f);
    const current = f.store.getTask(f.task.id);
    const patch = await request(f.ctx.base, {
      method: "PATCH",
      path: `/api/v1/tasks/${f.task.id}`,
      headers: writeHeaders(f.ctx.base),
      body: { expectedVersion: current.version, changes: { status: "AWAITING_ACCEPTANCE" } },
    });
    assert.equal(patch.status, 409);
    assert.equal(patch.json.error.details.reason, "execution-state-guard");
    assert.equal(f.store.getTask(f.task.id).status, "INTEGRATING");
    const integration = await request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${f.task.id}/integration`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, "user-action"), "content-type": "application/json" },
      body: { taskId: f.task.id, runId: run.id, commitSha: "b".repeat(40), manifestHash: MANIFEST },
    });
    assert.equal(integration.status, 200, integration.text);
    assert.equal(f.store.getTask(f.task.id).status, "AWAITING_ACCEPTANCE");
  });

  test("QA-01.9 DONE is reachable only through a matching human approval", async (t) => {
    const f = await backendFixture(t);
    await reviewToIntegrating(f);
    const run = f.store.listRuns({ taskId: f.task.id }).at(-1);
    const manifestHash = "c".repeat(64);
    // Use a fresh PASS review target hash for this acceptance cycle.
    const currentRun = makeCompletedRun(f);
    const created = await createReview(f, currentRun.id);
    assert.equal(created.status, 201, created.text);
    const submitted = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/reviews/${created.json.id}/submit`,
      headers: writeHeaders(f.ctx.base),
      body: passBody(created.json),
    });
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(f.store.getTask(f.task.id).status, "INTEGRATING");
    const integration = await request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${f.task.id}/integration`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, "user-action"), "content-type": "application/json" },
      body: { taskId: f.task.id, runId: currentRun.id, commitSha: "d".repeat(40), manifestHash: MANIFEST },
    });
    assert.equal(integration.status, 200, integration.text);
    const awaiting = f.store.getTask(f.task.id);
    assert.equal(awaiting.status, "AWAITING_ACCEPTANCE");
    const patch = await request(f.ctx.base, {
      method: "PATCH",
      path: `/api/v1/tasks/${f.task.id}`,
      headers: writeHeaders(f.ctx.base),
      body: { expectedVersion: awaiting.version, changes: { status: "DONE" } },
    });
    assert.equal(patch.status, 409);
    assert.equal(patch.json.error.details.reason, "execution-state-guard");
    const approval = f.store.createApproval({ taskId: f.task.id, scope: "qa", targetHash: MANIFEST, actor: "HUMAN" });
    const stale = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/approvals/${approval.id}/decide`,
      headers: writeHeaders(f.ctx.base),
      body: { decision: "APPROVED", targetHash: "e".repeat(64), actor: "agent-evil" },
    });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.error.code, "APPROVAL_STALE");
    assert.equal(f.store.getTask(f.task.id).status, "AWAITING_ACCEPTANCE");
    const decided = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/approvals/${approval.id}/decide`,
      headers: writeHeaders(f.ctx.base),
      body: { decision: "APPROVED", targetHash: MANIFEST, actor: "agent-evil" },
    });
    assert.equal(decided.status, 200, decided.text);
    assert.equal(f.store.getTask(f.task.id).status, "DONE");
    const events = f.store.listEvents({ aggregateId: approval.id, type: "approval.recorded", limit: 10 });
    assert.equal(events.at(-1)?.payload?.principal, "HUMAN");
    void run;
    void manifestHash;
  });
}





