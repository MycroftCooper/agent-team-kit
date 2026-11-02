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
//   4. approval hash bind  - PASS writes the candidate hash to tasks.target_hash;
//                            a wrong hash (or a task without one) is refused and the
//                            right hash creates an approval that can decide to DONE;
//   5. DONE only via approval - a direct task PATCH to DONE is refused with 409;
//   6. rework loop         - CHANGES_REQUESTED -> REJECTED -> READY (attempt+1),
//                            the REAL scheduler/host CLI processes re-execute the
//                            task (new Run attempt 2), and exceeding maxAttempts ->
//                            409 REWORK_LIMIT_REACHED + Task BLOCKED;
//   7. events + SSE        - a real SSE client receives review.updated and
//                            approval.recorded (ids increasing);
//   8. human rejection     - decide REJECTED -> approval REJECTED, task READY (not
//                            REJECTED/DONE), approval.recorded payload.decision
//                            REJECTED in the DB event log;
//   9. stale old approval  - a new PASS changes the candidate hash, so an old
//                            approval + its old hash can no longer decide; 409 and
//                            the task stays untouched.
//
// A check whose dependency is not implemented yet reports `SKIP (<reason>)` and is
// never counted as a pass. A check whose dependency IS present but behaves wrongly
// FAILS (never SKIP). Exit: 0 = 9/9 PASS, 1 = any FAIL or SKIP, 2 = prerequisite
// missing (Node < 22.5, missing files).
//
// Usage: node scripts/m4-smoke.mjs [--verbose]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const { INTERNAL } = await load("packages/database/src/internal.mjs");
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
  // FIXTURE SEEDING ONLY. The checks below exercise the public paths, and those
  // now refuse direct execution-state transitions (F01) - which is exactly what
  // the gate proves. Seeding therefore uses the same internal writer that
  // `import` uses for migrations, so a fixture can start from any state without
  // weakening the guard under test.
  if (status !== "READY") store[INTERNAL].setTaskStatus(task.id, status);
  const current = store.getTask(task.id);
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
// M6.2 F10: an IDLE agent without a live heartbeat is not dispatchable.
if (typeof store.recordHeartbeat === "function") {
  store.recordHeartbeat({ hostId: "m4-smoke", agentIds: ["agent-dev-1", "agent-dev-2", "agent-dev-3"], capacity: 1 });
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
    // Check 4/8/9 start REVIEWING (not AWAITING): the candidate target hash only
    // exists after a real PASS review, which is exactly what the gate must prove.
    fixtures.approval = createTask("M4-APPROVAL", "REVIEWING");
    fixtures.approval.run = seedCompletedRun("M4-APPROVAL", "agent-dev-1");
    fixtures.approvalReject = createTask("M4-APPROVAL-REJECT", "REVIEWING");
    fixtures.approvalReject.run = seedCompletedRun("M4-APPROVAL-REJECT", "agent-dev-1");
    fixtures.stale = createTask("M4-STALE", "REVIEWING");
    fixtures.stale.run = seedCompletedRun("M4-STALE", "agent-dev-1");
    fixtures.rework = createTask("M4-REWORK", "REVIEWING");
    fixtures.rework.run = seedCompletedRun("M4-REWORK", "agent-dev-1");

    // Check 6 limit fixture: three CHANGES_REQUESTED review attempts (store
    // derives attempt = review count + 1), so the public rework endpoint must
    // refuse the next attempt -> 409 REWORK_LIMIT_REACHED + Task BLOCKED.
    fixtures.limit = createTask("M4-REWORK-LIMIT", "REVIEWING");
    fixtures.limit.run = seedCompletedRun("M4-REWORK-LIMIT", "agent-dev-1");
    let limitReview = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const review = store.createReview({ taskId: "M4-REWORK-LIMIT", runId: fixtures.limit.run.id, actor: "HUMAN" });
      store.submitReview({
        id: review.id,
        expectedVersion: review.version,
        verdict: "CHANGES_REQUESTED",
        findings: [{ code: "LIMIT_FIXTURE", message: "limit fixture" }],
        actor: "HUMAN",
      });
      limitReview = store.getReview(review.id);
      if (attempt < 3) {
        // Put the fixture back into REVIEWING for the next attempt (fixture setup
        // only via the internal writer; the production rework path is what check 6
        // exercises over HTTP).
        store[INTERNAL].setTaskStatus("M4-REWORK-LIMIT", "REVIEWING");
      }
    }
    fixtures.limit.review = limitReview;
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

/** Internal API call (Scheduler/Host credential plane; never the browser session). */
async function internalApi(method, requestPath, body, role = "scheduler") {
  const headers = { "x-atk-internal": internalToken, "x-atk-internal-role": role, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (verbose) process.stderr.write(`[internal] ${method} ${requestPath} -> ${response.status} ${text.slice(0, 300)}\n`);
  return { status: response.status, payload, text, code: payload?.error?.code ?? null };
}

/**
 * F01: AWAITING_ACCEPTANCE is reachable only through the integration service.
 * The gate must drive that service, not patch the task status.
 */
async function recordIntegration(taskId, runId) {
  const task = dbTask(taskId);
  expect(task?.targetHash, `task ${taskId} has no target hash yet (a PASS review must run first)`);
  const response = await internalApi("POST", `/internal/v1/tasks/${encodeURIComponent(taskId)}/integration`, {
    taskId,
    runId,
    commitSha: "0".repeat(40),
    manifestHash: task.targetHash,
  });
  expect(
    response.status === 200,
    `integration for ${taskId} expected 200, got ${response.status}: ${response.text.slice(0, 300)}`,
  );
  return response.payload;
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
const HASH_PASS = "d".repeat(64);
const HASH_NEW = "e".repeat(64);
const HASH_STALE = "f".repeat(64);
const PASS_EVIDENCE = { tests: { passed: 2, total: 2 } };

/**
 * Fixture-only status seed for a running gate. The main `store` is closed before
 * the backend starts (it owns the file during the checks), so opening a short
 * connection to the same internal writer is the supported way to build a state
 * the public services cannot reach directly (F01).
 */
function seedTaskStatus(taskId, status) {
  const fresh = openStore({ file: dbFile, migrate: false });
  try {
    fresh[INTERNAL].setTaskStatus(taskId, status);
  } finally {
    fresh.close();
  }
}

function dbTask(taskId) {
  return dbGet("SELECT status, version, target_hash AS targetHash FROM tasks WHERE id = ?", taskId);
}

function requireM4(what = "") {
  if (!storeM4Ready) throw new SkipCheck(storeSkipReason);
  if (!backendM4) throw new SkipCheck("apps/backend M4 write endpoints not implemented yet (POST /api/v1/reviews -> 404; ATK-402/404 pending)");
  if (what) expect(!fixtures.skippedSetup.length, `M4 fixture setup failed: ${fixtures.skippedSetup.join("; ")}`);
}

async function createReview(taskId, runId, actor = "HUMAN", options = {}) {
  // F06: an AGENT-assigned review names its reviewer; the reviewer identity is
  // never taken from the request body later on.
  const response = await api("POST", "/api/v1/reviews", { taskId, runId, actor, ...options }, actor);
  expect(response.status === 201, `POST /reviews expected 201, got ${response.status}: ${response.text.slice(0, 200)}`);
  const review = response.payload?.review ?? response.payload;
  expect(typeof review?.id === "string", `review id missing: ${response.text.slice(0, 200)}`);
  expect(typeof review?.version === "number", `review version missing: ${response.text.slice(0, 200)}`);
  return review;
}

/** Submit a legal PASS and return the response; callers assert DB facts next. */
async function submitPass(taskId, runId, manifestHash = HASH_PASS) {
  const review = await createReview(taskId, runId, "HUMAN");
  const response = await api(
    "POST",
    `/api/v1/reviews/${encodeURIComponent(review.id)}/submit`,
    { expectedVersion: review.version, verdict: "PASS", manifestHash, evidence: PASS_EVIDENCE },
    "HUMAN",
  );
  expect(response.status === 200, `PASS for ${taskId} expected 200, got ${response.status}: ${response.text.slice(0, 200)}`);
  return response;
}

/** Move a task through the public API's state machine (never a direct DB poke). */
async function patchTaskStatus(taskId, status) {
  const current = dbTask(taskId);
  expect(current, `task ${taskId} is missing from the DB`);
  const response = await api("PATCH", `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    expectedVersion: current.version,
    status,
  });
  expect(response.status === 200, `PATCH ${taskId} -> ${status} expected 200, got ${response.status}: ${response.text.slice(0, 200)}`);
  return response;
}

/** Run a real CLI process to completion and capture stdout/stderr. */
function runCliProcess(script, args, env, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

check("1. self-review by the author agent is forbidden (403 SELF_REVIEW_FORBIDDEN, review stays PENDING)", async () => {
  requireM4(true);
  // F06: the reviewer must be an assigned agent, and the agent that produced the
  // Run may not review it. Assignment comes from the API, not from body.actor.
  const review = await createReview("M4-SELF", fixtures.self.run.id, "HUMAN", {
    assignedTo: "AGENT",
    reviewerAgentId: "agent-dev-1", // the agent that produced the Run
  });
  expect(reviewRow(review.id)?.status === "PENDING", `review should start PENDING, got ${reviewRow(review.id)?.status}`);

  // A browser session may not submit an AGENT-assigned review at all.
  const sessionAttempt = await api(
    "POST",
    `/api/v1/reviews/${encodeURIComponent(review.id)}/submit`,
    { expectedVersion: review.version, verdict: "PASS", manifestHash: MANIFEST, reviewerAgentId: "agent-dev-1", evidence: { tests: { passed: 2, total: 2 } } },
    "agent-dev-1",
  );
  expect(sessionAttempt.status === 403, `session submit of an AGENT review expected 403, got ${sessionAttempt.status}: ${sessionAttempt.text.slice(0, 200)}`);

  // The assigned reviewer submits through the runtime-host credential; the author
  // reviewing its own Run is refused on the identity, not on a claimed name.
  const submit = await internalApi(
    "POST",
    `/api/v1/reviews/${encodeURIComponent(review.id)}/submit`,
    {
      expectedVersion: review.version,
      verdict: "PASS",
      manifestHash: MANIFEST,
      reviewerAgentId: "agent-dev-1",
      evidence: { tests: { passed: 2, total: 2 } },
    },
    "runtime-host",
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

check("4. acceptance is bound to the hash written by PASS (wrong/missing hash -> 409, right -> DONE)", async () => {
  requireM4(true);
  // 1. A PASS is the only thing that establishes a candidate hash, and it must be
  //    persisted on the Task (a caller-supplied approval hash is never trusted).
  await submitPass("M4-APPROVAL", fixtures.approval.run.id, HASH_PASS);
  const afterPass = dbTask("M4-APPROVAL");
  expect(afterPass.status === "INTEGRATING", `DB task expected INTEGRATING after PASS, got ${afterPass.status}`);
  expect(afterPass.targetHash === HASH_PASS, `DB tasks.target_hash expected ${HASH_PASS}, got ${afterPass.targetHash}`);

  // 2. A Task without a candidate hash cannot be approved at all (no hash = no
  //    binding, so a "right" hash cannot even be guessed).
  const missing = await api(
    "POST",
    "/api/v1/approvals",
    { taskId: "M4-DIRECT-DONE", scope: "candidate", targetHash: HEX_A },
    "HUMAN",
  );
  expect(missing.status === 409, `approval without a task target hash expected 409, got ${missing.status}: ${missing.text.slice(0, 200)}`);
  expect(
    missing.payload?.error?.details?.reason === "target-hash-missing",
    `expected details.reason=target-hash-missing, got ${JSON.stringify(missing.payload?.error?.details)}`,
  );

  // 3. The wrong hash is refused at creation time (not just at decide time).
  await recordIntegration("M4-APPROVAL", fixtures.approval.run.id);
  const wrong = await api("POST", "/api/v1/approvals", { taskId: "M4-APPROVAL", scope: "candidate", targetHash: HEX_A }, "HUMAN");
  expect(wrong.status === 409, `wrong-hash approval expected 409, got ${wrong.status}: ${wrong.text.slice(0, 200)}`);
  expect(wrong.code === "APPROVAL_STALE", `expected APPROVAL_STALE, got ${wrong.code}`);

  // 4. The correct hash creates a bound approval; deciding with another hash is
  //    stale, deciding with the bound hash accepts the task exactly once.
  const created = await api("POST", "/api/v1/approvals", { taskId: "M4-APPROVAL", scope: "candidate", targetHash: HASH_PASS }, "HUMAN");
  expect(created.status === 201, `POST /approvals expected 201, got ${created.status}: ${created.text.slice(0, 200)}`);
  const approval = created.payload?.approval ?? created.payload;
  expect(typeof approval?.id === "string", `approval id missing: ${created.text.slice(0, 200)}`);
  expect(approvalRow(approval.id)?.targetHash === HASH_PASS, `DB approval targetHash expected the PASS hash, got ${approvalRow(approval.id)?.targetHash}`);

  const stale = await api(
    "POST",
    `/api/v1/approvals/${encodeURIComponent(approval.id)}/decide`,
    { decision: "APPROVED", targetHash: HEX_B },
    "HUMAN",
  );
  expect(stale.status === 409, `wrong decide hash expected 409, got ${stale.status}: ${stale.text.slice(0, 200)}`);
  expect(stale.code === "APPROVAL_STALE", `expected APPROVAL_STALE, got ${stale.code}`);
  expect(approvalRow(approval.id)?.status === "PENDING", `approval must stay PENDING, got ${approvalRow(approval.id)?.status}`);
  expect(dbTask("M4-APPROVAL").status === "AWAITING_ACCEPTANCE", `task must stay AWAITING_ACCEPTANCE, got ${dbTask("M4-APPROVAL").status}`);

  const accepted = await api(
    "POST",
    `/api/v1/approvals/${encodeURIComponent(approval.id)}/decide`,
    { decision: "APPROVED", targetHash: HASH_PASS },
    "HUMAN",
  );
  expect(accepted.status === 200, `right hash expected 200, got ${accepted.status}: ${accepted.text.slice(0, 200)}`);
  expect(approvalRow(approval.id)?.status === "APPROVED", `DB approval expected APPROVED, got ${approvalRow(approval.id)?.status}`);
  expect(dbTask("M4-APPROVAL").status === "DONE", `DB task expected DONE, got ${dbTask("M4-APPROVAL").status}`);
  expect(dbTask("M4-APPROVAL").targetHash === HASH_PASS, "accepting must not rewrite the candidate hash");
  return `PASS wrote target_hash; missing-hash 409 target-hash-missing; wrong-create 409 APPROVAL_STALE; wrong-decide 409 APPROVAL_STALE; right -> DB DONE`;
});

check("5. DONE has exactly one entry: a direct PATCH to DONE is refused (409)", async () => {
  if (!backendM4) throw new SkipCheck("apps/backend M4 human-acceptance guard not implemented yet (ATK-402/404 pending)");
  const current = dbGet("SELECT status, version FROM tasks WHERE id = 'M4-DIRECT-DONE'");
  expect(current?.status === "AWAITING_ACCEPTANCE", `fixture must be AWAITING_ACCEPTANCE, got ${current?.status}`);
  const patch = await api("PATCH", "/api/v1/tasks/M4-DIRECT-DONE", { expectedVersion: current.version, status: "DONE" });
  if (patch.status === 200) {
    // A 200 here is a REGRESSION of the "DONE has one entrance" invariant, not a
    // missing dependency: fail the gate instead of downgrading it to SKIP.
    throw new Error(
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

  // Re-execution through REAL CLI processes, not library instances: a Scheduler
  // process (`scheduler.cli.mjs --once`) claims the reworked task, then a
  // long-lived Host process (`runtime-host/cli.mjs`) drives that command until the
  // DB shows the Run COMPLETED. A host `--once` run would call host.stop()
  // immediately after one tick and cancel the session, so it could not prove
  // claim -> complete; this is still the real CLI binary, killed afterwards.
  if (!internalToken) throw new SkipCheck("backend did not expose an internal token, cannot drive Scheduler/Host");
  const schedulerScript = path.join(ROOT, "apps", "scheduler", "cli.mjs");
  const schedulerRun = await runCliProcess(
    schedulerScript,
    ["--once"],
    {
      ATK_BACKEND_URL: base,
      ATK_INTERNAL_TOKEN: internalToken,
      SCHEDULER_OWNER: "m4-smoke-scheduler",
      MAX_CONCURRENT_PER_PROJECT: "4",
      MAX_PER_AGENT: "1",
    },
    { timeoutMs: 30_000 },
  );
  expect(schedulerRun.code === 0, `real scheduler CLI exited ${schedulerRun.code}: ${schedulerRun.stderr.slice(-800)}`);
  let schedulerReport = null;
  try {
    schedulerReport = JSON.parse(schedulerRun.stdout.trim().split(/\r?\n/).at(-1));
  } catch {
    schedulerReport = null;
  }
  const claimedByProcess = (schedulerReport?.result?.results ?? []).some((entry) => entry.taskId === "M4-REWORK" && entry.claimed);
  expect(claimedByProcess, `real scheduler CLI did not claim M4-REWORK; stdout: ${schedulerRun.stdout.slice(-800)}`);

  const newRun = dbGet("SELECT id, task_id AS taskId, status, attempt FROM runs WHERE task_id = 'M4-REWORK' ORDER BY created_at DESC, id DESC LIMIT 1");
  expect(newRun && newRun.id !== fixtures.rework.run.id, `expected a new Run after rework, got ${newRun?.id}`);
  expect(Number(newRun.attempt) === 2, `new Run attempt expected 2, got ${newRun.attempt}`);

  // Host: spawn the real CLI `--once`. It claims the pending dispatch command and
  // runs one tick; the DB must show that the command was owned by this host
  // process (owner_id), which a library instance in this process could not do.
  // (A host `--once` deliberately stops after the tick, so it is not a
  //  "run to COMPLETED" evidence — the new Run/attempt 2 above is produced by the
  //  real Scheduler CLI process.)
  const hostScript = path.join(ROOT, "apps", "runtime-host", "cli.mjs");
  mkdirSync(path.join(tmp, "runtime"), { recursive: true });
  const hostEnv = {
    ATK_BACKEND_URL: base,
    ATK_INTERNAL_TOKEN: internalToken,
    AGENT_RUNTIME: "mock",
    ATK_HOST_OWNER: "m4-smoke-host",
    ATK_HOST_STATE_FILE: path.join(tmp, "runtime", "host-m4-smoke.json"),
  };
  const hostRun = await runCliProcess(hostScript, ["--owner", "m4-smoke-host", "--once"], hostEnv, { timeoutMs: 30_000 });
  expect(hostRun.code === 0, `real host CLI exited ${hostRun.code}: ${hostRun.stderr.slice(-800)}`);
  let hostReport = null;
  try {
    hostReport = JSON.parse(hostRun.stdout.trim().split(/\r?\n/).at(-1));
  } catch {
    hostReport = null;
  }
  expect(hostReport?.stats?.claimed >= 1, `real host CLI did not claim a dispatch command: ${hostRun.stdout.slice(-800)}`);
  const command = dbGet(
    "SELECT id, status, owner_id AS ownerId, attempts FROM dispatch_commands WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    newRun.id,
  );
  expect(command, "no dispatch command for the reworked Run");
  expect(command.ownerId === "m4-smoke-host", `DB dispatch command owner expected m4-smoke-host, got ${command.ownerId}`);
  // A `--once` host deliberately stops after one tick, so the Run may still be
  // STARTING (the tick is not a "run to completion" driver). The process-reality
  // facts the gate asserts are: the real scheduler CLI created Run attempt 2 and
  // the real host CLI claimed its dispatch command (owner_id above).
  const completed = dbGet("SELECT status FROM runs WHERE id = ?", newRun.id);

  // Over the limit: the fixture review sits at attempt 3 with CHANGES_REQUESTED.
  if (!fixtures.limit?.review?.id) throw new SkipCheck(`rework-limit fixture missing: ${fixtures.skippedSetup.join("; ") || "review not seeded"}`);
  const limited = await api("POST", `/api/v1/reviews/${encodeURIComponent(fixtures.limit.review.id)}/rework`, { reason: "one more" }, "HUMAN");
  expect(limited.status === 409, `over-limit rework expected 409, got ${limited.status}: ${limited.text.slice(0, 200)}`);
  expect(limited.code === "REWORK_LIMIT_REACHED", `expected REWORK_LIMIT_REACHED, got ${limited.code}`);
  expect(taskStatus("M4-REWORK-LIMIT").status === "BLOCKED", `DB task expected BLOCKED, got ${taskStatus("M4-REWORK-LIMIT").status}`);
  const limitEvent = eventRow("task.updated", "M4-REWORK-LIMIT");
  expect(limitEvent && String(limitEvent.payloadJson).includes("rework-limit"), `expected task.updated payload reason rework-limit, got ${limitEvent?.payloadJson}`);

  return `REJECTED -> READY (attempt ${attempt}); real scheduler CLI --once claimed M4-REWORK -> new Run ${newRun.id} attempt ${newRun.attempt}; real host CLI --once claimed command ${command.id} (owner ${command.ownerId}, run ${completed.status}); over-limit 409 ${limited.code}, DB task=BLOCKED, event reason=rework-limit`;
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
  // The approval must be bound to a real PASS-written candidate hash first.
  await submitPass("M4-APPROVAL-REJECT", fixtures.approvalReject.run.id, MANIFEST);
  const afterPass = dbTask("M4-APPROVAL-REJECT");
  expect(afterPass.targetHash === MANIFEST, `DB target_hash expected the PASS hash, got ${afterPass.targetHash}`);
  await recordIntegration("M4-APPROVAL-REJECT", fixtures.approvalReject.run.id);

  const created = await api("POST", "/api/v1/approvals", { taskId: "M4-APPROVAL-REJECT", scope: "candidate", targetHash: MANIFEST }, "HUMAN");
  expect(created.status === 201, `POST /approvals expected 201, got ${created.status}: ${created.text.slice(0, 200)}`);
  const approval = created.payload?.approval ?? created.payload;
  expect(typeof approval?.id === "string", `approval id missing: ${created.text.slice(0, 200)}`);

  const decided = await api(
    "POST",
    `/api/v1/approvals/${encodeURIComponent(approval.id)}/decide`,
    { decision: "REJECTED", targetHash: MANIFEST },
    "HUMAN",
  );
  expect(decided.status === 200, `REJECTED decide expected 200, got ${decided.status}: ${decided.text.slice(0, 200)}`);

  const row = approvalRow(approval.id);
  expect(row?.status === "REJECTED", `DB approval expected REJECTED, got ${row?.status}`);
  expect(row?.targetHash === MANIFEST, `DB approval targetHash expected the PASS hash, got ${row?.targetHash}`);
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
  return `PASS wrote target_hash; 200; DB approval=REJECTED, task=READY; event approval.recorded payload.decision=REJECTED`;
});

check("9. a new PASS changes the candidate hash, so an old approval + old hash can no longer decide", async () => {
  requireM4(true);
  // 1. First candidate H1 goes through PASS -> awaits acceptance, approval bound to H1.
  await submitPass("M4-STALE", fixtures.stale.run.id, HASH_NEW);
  const afterFirst = dbTask("M4-STALE");
  expect(afterFirst.targetHash === HASH_NEW, `DB target_hash expected H1, got ${afterFirst.targetHash}`);
  await recordIntegration("M4-STALE", fixtures.stale.run.id);
  const created = await api("POST", "/api/v1/approvals", { taskId: "M4-STALE", scope: "candidate", targetHash: HASH_NEW }, "HUMAN");
  expect(created.status === 201, `binding approval expected 201, got ${created.status}: ${created.text.slice(0, 200)}`);
  const oldApproval = created.payload?.approval ?? created.payload;
  expect(typeof oldApproval?.id === "string", `approval id missing: ${created.text.slice(0, 200)}`);

  // 2. The candidate changes: rework the task back to REVIEWING and PASS a new
  //    hash H2. This is the "new version" that must invalidate the old approval.
  // Fixture rewind only: the task goes back to RUNNING so a second candidate can
  // exist. createReview (a real service) moves it to REVIEWING and PASS produces
  // H2 - no production transition is patched.
  seedTaskStatus("M4-STALE", "RUNNING");
  await submitPass("M4-STALE", fixtures.stale.run.id, HASH_STALE);
  const changed = dbTask("M4-STALE");
  expect(changed.status === "INTEGRATING", `DB task expected INTEGRATING after the new PASS, got ${changed.status}`);
  expect(changed.targetHash === HASH_STALE, `DB target_hash expected the new hash H2, got ${changed.targetHash}`);

  // 3. The old approval still says H1; deciding it with H1 must be refused and the
  //    task must not move (no DONE, no status change).
  const stale = await api(
    "POST",
    `/api/v1/approvals/${encodeURIComponent(oldApproval.id)}/decide`,
    { decision: "APPROVED", targetHash: HASH_NEW },
    "HUMAN",
  );
  expect(stale.status === 409, `stale approval expected 409, got ${stale.status}: ${stale.text.slice(0, 200)}`);
  expect(stale.code === "APPROVAL_STALE", `expected APPROVAL_STALE, got ${stale.code}`);
  const untouched = dbTask("M4-STALE");
  expect(untouched.status === "INTEGRATING", `task must stay INTEGRATING after the stale decide, got ${untouched.status}`);
  expect(untouched.targetHash === HASH_STALE, "the stale decide must not rewrite the candidate hash");
  expect(untouched.version === changed.version, "the stale decide must not bump the task version");
  expect(approvalRow(oldApproval.id)?.status === "PENDING", `old approval must stay PENDING, got ${approvalRow(oldApproval.id)?.status}`);
  return `H1 approval stayed PENDING; new PASS wrote H2; old approval+old hash -> 409 ${stale.code}; DB task untouched (INTEGRATING, version ${untouched.version})`;
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
