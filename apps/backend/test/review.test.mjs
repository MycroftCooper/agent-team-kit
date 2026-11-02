// M4 review / rework / human acceptance API tests (m4-contracts §2).
// The contract-layer checks (self-review, PASS evidence, approval target hash,
// DONE entrance) are asserted through real HTTP, not just via the fake store.
import assert from "node:assert/strict";
import test from "node:test";

import { validateErrorBody } from "@atk/contracts";

import { createFakeStore } from "./fake-store.mjs";
import {
  TEST_TOKEN,
  closeSse,
  internalHeaders,
  openSse,
  readHeaders,
  request,
  startServer,
  waitForFrame,
  writeHeaders,
} from "./helpers.mjs";

const MANIFEST_HASH = "a".repeat(64);
const TARGET_HASH = "1".repeat(64);
const OTHER_HASH = "2".repeat(64);

function baseTask(overrides = {}) {
  return {
    id: "TASK-1",
    projectId: "P-1",
    title: "Review me",
    description: "d",
    functionRequired: "WORKER",
    roleRequired: "BE",
    priority: 2,
    deps: [],
    status: "REVIEWING",
    version: 0,
    ...overrides,
  };
}

function createStore({ taskOverrides = {}, tasks = [], runs = [], reviews = [] } = {}) {
  return createFakeStore({
    projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks: [
      baseTask(taskOverrides),
      ...tasks,
    ],
    runs: [
      { id: "RUN-1", taskId: "TASK-1", agentId: "agent-1", function: "WORKER", status: "COMPLETED", attempt: 1 },
      ...runs,
    ],
    reviews,
  });
}

async function withServer(t, options = {}) {
  const store = options.store ?? createStore(options);
  const ctx = await startServer({ store });
  t.after(() => ctx.server.close());
  return { ...ctx, store };
}

function assertErrorEnvelope(res, expectedCode, expectedStatus) {
  assert.equal(res.status, expectedStatus, `expected HTTP ${expectedStatus}, body: ${res.text}`);
  assert.ok(res.json, `expected a JSON error body, got: ${res.text}`);
  assert.deepEqual(validateErrorBody(res.json), { ok: true, errors: [] }, res.text);
  assert.equal(res.json.error.code, expectedCode);
  assert.equal(res.headers["x-request-id"], res.json.error.requestId);
}

function write(base) {
  return writeHeaders(base);
}

function createReview(ctx, overrides = {}) {
  return request(ctx.base, {
    method: "POST",
    path: "/api/v1/reviews",
    headers: write(ctx.base),
    body: { taskId: "TASK-1", runId: "RUN-1", actor: "agent-2", ...overrides },
  });
}

function submitBody(overrides = {}) {
  return {
    expectedVersion: 0,
    verdict: "PASS",
    manifestHash: MANIFEST_HASH,
    commitSha: "abc1234",
    evidence: { tests: { passed: 3, total: 3 }, command: "node scripts/test.mjs" },
    ...overrides,
  };
}

function submitReview(ctx, reviewId, body) {
  return request(ctx.base, {
    method: "POST",
    path: `/api/v1/reviews/${reviewId}/submit`,
    headers: write(ctx.base),
    body,
  });
}

/** AGENT assignments are submitted with the runtime-host internal credential. */
function submitInternal(ctx, reviewId, body) {
  return request(ctx.base, {
    method: "POST",
    path: `/api/v1/reviews/${reviewId}/submit`,
    headers: internalHeaders(undefined, "runtime-host"),
    body,
  });
}

test("POST /reviews creates a PENDING review, emits review.requested and lists with filters", async (t) => {
  const ctx = await withServer(t);
  const res = await createReview(ctx);
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.status, "PENDING");
  assert.equal(res.json.verdict, null);
  assert.equal(res.json.taskId, "TASK-1");
  assert.equal(res.json.runId, "RUN-1");
  assert.equal(res.json.actor, "HUMAN"); // body.actor is ignored (m6.1 F06)
  assert.equal(res.json.version, 0);
  assert.equal(res.json.attempt, 1);

  const events = await request(ctx.base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
  assert.ok(events.json.items.some((event) => event.type === "review.requested"));

  const byTask = await request(ctx.base, { path: "/api/v1/reviews?taskId=TASK-1", headers: readHeaders() });
  assert.equal(byTask.status, 200);
  assert.equal(byTask.json.items.length, 1);
  assert.equal(byTask.json.hasMore, false);
  assert.equal(byTask.json.total, undefined, "total is omitted unless withTotal=1");
  const byTaskWithTotal = await request(ctx.base, { path: "/api/v1/reviews?taskId=TASK-1&withTotal=1", headers: readHeaders() });
  assert.equal(byTaskWithTotal.json.total, 1);
  const byStatus = await request(ctx.base, { path: "/api/v1/reviews?status=PENDING", headers: readHeaders() });
  assert.equal(byStatus.json.items.length, 1);
  const limited = await request(ctx.base, { path: "/api/v1/reviews?limit=1", headers: readHeaders() });
  assert.equal(limited.json.items.length, 1);
  assertErrorEnvelope(await request(ctx.base, { path: "/api/v1/reviews?status=NOPE", headers: readHeaders() }), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(await request(ctx.base, { path: "/api/v1/reviews?limit=0", headers: readHeaders() }), "VALIDATION_ERROR", 400);
});

test("POST /reviews contract-layer negatives: non-REVIEWING task, foreign run, duplicate active review", async (t) => {
  const readyCtx = await withServer(t, { taskOverrides: { status: "READY" } });
  const notReviewing = await createReview(readyCtx);
  assertErrorEnvelope(notReviewing, "TASK_VERSION_CONFLICT", 409);
  assert.equal(notReviewing.json.error.details.reason, "not-reviewing");
  assert.equal(notReviewing.json.error.details.status, "READY");

  const ctx = await withServer(t, {
    tasks: [baseTask({ id: "TASK-2", status: "REVIEWING" })],
    runs: [{ id: "RUN-2", taskId: "TASK-2", agentId: "agent-9", function: "WORKER", status: "COMPLETED", attempt: 1 }],
  });
  const foreignRun = await createReview(ctx, { runId: "RUN-2" });
  assertErrorEnvelope(foreignRun, "VALIDATION_ERROR", 400);
  assert.match(foreignRun.json.error.details.errors.join(" "), /runId does not belong/);

  const first = await createReview(ctx);
  assert.equal(first.status, 201, first.text);
  const duplicate = await createReview(ctx);
  assertErrorEnvelope(duplicate, "VERSION_CONFLICT", 409);
  assert.equal(duplicate.json.error.details.activeReviewId, first.json.id);

  assertErrorEnvelope(
    await request(ctx.base, { method: "POST", path: "/api/v1/reviews", headers: write(ctx.base), body: { taskId: "TASK-NOPE", actor: "agent-2" } }),
    "NOT_FOUND",
    404,
  );
});

test("submit PASS persists Review PASS + Task INTEGRATING and appends events", async (t) => {
  const ctx = await withServer(t);
  const review = (await createReview(ctx)).json;
  const res = await submitReview(ctx, review.id, submitBody());
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.review.status, "PASS");
  assert.equal(res.json.review.verdict, "PASS");
  assert.equal(res.json.review.version, 1);
  assert.equal(res.json.review.manifestHash, MANIFEST_HASH);
  assert.equal(res.json.task.status, "INTEGRATING");
  // PASS publishes the candidate target hash on the Task (createApproval binds to it).
  assert.equal(res.json.task.targetHash, MANIFEST_HASH);

  // The response must be backed by database facts, not just a happy shape.
  const task = await request(ctx.base, { path: "/api/v1/tasks/TASK-1", headers: readHeaders() });
  assert.equal(task.json.status, "INTEGRATING");
  assert.equal(task.json.targetHash, MANIFEST_HASH);
  const reviews = await request(ctx.base, { path: "/api/v1/reviews?taskId=TASK-1", headers: readHeaders() });
  assert.equal(reviews.json.items[0].status, "PASS");
  const events = await request(ctx.base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
  const types = events.json.items.map((event) => event.type);
  assert.ok(types.includes("review.updated"));
  assert.ok(types.includes("task.updated"));
});

test("self-review is decided by the trusted review assignment, not body.actor", async (t) => {
  const store = createStore({
    reviews: [
      {
        id: "REV-SELF",
        taskId: "TASK-1",
        runId: "RUN-1",
        status: "PENDING",
        verdict: null,
        version: 0,
        attempt: 1,
        findings: [],
        assignedTo: "AGENT",
        reviewerAgentId: "agent-1", // same as the reviewed Run's author
      },
    ],
  });
  const ctx = await withServer(t, { store });
  // body.actor is irrelevant; the assignment says the author is the reviewer.
  const res = await submitInternal(ctx, "REV-SELF", submitBody({ actor: "agent-2", runId: "RUN-1" }));
  assertErrorEnvelope(res, "SELF_REVIEW_FORBIDDEN", 403);
  assert.equal(res.json.error.details.reviewerAgentId, "agent-1");
  assert.equal(res.json.error.details.authorAgentId, "agent-1");
  const after = await request(ctx.base, { path: "/api/v1/reviews?taskId=TASK-1", headers: readHeaders() });
  assert.equal(after.json.items[0].status, "PENDING");
  assert.equal((await request(ctx.base, { path: "/api/v1/tasks/TASK-1", headers: readHeaders() })).json.status, "REVIEWING");
});

test("assignment comparison is canonical (case/space) and a legitimate reviewer passes", async (t) => {
  for (const reviewerAgentId of ["AGENT-1", " agent-1", "agent-1 "]) {
    const store = createStore({
      reviews: [
        {
          id: "REV-SELF",
          taskId: "TASK-1",
          runId: "RUN-1",
          status: "PENDING",
          verdict: null,
          version: 0,
          attempt: 1,
          findings: [],
          assignedTo: "AGENT",
          reviewerAgentId,
        },
      ],
    });
    const ctx = await withServer(t, { store });
    const res = await submitInternal(ctx, "REV-SELF", submitBody({ runId: "RUN-1" }));
    assertErrorEnvelope(res, "SELF_REVIEW_FORBIDDEN", 403);
    assert.equal(res.json.error.details.reviewerAgentId, reviewerAgentId);
  }

  const store = createStore({
    runs: [{ id: "RUN-2", taskId: "TASK-1", agentId: "agent-2", function: "REVIEWER", status: "RUNNING", attempt: 2 }],
    reviews: [
      {
        id: "REV-OK",
        taskId: "TASK-1",
        runId: "RUN-1",
        status: "PENDING",
        verdict: null,
        version: 0,
        attempt: 1,
        findings: [],
        assignedTo: "AGENT",
        reviewerAgentId: "agent-2",
      },
    ],
  });
  const ctx = await withServer(t, { store });
  const legal = await submitInternal(ctx, "REV-OK", submitBody({ actor: "forged", runId: "RUN-2" }));
  assert.equal(legal.status, 200, legal.text);
  assert.equal(legal.json.review.status, "PASS");
  assert.equal(legal.json.task.status, "INTEGRATING");
});

test("createApproval binds the Task's real candidate hash (no arbitrary targetHash)", async (t) => {
  const ctx = await withServer(t, {
    tasks: [
      baseTask({ id: "TASK-TARGET", status: "AWAITING_ACCEPTANCE", targetHash: TARGET_HASH }),
      baseTask({ id: "TASK-NOHASH", status: "AWAITING_ACCEPTANCE" }),
    ],
  });
  const create = (taskId, targetHash) =>
    request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: write(ctx.base),
      body: { taskId, scope: "acceptance", targetHash },
    });

  const ok = await create("TASK-TARGET", TARGET_HASH);
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.targetHash, TARGET_HASH);

  const wrong = await create("TASK-TARGET", OTHER_HASH);
  assertErrorEnvelope(wrong, "APPROVAL_STALE", 409);
  assert.deepEqual(wrong.json.error.details, {
    taskId: "TASK-TARGET",
    expectedTargetHash: TARGET_HASH,
    receivedTargetHash: OTHER_HASH,
  });

  const missing = await create("TASK-NOHASH", TARGET_HASH);
  assertErrorEnvelope(missing, "TASK_VERSION_CONFLICT", 409);
  assert.equal(missing.json.error.details.reason, "target-hash-missing");
  assert.equal(missing.json.error.details.taskId, "TASK-NOHASH");
});

test("PASS without evidence is 400 EVIDENCE_MISSING (manifestHash, tests, passed!==total)", async (t) => {
  const ctx = await withServer(t);
  const review = (await createReview(ctx)).json;

  const noManifest = await submitReview(ctx, review.id, submitBody({ manifestHash: undefined }));
  assertErrorEnvelope(noManifest, "EVIDENCE_MISSING", 400);
  assert.ok(noManifest.json.error.details.missing.includes("manifestHash"));

  const noTests = await submitReview(ctx, review.id, submitBody({ evidence: {} }));
  assertErrorEnvelope(noTests, "EVIDENCE_MISSING", 400);
  assert.ok(noTests.json.error.details.missing.includes("evidence.tests"));

  const redTests = await submitReview(ctx, review.id, submitBody({ evidence: { tests: { passed: 1, total: 2 } } }));
  assertErrorEnvelope(redTests, "EVIDENCE_MISSING", 400);
  assert.ok(redTests.json.error.details.missing.includes("evidence.tests.passed===total"));

  const zeroTests = await submitReview(ctx, review.id, submitBody({ evidence: { tests: { passed: 0, total: 0 } } }));
  assertErrorEnvelope(zeroTests, "EVIDENCE_MISSING", 400);
  assert.ok(zeroTests.json.error.details.missing.includes("evidence.tests.total"));

  // Still pending after all rejected attempts; Task untouched.
  const reviews = await request(ctx.base, { path: "/api/v1/reviews?taskId=TASK-1", headers: readHeaders() });
  assert.equal(reviews.json.items[0].status, "PENDING");
  assert.equal((await request(ctx.base, { path: "/api/v1/tasks/TASK-1", headers: readHeaders() })).json.status, "REVIEWING");
});

test("findings are only required for CHANGES_REQUESTED (m4-smoke regression)", async (t) => {
  // PASS without any findings field must succeed.
  const noFindingsCtx = await withServer(t);
  const review1 = (await createReview(noFindingsCtx)).json;
  const passNoFindings = await submitReview(noFindingsCtx, review1.id, submitBody());
  assert.equal(passNoFindings.status, 200, passNoFindings.text);
  assert.equal(passNoFindings.json.review.status, "PASS");

  // PASS with an explicitly empty findings array is equally valid.
  const emptyCtx = await withServer(t);
  const review2 = (await createReview(emptyCtx)).json;
  const passEmptyFindings = await submitReview(emptyCtx, review2.id, submitBody({ findings: [] }));
  assert.equal(passEmptyFindings.status, 200, passEmptyFindings.text);
  assert.equal(passEmptyFindings.json.review.status, "PASS");

  // CHANGES_REQUESTED without findings is rejected.
  const changesCtx = await withServer(t);
  const review3 = (await createReview(changesCtx)).json;
  const changesNoFindings = await submitReview(changesCtx, review3.id, submitBody({ verdict: "CHANGES_REQUESTED", manifestHash: undefined, evidence: undefined, findings: [] }));
  assertErrorEnvelope(changesNoFindings, "VALIDATION_ERROR", 400);
  assert.match(changesNoFindings.json.error.details.errors.join(" "), /findings?/);

  // CHANGES_REQUESTED with findings succeeds and moves the Task to REJECTED.
  const changesWithFindingsCtx = await withServer(t);
  const review4 = (await createReview(changesWithFindingsCtx)).json;
  const changesWithFindings = await submitReview(changesWithFindingsCtx, review4.id, submitBody({
    verdict: "CHANGES_REQUESTED",
    manifestHash: undefined,
    evidence: undefined,
    findings: [{ code: "STYLE", message: "rename" }],
  }));
  assert.equal(changesWithFindings.status, 200, changesWithFindings.text);
  assert.equal(changesWithFindings.json.review.status, "CHANGES_REQUESTED");
  assert.equal(changesWithFindings.json.task.status, "REJECTED");
  assert.equal(changesWithFindings.json.review.findings.length, 1);
});

test("submit validation and CAS negatives", async (t) => {
  const ctx = await withServer(t);
  const review = (await createReview(ctx)).json;

  assertErrorEnvelope(await submitReview(ctx, review.id, submitBody({ expectedVersion: 9 })), "VERSION_CONFLICT", 409);
  assert.equal((await submitReview(ctx, review.id, submitBody({ expectedVersion: 9 }))).json.error.details.currentVersion, 0);
  assertErrorEnvelope(await submitReview(ctx, review.id, submitBody({ verdict: "FAIL" })), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(await submitReview(ctx, review.id, submitBody({ expectedVersion: undefined })), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(await submitReview(ctx, review.id, submitBody({ commitSha: "zzz" })), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(
    await submitReview(ctx, review.id, submitBody({ verdict: "CHANGES_REQUESTED", findings: [] })),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(await request(ctx.base, { method: "POST", path: "/api/v1/reviews/REV-NOPE/submit", headers: write(ctx.base), body: submitBody() }), "NOT_FOUND", 404);

  // A finalized review cannot be submitted twice.
  const ok = await submitReview(ctx, review.id, submitBody());
  assert.equal(ok.status, 200, ok.text);
  const twice = await submitReview(ctx, review.id, submitBody({ expectedVersion: 1 }));
  assertErrorEnvelope(twice, "VERSION_CONFLICT", 409);
  assert.equal(twice.json.error.details.reason, "not-pending");
});

test("CHANGES_REQUESTED moves Task to REJECTED and rework moves it back to READY with attempt+1", async (t) => {
  const ctx = await withServer(t);
  const review = (await createReview(ctx)).json;
  const submitted = await submitReview(ctx, review.id, submitBody({
    verdict: "CHANGES_REQUESTED",
    manifestHash: undefined,
    evidence: undefined,
    findings: [{ code: "STYLE", message: "rename things" }],
  }));
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.json.review.status, "CHANGES_REQUESTED");
  assert.equal(submitted.json.task.status, "REJECTED");
  assert.deepEqual(submitted.json.review.findings, [{ code: "STYLE", message: "rename things" }]);

  const rework = await request(ctx.base, {
    method: "POST",
    path: `/api/v1/reviews/${review.id}/rework`,
    headers: write(ctx.base),
    body: { reason: "addressing review findings" },
  });
  assert.equal(rework.status, 200, rework.text);
  assert.equal(rework.json.review.attempt, 2);
  assert.equal(rework.json.task.status, "READY");
  assert.equal(rework.json.attempt, 2);

  const events = await request(ctx.base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
  const taskUpdates = events.json.items.filter((event) => event.type === "task.updated");
  assert.ok(taskUpdates.some((event) => event.payload.reason === "rework"));
  assert.ok(taskUpdates.some((event) => event.payload.status === "READY"));

  assertErrorEnvelope(
    await request(ctx.base, { method: "POST", path: `/api/v1/reviews/${review.id}/rework`, headers: write(ctx.base), body: {} }),
    "VALIDATION_ERROR",
    400,
  );
});

test("rework beyond maxAttempts is 409 REWORK_LIMIT_REACHED and blocks the Task", async (t) => {
  const direct = createFakeStore({
    projects: [{ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" }],
    tasks: [baseTask({ status: "REVIEWING" })],
    runs: [{ id: "RUN-1", taskId: "TASK-1", agentId: "agent-1", function: "WORKER", status: "COMPLETED", attempt: 1 }],
    reviews: [
      {
        id: "REV-LIMIT",
        taskId: "TASK-1",
        runId: "RUN-1",
        actor: "agent-2",
        status: "CHANGES_REQUESTED",
        verdict: "CHANGES_REQUESTED",
        attempt: 3,
        version: 1,
        findings: [{ code: "X" }],
      },
    ],
  });
  const ctx = await startServer({ store: direct });
  t.after(() => ctx.server.close());

  const res = await request(ctx.base, {
    method: "POST",
    path: "/api/v1/reviews/REV-LIMIT/rework",
    headers: write(ctx.base),
    body: { reason: "one more time" },
  });
  assertErrorEnvelope(res, "REWORK_LIMIT_REACHED", 409);
  assert.deepEqual(res.json.error.details, { taskId: "TASK-1", attempt: 3, maxAttempts: 3 });
  assert.equal((await request(ctx.base, { path: "/api/v1/tasks/TASK-1", headers: readHeaders() })).json.status, "BLOCKED");
});

test("approval create is bound to AWAITING_ACCEPTANCE and records approval.recorded", async (t) => {
  const ctx = await withServer(t, {
    tasks: [baseTask({ id: "TASK-AWAIT", status: "AWAITING_ACCEPTANCE", targetHash: TARGET_HASH })],
  });
  const res = await request(ctx.base, {
    method: "POST",
    path: "/api/v1/approvals",
    headers: write(ctx.base),
    body: { taskId: "TASK-AWAIT", scope: "acceptance", targetHash: TARGET_HASH },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.status, "PENDING");
  assert.equal(res.json.actor, "HUMAN");
  assert.equal(res.json.targetHash, TARGET_HASH);
  const events = await request(ctx.base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
  assert.ok(events.json.items.some((event) => event.type === "approval.recorded"));

  assertErrorEnvelope(
    await request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: write(ctx.base),
      body: { taskId: "TASK-1", scope: "acceptance", targetHash: TARGET_HASH },
    }),
    "TASK_VERSION_CONFLICT",
    409,
  );
  assertErrorEnvelope(
    await request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: write(ctx.base),
      body: { taskId: "TASK-AWAIT", scope: "acceptance" },
    }),
    "VALIDATION_ERROR",
    400,
  );
  assertErrorEnvelope(
    await request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: write(ctx.base),
      body: { taskId: "TASK-AWAIT", scope: "acceptance", targetHash: "" },
    }),
    "VALIDATION_ERROR",
    400,
  );
});

test("decide APPROVED with the correct hash is the only DONE entrance", async (t) => {
  const ctx = await withServer(t, {
    tasks: [baseTask({ id: "TASK-AWAIT", status: "AWAITING_ACCEPTANCE", targetHash: TARGET_HASH })],
  });
  const approval = (
    await request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: write(ctx.base),
      body: { taskId: "TASK-AWAIT", scope: "acceptance", targetHash: TARGET_HASH },
    })
  ).json;

  const stale = await request(ctx.base, {
    method: "POST",
    path: `/api/v1/approvals/${approval.id}/decide`,
    headers: write(ctx.base),
    body: { decision: "APPROVED", targetHash: OTHER_HASH },
  });
  assertErrorEnvelope(stale, "APPROVAL_STALE", 409);
  assert.deepEqual(stale.json.error.details, {
    approvalId: approval.id,
    taskId: "TASK-AWAIT",
    expectedTargetHash: TARGET_HASH,
    receivedTargetHash: OTHER_HASH,
  });
  assert.equal((await request(ctx.base, { path: "/api/v1/tasks/TASK-AWAIT", headers: readHeaders() })).json.status, "AWAITING_ACCEPTANCE");

  const approved = await request(ctx.base, {
    method: "POST",
    path: `/api/v1/approvals/${approval.id}/decide`,
    headers: write(ctx.base),
    body: { decision: "APPROVED", targetHash: TARGET_HASH },
  });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.approval.status, "APPROVED");
  assert.equal(approved.json.task.status, "DONE");
  const events = await request(ctx.base, { path: "/api/v1/events?afterSeq=0", headers: readHeaders() });
  assert.ok(events.json.items.filter((event) => event.type === "approval.recorded").length >= 2);
  assert.ok(events.json.items.some((event) => event.type === "task.updated" && event.payload.status === "DONE"));

  // Direct PATCH to DONE is refused even before the store state machine runs.
  const direct = await request(ctx.base, {
    method: "PATCH",
    path: "/api/v1/tasks/TASK-1",
    headers: write(ctx.base),
    body: { expectedVersion: 0, changes: { status: "DONE" } },
  });
  assertErrorEnvelope(direct, "TASK_VERSION_CONFLICT", 409);
  assert.equal(direct.json.error.details.reason, "execution-state-guard");
  assert.equal(direct.json.error.details.requestedStatus, "DONE");
});

test("decide rejects stale Task target hash and REJECTED returns the Task to READY", async (t) => {
  const ctx = await withServer(t, {
    tasks: [baseTask({ id: "TASK-AWAIT", status: "AWAITING_ACCEPTANCE", targetHash: TARGET_HASH })],
  });
  const approval = (
    await request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: write(ctx.base),
      body: { taskId: "TASK-AWAIT", scope: "acceptance", targetHash: TARGET_HASH },
    })
  ).json;
  // The task target hash changes after the acceptance was recorded (e.g. a new
  // integration produced a different artifact).
  ctx.store._updateTask("TASK-AWAIT", { targetHash: OTHER_HASH });
  const stale = await request(ctx.base, {
    method: "POST",
    path: `/api/v1/approvals/${approval.id}/decide`,
    headers: write(ctx.base),
    body: { decision: "APPROVED", targetHash: TARGET_HASH },
  });
  assertErrorEnvelope(stale, "APPROVAL_STALE", 409);
  assert.equal(stale.json.error.details.expectedTargetHash, OTHER_HASH);
  assert.equal((await request(ctx.base, { path: "/api/v1/tasks/TASK-AWAIT", headers: readHeaders() })).json.status, "AWAITING_ACCEPTANCE");

  const rejectedCtx = await withServer(t, {
    tasks: [baseTask({ id: "TASK-REJ", status: "AWAITING_ACCEPTANCE", targetHash: TARGET_HASH })],
  });
  const approval2 = (
    await request(rejectedCtx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: write(rejectedCtx.base),
      body: { taskId: "TASK-REJ", scope: "acceptance", targetHash: TARGET_HASH },
    })
  ).json;
  const rejected = await request(rejectedCtx.base, {
    method: "POST",
    path: `/api/v1/approvals/${approval2.id}/decide`,
    headers: write(rejectedCtx.base),
    body: { decision: "REJECTED", targetHash: TARGET_HASH },
  });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.json.approval.status, "REJECTED");
  assert.equal(rejected.json.task.status, "READY");
});

test("approval decide negatives: unknown id, bad decision, already decided", async (t) => {
  const ctx = await withServer(t, {
    tasks: [baseTask({ id: "TASK-AWAIT", status: "AWAITING_ACCEPTANCE", targetHash: TARGET_HASH })],
  });
  assertErrorEnvelope(
    await request(ctx.base, { method: "POST", path: "/api/v1/approvals/APR-NOPE/decide", headers: write(ctx.base), body: { decision: "APPROVED", targetHash: TARGET_HASH } }),
    "NOT_FOUND",
    404,
  );
  const approval = (
    await request(ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: write(ctx.base),
      body: { taskId: "TASK-AWAIT", scope: "acceptance", targetHash: TARGET_HASH },
    })
  ).json;
  assertErrorEnvelope(
    await request(ctx.base, {
      method: "POST",
      path: `/api/v1/approvals/${approval.id}/decide`,
      headers: write(ctx.base),
      body: { decision: "MAYBE", targetHash: TARGET_HASH },
    }),
    "VALIDATION_ERROR",
    400,
  );
  const ok = await request(ctx.base, {
    method: "POST",
    path: `/api/v1/approvals/${approval.id}/decide`,
    headers: write(ctx.base),
    body: { decision: "APPROVED", targetHash: TARGET_HASH },
  });
  assert.equal(ok.status, 200, ok.text);
  const twice = await request(ctx.base, {
    method: "POST",
    path: `/api/v1/approvals/${approval.id}/decide`,
    headers: write(ctx.base),
    body: { decision: "REJECTED", targetHash: TARGET_HASH },
  });
  assertErrorEnvelope(twice, "VERSION_CONFLICT", 409);
  assert.equal(twice.json.error.details.reason, "not-pending");
});

test("GET approvals filters by task and validates status/limit", async (t) => {
  const ctx = await withServer(t, {
    tasks: [baseTask({ id: "TASK-AWAIT", status: "AWAITING_ACCEPTANCE", targetHash: TARGET_HASH })],
  });
  const created = await request(ctx.base, {
    method: "POST",
    path: "/api/v1/approvals",
    headers: write(ctx.base),
    body: { taskId: "TASK-AWAIT", scope: "acceptance", targetHash: TARGET_HASH },
  });
  const list = await request(ctx.base, { path: "/api/v1/approvals?taskId=TASK-AWAIT", headers: readHeaders() });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, created.json.id);
  const pending = await request(ctx.base, { path: "/api/v1/approvals?status=PENDING", headers: readHeaders() });
  assert.equal(pending.json.items.length, 1);
  assertErrorEnvelope(await request(ctx.base, { path: "/api/v1/approvals?status=NOPE", headers: readHeaders() }), "VALIDATION_ERROR", 400);
  assertErrorEnvelope(await request(ctx.base, { path: "/api/v1/approvals?limit=0", headers: readHeaders() }), "VALIDATION_ERROR", 400);
});

test("writes require the browser session + CSRF (public API middleware)", async (t) => {
  const ctx = await withServer(t);
  assertErrorEnvelope(
    await request(ctx.base, { method: "POST", path: "/api/v1/reviews", body: { taskId: "TASK-1", actor: "agent-2" } }),
    "NOT_AUTHORIZED",
    403,
  );
  const noCsrf = await request(ctx.base, {
    method: "POST",
    path: "/api/v1/reviews",
    headers: { "x-atk-token": TEST_TOKEN, origin: ctx.base },
    body: { taskId: "TASK-1", actor: "agent-2" },
  });
  assertErrorEnvelope(noCsrf, "NOT_AUTHORIZED", 403);
  assert.equal(noCsrf.json.error.details.reason, "csrf-missing");
});

test("SSE receives review.requested, review.updated and task.updated frames", async (t) => {
  const ctx = await withServer(t);
  const client = await openSse(ctx.base, { token: TEST_TOKEN });
  t.after(() => closeSse(client));
  await waitForFrame(client, (frame) => String(frame.comment ?? "").startsWith("connected"));

  const review = (await createReview(ctx)).json;
  const requested = await waitForFrame(client, (frame) => frame.type === "review.requested");
  assert.equal(requested.frame.payload.reviewId, review.id);

  const submitted = await submitReview(ctx, review.id, submitBody());
  assert.equal(submitted.status, 200, submitted.text);
  const updated = await waitForFrame(client, (frame) => frame.type === "review.updated");
  assert.equal(updated.frame.payload.reviewId, review.id);
  assert.equal(updated.frame.payload.verdict, "PASS");
  const taskUpdated = await waitForFrame(client, (frame) => frame.type === "task.updated");
  assert.equal(taskUpdated.frame.payload.status, "INTEGRATING");
  assert.equal(client.frames.some((frame) => JSON.stringify(frame).includes(TEST_TOKEN)), false);
});
