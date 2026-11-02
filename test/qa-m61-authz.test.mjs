// M6.1 independent QA-03: permission and identity boundary (QA-007 style).
//
// Status: the M6.1 branch is still being implemented. Tests for landed behaviour
// run against a real HTTP backend + real SQLite. Tests that depend on pending
// WP2 review assignments / integration records are explicitly skipped, never
// reported as passes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);

let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

if (!hasSqlite) {
  test("qa-m61 authz suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5" }, () => {});
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { openStore } = await load("packages/database/src/index.mjs");
  const { INTERNAL } = await load("packages/database/src/internal.mjs");
  const { normalizeRepoPath, pathsOverlap } = await load("packages/contracts/src/paths.mjs");
  const { filesIntersection } = await load("packages/database/src/model.mjs");
  const helpers = await load("apps/backend/test/helpers.mjs");
  const { startServer, request, writeHeaders, internalHeaders, TEST_TOKEN, TEST_INTERNAL_TOKEN } = helpers;

  function tempDir(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m61-authz-"));
    t.after(() => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* busy */ }
      }
    });
    return dir;
  }
  function setStatus(dbFile, taskId, status) {
    const raw = new DatabaseSync(dbFile);
    try {
      raw.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
    } finally {
      raw.close();
    }
  }

  async function fixture(t, { status = "READY", withReview = false } = {}) {
    const dir = tempDir(t);
    const dbFile = path.join(dir, "data", "atk.db");
    const store = openStore({ file: dbFile, migrate: true });
    const project = store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    const task = store.createTask({ id: "T1", projectId: project.id, title: "task", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    if (status !== "READY") setStatus(dbFile, task.id, status);
    let review = null;
    let run = null;
    if (withReview) {
      run = store.createRun({ taskId: task.id, agentId: "agent-author", function: "WORKER", role: "DEV" });
      store.updateRunStatus(run.id, { status: "RUNNING" });
      store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
      setStatus(dbFile, task.id, "REVIEWING");
      review = store.createReview({ taskId: task.id, runId: run.id, actor: "HUMAN" });
    }
    const ctx = await startServer({ store, logger: { info() {}, warn() {}, error() {} } });
    t.after(async () => {
      await ctx.server.close().catch(() => {});
      try { store.close(); } catch { /* closed */ }
    });
    return { dir, dbFile, store, task, review, run, ctx };
  }

  const PASS_BODY = (review) => ({ expectedVersion: review.version, verdict: "PASS", manifestHash: "a".repeat(64), evidence: { tests: { passed: 1, total: 1 } } });

  test("QA-03.1 body.actor cannot turn a human review into an agent self-review", async (t) => {
    const f = await fixture(t, { withReview: true });
    const response = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/reviews/${f.review.id}/submit`,
      headers: writeHeaders(f.ctx.base),
      body: { ...PASS_BODY(f.review), actor: "agent-author" },
    });
    assert.equal(response.status, 200, response.text);
    const raw = new DatabaseSync(f.dbFile, { readOnly: true });
    let reviewer;
    try {
      reviewer = raw.prepare("SELECT reviewer FROM reviews WHERE id = ?").get(f.review.id)?.reviewer;
    } finally {
      raw.close();
    }
    assert.equal(reviewer, "HUMAN", "the reviewer must come from the trusted principal, not body.actor");
    const events = f.store.listEvents({ aggregateId: f.review.id });
    assert.ok(!JSON.stringify(events).includes("agent-author"), "body.actor must not be persisted as the reviewer");
  });

  test("QA-03.2 the internal credential is runtime-host-only on review submit", async (t) => {
    const f = await fixture(t, { withReview: true });
    const submit = (role) => request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/reviews/${f.review.id}/submit`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, role), "content-type": "application/json" },
      body: PASS_BODY(f.review),
    });
    const missing = await submit("");
    assert.equal(missing.status, 403);
    assert.equal(missing.json.error.code, "NOT_AUTHORIZED");
    assert.equal(missing.json.error.details.reason, "internal-role-required");
    const scheduler = await submit("scheduler");
    assert.equal(scheduler.status, 403);
    assert.equal(scheduler.json.error.details.reason, "internal-role-forbidden");
    const runtimeHost = await submit("runtime-host");
    assert.equal(runtimeHost.status, 403, "a HUMAN assignment cannot be submitted with the runtime-host credential");
    assert.equal(runtimeHost.json.error.details.reason, "review-assignment-required");
  });

  test("QA-03.3 internal role matrix is deny-by-default and endpoint-scoped (real HTTP)", async (t) => {
    const f = await fixture(t, { status: "READY" });
    const claim = (role) => request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${f.task.id}/claim`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, role), "content-type": "application/json" },
      body: { agentId: "agent-1", expectedTaskVersion: f.task.version, idempotencyKey: "qa-m61-role" },
    });
    const missing = await claim("");
    assert.equal(missing.status, 403);
    assert.equal(missing.json.error.details.reason, "internal-role-required");
    const wrong = await claim("runtime-host");
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.error.details.reason, "internal-role-forbidden");
    const unknown = await claim("root");
    assert.equal(unknown.status, 403);
    assert.equal(unknown.json.error.details.reason, "internal-role-forbidden");
    const allowed = await claim("scheduler");
    assert.notEqual(allowed.status, 403, `scheduler must pass the role gate: ${allowed.text}`);
  });

  test("QA-03.4 credential planes cannot be swapped (session鈫攊nternal)", async (t) => {
    const f = await fixture(t, { status: "READY" });
    const sessionOnInternal = await request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${f.task.id}/claim`,
      headers: { "content-type": "application/json", "x-atk-token": TEST_TOKEN },
      body: { agentId: "agent-1", expectedTaskVersion: f.task.version, idempotencyKey: "qa-m61-plane-1" },
    });
    assert.ok(sessionOnInternal.status === 401 || sessionOnInternal.status === 403, `session token must not authenticate the internal plane: ${sessionOnInternal.status} ${sessionOnInternal.text}`);
    assert.equal(sessionOnInternal.json.error.code, "NOT_AUTHORIZED");
    const internalOnBrowser = await request(f.ctx.base, {
      method: "GET",
      path: "/api/v1/approvals",
      headers: internalHeaders(TEST_INTERNAL_TOKEN, "scheduler"),
    });
    assert.ok(internalOnBrowser.status === 401 || internalOnBrowser.status === 403, `the browser API must never accept x-atk-internal: ${internalOnBrowser.status} ${internalOnBrowser.text}`);
    assert.equal(internalOnBrowser.json.error.code, "NOT_AUTHORIZED");
  });

  test("QA-03.5 repository path rules agree across contracts / database / scheduler-core", async () => {
    const cases = [
      ["src", "src/a.ts", true],
      ["src/", "src/a.ts", true],
      ["src", "src2/a.ts", false],
      ["src\\a.ts", "./src/a.ts", true],
      [" src ", "src/a.ts", true],
      ["src/a.ts", "src/A.ts", false],
    ];
    for (const [left, right, expected] of cases) {
      const database = filesIntersection([left], [right]).length > 0;
      const scheduler = pathsOverlap(normalizeRepoPath(left), normalizeRepoPath(right));
      assert.equal(database, expected, `database rule for ${left} vs ${right}`);
      assert.equal(scheduler, expected, `scheduler rule for ${left} vs ${right}`);
      assert.equal(database, scheduler, `layers diverge on ${left} vs ${right}`);
    }
    for (const escape of ["../outside", "a/../../outside", "/abs/path"]) {
      assert.throws(() => normalizeRepoPath(escape), `contracts must reject ${escape}`);
      assert.throws(() => filesIntersection([escape], ["src"]), `database must reject ${escape}`);
    }
  });

  test("QA-03.5b a Windows drive-absolute path must be rejected by the shared rules", async () => {
    // On Windows "C:\\abs\\path" is an absolute host path. The contract says all
    // scope paths are repository-relative, and the legacy importer already
    // rejects /^[A-Za-z]:/; the shared F13 normaliser must not disagree.
    assert.throws(() => normalizeRepoPath("C:\\abs\\path"), "contracts must reject a Windows drive-absolute path");
    assert.throws(() => filesIntersection(["C:\\abs\\path"], ["src"]), "database must reject a Windows drive-absolute path");
  });

  test("QA-03.6 the launcher never puts the browser session token into child env", async (t) => {
    const { createLauncher } = await load("apps/launcher/src/launcher.mjs");
    const fake = await load("apps/launcher/test/fake.mjs");
    const { createFakeSpawn, createHealthyFetch, createClock, createAliveMap, FAKE_TOKEN } = fake;
    const dir = tempDir(t);
    const spawn = createFakeSpawn();
    const alive = createAliveMap();
    const clock = createClock();
    const launcher = createLauncher({
      dataDir: path.join(dir, "data"),
      port: 1461,
      hosts: 2,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: createHealthyFetch(),
      logger: { info() {}, warn() {}, error() {} },
      now: clock.now,
      sleep: clock.sleep,
      isAliveImpl: alive.isAlive,
      killImpl: alive.kill,
      settleMs: 0,
      healthTimeoutMs: 1000,
      healthIntervalMs: 10,
      tokenTimeoutMs: 1000,
      stopTimeoutMs: 100,
      stopPollMs: 10,
      repoRoot: REPO,
    });
    t.after(async () => { try { await launcher.stop(); } catch { /* ignore */ } });
    await launcher.start();
    const scheduler = spawn.calls.find((call) => call.name === "scheduler");
    const hosts = spawn.calls.filter((call) => call.name.startsWith("host-"));
    const backend = spawn.calls.find((call) => call.name === "backend");
    assert.ok(scheduler && hosts.length === 2 && backend, "all children must be spawned");
    for (const call of [scheduler, ...hosts]) {
      assert.equal(call.options.env.ATK_INTERNAL_TOKEN, FAKE_TOKEN, `${call.name} gets the internal credential via env`);
      const tokenKeys = new Set(["ATK_SESSION_TOKEN", "ATK_TOKEN", "X_ATK_TOKEN", "ATK_CSRF", "ATK_CSRF_TOKEN", "SESSION_TOKEN"]);
      for (const key of Object.keys(call.options.env)) {
        assert.equal(tokenKeys.has(key), false, `${call.name} must not inherit ${key}`);
      }
      assert.equal(JSON.stringify(call.options.env).includes("session-token"), false, `${call.name} env mentions the session token file`);
    }
    for (const key of ["ATK_SESSION_TOKEN", "ATK_TOKEN", "X_ATK_TOKEN", "ATK_CSRF", "ATK_CSRF_TOKEN", "SESSION_TOKEN"]) {
      assert.equal(key in backend.options.env, false, `backend must not inherit ${key}`);
    }
    assert.equal(JSON.stringify(backend.options.env).includes(FAKE_TOKEN), false, "the backend creates the token; it does not receive it");
    const stateText = readFileSync(path.join(dir, "data", "launcher.json"), "utf8");
    assert.equal(stateText.includes(FAKE_TOKEN), false, "launcher state must not persist the internal token");
    // Strength note: on Windows there is no portable "read another process's env"
    // API. This captures the REAL env objects handed to spawn by the launcher;
    // it is a spawn-boundary proof, not a kernel-level isolation claim.
  });

  test("QA-03.7 AGENT assignment is created by a trusted action and submits only with runtime-host", async (t) => {
    const f = await fixture(t);
    f.store.upsertAgent({ id: "agent-2", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const run = f.store.createRun({ taskId: f.task.id, agentId: "agent-author", function: "WORKER", role: "DEV" });
    f.store.updateRunStatus(run.id, { status: "RUNNING" });
    f.store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    f.store[INTERNAL].setTaskStatus(f.task.id, "RUNNING");
    const reviewerRun = f.store.createRun({ taskId: f.task.id, agentId: "agent-2", function: "WORKER", role: "DEV" });
    const created = await request(f.ctx.base, {
      method: "POST",
      path: "/api/v1/reviews",
      headers: writeHeaders(f.ctx.base),
      body: { taskId: f.task.id, runId: run.id, assignedTo: "AGENT", reviewerAgentId: "agent-2" },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.assignedTo, "AGENT");
    assert.equal(created.json.reviewerAgentId, "agent-2");
    const review = created.json;
    const sessionSubmit = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/reviews/${review.id}/submit`,
      headers: writeHeaders(f.ctx.base),
      body: PASS_BODY(review),
    });
    assert.equal(sessionSubmit.status, 403, "a browser session must not submit an AGENT-assigned review");
    assert.equal(sessionSubmit.json.error.details.reason, "review-requires-runtime-host");
    const internal = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/reviews/${review.id}/submit`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, "runtime-host"), "content-type": "application/json" },
      body: { ...PASS_BODY(review), actor: "agent-1", runId: reviewerRun.id },
    });
    assert.equal(internal.status, 200, internal.text);
    const raw = new DatabaseSync(f.dbFile, { readOnly: true });
    let row;
    try { row = raw.prepare("SELECT reviewer, reviewer_agent_id AS reviewerAgentId FROM reviews WHERE id = ?").get(review.id); } finally { raw.close(); }
    assert.equal(row.reviewer, "agent-2", "the reviewer comes from the assignment, not body.actor");
    assert.equal(row.reviewerAgentId, "agent-2");
  });

  test("QA-03.7b an AGENT review whose reviewer is the author is refused at creation", async (t) => {
    const f = await fixture(t);
    const run = f.store.createRun({ taskId: f.task.id, agentId: "agent-author", function: "WORKER", role: "DEV" });
    f.store.updateRunStatus(run.id, { status: "RUNNING" });
    f.store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    f.store[INTERNAL].setTaskStatus(f.task.id, "RUNNING");
    const before = new DatabaseSync(f.dbFile, { readOnly: true });
    let reviewsBefore;
    try { reviewsBefore = Number(before.prepare("SELECT COUNT(*) AS c FROM reviews").get().c); } finally { before.close(); }
    const created = await request(f.ctx.base, {
      method: "POST",
      path: "/api/v1/reviews",
      headers: writeHeaders(f.ctx.base),
      body: { taskId: f.task.id, runId: run.id, assignedTo: "AGENT", reviewerAgentId: "agent-author" },
    });
    assert.ok(created.status === 403 || created.status === 409, created.text);
    assert.equal(created.json.error.code, "SELF_REVIEW_FORBIDDEN");
    const after = new DatabaseSync(f.dbFile, { readOnly: true });
    let reviewsAfter;
    try { reviewsAfter = Number(after.prepare("SELECT COUNT(*) AS c FROM reviews").get().c); } finally { after.close(); }
    assert.equal(reviewsAfter, reviewsBefore, "a refused self-assignment must not create a review");
    assert.equal(f.store.getTask(f.task.id).status, "RUNNING");
  });

  test("QA-03.8 approval events are server-filled HUMAN with hash binding", async (t) => {
    const f = await fixture(t);
    const targetHash = "d".repeat(64);
    const raw = new DatabaseSync(f.dbFile);
    try {
      raw.prepare("UPDATE tasks SET status = 'AWAITING_ACCEPTANCE', target_hash = ? WHERE id = ?").run(targetHash, f.task.id);
    } finally { raw.close(); }
    const approval = f.store.createApproval({ taskId: f.task.id, scope: "qa acceptance", targetHash, actor: "HUMAN" });
    const response = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/approvals/${approval.id}/decide`,
      headers: writeHeaders(f.ctx.base),
      body: { decision: "APPROVED", targetHash, actor: "agent-evil" },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(f.store.getTask(f.task.id).status, "DONE");
    const events = f.store.listEvents({ aggregateId: approval.id, type: "approval.recorded", limit: 10 });
    const payload = events.at(-1)?.payload;
    assert.ok(payload, "the decision event must be recorded");
    assert.equal(payload.principal, "HUMAN");
    assert.equal(payload.operation, "approval.decide");
    assert.equal(payload.targetHash, targetHash);
    assert.equal(payload.targetVersion, f.store.getTask(f.task.id).version);
    assert.equal(JSON.stringify(payload).includes("agent-evil"), false, "body.actor must not enter the approval event");
  });

  test("QA-03.9 integration is role-scoped and bound to the task manifest", async (t) => {
    const f = await fixture(t);
    const targetHash = "e".repeat(64);
    const run = f.store.createRun({ taskId: f.task.id, agentId: "agent-author", function: "WORKER", role: "DEV" });
    f.store.updateRunStatus(run.id, { status: "RUNNING" });
    f.store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    const raw = new DatabaseSync(f.dbFile);
    try {
      raw.prepare("UPDATE tasks SET status = 'INTEGRATING', target_hash = ? WHERE id = ?").run(targetHash, f.task.id);
    } finally { raw.close(); }
    const body = { taskId: f.task.id, runId: run.id, commitSha: "a".repeat(40), manifestHash: targetHash };
    const attempt = (role) => request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${f.task.id}/integration`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, role), "content-type": "application/json" },
      body,
    });
    const missing = await attempt("");
    assert.equal(missing.status, 403);
    assert.equal(missing.json.error.details.reason, "internal-role-required");
    const wrong = await attempt("runtime-host");
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.error.details.reason, "internal-role-forbidden");
    // user-action is allowed; a wrong manifest is refused before any write.
    const wrongBody = await request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${f.task.id}/integration`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, "user-action"), "content-type": "application/json" },
      body: { ...body, manifestHash: "f".repeat(64) },
    });
    assert.equal(wrongBody.status, 409, wrongBody.text);
    assert.equal(wrongBody.json.error.code, "APPROVAL_STALE");
    const accepted = await attempt("user-action");
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json.task.status, "AWAITING_ACCEPTANCE");
    const rawCheck = new DatabaseSync(f.dbFile, { readOnly: true });
    let count;
    try { count = Number(rawCheck.prepare("SELECT COUNT(*) AS c FROM integrations WHERE task_id = ?").get(f.task.id).c); } finally { rawCheck.close(); }
    assert.equal(count, 1);
  });
}

