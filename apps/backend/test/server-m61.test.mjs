// M6.1 WP1: reproduction (stage A) + stage B regression tests for F01/F06/F11.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { checkInternalRole, requiredInternalRoles } from "../src/internal.mjs";
import { createFakeStore } from "./fake-store.mjs";
import { internalHeaders, readHeaders, request, startServer, writeHeaders } from "./helpers.mjs";

const MANIFEST = "a".repeat(64);

function baseTask(overrides = {}) {
  return {
    id: "TASK-1",
    projectId: "P-1",
    title: "Task",
    description: "d",
    functionRequired: "WORKER",
    roleRequired: "BE",
    priority: 2,
    deps: [],
    status: "READY",
    version: 0,
    ...overrides,
  };
}

async function withStore(t, store) {
  const ctx = await startServer({ store });
  t.after(() => ctx.server.close());
  return ctx;
}

test("F01: generic PATCH must not advance execution states (CLAIMED/RUNNING/REVIEWING/INTEGRATING/AWAITING_ACCEPTANCE)", async (t) => {
  const executionStates = ["CLAIMED", "RUNNING", "REVIEWING", "INTEGRATING", "AWAITING_ACCEPTANCE"];
  for (const status of executionStates) {
    const store = createFakeStore({ projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }], tasks: [baseTask()] });
    const ctx = await withStore(t, store);
    const res = await request(ctx.base, {
      method: "PATCH",
      path: "/api/v1/tasks/TASK-1",
      headers: writeHeaders(ctx.base),
      body: { expectedVersion: 0, changes: { status } },
    });
    assert.ok(
      res.status === 409 || res.status === 403,
      `PATCH status=${status} must be refused by the generic endpoint (expected 409/403), got ${res.status}: ${res.text}`,
    );
    assert.equal(res.json.error.code, "TASK_VERSION_CONFLICT", `PATCH status=${status}: ${res.text}`);
    // The task did not move.
    const task = await request(ctx.base, { path: "/api/v1/tasks/TASK-1", headers: readHeaders() });
    assert.equal(task.json.status, "READY", `PATCH status=${status} must not mutate the task`);
  }

  // Control: DONE is already guarded (this part is green on baseline).
  const store = createFakeStore({ projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }], tasks: [baseTask()] });
  const ctx = await withStore(t, store);
  const done = await request(ctx.base, {
    method: "PATCH",
    path: "/api/v1/tasks/TASK-1",
    headers: writeHeaders(ctx.base),
    body: { expectedVersion: 0, changes: { status: "DONE" } },
  });
  assert.equal(done.status, 409);
  assert.equal(done.json.error.details.reason, "execution-state-guard");
  assert.equal(done.json.error.details.requestedStatus, "DONE");
});

test("F06: body.actor is ignored; reviewer identity comes from the trusted assignment/credential", async (t) => {
  const makeStore = (reviewOverrides = {}) =>
    createFakeStore({
      projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
      tasks: [baseTask({ status: "REVIEWING" })],
      runs: [
        { id: "RUN-1", taskId: "TASK-1", agentId: "agent-1", function: "WORKER", status: "COMPLETED", attempt: 1 },
        { id: "RUN-2", taskId: "TASK-1", agentId: "agent-3", function: "REVIEWER", status: "RUNNING", attempt: 2 },
        { id: "RUN-OTHER", taskId: "TASK-OTHER", agentId: "agent-3", function: "REVIEWER", status: "RUNNING", attempt: 1 },
      ],
      reviews: [
        {
          id: "REV-ASSIGN",
          taskId: "TASK-1",
          runId: "RUN-1",
          status: "PENDING",
          verdict: null,
          version: 0,
          attempt: 1,
          findings: [],
          ...reviewOverrides,
        },
      ],
    });
  const submitBody = (actor, runId) => ({
    expectedVersion: 0,
    verdict: "PASS",
    manifestHash: MANIFEST,
    evidence: { tests: { passed: 1, total: 1 } },
    actor,
    ...(runId === undefined ? {} : { runId }),
  });

  // 1. Session (human) cannot submit an AGENT assignment, regardless of body.actor.
  {
    const ctx = await withStore(t, makeStore({ assignedTo: "AGENT", reviewerAgentId: "agent-3" }));
    for (const actor of ["agent-3", "AGENT-3", " agent-3", "agent-3 ", "agent-1", "forged"]) {
      const res = await request(ctx.base, {
        method: "POST",
        path: "/api/v1/reviews/REV-ASSIGN/submit",
        headers: writeHeaders(ctx.base),
        body: submitBody(actor),
      });
      assert.equal(res.status, 403, `session + actor ${JSON.stringify(actor)}: ${res.text}`);
      assert.equal(res.json.error.details.reason, "review-requires-runtime-host");
    }
    const review = await request(ctx.base, { path: "/api/v1/reviews?taskId=TASK-1", headers: readHeaders() });
    assert.equal(review.json.items[0].status, "PENDING");
  }

  // 2. Internal credential + missing role → required; wrong role → forbidden.
  {
    const ctx = await withStore(t, makeStore({ assignedTo: "AGENT", reviewerAgentId: "agent-3" }));
    const missingRole = await request(ctx.base, {
      method: "POST",
      path: "/api/v1/reviews/REV-ASSIGN/submit",
      headers: { "x-atk-internal": internalHeaders()["x-atk-internal"] },
      body: submitBody("ignored"),
    });
    assert.equal(missingRole.status, 403, missingRole.text);
    assert.equal(missingRole.json.error.details.reason, "internal-role-required");

    const wrongRole = await request(ctx.base, {
      method: "POST",
      path: "/api/v1/reviews/REV-ASSIGN/submit",
      headers: internalHeaders(undefined, "scheduler"),
      body: submitBody("ignored"),
    });
    assert.equal(wrongRole.status, 403, wrongRole.text);
    assert.equal(wrongRole.json.error.details.reason, "internal-role-forbidden");
  }

  // 3. runtime-host with no assignment → assignment-required (body.actor ignored).
  {
    const ctx = await withStore(t, makeStore({ assignedTo: "AGENT" }));
    const res = await request(ctx.base, {
      method: "POST",
      path: "/api/v1/reviews/REV-ASSIGN/submit",
      headers: internalHeaders(undefined, "runtime-host"),
      body: submitBody("agent-3"),
    });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.error.details.reason, "review-assignment-required");
  }

  // 4. Assignment equals the reviewed Run's author → self-review (even via runtime-host).
  {
    const ctx = await withStore(t, makeStore({ assignedTo: "AGENT", reviewerAgentId: "agent-1" }));
    const res = await request(ctx.base, {
      method: "POST",
      path: "/api/v1/reviews/REV-ASSIGN/submit",
      headers: internalHeaders(undefined, "runtime-host"),
      body: submitBody("agent-1", "RUN-1"),
    });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.error.code, "SELF_REVIEW_FORBIDDEN");
    assert.equal(res.json.error.details.reviewerAgentId, "agent-1");
    assert.equal(res.json.error.details.authorAgentId, "agent-1");
  }

  // 5. Valid AGENT assignment submitted by runtime-host succeeds.
  {
    const ctx = await withStore(t, makeStore({ assignedTo: "AGENT", reviewerAgentId: "agent-3" }));
    const res = await request(ctx.base, {
      method: "POST",
      path: "/api/v1/reviews/REV-ASSIGN/submit",
      headers: internalHeaders(undefined, "runtime-host"),
      body: submitBody("forged-body-actor", "RUN-2"),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.review.status, "PASS");
    assert.equal(res.json.task.status, "INTEGRATING");
  }

  // 5b. The assigned reviewer's Run is the trust anchor: missing, other-task
  // and other-agent Runs are all refused even with a valid assignment.
  {
    const forgedRunBodies = [
      ["missing runId", submitBody("forged")],
      ["other task", submitBody("forged", "RUN-OTHER")],
      ["other agent", submitBody("forged", "RUN-1")],
      ["unknown run", submitBody("forged", "RUN-NOPE")],
    ];
    for (const [label, body] of forgedRunBodies) {
      const ctx = await withStore(t, makeStore({ assignedTo: "AGENT", reviewerAgentId: "agent-3" }));
      const res = await request(ctx.base, {
        method: "POST",
        path: "/api/v1/reviews/REV-ASSIGN/submit",
        headers: internalHeaders(undefined, "runtime-host"),
        body,
      });
      assert.equal(res.status, 403, `${label}: ${res.text}`);
      assert.equal(res.json.error.code, "SELF_REVIEW_FORBIDDEN", label);
      assert.equal(res.json.error.details.reviewerAgentId, "agent-3", label);
    }
  }

  // 6. HUMAN assignment: session fills actor=HUMAN; body.actor is ignored.
  {
    const hex = "b".repeat(64);
    const store = createFakeStore({
      projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
      tasks: [
        baseTask({ id: "TASK-HUMAN", status: "REVIEWING" }),
        baseTask({ id: "TASK-APPROVE", status: "AWAITING_ACCEPTANCE", targetHash: hex }),
        baseTask({ id: "TASK-OTHER", status: "AWAITING_ACCEPTANCE", targetHash: "c".repeat(64) }),
      ],
      reviews: [
        { id: "REV-HUMAN", taskId: "TASK-HUMAN", runId: null, status: "PENDING", verdict: null, version: 0, attempt: 1, findings: [], assignedTo: "HUMAN" },
      ],
    });
    const ctx = await withStore(t, store);
    const submit = await request(ctx.base, {
      method: "POST",
      path: "/api/v1/reviews/REV-HUMAN/submit",
      headers: writeHeaders(ctx.base),
      body: submitBody("forged-agent-id"),
    });
    assert.equal(submit.status, 200, submit.text);
    assert.equal(submit.json.review.status, "PASS");

    const approval = await request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: writeHeaders(ctx.base),
      body: { taskId: "TASK-APPROVE", scope: "acceptance", targetHash: hex, actor: "forged-agent-id" },
    });
    assert.equal(approval.status, 201, approval.text);
    assert.equal(approval.json.actor, "HUMAN");
    const decide = await request(ctx.base, {
      method: "POST",
      path: `/api/v1/approvals/${approval.json.id}/decide`,
      headers: writeHeaders(ctx.base),
      body: { decision: "APPROVED", targetHash: hex, taskId: "TASK-OTHER", actor: "forged-agent-id" },
    });
    assert.equal(decide.status, 200, decide.text);
    assert.equal(decide.json.approval.actor, "HUMAN");
    // The approval decides only its own Task; a body taskId cannot redirect it.
    const other = await request(ctx.base, { path: "/api/v1/tasks/TASK-OTHER", headers: readHeaders() });
    assert.equal(other.json.status, "AWAITING_ACCEPTANCE");
    const events = await request(ctx.base, { path: "/api/v1/events?type=approval.recorded", headers: readHeaders() });
    assert.ok(events.json.items.length >= 1);
    assert.ok(events.json.items.some((event) => event.payload?.actor === "HUMAN"));
    assert.equal(JSON.stringify(events.json.items).includes("forged-agent-id"), false);
  }
});

test("F11: GET /reviews?status=PENDING&limit=50 must filter before paginating (200 rows, target at #150)", async (t) => {
  const reviews = [];
  for (let index = 0; index < 200; index += 1) {
    reviews.push({
      id: `REV-${String(index).padStart(3, "0")}`,
      taskId: "TASK-1",
      runId: "RUN-1",
      actor: "agent-2",
      // The target (#150) and every later row are PENDING; the first 150 are not.
      status: index >= 150 ? "PENDING" : "PASS",
      verdict: index >= 150 ? null : "PASS",
      version: 1,
      attempt: 1,
      findings: [],
    });
  }
  const store = createFakeStore({
    projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks: [baseTask({ status: "REVIEWING" })],
    reviews,
  });
  const ctx = await withStore(t, store);

  const page = await request(ctx.base, { path: "/api/v1/reviews?status=PENDING&limit=50", headers: readHeaders() });
  assert.equal(page.status, 200, page.text);
  assert.equal(page.json.items.length, 50, `expected a full PENDING page, got ${JSON.stringify(page.json)}`);
  assert.ok(page.json.items.every((review) => review.status === "PENDING"), "every returned row must be PENDING");
  assert.ok(
    page.json.items.some((review) => review.id === "REV-150"),
    `the first PENDING page must start at the first PENDING row (#150), got ${page.json.items.map((review) => review.id).join(",")}`,
  );
});

test("F01: generic PATCH still allows the non-execution transitions and idempotent no-op", async (t) => {
  const transitions = [
    ["DRAFT", "READY"],
    ["REJECTED", "READY"],
    ["BLOCKED", "READY"],
    ["READY", "BLOCKED"],
    ["READY", "CANCELLED"],
    ["AWAITING_ACCEPTANCE", "BLOCKED"],
    ["AWAITING_ACCEPTANCE", "CANCELLED"],
  ];
  for (const [from, to] of transitions) {
    const store = createFakeStore({
      projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
      tasks: [baseTask({ status: from })],
    });
    const ctx = await withStore(t, store);
    const res = await request(ctx.base, {
      method: "PATCH",
      path: "/api/v1/tasks/TASK-1",
      headers: writeHeaders(ctx.base),
      body: { expectedVersion: 0, changes: { status: to } },
    });
    assert.equal(res.status, 200, `${from} -> ${to}: ${res.text}`);
    assert.equal(res.json.status, to, `${from} -> ${to}`);
  }

  const store = createFakeStore({
    projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks: [baseTask({ status: "READY" })],
  });
  const ctx = await withStore(t, store);
  const noop = await request(ctx.base, {
    method: "PATCH",
    path: "/api/v1/tasks/TASK-1",
    headers: writeHeaders(ctx.base),
    body: { expectedVersion: 0, changes: { status: "READY" } },
  });
  assert.equal(noop.status, 200, noop.text);
  assert.equal(noop.json.status, "READY");
});

test("F11: cursor pagination filters first, walks every PENDING row without duplicates", async (t) => {
  const reviews = [];
  for (let index = 0; index < 260; index += 1) {
    reviews.push({
      id: `REV-${String(index).padStart(3, "0")}`,
      taskId: "TASK-1",
      runId: "RUN-1",
      actor: "agent-2",
      status: "PENDING",
      verdict: null,
      version: 1,
      attempt: 1,
      findings: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const ctx = await withStore(
    t,
    createFakeStore({
      projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
      tasks: [baseTask({ status: "REVIEWING" })],
      reviews,
    }),
  );

  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const query = new URLSearchParams({ status: "PENDING", limit: "50" });
    if (cursor !== undefined) query.set("cursor", cursor);
    if (pages === 0) query.set("withTotal", "1");
    const page = await request(ctx.base, { path: `/api/v1/reviews?${query}`, headers: readHeaders() });
    assert.equal(page.status, 200, page.text);
    assert.ok(page.json.items.every((review) => review.status === "PENDING"));
    if (pages === 0) assert.equal(page.json.total, 260, "withTotal=1 returns the filtered total");
    seen.push(...page.json.items.map((review) => review.id));
    cursor = page.json.nextCursor;
    pages += 1;
    if (!page.json.hasMore) break;
    assert.equal(typeof cursor, "string", "hasMore requires nextCursor");
  } while (pages < 10);

  assert.equal(pages, 6, `expected 6 pages of 50/10, got ${pages}`);
  assert.equal(seen.length, 260);
  assert.equal(new Set(seen).size, 260, "no duplicate reviews across pages");
  const expected = [...reviews].sort((a, b) => (a.id < b.id ? 1 : -1)).map((review) => review.id);
  assert.deepEqual(seen, expected, "descending keyset order is complete and stable");
});

test("F06 helper: internal role matrix is deny-by-default and endpoint-scoped", () => {
  assert.deepEqual(requiredInternalRoles("POST", "/internal/v1/tasks/TASK-1/claim"), ["scheduler"]);
  assert.deepEqual(requiredInternalRoles("POST", "/internal/v1/runs/RUN-1/events"), ["runtime-host"]);
  assert.equal(requiredInternalRoles("POST", "/internal/v1/unknown"), null);

  assert.deepEqual(checkInternalRole(undefined, ["scheduler"]), {
    ok: false,
    reason: "internal-role-required",
    allowed: ["scheduler"],
  });
  assert.equal(checkInternalRole("runtime-host", ["scheduler"]).reason, "internal-role-forbidden");
  assert.equal(checkInternalRole("forged", ["scheduler"]).reason, "internal-role-forbidden");
  assert.deepEqual(checkInternalRole("scheduler", ["scheduler"]), { ok: true, role: "scheduler" });
  assert.deepEqual(checkInternalRole("user-action", ["scheduler", "user-action"]), { ok: true, role: "user-action" });
});

test("F06 real SQLite: assignment-bound review, session refused, runtime-host accepted", async (t) => {
  const { openStore } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "..", "..", "packages", "database", "src", "index.mjs")).href
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m61-f06-"));
  const store = openStore({ file: path.join(dir, "atk.db"), migrate: true });
  store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
  const task = store.createTask({
    id: "T-F06",
    projectId: "P1",
    title: "review me",
    description: "d",
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority: 2,
    deps: [],
    acceptance: "x",
  });
  store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
  const claim = store.claimTask({ taskId: task.id, agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: "m61-f06" });
  store.updateRunStatus(claim.run.id, { status: "RUNNING" });
  store.updateRunStatus(claim.run.id, { status: "COMPLETED" });
  // Fixture: the owning runtime-event service already advanced the Task to
  // RUNNING before the batch completed; emulate that persisted state directly.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path.join(dir, "atk.db"));
  raw.prepare("UPDATE tasks SET status = 'RUNNING', version = version + 1 WHERE id = ?").run(task.id);
  raw.close();
  const reviewerRun = store.createRun({ id: "RUN-REVIEWER", taskId: task.id, agentId: "reviewer-1", function: "WORKER", role: "REVIEWER", status: "RUNNING" });

  const ctx = await startServer({ store });
  t.after(async () => {
    await ctx.server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const created = await request(ctx.base, {
    method: "POST",
    path: "/api/v1/reviews",
    headers: writeHeaders(ctx.base),
    body: { taskId: task.id, runId: claim.run.id, reviewerAgentId: "reviewer-1", assignedTo: "AGENT", actor: "forged" },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.reviewerAgentId, "reviewer-1");
  assert.equal(created.json.assignedTo, "AGENT");
  assert.equal(created.json.status, "PENDING");

  const body = {
    expectedVersion: 0,
    verdict: "PASS",
    manifestHash: MANIFEST,
    evidence: { tests: { passed: 1, total: 1 } },
    runId: reviewerRun.id,
    actor: "forged",
  };
  const sessionSubmit = await request(ctx.base, {
    method: "POST",
    path: `/api/v1/reviews/${created.json.id}/submit`,
    headers: writeHeaders(ctx.base),
    body,
  });
  assert.equal(sessionSubmit.status, 403, sessionSubmit.text);
  assert.equal(sessionSubmit.json.error.details.reason, "review-requires-runtime-host");

  const hostSubmit = await request(ctx.base, {
    method: "POST",
    path: `/api/v1/reviews/${created.json.id}/submit`,
    headers: internalHeaders(undefined, "runtime-host"),
    body,
  });
  assert.equal(hostSubmit.status, 200, hostSubmit.text);
  assert.equal(hostSubmit.json.review.status, "PASS");
  assert.equal(hostSubmit.json.task.status, "INTEGRATING");
});

test("F06 real SQLite: producer is review.runId, self-review 403 and unknown producer 400", async (t) => {
  const { openStore } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "..", "..", "packages", "database", "src", "index.mjs")).href
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m61-f06-producer-"));
  const file = path.join(dir, "atk.db");
  const store = openStore({ file, migrate: true });
  store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
  store.createTask({ id: "T-SELF", projectId: "P1", title: "self", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
  store.createTask({ id: "T-NOPROD", projectId: "P1", title: "noprod", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
  const producer = store.createRun({ id: "RUN-SELF", taskId: "T-SELF", agentId: "agent-1", function: "WORKER", role: "DEV", status: "RUNNING" });
  store.updateRunStatus(producer.id, { status: "RUNNING" });
  store.updateRunStatus(producer.id, { status: "COMPLETED" });
  // The reviewer's own Run proves who is submitting, but must NOT become the producer.
  const reviewerRun = store.createRun({ id: "RUN-REVIEWER2", taskId: "T-NOPROD", agentId: "reviewer-1", function: "WORKER", role: "REVIEWER", status: "RUNNING" });
  const at = "2026-01-01T00:00:00.000Z";
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE tasks SET status = 'REVIEWING' WHERE id IN ('T-SELF','T-NOPROD')").run();
  const insert = raw.prepare(
    `INSERT INTO reviews
       (id, task_id, run_id, status, verdict, manifest_hash, commit_sha, findings_json, attempt,
        version, reviewer, evidence_json, submitted_at, created_at, updated_at, reviewer_agent_id, assigned_to)
     VALUES (?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL, 1, 0, NULL, NULL, NULL, ?, ?, ?, 'AGENT')`,
  );
  insert.run("REV-SELF", "T-SELF", "RUN-SELF", at, at, "agent-1");
  insert.run("REV-NOPROD", "T-NOPROD", null, at, at, "reviewer-1");
  raw.close();

  const ctx = await startServer({ store });
  t.after(async () => {
    await ctx.server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const body = (runId) => ({
    expectedVersion: 0,
    verdict: "PASS",
    manifestHash: MANIFEST,
    evidence: { tests: { passed: 1, total: 1 } },
    runId,
  });

  const self = await request(ctx.base, {
    method: "POST",
    path: "/api/v1/reviews/REV-SELF/submit",
    headers: internalHeaders(undefined, "runtime-host"),
    body: body("RUN-SELF"),
  });
  assert.equal(self.status, 403, self.text);
  assert.equal(self.json.error.code, "SELF_REVIEW_FORBIDDEN");

  const noProducer = await request(ctx.base, {
    method: "POST",
    path: "/api/v1/reviews/REV-NOPROD/submit",
    headers: internalHeaders(undefined, "runtime-host"),
    body: body(reviewerRun.id),
  });
  assert.equal(noProducer.status, 400, noProducer.text);
  assert.equal(noProducer.json.error.code, "VALIDATION_ERROR");
  assert.equal(noProducer.json.error.details.reason, "review-run-unknown");
});

test("F12 real SQLite: events response exposes the retained earliestSeq", async (t) => {
  const { openStore } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "..", "..", "packages", "database", "src", "index.mjs")).href
  );
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m61-earliest-"));
  const file = path.join(dir, "atk.db");
  const store = openStore({ file, migrate: true });
  store.createProject({ id: "P-1", name: "P", repoPath: ".", defaultBranch: "main" });
  const ctx = await startServer({ store });
  t.after(async () => {
    await ctx.server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const empty = await request(ctx.base, { path: "/api/v1/events", headers: readHeaders() });
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.json.earliestSeq, null, "an empty log has no retained seq");
  assert.equal(empty.json.items.length, 0);

  for (let index = 0; index < 3; index += 1) {
    store.appendEvent({ projectId: "P-1", aggregateType: "task", aggregateId: "T-1", type: "task.updated", payload: { index } });
  }
  const before = await request(ctx.base, { path: "/api/v1/events", headers: readHeaders() });
  assert.equal(before.json.earliestSeq, 1);
  assert.deepEqual(before.json.items.map((event) => event.seq), [1, 2, 3]);

  // Simulate retention trimming and prove the metadata moves with it.
  const raw = new DatabaseSync(file);
  raw.prepare("DELETE FROM events WHERE seq < 3").run();
  raw.close();
  const trimmed = await request(ctx.base, { path: "/api/v1/events", headers: readHeaders() });
  assert.equal(trimmed.json.earliestSeq, 3, "earliestSeq is the smallest RETAINED seq");
  assert.deepEqual(trimmed.json.items.map((event) => event.seq), [3]);
  // It is global metadata, not the filtered page's first seq: a filter with no
  // matches still reports the retained floor.
  const filtered = await request(ctx.base, { path: "/api/v1/events?aggregateId=T-NOPE", headers: readHeaders() });
  assert.equal(filtered.json.items.length, 0);
  assert.equal(filtered.json.earliestSeq, 3);
});
