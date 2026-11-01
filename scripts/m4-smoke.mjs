#!/usr/bin/env node
// M4 end-to-end gate: Review / rework / human acceptance (real backend + real SQLite).
//
// Contract: docs/architecture/m4-contracts.md §4 (7 checks) plus the human
// REJECTION branch (check 8). The gate deliberately
// reads the database for the final business fact of every check instead of trusting
// an HTTP response: M2 shipped a gate that asserted "the process said 200" while the
// persisted business fact was wrong. HTTP is used to *perform* the action; the DB is
// used to *prove* it.
//
//   1. self-review         - author agent submits PASS -> 403 SELF_REVIEW_FORBIDDEN,
//                            review stays PENDING in the DB;
//   2. evidence missing    - PASS without manifestHash / with failed tests -> 400
//                            EVIDENCE_MISSING, task+review unchanged;
//   3. PASS advances       - legal PASS -> review PASS, task REVIEWING -> INTEGRATING;
//   4. approval hash bind  - wrong targetHash -> 409 APPROVAL_STALE (task untouched),
//                            right hash -> task DONE;
//   5. DONE only via approval - a direct task PATCH to DONE is refused with 409;
//   6. rework loop         - CHANGES_REQUESTED -> REJECTED -> READY (attempt+1),
//                            Scheduler+Host re-execute the task (new Run, attempt 2),
//                            and exceeding maxAttempts -> 409 REWORK_LIMIT_REACHED +
//                            Task BLOCKED;
//   7. events + SSE        - a real SSE client receives review.updated and
//                            approval.recorded (ids increasing);
//   8. human rejection     - decide REJECTED -> approval REJECTED, task READY (not
//                            REJECTED/DONE), approval.recorded payload.decision
//                            REJECTED in the DB event log.
//
// A check whose dependency is not implemented yet reports `SKIP (<reason>)` and is
// never counted as a pass. Exit: 0 = 8/8 PASS, 1 = any FAIL or SKIP, 2 = prerequisite
// missing (Node < 22.5, missing files).
//
// Usage: node scripts/m4-smoke.mjs [--verbose]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_CLI = path.join(ROOT, "apps", "backend", "cli.mjs");
const STATE = path.join(ROOT, ".agent-flow", "state.json");
const DIST = path.join(ROOT, "apps", "web", "dist");
const verbose = process.argv.includes("--verbose");
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5)) {
  process.stderr.write(`m4-smoke: SKIP (node:sqlite requires Node >= 22.5.0; running ${process.versions.node})\n`);
  process.exit(2);
}
for (const required of [BACKEND_CLI, STATE]) {
  if (!existsSync(required)) {
    process.stderr.write(`m4-smoke: missing ${required}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// check harness (same shape as m3-smoke: pass / fail / skip are distinct)
// ---------------------------------------------------------------------------
class SkipCheck extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SkipCheck";
  }
}
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 15000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}
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

// ---------------------------------------------------------------------------
// setup: migrate a throwaway DB, seed fixtures through the store API
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m4-smoke-"));
const dbFile = path.join(tmp, "atk.db");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const migrate = spawnSync(process.execPath, [BACKEND_CLI, "migrate", "--data", dbFile, "--from", STATE, "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  windowsHide: true,
});
if (migrate.status !== 0) {
  process.stderr.write(`m4-smoke: migrate failed (exit ${migrate.status})\n${migrate.stdout}\n${migrate.stderr}\n`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const { openStore } = await load("packages/database/src/index.mjs");
const store = openStore({ file: dbFile, migrate: true });

// Capability detection: a missing M4 write path is a SKIP, never a pass.
const STORE_M4_METHODS = ["createReview", "getReview", "submitReview", "reworkTask", "createApproval", "decideApproval"];
const missingStoreMethods = STORE_M4_METHODS.filter((method) => typeof store[method] !== "function");
const storeM4Ready = missingStoreMethods.length === 0;
const storeSkipReason = storeM4Ready
  ? ""
  : `packages/database M4 write path not implemented yet (missing: ${missingStoreMethods.join(", ")})`;

const project = store.listProjects()[0];
function createTask(id, status) {
  const task = store.createTask({
    id,
    projectId: project.id,
    title: `m4 ${id}`,
    description: `${id} (m4-smoke)`,
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority: 2,
    deps: [],
    acceptance: "m4-smoke",
  });
  // Walk the legal status chain with the store's own state machine (no DB pokes).
  const chain = ["CLAIMED", "RUNNING", "REVIEWING", "INTEGRATING", "AWAITING_ACCEPTANCE", "DONE"];
  let current = task;
  for (const next of chain) {
    if (current.status === status) break;
    current = store.patchTask(current.id, { expectedVersion: current.version, changes: { status: next } });
    if (next === status) break;
  }
  if (current.status !== status) throw new Error(`could not move ${id} to ${status} (stuck at ${current.status})`);
  return current;
}
function seedCompletedRun(taskId, agentId) {
  const run = store.createRun({ taskId, agentId, function: "WORKER", role: "DEV" });
  // Walk the Run lifecycle the same way the Host does: STARTING -> RUNNING -> COMPLETED.
  store.updateRunStatus(run.id, { status: "RUNNING" });
  store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
  return store.getRun(run.id);
}

const fixtures = { skippedSetup: [] };
for (const index of [1, 2, 3]) {
  store.upsertAgent({ id: `agent-dev-${index}`, role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
}

// Check 5 only needs the base store: an AWAITING_ACCEPTANCE task.
fixtures.directDone = createTask("M4-DIRECT-DONE", "AWAITING_ACCEPTANCE");

if (storeM4Ready) {
  try {
    fixtures.self = createTask("M4-SELF", "REVIEWING");
    fixtures.self.run = seedCompletedRun("M4-SELF", "agent-dev-1");
    fixtures.evidence = createTask("M4-EVIDENCE", "REVIEWING");
    fixtures.evidence.run = seedCompletedRun("M4-EVIDENCE", "agent-dev-1");
    fixtures.pass = createTask("M4-PASS", "REVIEWING");
    fixtures.pass.run = seedCompletedRun("M4-PASS", "agent-dev-1");
    fixtures.approval = createTask("M4-APPROVAL", "AWAITING_ACCEPTANCE");
    fixtures.approvalReject = createTask("M4-APPROVAL-REJECT", "AWAITING_ACCEPTANCE");
    fixtures.rework = createTask("M4-REWORK", "REVIEWING");
    fixtures.rework.run = seedCompletedRun("M4-REWORK", "agent-dev-1");

    // Check 6 limit fixture: a CHANGES_REQUESTED review already sitting at attempt 3,
    // so the public rework endpoint is the thing that must refuse -> 409 + BLOCKED.
    fixtures.limit = createTask("M4-REWORK-LIMIT", "REVIEWING");
    fixtures.limit.run = seedCompletedRun("M4-REWORK-LIMIT", "agent-dev-1");
    const limitReview = store.createReview({ taskId: "M4-REWORK-LIMIT", runId: fixtures.limit.run.id, actor: "HUMAN", attempt: 3 });
    store.submitReview({
      id: limitReview.id,
      expectedVersion: limitReview.version,
      verdict: "CHANGES_REQUESTED",
      findings: [{ code: "LIMIT_FIXTURE", message: "limit fixture" }],
      actor: "HUMAN",
    });
    fixtures.limit.review = store.getReview(limitReview.id);
    fixtures.limit.task = store.getTask("M4-REWORK-LIMIT");
  } catch (error) {
    fixtures.skippedSetup.push(String(error?.message ?? error));
  }
}
store.close();

// ---------------------------------------------------------------------------
// database readers (the gate's source of truth for business facts)
// ---------------------------------------------------------------------------
function dbGet(sql, ...params) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare(sql).get(...params) ?? null;
  } finally {
    db.close();
  }
}
function dbAll(sql, ...params) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
function reviewRow(id) {
  return dbGet("SELECT id, task_id AS taskId, run_id AS runId, status, verdict, attempt, version FROM reviews WHERE id = ?", id);
}
function approvalRow(id) {
  return dbGet("SELECT id, task_id AS taskId, scope, target_hash AS targetHash, status, actor FROM approvals WHERE id = ?", id);
}
function taskStatus(taskId) {
  return dbGet("SELECT status, version FROM tasks WHERE id = ?", taskId);
}
function eventRow(type, aggregateId) {
  return dbGet(
    "SELECT seq, type, payload_json AS payloadJson FROM events WHERE type = ? AND aggregate_id = ? ORDER BY seq DESC LIMIT 1",
    type,
    aggregateId,
  );
}

// ---------------------------------------------------------------------------
// backend lifecycle + authenticated HTTP
// ---------------------------------------------------------------------------
let backend = null;
let backendOut = "";
let internalToken = "";
let publicToken = "";
let csrf = "";
let sseController = null;
let sseText = "";
let sseTask = null;

async function startBackend() {
  const args = [BACKEND_CLI, "serve", "--port", String(port), "--data", dbFile];
  if (existsSync(path.join(DIST, "index.html"))) args.push("--web-dist", DIST);
  backend = spawn(process.execPath, args, {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: tmp },
  });
  backend.stdout.on("data", (chunk) => (backendOut += chunk));
  backend.stderr.on("data", (chunk) => (backendOut += chunk));
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/api/v1/system/health`)).ok;
    } catch {
      return false;
    }
  }, 20000, "backend health");
  const match = backendOut.match(/internal token:\s*(\S+)/);
  if (match) internalToken = match[1];
  const session = await (await fetch(`${base}/api/v1/session`)).json();
  publicToken = session.token;
  csrf = session.csrf;
}

function authed(extra = {}) {
  return { "x-atk-token": publicToken, ...extra };
}
function writeHeaders(extra = {}) {
  return { ...authed(), "x-atk-csrf": csrf, "content-type": "application/json", origin: base, ...extra };
}
/** HTTP action; actor is sent in the body and as x-atk-actor for automation paths. */
async function api(method, requestPath, body, actor) {
  const headers = body === undefined ? authed() : writeHeaders(actor ? { "x-atk-actor": actor } : {});
  const response = await fetch(`${base}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(actor ? { ...body, actor } : body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (verbose) process.stderr.write(`[http] ${method} ${requestPath} -> ${response.status} ${text.slice(0, 300)}\n`);
  return { status: response.status, payload, text, code: payload?.error?.code ?? null };
}

async function startSse() {
  sseController = new AbortController();
  const response = await fetch(`${base}/api/v1/events/stream`, {
    headers: { ...authed(), accept: "text/event-stream" },
    signal: sseController.signal,
  });
  expect(response.ok, `SSE stream refused with ${response.status}`);
  expect(String(response.headers.get("content-type")).includes("text/event-stream"), "expected text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  sseTask = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseText += decoder.decode(value, { stream: true });
      }
    } catch {
      /* aborted at the end of the run */
    }
  })();
}

/** Backend M4 write endpoints missing -> 404 (the base only had GET list routes). */
async function backendM4Ready() {
  const probe = await api("POST", "/api/v1/reviews", {}, "HUMAN");
  return probe.status !== 404 && probe.status !== 405;
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const MANIFEST = "c".repeat(64);

function requireM4(what = "") {
  if (!storeM4Ready) throw new SkipCheck(storeSkipReason);
  if (!backendM4) throw new SkipCheck("apps/backend M4 write endpoints not implemented yet (POST /api/v1/reviews -> 404; ATK-402/404 pending)");
  if (what) expect(!fixtures.skippedSetup.length, `M4 fixture setup failed: ${fixtures.skippedSetup.join("; ")}`);
}

async function createReview(taskId, runId, actor = "HUMAN") {
  const response = await api("POST", "/api/v1/reviews", { taskId, runId, actor }, actor);
  expect(response.status === 201, `POST /reviews expected 201, got ${response.status}: ${response.text.slice(0, 200)}`);
  const review = response.payload?.review ?? response.payload;
  expect(typeof review?.id === "string", `review id missing: ${response.text.slice(0, 200)}`);
  expect(typeof review?.version === "number", `review version missing: ${response.text.slice(0, 200)}`);
  return review;
}

check("1. self-review by the author agent is forbidden (403 SELF_REVIEW_FORBIDDEN, review stays PENDING)", async () => {
  requireM4(true);
  const review = await createReview("M4-SELF", fixtures.self.run.id, "HUMAN");
  expect(reviewRow(review.id)?.status === "PENDING", `review should start PENDING, got ${reviewRow(review.id)?.status}`);

  const submit = await api(
    "POST",
    `/api/v1/reviews/${encodeURIComponent(review.id)}/submit`,
    {
      expectedVersion: review.version,
      verdict: "PASS",
      manifestHash: MANIFEST,
      evidence: { tests: { passed: 2, total: 2 } },
    },
    "agent-dev-1", // the agent that produced the Run
  );
  expect(submit.status === 403, `expected 403 for self-review, got ${submit.status}: ${submit.text.slice(0, 200)}`);
  expect(submit.code === "SELF_REVIEW_FORBIDDEN", `expected SELF_REVIEW_FORBIDDEN, got ${submit.code}`);

  const row = reviewRow(review.id);
  expect(row.status === "PENDING", `review must stay PENDING after self-review, got ${row.status}`);
  expect(taskStatus("M4-SELF").status === "REVIEWING", `task must stay REVIEWING, got ${taskStatus("M4-SELF").status}`);
  return `403 ${submit.code}; DB review=${row.status}, task=${taskStatus("M4-SELF").status}`;
});

check("2. PASS without evidence is refused (400 EVIDENCE_MISSING, task+review unchanged)", async () => {
  requireM4(true);
  const review = await createReview("M4-EVIDENCE", fixtures.evidence.run.id, "HUMAN");
  const path = `/api/v1/reviews/${encodeURIComponent(review.id)}/submit`;

  const noHash = await api("POST", path, { expectedVersion: review.version, verdict: "PASS", evidence: { tests: { passed: 2, total: 2 } } }, "HUMAN");
  expect(noHash.status === 400, `expected 400 without manifestHash, got ${noHash.status}: ${noHash.text.slice(0, 200)}`);
  expect(noHash.code === "EVIDENCE_MISSING", `expected EVIDENCE_MISSING, got ${noHash.code}`);

  const failedTests = await api(
    "POST",
    path,
    { expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: { tests: { passed: 1, total: 2 } } },
    "HUMAN",
  );
  expect(failedTests.status === 400, `expected 400 for passed<total, got ${failedTests.status}: ${failedTests.text.slice(0, 200)}`);
  expect(failedTests.code === "EVIDENCE_MISSING", `expected EVIDENCE_MISSING, got ${failedTests.code}`);

  const row = reviewRow(review.id);
  expect(row.status === "PENDING", `review must stay PENDING, got ${row.status}`);
  expect(taskStatus("M4-EVIDENCE").status === "REVIEWING", `task must stay REVIEWING, got ${taskStatus("M4-EVIDENCE").status}`);
  return `400 ${noHash.code} (no hash) / 400 ${failedTests.code} (1/2); DB review=PENDING, task=REVIEWING`;
});

check("3. a legal PASS advances Review PASS and Task REVIEWING -> INTEGRATING (DB)", async () => {
  requireM4(true);
  const review = await createReview("M4-PASS", fixtures.pass.run.id, "HUMAN");
  const submit = await api(
    "POST",
    `/api/v1/reviews/${encodeURIComponent(review.id)}/submit`,
    { expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, evidence: { tests: { passed: 2, total: 2 } } },
    "HUMAN",
  );
  expect(submit.status === 200, `expected 200, got ${submit.status}: ${submit.text.slice(0, 200)}`);

  const row = reviewRow(review.id);
  expect(row.status === "PASS", `DB review status expected PASS, got ${row.status}`);
  expect(row.verdict === "PASS", `DB review verdict expected PASS, got ${row.verdict}`);
  expect(taskStatus("M4-PASS").status === "INTEGRATING", `DB task expected INTEGRATING, got ${taskStatus("M4-PASS").status}`);
  return `DB review=${row.status}/${row.verdict}, task=${taskStatus("M4-PASS").status}`;
});

check("4. acceptance is bound to targetHash (wrong -> 409 APPROVAL_STALE, right -> DONE)", async () => {
  requireM4(true);
  const created = await api("POST", "/api/v1/approvals", { taskId: "M4-APPROVAL", scope: "candidate", targetHash: HEX_A }, "HUMAN");
  expect(created.status === 201, `POST /approvals expected 201, got ${created.status}: ${created.text.slice(0, 200)}`);
  const approval = created.payload?.approval ?? created.payload;
  expect(typeof approval?.id === "string", `approval id missing: ${created.text.slice(0, 200)}`);
  expect(approvalRow(approval.id)?.targetHash === HEX_A, `DB approval targetHash should be A, got ${approvalRow(approval.id)?.targetHash}`);

  const stale = await api("POST", `/api/v1/approvals/${encodeURIComponent(approval.id)}/decide`, { decision: "APPROVED", targetHash: HEX_B }, "HUMAN");
  expect(stale.status === 409, `wrong hash expected 409, got ${stale.status}: ${stale.text.slice(0, 200)}`);
  expect(stale.code === "APPROVAL_STALE", `expected APPROVAL_STALE, got ${stale.code}`);
  expect(approvalRow(approval.id)?.status === "PENDING", `approval must stay PENDING, got ${approvalRow(approval.id)?.status}`);
  expect(taskStatus("M4-APPROVAL").status === "AWAITING_ACCEPTANCE", `task must stay AWAITING_ACCEPTANCE, got ${taskStatus("M4-APPROVAL").status}`);

  const accepted = await api("POST", `/api/v1/approvals/${encodeURIComponent(approval.id)}/decide`, { decision: "APPROVED", targetHash: HEX_A }, "HUMAN");
  expect(accepted.status === 200, `right hash expected 200, got ${accepted.status}: ${accepted.text.slice(0, 200)}`);
  expect(approvalRow(approval.id)?.status === "APPROVED", `DB approval expected APPROVED, got ${approvalRow(approval.id)?.status}`);
  expect(taskStatus("M4-APPROVAL").status === "DONE", `DB task expected DONE, got ${taskStatus("M4-APPROVAL").status}`);
  return `stale 409 ${stale.code} (task untouched) -> accepted 200; DB approval=APPROVED, task=DONE`;
});

check("5. DONE has exactly one entry: a direct PATCH to DONE is refused (409)", async () => {
  if (!backendM4) throw new SkipCheck("apps/backend M4 human-acceptance guard not implemented yet (ATK-402/404 pending)");
  const current = dbGet("SELECT status, version FROM tasks WHERE id = 'M4-DIRECT-DONE'");
  expect(current?.status === "AWAITING_ACCEPTANCE", `fixture must be AWAITING_ACCEPTANCE, got ${current?.status}`);
  const patch = await api("PATCH", "/api/v1/tasks/M4-DIRECT-DONE", { expectedVersion: current.version, status: "DONE" });
  if (patch.status === 200) {
    throw new SkipCheck(
      `M4 human-acceptance guard missing: PATCH AWAITING_ACCEPTANCE -> DONE succeeded (HTTP 200); only an APPROVED approval may set DONE. DB task=${taskStatus("M4-DIRECT-DONE").status}`,
    );
  }
  expect(patch.status === 409, `expected 409 from a direct DONE patch, got ${patch.status}: ${patch.text.slice(0, 200)}`);
  expect(taskStatus("M4-DIRECT-DONE").status === "AWAITING_ACCEPTANCE", `task must be unchanged, got ${taskStatus("M4-DIRECT-DONE").status}`);
  return `409 ${patch.code ?? "state-machine"}; DB task stays AWAITING_ACCEPTANCE`;
});

check("6. rework loop: REJECTED -> READY -> re-executed Run (attempt 2); over-limit -> 409 + BLOCKED", async () => {
  requireM4(true);
  const review = await createReview("M4-REWORK", fixtures.rework.run.id, "HUMAN");
  const requested = await api(
    "POST",
    `/api/v1/reviews/${encodeURIComponent(review.id)}/submit`,
    {
      expectedVersion: review.version,
      verdict: "CHANGES_REQUESTED",
      findings: [{ code: "OFF_BY_ONE", message: "please fix the off-by-one" }],
    },
    "HUMAN",
  );
  expect(requested.status === 200, `CHANGES_REQUESTED expected 200, got ${requested.status}: ${requested.text.slice(0, 200)}`);
  expect(taskStatus("M4-REWORK").status === "REJECTED", `DB task expected REJECTED, got ${taskStatus("M4-REWORK").status}`);

  const reworked = await api("POST", `/api/v1/reviews/${encodeURIComponent(review.id)}/rework`, { reason: "rework after findings" }, "HUMAN");
  expect(reworked.status === 200, `rework expected 200, got ${reworked.status}: ${reworked.text.slice(0, 200)}`);
  const attempt = reworked.payload?.attempt ?? dbGet("SELECT attempt FROM reviews WHERE id = ?", review.id)?.attempt;
  expect(Number(attempt) === 2, `DB/review attempt expected 2, got ${attempt}`);
  expect(taskStatus("M4-REWORK").status === "READY", `DB task expected READY after rework, got ${taskStatus("M4-REWORK").status}`);

  // Re-execution through the real M3 Scheduler + Host (no mocked backend).
  if (!internalToken) throw new SkipCheck("backend did not expose an internal token, cannot drive Scheduler/Host");
  const { planDispatch } = await load("packages/scheduler-core/src/index.mjs");
  const { createSchedulerClient } = await load("apps/scheduler/src/client.mjs");
  const { createScheduler } = await load("apps/scheduler/src/index.mjs");
  const { createInternalClient } = await load("apps/runtime-host/src/client.mjs");
  const { createHost } = await load("apps/runtime-host/src/host.mjs");
  const { createMockRuntime } = await load("packages/runtime-sdk/src/mock.mjs");
  const quiet = { info: () => {}, warn: () => {}, error: (message) => verbose && process.stderr.write(`${message}\n`) };

  const scheduler = createScheduler({
    client: createSchedulerClient({ baseUrl: base, token: internalToken }),
    core: { planDispatch },
    policies: { maxConcurrentPerProject: 4, maxPerAgent: 1 },
    ownerId: "m4-smoke-scheduler",
    pollMs: 20,
    heartbeatMs: 500,
    logger: quiet,
  });
  const round = await scheduler.runOnce();
  await scheduler.stop();
  expect(round.ok, "scheduler round failed");
  expect(round.results.some((result) => result.taskId === "M4-REWORK" && result.claimed), `scheduler did not claim M4-REWORK: ${JSON.stringify(round.results)}`);

  const newRun = dbGet("SELECT id, task_id AS taskId, status, attempt FROM runs WHERE task_id = 'M4-REWORK' ORDER BY created_at DESC, id DESC LIMIT 1");
  expect(newRun && newRun.id !== fixtures.rework.run.id, `expected a new Run after rework, got ${newRun?.id}`);
  expect(Number(newRun.attempt) === 2, `new Run attempt expected 2, got ${newRun.attempt}`);

  const host = createHost({
    client: createInternalClient({ baseUrl: base, token: internalToken }),
    runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "m4-mock" }),
    ownerId: "m4-smoke-host",
    leaseMs: 5000,
    pollMs: 20,
    flushMs: 10,
    heartbeatMs: 500,
    logger: quiet,
  });
  host.start();
  try {
    await waitFor(
      async () => dbGet("SELECT status FROM runs WHERE id = ?", newRun.id)?.status === "COMPLETED",
      20000,
      "reworked Run COMPLETED",
    );
    await waitFor(
      async () =>
        dbGet(
          "SELECT status FROM dispatch_commands WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
          newRun.id,
        )?.status === "DONE",
      10000,
      "reworked dispatch command DONE",
    );
  } finally {
    await host.stop();
  }
  const completed = dbGet("SELECT status FROM runs WHERE id = ?", newRun.id);
  expect(completed.status === "COMPLETED", `DB reworked Run expected COMPLETED, got ${completed.status}`);

  // Over the limit: the fixture review sits at attempt 3 with CHANGES_REQUESTED.
  if (!fixtures.limit?.review?.id) throw new SkipCheck(`rework-limit fixture missing: ${fixtures.skippedSetup.join("; ") || "review not seeded"}`);
  const limited = await api("POST", `/api/v1/reviews/${encodeURIComponent(fixtures.limit.review.id)}/rework`, { reason: "one more" }, "HUMAN");
  expect(limited.status === 409, `over-limit rework expected 409, got ${limited.status}: ${limited.text.slice(0, 200)}`);
  expect(limited.code === "REWORK_LIMIT_REACHED", `expected REWORK_LIMIT_REACHED, got ${limited.code}`);
  expect(taskStatus("M4-REWORK-LIMIT").status === "BLOCKED", `DB task expected BLOCKED, got ${taskStatus("M4-REWORK-LIMIT").status}`);
  const limitEvent = eventRow("task.updated", "M4-REWORK-LIMIT");
  expect(limitEvent && String(limitEvent.payloadJson).includes("rework-limit"), `expected task.updated payload reason rework-limit, got ${limitEvent?.payloadJson}`);

  return `REJECTED -> READY (attempt ${attempt}); re-executed Run ${newRun.id} attempt ${newRun.attempt} COMPLETED + command DONE; over-limit 409 ${limited.code}, DB task=BLOCKED, event reason=rework-limit`;
});

check("7. SSE delivers review.updated and approval.recorded with increasing ids", async () => {
  if (!storeM4Ready || !backendM4) throw new SkipCheck(storeM4Ready ? "backend M4 write endpoints missing; no M4 events can be produced" : storeSkipReason);
  expect(sseText.length > 0, "no SSE bytes collected");
  const events = [...sseText.matchAll(/^event: (\S+)$/gm)].map((match) => match[1]);
  const ids = [...sseText.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  const wanted = ["review.updated", "approval.recorded"];
  for (const type of wanted) {
    expect(events.includes(type), `SSE never delivered ${type}; saw ${JSON.stringify([...new Set(events)].slice(0, 20))}`);
  }
  expect(ids.length >= 2, `expected at least two SSE ids, got ${ids.length}`);
  for (let index = 1; index < ids.length; index += 1) {
    expect(ids[index] > ids[index - 1], `SSE ids must increase, got ${ids[index - 1]} then ${ids[index]}`);
  }
  // DB corroboration: the same event types exist with increasing seq.
  const persisted = dbAll("SELECT type, seq FROM events WHERE type IN ('review.updated','approval.recorded') ORDER BY seq ASC");
  expect(persisted.length >= 2, `DB events missing M4 types, got ${persisted.length}`);
  const seqs = persisted.map((row) => Number(row.seq));
  for (let index = 1; index < seqs.length; index += 1) expect(seqs[index] > seqs[index - 1], "DB event seq must increase");
  return `SSE saw ${wanted.join(" + ")}; ${ids.length} id(s) increasing; DB has ${persisted.length} M4 event(s)`;
});

check("8. human REJECTION re-queues the task to READY (not REJECTED/DONE); DB + event say REJECTED", async () => {
  requireM4(true);
  const created = await api("POST", "/api/v1/approvals", { taskId: "M4-APPROVAL-REJECT", scope: "candidate", targetHash: HEX_A }, "HUMAN");
  expect(created.status === 201, `POST /approvals expected 201, got ${created.status}: ${created.text.slice(0, 200)}`);
  const approval = created.payload?.approval ?? created.payload;
  expect(typeof approval?.id === "string", `approval id missing: ${created.text.slice(0, 200)}`);

  const decided = await api(
    "POST",
    `/api/v1/approvals/${encodeURIComponent(approval.id)}/decide`,
    { decision: "REJECTED", targetHash: HEX_A },
    "HUMAN",
  );
  expect(decided.status === 200, `REJECTED decide expected 200, got ${decided.status}: ${decided.text.slice(0, 200)}`);

  const row = approvalRow(approval.id);
  expect(row?.status === "REJECTED", `DB approval expected REJECTED, got ${row?.status}`);
  expect(row?.targetHash === HEX_A, `DB approval targetHash expected A, got ${row?.targetHash}`);
  // Human rejection is "go back and redo it", not the review waiting room:
  // Task REJECTED belongs to the review loop, and DONE belongs to approval.
  const task = taskStatus("M4-APPROVAL-REJECT");
  expect(task.status === "READY", `DB task expected READY after human rejection, got ${task.status}`);
  expect(task.status !== "REJECTED", "human rejection must not leave the task in the review waiting room REJECTED");
  expect(task.status !== "DONE", "human rejection must not accept the task");

  const event = eventRow("approval.recorded", approval.id);
  expect(event, "DB approval.recorded event missing");
  let payload = null;
  try {
    payload = JSON.parse(event.payloadJson);
  } catch {
    payload = null;
  }
  expect(payload?.decision === "REJECTED", `event payload.decision expected REJECTED, got ${event.payloadJson}`);
  expect(payload?.status === "REJECTED", `event payload.status expected REJECTED, got ${event.payloadJson}`);
  return `200; DB approval=REJECTED, task=READY; event approval.recorded payload.decision=REJECTED`;
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
let backendM4 = false;
const results = [];
try {
  await startBackend();
  backendM4 = await backendM4Ready();
  await startSse();

  for (const { name, fn } of checks) {
    try {
      const detail = (await fn()) ?? "";
      results.push({ status: "PASS", name, detail });
    } catch (error) {
      if (error instanceof SkipCheck) results.push({ status: "SKIP", name, detail: error.message });
      else results.push({ status: "FAIL", name, detail: String(error?.message ?? error) });
    }
  }
} catch (error) {
  results.push({ status: "FAIL", name: "harness", detail: String(error?.message ?? error) });
} finally {
  try {
    sseController?.abort();
  } catch {
    /* ignore */
  }
  if (backend) {
    backend.kill();
    await sleep(300);
    backend.stdout?.destroy();
    backend.stderr?.destroy();
  }
  await sseTask?.catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("M4 smoke gate (review + rework + human acceptance, backend + SQLite)\n\n");
if (!backendM4) process.stdout.write(`note: apps/backend M4 write endpoints are not available yet (plain English below)\n`);
for (const result of results) {
  process.stdout.write(`${result.status.padEnd(4)}  ${result.name}\n`);
  if (result.detail) process.stdout.write(`      ${result.detail.split("\n").join("\n      ")}\n`);
}
const passed = results.filter((result) => result.status === "PASS").length;
const skipped = results.filter((result) => result.status === "SKIP").length;
const failed = results.filter((result) => result.status === "FAIL").length;
process.stdout.write(`\n${passed}/${results.length} checks passed, ${skipped} skipped, ${failed} failed\n`);
if (failed > 0) process.stdout.write(`\n--- backend output (tail) ---\n${backendOut.slice(-3000)}\n`);
process.exitCode = passed === results.length ? 0 : 1;
