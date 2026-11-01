// M4 independent QA: adversarial regression suite (QA-005).
//
// Scope: the frozen M4 review/acceptance layer at 36c9b55 - self-review ban,
// PASS evidence gate, human-acceptance hash binding, the rework loop, the single
// DONE entrance, events, migration and the m4-smoke gate itself.
//
// Tests are written against docs/architecture/m4-contracts.md (and the M4 status
// rulings), not against the implementation. A failing test here is a finding.
//
// Node < 22.5 has no node:sqlite: the whole file is skipped, never "passed".
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "apps", "backend", "cli.mjs");
const STATE = path.join(REPO, ".agent-flow", "state.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const MANIFEST = "c".repeat(64);
const PASS_EVIDENCE = { tests: { passed: 2, total: 2 } };

let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

if (!hasSqlite) {
  test("m4 adversarial suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5; this file is skipped, not passed" }, () => {});
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { openStore } = await import(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href);

  function freePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
  }

  async function makeEnv(t) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m4-qa-"));
    const dbFile = path.join(tmp, "atk.db");
    const migrated = spawnSync(process.execPath, [CLI, "migrate", "--data", dbFile, "--from", STATE, "--json"], { cwd: REPO, encoding: "utf8", windowsHide: true });
    assert.equal(migrated.status, 0, `migrate failed: ${migrated.stderr || migrated.stdout}`);
    const store = openStore({ file: dbFile, migrate: true });
    const project = store.listProjects()[0];
    const env = {
      tmp,
      dbFile,
      store,
      project,
      backend: null,
      base: null,
      token: null,
      csrf: null,
      makeAgent(id, overrides = {}) {
        return store.upsertAgent({ id, role: "DEV", capabilities: ["WORKER"], status: "IDLE", ...overrides });
      },
      makeTask(id) {
        let task = store.createTask({ id, projectId: project.id, title: id, description: `qa ${id}`, functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "qa" });
        for (const status of ["CLAIMED", "RUNNING", "REVIEWING"]) task = store.patchTask(id, { expectedVersion: task.version, changes: { status } });
        return task;
      },
      toAwaiting(id) {
        env.makeTask(id);
        let task = store.getTask(id);
        for (const status of ["INTEGRATING", "AWAITING_ACCEPTANCE"]) task = store.patchTask(id, { expectedVersion: task.version, changes: { status } });
        return task;
      },
      makeRun(taskId, agentId = "agent-dev-1") {
        const run = store.createRun({ taskId, agentId, function: "WORKER", role: "DEV" });
        store.updateRunStatus(run.id, { status: "RUNNING" });
        store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
        return store.getRun(run.id);
      },
      createReview(taskId, runId = null, actor = "HUMAN") {
        return store.createReview({ taskId, runId, actor });
      },
      raw() {
        return new DatabaseSync(dbFile);
      },
      async startBackend() {
        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        const child = spawn(process.execPath, [CLI, "serve", "--port", String(port), "--data", dbFile], { cwd: REPO, windowsHide: true, env: { ...process.env, LOCALAPPDATA: tmp } });
        env.backend = child;
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        let healthy = false;
        for (let i = 0; i < 120; i += 1) {
          try {
            if ((await fetch(`http://127.0.0.1:${port}/api/v1/system/health`)).ok) {
              healthy = true;
              break;
            }
          } catch {
            /* not up yet */
          }
          await sleep(50);
        }
        assert.ok(healthy, `backend did not start: ${output.slice(-400)}`);
        const session = await (await fetch(`${base}/api/v1/session`)).json();
        env.base = base;
        env.token = session.token;
        env.csrf = session.csrf;
        env.api = async (method, route, body) => {
          const response = await fetch(`${base}${route}`, {
            method,
            headers: { "x-atk-token": session.token, "x-atk-csrf": session.csrf, "content-type": "application/json", origin: base },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const text = await response.text();
          let payload = null;
          try {
            payload = text ? JSON.parse(text) : null;
          } catch {
            payload = null;
          }
          return { status: response.status, payload, code: payload?.error?.code ?? null };
        };
        return env;
      },
    };
    t.after(async () => {
      if (env.backend && env.backend.exitCode === null) {
        env.backend.kill();
        for (let i = 0; i < 40 && env.backend.exitCode === null; i += 1) await sleep(25);
      }
      try {
        store.close();
      } catch {
        /* already closed */
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(tmp, { recursive: true, force: true });
          return;
        } catch {
          await sleep(150);
        }
      }
    });
    return env;
  }

  function dbRows(env, sql, ...params) {
    const raw = env.raw();
    try {
      return raw.prepare(sql).all(...params);
    } finally {
      raw.close();
    }
  }
  function dbRow(env, sql, ...params) {
    const raw = env.raw();
    try {
      return raw.prepare(sql).get(...params) ?? null;
    } finally {
      raw.close();
    }
  }
  function reviewRow(env, id) {
    return dbRow(env, "SELECT id, task_id AS taskId, run_id AS runId, status, verdict, reviewer, attempt, version FROM reviews WHERE id = ?", id);
  }
  function taskRow(env, id) {
    return dbRow(env, "SELECT id, status, version, target_hash AS targetHash FROM tasks WHERE id = ?", id);
  }

  // -------------------------------------------------------------------------
  // A. self-review gate
  // -------------------------------------------------------------------------
  test("A1 the exact author agent cannot submit a review (403, zero writes)", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("SELF-EXACT");
    const run = env.makeRun("SELF-EXACT", "agent-dev-1");
    const review = env.createReview("SELF-EXACT", run.id);
    await env.startBackend();
    const eventsBefore = Number(dbRow(env, "SELECT COUNT(*) AS c FROM events").c);
    const response = await env.api("POST", `/api/v1/reviews/${review.id}/submit`, { expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE, actor: "agent-dev-1" });
    assert.equal(response.status, 403);
    assert.equal(response.code, "SELF_REVIEW_FORBIDDEN");
    assert.equal(reviewRow(env, review.id).status, "PENDING");
    assert.equal(reviewRow(env, review.id).reviewer, null);
    assert.equal(taskRow(env, "SELF-EXACT").status, "REVIEWING");
    assert.equal(Number(dbRow(env, "SELECT COUNT(*) AS c FROM events").c), eventsBefore, "a refused self-review must not write events");
  });

  test("A2 without runId the latest Run's agent is still recognised as the author", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("SELF-NORUN");
    env.makeRun("SELF-NORUN", "agent-dev-1");
    const review = env.createReview("SELF-NORUN", null);
    await env.startBackend();
    const response = await env.api("POST", `/api/v1/reviews/${review.id}/submit`, { expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE, actor: "agent-dev-1" });
    assert.equal(response.status, 403, "the proxy author detection (latest Run agent) must fire");
    assert.equal(response.code, "SELF_REVIEW_FORBIDDEN");
    assert.equal(reviewRow(env, review.id).status, "PENDING");
    assert.equal(taskRow(env, "SELF-NORUN").status, "REVIEWING");
  });

  test("A3 whitespace and case variants of the author id must still be refused", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    const variants = [
      ["leading-space", " agent-dev-1"],
      ["trailing-space", "agent-dev-1 "],
      ["upper-case", "AGENT-DEV-1"],
    ];
    await env.startBackend();
    for (const [name, actor] of variants) {
      const taskId = `SELF-VARIANT-${name}`;
      env.makeTask(taskId);
      const run = env.makeRun(taskId, "agent-dev-1");
      const review = env.createReview(taskId, run.id);
      const response = await env.api("POST", `/api/v1/reviews/${review.id}/submit`, { expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE, actor });
      assert.notEqual(response.status, 200, `${name}: actor ${JSON.stringify(actor)} of the author must be refused, got 200`);
      assert.equal(reviewRow(env, review.id).status, "PENDING", `${name}: review must stay PENDING`);
      assert.equal(taskRow(env, taskId).status, "REVIEWING", `${name}: task must stay REVIEWING`);
    }
  });

  test("A4 a submit without actor is recorded as HUMAN (documented trust boundary)", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("SELF-NOACTOR");
    const run = env.makeRun("SELF-NOACTOR", "agent-dev-1");
    const review = env.createReview("SELF-NOACTOR", run.id);
    await env.startBackend();
    const response = await env.api("POST", `/api/v1/reviews/${review.id}/submit`, { expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE });
    assert.equal(response.status, 200, "server.mjs documents that a missing actor defaults to HUMAN for browser sessions");
    assert.equal(reviewRow(env, review.id).reviewer, "HUMAN");
    assert.equal(taskRow(env, "SELF-NOACTOR").status, "INTEGRATING");
  });

  // -------------------------------------------------------------------------
  // B. evidence gate
  // -------------------------------------------------------------------------
  test("B1 PASS evidence matrix is refused with EVIDENCE_MISSING and zero writes", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    const cases = [
      ["no-manifest", { verdict: "PASS", evidence: PASS_EVIDENCE }],
      ["passed-below-total", { verdict: "PASS", manifestHash: MANIFEST, evidence: { tests: { passed: 1, total: 2 } } }],
      ["total-zero", { verdict: "PASS", manifestHash: MANIFEST, evidence: { tests: { passed: 0, total: 0 } } }],
      ["passed-string", { verdict: "PASS", manifestHash: MANIFEST, evidence: { tests: { passed: "2", total: 2 } } }],
      ["evidence-string", { verdict: "PASS", manifestHash: MANIFEST, evidence: "all green" }],
      ["passed-negative", { verdict: "PASS", manifestHash: MANIFEST, evidence: { tests: { passed: -1, total: 2 } } }],
    ];
    for (const [name, body] of cases) {
      const taskId = `EVIDENCE-${name}`;
      env.makeTask(taskId);
      const run = env.makeRun(taskId, "agent-dev-1");
      const review = env.createReview(taskId, run.id);
      const before = { review: reviewRow(env, review.id), task: taskRow(env, taskId), events: Number(dbRow(env, "SELECT COUNT(*) AS c FROM events").c) };
      let error = null;
      try {
        env.store.submitReview({ id: review.id, expectedVersion: review.version, actor: "agent-dev-2", ...body });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error, `${name}: PASS with bad evidence must fail`);
      assert.equal(error.code, "EVIDENCE_MISSING", `${name}: wrong code ${error.code}`);
      assert.deepEqual(reviewRow(env, review.id), before.review, `${name}: review row changed`);
      assert.deepEqual(taskRow(env, taskId), before.task, `${name}: task row changed`);
      assert.equal(Number(dbRow(env, "SELECT COUNT(*) AS c FROM events").c), before.events, `${name}: events written`);
    }
  });

  test("B2 findings are required for CHANGES_REQUESTED but optional for PASS/BLOCKED", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    const setup = (taskId) => {
      env.makeTask(taskId);
      const run = env.makeRun(taskId, "agent-dev-1");
      return env.createReview(taskId, run.id);
    };
    const pass = setup("FIND-PASS");
    assert.equal(env.store.submitReview({ id: pass.id, expectedVersion: pass.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE, actor: "agent-dev-2" }).review.status, "PASS");
    const blocked = setup("FIND-BLOCKED");
    assert.equal(env.store.submitReview({ id: blocked.id, expectedVersion: blocked.version, verdict: "BLOCKED", actor: "agent-dev-2" }).review.status, "BLOCKED");
    const changes = setup("FIND-CHANGES");
    assert.throws(
      () => env.store.submitReview({ id: changes.id, expectedVersion: changes.version, verdict: "CHANGES_REQUESTED", actor: "agent-dev-2" }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.equal(reviewRow(env, changes.id).status, "PENDING");
    const withFindings = env.store.submitReview({ id: changes.id, expectedVersion: changes.version, verdict: "CHANGES_REQUESTED", findings: [{ code: "OFF_BY_ONE", message: "fix" }], actor: "agent-dev-2" });
    assert.equal(withFindings.review.status, "CHANGES_REQUESTED");
  });

  test("B3 absurdly large-but-equal evidence counters must be refused", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("EVIDENCE-HUGE");
    const run = env.makeRun("EVIDENCE-HUGE", "agent-dev-1");
    const review = env.createReview("EVIDENCE-HUGE", run.id);
    assert.throws(
      () => env.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: { tests: { passed: 1e15, total: 1e15 } }, actor: "agent-dev-2" }),
      "absurdly large but equal evidence counters must not be accepted as a real green run",
    );
    assert.equal(reviewRow(env, review.id).status, "PENDING");
  });

  // -------------------------------------------------------------------------
  // C. human acceptance / hash binding
  // -------------------------------------------------------------------------
  test("C1 a wrong targetHash is APPROVAL_STALE and leaves task+approval untouched", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("ACCEPT-STALE");
    const staleRun = env.makeRun("ACCEPT-STALE", "agent-dev-1");
    const staleReview = env.createReview("ACCEPT-STALE", staleRun.id);
    env.store.submitReview({ id: staleReview.id, expectedVersion: staleReview.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE, actor: "agent-dev-2" });
    let staleTask = env.store.getTask("ACCEPT-STALE");
    staleTask = env.store.patchTask("ACCEPT-STALE", { expectedVersion: staleTask.version, changes: { status: "AWAITING_ACCEPTANCE" } });
    const targetHash = taskRow(env, "ACCEPT-STALE").targetHash || HEX_A;
    const otherHash = targetHash === HEX_A ? HEX_B : HEX_A;
    await env.startBackend();
    const created = await env.api("POST", "/api/v1/approvals", { taskId: "ACCEPT-STALE", scope: "candidate", targetHash });
    assert.equal(created.status, 201);
    const approval = created.payload?.approval ?? created.payload;
    const eventsBefore = Number(dbRow(env, "SELECT COUNT(*) AS c FROM events").c);
    const decided = await env.api("POST", `/api/v1/approvals/${approval.id}/decide`, { decision: "APPROVED", targetHash: otherHash });
    assert.equal(decided.status, 409);
    assert.equal(decided.code, "APPROVAL_STALE");
    assert.equal(dbRow(env, "SELECT status FROM approvals WHERE id = ?", approval.id).status, "PENDING");
    assert.equal(taskRow(env, "ACCEPT-STALE").status, "AWAITING_ACCEPTANCE");
    assert.equal(Number(dbRow(env, "SELECT COUNT(*) AS c FROM events").c), eventsBefore, "a stale acceptance must not write events");
  });

  test("C2 a task awaiting acceptance must carry the target hash the approval is bound to", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("ACCEPT-TARGET");
    const run = env.makeRun("ACCEPT-TARGET", "agent-dev-1");
    const review = env.createReview("ACCEPT-TARGET", run.id);
    env.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE, actor: "agent-dev-2" });
    let task = env.store.getTask("ACCEPT-TARGET");
    task = env.store.patchTask("ACCEPT-TARGET", { expectedVersion: task.version, changes: { status: "AWAITING_ACCEPTANCE" } });
    const row = taskRow(env, "ACCEPT-TARGET");
    assert.equal(row.status, "AWAITING_ACCEPTANCE");
    assert.ok(typeof row.targetHash === "string" && row.targetHash.length > 0, "m4-contracts §0.3 requires the approval hash to match the target's current hash; the frozen tree never writes tasks.target_hash, so acceptance degenerates to an echo of the caller's own hash");
  });

  test("C3 when a task target_hash exists the stale guard fires and a matching hash reaches DONE", async (t) => {
    const env = await makeEnv(t);
    env.toAwaiting("ACCEPT-CODE");
    const raw = env.raw();
    try {
      raw.prepare("UPDATE tasks SET target_hash = ? WHERE id = 'ACCEPT-CODE'").run(HEX_B);
    } finally {
      raw.close();
    }
    await env.startBackend();
    const created = await env.api("POST", "/api/v1/approvals", { taskId: "ACCEPT-CODE", scope: "candidate", targetHash: HEX_B });
    const approval = created.payload?.approval ?? created.payload;
    const stale = await env.api("POST", `/api/v1/approvals/${approval.id}/decide`, { decision: "APPROVED", targetHash: HEX_A });
    assert.equal(stale.status, 409);
    assert.equal(stale.code, "APPROVAL_STALE");
    assert.equal(taskRow(env, "ACCEPT-CODE").status, "AWAITING_ACCEPTANCE");
    // A fresh approval with a matching hash succeeds.
    const matching = await env.api("POST", "/api/v1/approvals", { taskId: "ACCEPT-CODE", scope: "candidate", targetHash: HEX_B });
    const matchingApproval = matching.payload?.approval ?? matching.payload;
    const accepted = await env.api("POST", `/api/v1/approvals/${matchingApproval.id}/decide`, { decision: "APPROVED", targetHash: HEX_B });
    assert.equal(accepted.status, 200);
    assert.equal(taskRow(env, "ACCEPT-CODE").status, "DONE");
  });

  test("C4 a decided approval cannot be decided twice and rejected acceptance re-queues READY", async (t) => {
    const env = await makeEnv(t);
    env.toAwaiting("ACCEPT-TWICE");
    env.toAwaiting("ACCEPT-REJECT");
    {
      const raw = env.raw();
      try {
        raw.prepare("UPDATE tasks SET target_hash = ? WHERE id IN ('ACCEPT-TWICE','ACCEPT-REJECT')").run(HEX_A);
      } finally {
        raw.close();
      }
    }
    await env.startBackend();
    const created = await env.api("POST", "/api/v1/approvals", { taskId: "ACCEPT-TWICE", scope: "candidate", targetHash: HEX_A });
    const approval = created.payload?.approval ?? created.payload;
    assert.equal((await env.api("POST", `/api/v1/approvals/${approval.id}/decide`, { decision: "APPROVED", targetHash: HEX_A })).status, 200);
    assert.equal(taskRow(env, "ACCEPT-TWICE").status, "DONE");
    const again = await env.api("POST", `/api/v1/approvals/${approval.id}/decide`, { decision: "REJECTED", targetHash: HEX_A });
    assert.equal(again.status, 409);
    assert.equal(taskRow(env, "ACCEPT-TWICE").status, "DONE", "a decided approval must not move the task again");

    const rejectedCreated = await env.api("POST", "/api/v1/approvals", { taskId: "ACCEPT-REJECT", scope: "candidate", targetHash: HEX_A });
    const rejectedApproval = rejectedCreated.payload?.approval ?? rejectedCreated.payload;
    assert.equal((await env.api("POST", `/api/v1/approvals/${rejectedApproval.id}/decide`, { decision: "REJECTED", targetHash: HEX_A })).status, 200);
    assert.equal(taskRow(env, "ACCEPT-REJECT").status, "READY", "human rejection re-queues the task (m4-status ruling 3)");
    assert.equal(dbRow(env, "SELECT status FROM approvals WHERE id = ?", rejectedApproval.id).status, "REJECTED");
  });

  test("C5 DONE is refused by PATCH from both AWAITING_ACCEPTANCE and REJECTED", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    const awaiting = env.toAwaiting("DONE-AWAIT");
    env.makeTask("DONE-REJECTED");
    const run = env.makeRun("DONE-REJECTED", "agent-dev-1");
    const review = env.createReview("DONE-REJECTED", run.id);
    env.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "CHANGES_REQUESTED", findings: [{ code: "X", message: "x" }], actor: "agent-dev-2" });
    assert.equal(taskRow(env, "DONE-REJECTED").status, "REJECTED");
    await env.startBackend();
    const fromAwaiting = await env.api("PATCH", "/api/v1/tasks/DONE-AWAIT", { expectedVersion: awaiting.version, status: "DONE" });
    assert.equal(fromAwaiting.status, 409);
    assert.equal(fromAwaiting.code, "TASK_VERSION_CONFLICT");
    assert.equal(taskRow(env, "DONE-AWAIT").status, "AWAITING_ACCEPTANCE");
    const rejected = taskRow(env, "DONE-REJECTED");
    const fromRejected = await env.api("PATCH", "/api/v1/tasks/DONE-REJECTED", { expectedVersion: rejected.version, status: "DONE" });
    assert.equal(fromRejected.status, 409);
    assert.equal(taskRow(env, "DONE-REJECTED").status, "REJECTED");
  });

  // -------------------------------------------------------------------------
  // D. rework loop
  // -------------------------------------------------------------------------
  test("D1 CHANGES_REQUESTED -> REJECTED -> rework -> READY with a new attempt and events", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("REWORK-ONE");
    const run = env.makeRun("REWORK-ONE", "agent-dev-1");
    const review = env.createReview("REWORK-ONE", run.id);
    env.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "CHANGES_REQUESTED", findings: [{ code: "F1", message: "fix" }], actor: "agent-dev-2" });
    assert.equal(taskRow(env, "REWORK-ONE").status, "REJECTED");
    const reworked = env.store.reworkTask({ taskId: "REWORK-ONE", reviewId: review.id, reason: "fix it", actor: "HUMAN" });
    assert.equal(reworked.task.status, "READY");
    assert.equal(Number(reworked.attempt), 2);
    assert.equal(reviewRow(env, review.id).status, "CHANGES_REQUESTED", "the old review keeps its verdict; a new review carries the next attempt");
    const event = dbRow(env, "SELECT payload_json AS payload FROM events WHERE type = 'task.updated' AND aggregate_id = 'REWORK-ONE' ORDER BY seq DESC LIMIT 1");
    assert.match(String(event?.payload), /"reason":"rework"/);
  });

  test("D2 each rework round is recorded once (attempt numbers are not duplicated)", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("REWORK-ATTEMPTS");
    const run = env.makeRun("REWORK-ATTEMPTS", "agent-dev-1");
    const first = env.createReview("REWORK-ATTEMPTS", run.id);
    env.store.submitReview({ id: first.id, expectedVersion: first.version, verdict: "CHANGES_REQUESTED", findings: [{ code: "F1", message: "fix" }], actor: "agent-dev-2" });
    env.store.reworkTask({ taskId: "REWORK-ATTEMPTS", reviewId: first.id, reason: "fix", actor: "HUMAN" });
    let task = env.store.getTask("REWORK-ATTEMPTS");
    for (const status of ["CLAIMED", "RUNNING", "REVIEWING"]) task = env.store.patchTask("REWORK-ATTEMPTS", { expectedVersion: task.version, changes: { status } });
    env.makeRun("REWORK-ATTEMPTS", "agent-dev-1");
    const second = env.createReview("REWORK-ATTEMPTS", null);
    const rows = dbRows(
      env,
      `SELECT ra.attempt AS attempt, COUNT(*) AS c
         FROM review_attempts ra JOIN reviews r ON r.id = ra.review_id
        WHERE r.task_id = ?
        GROUP BY ra.attempt ORDER BY ra.attempt`,
      "REWORK-ATTEMPTS",
    );
    assert.ok(second.attempt >= 2);
    assert.deepEqual(rows.map((row) => Number(row.c)), rows.map(() => 1), `attempt numbers must identify one round each, got ${JSON.stringify(rows)}`);
  });

  test("D3 maxAttempts is enforced at the boundary (maxAttempts=1 and the default 3)", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    const seedChanges = (taskId) => {
      env.makeTask(taskId);
      const run = env.makeRun(taskId, "agent-dev-1");
      const review = env.createReview(taskId, run.id);
      env.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "CHANGES_REQUESTED", findings: [{ code: "F", message: "f" }], actor: "agent-dev-2" });
      return review;
    };
    const maxOne = seedChanges("REWORK-MAX-1");
    assert.throws(
      () => env.store.reworkTask({ taskId: "REWORK-MAX-1", reviewId: maxOne.id, reason: "x", actor: "HUMAN", maxAttempts: 1 }),
      (error) => error.code === "REWORK_LIMIT_REACHED" && error.details?.attempt === 2 && error.details?.maxAttempts === 1,
    );
    assert.equal(taskRow(env, "REWORK-MAX-1").status, "BLOCKED");
    assert.match(String(dbRow(env, "SELECT payload_json AS payload FROM events WHERE type = 'task.updated' AND aggregate_id = 'REWORK-MAX-1' ORDER BY seq DESC LIMIT 1")?.payload), /"reason":"rework-limit"/);

    // Default limit 3: rounds 1 and 2 may rework, round 3 must block.
    let review = seedChanges("REWORK-MAX-3");
    for (const round of [1, 2]) {
      const outcome = env.store.reworkTask({ taskId: "REWORK-MAX-3", reviewId: review.id, reason: `fix ${round}`, actor: "HUMAN" });
      assert.equal(outcome.task.status, "READY");
      let task = env.store.getTask("REWORK-MAX-3");
      for (const status of ["CLAIMED", "RUNNING", "REVIEWING"]) task = env.store.patchTask("REWORK-MAX-3", { expectedVersion: task.version, changes: { status } });
      env.makeRun("REWORK-MAX-3", "agent-dev-1");
      review = env.createReview("REWORK-MAX-3", null);
      env.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "CHANGES_REQUESTED", findings: [{ code: `F${round}`, message: "f" }], actor: "agent-dev-2" });
    }
    assert.throws(
      () => env.store.reworkTask({ taskId: "REWORK-MAX-3", reviewId: review.id, reason: "one more", actor: "HUMAN" }),
      (error) => error.code === "REWORK_LIMIT_REACHED",
    );
    assert.equal(taskRow(env, "REWORK-MAX-3").status, "BLOCKED");
  });

  test("D4 two concurrent rework requests on the same review: exactly one succeeds", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("REWORK-RACE");
    const run = env.makeRun("REWORK-RACE", "agent-dev-1");
    const review = env.createReview("REWORK-RACE", run.id);
    env.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "CHANGES_REQUESTED", findings: [{ code: "F", message: "f" }], actor: "agent-dev-2" });
    const child = path.join(env.tmp, "rework-child.mjs");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      child,
      `import { openStore } from ${JSON.stringify(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href)};
const [db, reviewId, key, startAt] = process.argv.slice(2);
const store = openStore({ file: db, migrate: true });
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));
let out;
try {
  const result = store.reworkTask({ taskId: "REWORK-RACE", reviewId, reason: key, actor: "HUMAN" });
  out = { ok: true, task: result.task.status, attempt: result.attempt };
} catch (error) {
  out = { ok: false, code: error.code, details: error.details };
}
store.close();
process.stdout.write(JSON.stringify(out));
`,
    );
    const startAt = Date.now() + 600;
    const runChild = (key) =>
      new Promise((resolve) => {
        const childProcess = spawn(process.execPath, [child, env.dbFile, review.id, key, String(startAt)], { cwd: env.tmp, windowsHide: true });
        let output = "";
        childProcess.stdout.on("data", (chunk) => (output += chunk));
        childProcess.on("close", () => {
          try {
            resolve(JSON.parse(output));
          } catch {
            resolve({ raw: output });
          }
        });
      });
    const results = await Promise.all([runChild("race-a"), runChild("race-b")]);
    assert.equal(results.filter((entry) => entry.ok).length, 1, `exactly one rework may win: ${JSON.stringify(results)}`);
    assert.equal(taskRow(env, "REWORK-RACE").status, "READY");
    const events = Number(dbRow(env, "SELECT COUNT(*) AS c FROM events WHERE type = 'task.updated' AND aggregate_id = 'REWORK-RACE' AND payload_json LIKE '%\"reason\":\"rework\"%'").c);
    assert.equal(events, 1, "one rework round = one task.updated(reason=rework)");
  });

  // -------------------------------------------------------------------------
  // E. DONE entry + audit chain
  // -------------------------------------------------------------------------
  test("E1 the store must not offer a second DONE entrance", async (t) => {
    const env = await makeEnv(t);
    const task = env.toAwaiting("DONE-STORE");
    assert.throws(
      () => env.store.patchTask("DONE-STORE", { expectedVersion: task.version, changes: { status: "DONE" } }),
      "the store itself must not offer a second DONE entrance (the frozen tree allowed it)",
    );
    assert.equal(taskRow(env, "DONE-STORE").status, "AWAITING_ACCEPTANCE");
  });

  test("E2 M4 writes an auditable event chain (requested -> updated -> approval recorded)", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("AUDIT-CHAIN");
    const run = env.makeRun("AUDIT-CHAIN", "agent-dev-1");
    const review = env.createReview("AUDIT-CHAIN", run.id);
    env.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: PASS_EVIDENCE, actor: "agent-dev-2" });
    env.store.patchTask("AUDIT-CHAIN", { expectedVersion: env.store.getTask("AUDIT-CHAIN").version, changes: { status: "AWAITING_ACCEPTANCE" } });
    const targetHash = taskRow(env, "AUDIT-CHAIN").targetHash || MANIFEST;
    const approval = env.store.createApproval({ taskId: "AUDIT-CHAIN", scope: "candidate", targetHash, actor: "HUMAN" });
    env.store.decideApproval({ id: approval.id, decision: "APPROVED", actor: "HUMAN", targetHash });
    const events = dbRows(env, "SELECT type, aggregate_id AS aggregateId, payload_json AS payload FROM events WHERE aggregate_id IN (?, ?) OR (type = 'task.updated' AND aggregate_id = 'AUDIT-CHAIN') ORDER BY seq", review.id, approval.id);
    const types = events.map((event) => event.type);
    for (const wanted of ["review.requested", "review.updated", "approval.recorded"]) assert.ok(types.includes(wanted), `missing ${wanted}: ${JSON.stringify(types)}`);
    const reviewUpdated = events.find((event) => event.type === "review.updated");
    assert.match(String(reviewUpdated.payload), /"verdict":"PASS"/);
    const approvalDecided = events.filter((event) => event.type === "approval.recorded" && String(event.payload).includes("\"decision\":\"APPROVED\""));
    assert.equal(approvalDecided.length, 1);
    assert.match(String(approvalDecided[0].payload), new RegExp(targetHash));
  });

  // -------------------------------------------------------------------------
  // F. migration + concurrent submit
  // -------------------------------------------------------------------------
  test("F1 a v3 database upgrades to v4 in place, keeps data, and heals missing 0004 bookkeeping", async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m4-mig-"));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const db = path.join(dir, "atk.db");
    const raw = new DatabaseSync(db);
    raw.exec(readFileSync(path.join(REPO, "packages/database/migrations/0001_init.sql"), "utf8"));
    raw.exec(readFileSync(path.join(REPO, "packages/database/migrations/0002_runs_dispatch.sql"), "utf8"));
    raw.exec(readFileSync(path.join(REPO, "packages/database/migrations/0003_scheduling.sql"), "utf8"));
    for (const [version, name] of [[1, "0001_init.sql"], [2, "0002_runs_dispatch.sql"], [3, "0003_scheduling.sql"]]) {
      raw.exec(`INSERT INTO schema_migrations (version,name,applied_at) VALUES (${version},'${name}','${new Date().toISOString()}')`);
    }
    raw.exec("INSERT INTO projects (id,name,repo_path,default_branch,created_at,updated_at) VALUES ('V3P','v3','.','main','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    raw.exec("INSERT INTO tasks (id,project_id,title,description,function_required,role_required,priority,status,created_at,updated_at) VALUES ('V3T','V3P','v3 task','d','WORKER','DEV',2,'READY','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    raw.close();
    const upgraded = openStore({ file: db, migrate: true });
    try {
      assert.ok(upgraded.health().schemaVersion >= 4);
      assert.equal(upgraded.getTask("V3T").status, "READY");
    } finally {
      upgraded.close();
    }
    const raw2 = new DatabaseSync(db);
    raw2.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
    raw2.close();
    let healed;
    try {
      healed = openStore({ file: db, migrate: true });
    } catch (error) {
      assert.fail(`a lost 0004 bookkeeping row must self-heal, got ${error.message}`);
    }
    try {
      assert.ok(healed.health().schemaVersion >= 4);
      assert.equal(healed.getTask("V3T").status, "READY");
    } finally {
      healed.close();
    }
    const check = new DatabaseSync(db);
    try {
      assert.ok(check.prepare("SELECT 1 FROM pragma_table_info('reviews') WHERE name = 'reviewer'").get());
      assert.ok(check.prepare("SELECT 1 FROM pragma_table_info('approvals') WHERE name = 'decision'").get());
      assert.ok(check.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'target_hash'").get());
    } finally {
      check.close();
    }
  });

  test("F2 two concurrent submissions of the same review: one CAS winner", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-dev-1");
    env.makeAgent("agent-dev-2");
    env.makeTask("SUBMIT-RACE");
    const run = env.makeRun("SUBMIT-RACE", "agent-dev-1");
    const review = env.createReview("SUBMIT-RACE", run.id);
    const child = path.join(env.tmp, "submit-child.mjs");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      child,
      `import { openStore } from ${JSON.stringify(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href)};
const [db, reviewId, version, key, startAt] = process.argv.slice(2);
const store = openStore({ file: db, migrate: true });
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));
let out;
try {
  const result = store.submitReview({ id: reviewId, expectedVersion: Number(version), verdict: "PASS", manifestHash: "${MANIFEST}", evidence: { tests: { passed: 2, total: 2 } }, actor: key });
  out = { ok: true, task: result.task.status };
} catch (error) {
  out = { ok: false, code: error.code, details: error.details };
}
store.close();
process.stdout.write(JSON.stringify(out));
`,
    );
    const startAt = Date.now() + 600;
    const runChild = (actor) =>
      new Promise((resolve) => {
        const childProcess = spawn(process.execPath, [child, env.dbFile, review.id, String(review.version), actor, String(startAt)], { cwd: env.tmp, windowsHide: true });
        let output = "";
        childProcess.stdout.on("data", (chunk) => (output += chunk));
        childProcess.on("close", () => {
          try {
            resolve(JSON.parse(output));
          } catch {
            resolve({ raw: output });
          }
        });
      });
    const results = await Promise.all([runChild("agent-dev-2"), runChild("agent-dev-3")]);
    assert.equal(results.filter((entry) => entry.ok).length, 1, `exactly one submit may win: ${JSON.stringify(results)}`);
    assert.equal(reviewRow(env, review.id).status, "PASS");
    assert.equal(Number(dbRow(env, "SELECT COUNT(*) AS c FROM events WHERE type = 'review.updated' AND aggregate_id = ?", review.id).c), 1);
  });

  // -------------------------------------------------------------------------
  // G. contract/docs/web/privacy
  // -------------------------------------------------------------------------
  test("G1 the m4-contracts §2 endpoints all exist and M4 sources stay private", async () => {
    const server = readFileSync(path.join(REPO, "apps/backend/src/server.mjs"), "utf8").replace(/\\\//g, "/");
    const expected = [
      ["reviews.list", "/api/v1/reviews"],
      ["reviews.create", "/api/v1/reviews"],
      ["reviews.submit", "/api/v1/reviews/([^/]+)/submit"],
      ["reviews.rework", "/api/v1/reviews/([^/]+)/rework"],
      ["approvals.list", "/api/v1/approvals"],
      ["approvals.create", "/api/v1/approvals"],
      ["approvals.decide", "/api/v1/approvals/([^/]+)/decide"],
    ];
    for (const [name, route] of expected) assert.ok(server.includes(`"${name}"`) && server.includes(route), `${name} (${route}) missing from the backend route table`);
    const files = [];
    const collect = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.isFile() && /\.(mjs|ts|json|md)$/.test(entry.name)) files.push(full);
      }
    };
    for (const relative of ["apps/web/src/components", "apps/web/src/domain", "packages/database/src", "apps/backend/src"]) collect(path.join(REPO, relative));
    for (const relative of ["docs/architecture/m4-contracts.md", "docs/roadmap/m4-status.md", "scripts/m4-smoke.mjs"]) files.push(path.join(REPO, relative));
    const userName = process.env.USERNAME;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.ok(!/\bsk-[A-Za-z0-9_-]{20,}/.test(text), `${file}: secret-like token`);
      if (userName) assert.ok(!text.includes(userName), `${file}: machine username`);
    }
  });

  test("G2 web dictionaries stay in sync and map every M4 error code, including the 're-accept' copy", async () => {
    const en = readFileSync(path.join(REPO, "apps/web/src/i18n/en.ts"), "utf8");
    const zh = readFileSync(path.join(REPO, "apps/web/src/i18n/zh-CN.ts"), "utf8");
    const keysOf = (text) => [...text.matchAll(/^\s*["']([A-Za-z0-9_.]+)["']\s*:/gm)].map((match) => match[1]);
    const enKeys = keysOf(en);
    const zhKeys = keysOf(zh);
    assert.ok(enKeys.length >= 292, `expected the M4-grown dictionary, got ${enKeys.length}`);
    assert.deepEqual(enKeys, zhKeys, "en and zh-CN must have identical key sets in identical order");
    assert.match(zh, /"error\.code\.APPROVAL_STALE":\s*"[^"]*重新验收/);
    assert.match(en, /"error\.code\.APPROVAL_STALE":\s*"[^"]*again/i);

    const contracts = readFileSync(path.join(REPO, "packages/contracts/src/errors.mjs"), "utf8");
    const codes = [...contracts.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*\{/gm)].map((match) => match[1]);
    const errorsTs = readFileSync(path.join(REPO, "apps/web/src/domain/errors.ts"), "utf8");
    const mapped = [...errorsTs.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*"error\.code\./gm)].map((match) => match[1]);
    for (const code of codes) assert.ok(mapped.includes(code), `web ERROR_MESSAGE_KEYS is missing ${code}`);
    for (const code of ["SELF_REVIEW_FORBIDDEN", "EVIDENCE_MISSING", "APPROVAL_STALE", "REWORK_LIMIT_REACHED"]) assert.ok(mapped.includes(code));
  });

  test("G3 the m4 smoke gate is green only when every check is a real PASS", async (t) => {
    const result = spawnSync(process.execPath, [path.join(REPO, "scripts", "m4-smoke.mjs")], { cwd: REPO, encoding: "utf8", timeout: 180000, windowsHide: true });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `m4-smoke failed:\n${combined.slice(-2500)}`);
    assert.doesNotMatch(result.stdout, /^FAIL/m);
    assert.doesNotMatch(result.stdout, /^SKIP/m);
    const summary = result.stdout.match(/(\d+)\/(\d+) checks passed, (\d+) skipped, (\d+) failed/);
    assert.ok(summary, `missing gate summary:\n${result.stdout.slice(-600)}`);
    assert.equal(summary[1], summary[2]);
    assert.equal(summary[3], "0");
    assert.equal(summary[4], "0");
    assert.ok(Number(summary[1]) >= 8);
  });
}
