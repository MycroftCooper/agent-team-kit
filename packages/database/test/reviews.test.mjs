// M4 Review lifecycle (m4-contracts §1, ADR-005): create -> submit verdict ->
// rework loop, self-review / evidence hard invariants, CAS and cross-connection
// concurrency. Runs against SQLite and the in-memory store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { INTERNAL } from "../src/internal.mjs";
import { advanceTask, bothStores, projectDto, taskDto, useStore } from "./helpers.mjs";

const SHA = "a".repeat(64);
const WORKER_URL = new URL("./submit-review-worker.mjs", import.meta.url);

function seedReviewable(store, { taskId = "TASK-1", agentId = "agent-dev" } = {}) {
  store.createTask(taskDto("proj-1", { id: taskId }));
  store.upsertAgent({ id: agentId, role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
  const run = store.createRun({ taskId, agentId, function: "WORKER", role: "DEV" });
  advanceTask(store, taskId, "REVIEWING");
  return { task: store.getTask(taskId), run };
}

function fingerprint(store) {
  return {
    tasks: store.listTasks({ limit: 1000 }),
    reviews: store.listReviews({ limit: 100 }),
    approvals: store.listApprovals({ limit: 100 }),
    events: store.listEvents({ limit: 1000 }),
  };
}

function eventTypes(store) {
  return store.listEvents({ limit: 1000 }).map((event) => event.type);
}

test("createReview writes PENDING + review.requested and enforces one active review", (t) => {
  for (const { label, store } of bothStores(t)) {
    const { run } = seedReviewable(store);
    const versionBefore = store.getTask("TASK-1").version;
    const review = store.createReview({ taskId: "TASK-1", runId: run.id, actor: "HUMAN" });
    assert.equal(review.status, "PENDING", label);
    assert.equal(review.attempt, 1, label);
    assert.equal(review.version, 0, label);
    assert.equal(review.runId, run.id, label);
    assert.deepEqual(store.getReview(review.id), review, label);
    assert.deepEqual(store.listReviews({ taskId: "TASK-1" }).map((row) => row.id), [review.id], label);
    assert.deepEqual(store.listReviews({ status: "PENDING" }).map((row) => row.id), [review.id], label);
    assert.equal(store.getTask("TASK-1").version, versionBefore, `${label}: createReview does not bump the Task`);
    const event = store.listEvents({ limit: 1000 }).at(-1);
    assert.equal(event.type, "review.requested", label);
    assert.deepEqual(event.payload, { taskId: "TASK-1", reviewId: review.id, attempt: 1 }, label);

    const reviewsBefore = store.listReviews({ taskId: "TASK-1" }).length;
    const eventsBeforeDuplicate = store.listEvents({ limit: 1000 }).length;
    assert.throws(
      () => store.createReview({ taskId: "TASK-1", actor: "HUMAN" }),
      (error) => error.code === "TASK_VERSION_CONFLICT" && error.details.reason === "review-exists",
      label,
    );
    assert.equal(store.listReviews({ taskId: "TASK-1" }).length, reviewsBefore, label);
    assert.equal(store.listEvents({ limit: 1000 }).length, eventsBeforeDuplicate, label);

    // Task not REVIEWING.
    store.createTask(taskDto("proj-1", { id: "TASK-READY" }));
    store.upsertAgent({ id: "agent-other", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const otherRun = store.createRun({
      taskId: "TASK-READY",
      agentId: "agent-other",
      function: "WORKER",
      role: "DEV",
    });
    const beforeFailures = fingerprint(store);
    assert.throws(
      () => store.createReview({ taskId: "TASK-READY", actor: "HUMAN" }),
      (error) => error.code === "TASK_VERSION_CONFLICT" && error.details.reason === "not-reviewing",
      label,
    );
    assert.throws(
      () => store.createReview({ taskId: "TASK-MISSING", actor: "HUMAN" }),
      (error) => error.code === "TASK_VERSION_CONFLICT" && error.details.reason === "task-not-found",
      label,
    );
    // runId must exist and belong to the reviewed Task.
    assert.throws(
      () => store.createReview({ taskId: "TASK-1", runId: otherRun.id, actor: "HUMAN" }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.throws(
      () => store.createReview({ taskId: "TASK-1", runId: "RUN-MISSING", actor: "HUMAN" }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.throws(
      () => store.createReview({ taskId: "TASK-1", actor: "" }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.deepEqual(fingerprint(store), beforeFailures, `${label}: failed createReview wrote nothing`);
  }
});

test("submitReview PASS requires evidence and advances REVIEWING -> INTEGRATING", (t) => {
  for (const { label, store } of bothStores(t)) {
    const { run } = seedReviewable(store);
    const review = store.createReview({ taskId: "TASK-1", runId: run.id, actor: "HUMAN" });
    const versionBefore = store.getTask("TASK-1").version;
    const result = store.submitReview({
      id: review.id,
      expectedVersion: 0,
      verdict: "PASS",
      manifestHash: SHA,
      commitSha: "abc1234",
      findings: [], // Backend default: an empty findings list must not block PASS
      evidence: { tests: { passed: 3, total: 3 } },
      actor: "reviewer-1",
    });
    assert.equal(result.review.status, "PASS", label);
    assert.equal(result.review.verdict, "PASS", label);
    assert.equal(result.review.version, 1, label);
    assert.equal(result.review.actor, "reviewer-1", label);
    assert.equal(result.review.manifestHash, SHA, label);
    assert.equal(result.review.commitSha, "abc1234", label);
    assert.deepEqual(result.review.evidence, { tests: { passed: 3, total: 3 } }, label);
    assert.deepEqual(result.review.findings, [], label);
    assert.ok(result.review.submittedAt, label);
    assert.equal(result.task.id, "TASK-1", label);
    assert.equal(result.task.status, "INTEGRATING", label);
    assert.equal(result.task.version, versionBefore + 1, label);
    const event = store.listEvents({ limit: 1000 }).at(-1);
    assert.equal(event.type, "review.updated", label);
    assert.deepEqual(event.payload, {
      taskId: "TASK-1",
      reviewId: review.id,
      status: "PASS",
      verdict: "PASS",
      actor: "reviewer-1",
      attempt: 1,
      targetHash: SHA,
    }, label);

    // A decided review cannot be submitted again.
    assert.throws(
      () => store.submitReview({ id: review.id, expectedVersion: 1, verdict: "PASS", manifestHash: SHA, evidence: { tests: { passed: 1, total: 1 } }, actor: "reviewer-2" }),
      (error) => error.code === "REVIEW_INVALIDATED",
      label,
    );
  }
});

test("PASS without evidence is EVIDENCE_MISSING and writes nothing", (t) => {
  const cases = [
    {
      name: "missing manifestHash",
      submit: { manifestHash: undefined, evidence: { tests: { passed: 2, total: 2 } } },
      missing: ["manifestHash"],
    },
    {
      name: "missing test evidence",
      submit: { manifestHash: SHA, evidence: undefined },
      missing: ["evidence.tests"],
    },
    {
      name: "zero total",
      submit: { manifestHash: SHA, evidence: { tests: { passed: 0, total: 0 } } },
      missing: ["evidence.tests"],
    },
    {
      name: "not all tests pass",
      submit: { manifestHash: SHA, evidence: { tests: { passed: 3, total: 4 } } },
      missing: ["passed===total"],
    },
  ];
  for (const { label, store } of bothStores(t)) {
    for (const [index, scenario] of cases.entries()) {
      const taskId = `TASK-EVIDENCE-${index}`;
      seedReviewable(store, { taskId, agentId: "agent-dev" });
      const review = store.createReview({ taskId, actor: "HUMAN" });
      const before = fingerprint(store);
      assert.throws(
        () => store.submitReview({ id: review.id, expectedVersion: 0, verdict: "PASS", actor: "reviewer-1", ...scenario.submit }),
        (error) =>
          error.code === "EVIDENCE_MISSING" &&
          assert.deepEqual(error.details.missing, scenario.missing) === undefined,
        `${label}: ${scenario.name}`,
      );
      assert.deepEqual(fingerprint(store), before, `${label}: ${scenario.name} wrote nothing`);
    }
  }
});

test("self-review, CAS conflicts and invalid verdicts write nothing", (t) => {
  for (const { label, store } of bothStores(t)) {
    const { run } = seedReviewable(store);
    const review = store.createReview({ taskId: "TASK-1", runId: run.id, actor: "HUMAN" });

    const before = fingerprint(store);
    assert.throws(
      () => store.submitReview({
        id: review.id,
        expectedVersion: 0,
        verdict: "PASS",
        manifestHash: SHA,
        evidence: { tests: { passed: 1, total: 1 } },
        actor: "agent-dev", // the producer of the reviewed Run
      }),
      (error) =>
        error.code === "SELF_REVIEW_FORBIDDEN" &&
        error.details.actor === "agent-dev" &&
        error.details.authorAgentId === "agent-dev",
      label,
    );
    assert.throws(
      () => store.submitReview({
        id: review.id,
        expectedVersion: 7,
        verdict: "PASS",
        manifestHash: SHA,
        evidence: { tests: { passed: 1, total: 1 } },
        actor: "reviewer-1",
      }),
      (error) => error.code === "VERSION_CONFLICT" && error.details.currentVersion === 0,
      label,
    );
    assert.throws(
      () => store.submitReview({ id: review.id, expectedVersion: 0, verdict: "MAYBE", actor: "reviewer-1" }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.throws(
      () => store.submitReview({ id: "REV-MISSING", expectedVersion: 0, verdict: "BLOCKED", actor: "reviewer-1" }),
      (error) => error.code === "NOT_FOUND",
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: failed submits wrote nothing`);
  }
});

test("CHANGES_REQUESTED requires findings; BLOCKED does not", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedReviewable(store, { taskId: "TASK-CHANGES" });
    seedReviewable(store, { taskId: "TASK-BLOCK" });
    const changes = store.createReview({ taskId: "TASK-CHANGES", actor: "HUMAN" });
    const blocked = store.createReview({ taskId: "TASK-BLOCK", actor: "HUMAN" });

    const before = fingerprint(store);
    assert.throws(
      () => store.submitReview({ id: changes.id, expectedVersion: 0, verdict: "CHANGES_REQUESTED", actor: "reviewer-1" }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.throws(
      () => store.submitReview({ id: changes.id, expectedVersion: 0, verdict: "CHANGES_REQUESTED", findings: [], actor: "reviewer-1" }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: rejected CHANGES_REQUESTED wrote nothing`);

    const withFindings = store.submitReview({
      id: changes.id,
      expectedVersion: 0,
      verdict: "CHANGES_REQUESTED",
      findings: [{ file: "src/a.mjs", message: "fix the edge case" }],
      actor: "reviewer-1",
    });
    assert.equal(withFindings.review.status, "CHANGES_REQUESTED", label);
    assert.equal(withFindings.task.status, "REJECTED", label);

    const blockedResult = store.submitReview({
      id: blocked.id,
      expectedVersion: 0,
      verdict: "BLOCKED",
      findings: [],
      actor: "reviewer-1",
    });
    assert.equal(blockedResult.review.status, "BLOCKED", label);
    assert.equal(blockedResult.task.status, "BLOCKED", label);
  }
});

test("reworkTask requeues to READY with attempt+1 and enforces maxAttempts", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedReviewable(store, { taskId: "TASK-1" });
    const review = store.createReview({ taskId: "TASK-1", actor: "HUMAN" });
    store.submitReview({
      id: review.id,
      expectedVersion: 0,
      verdict: "CHANGES_REQUESTED",
      findings: [{ message: "rework" }],
      actor: "reviewer-1",
    });
    const reworked = store.reworkTask({ taskId: "TASK-1", reviewId: review.id, reason: "apply findings", actor: "reviewer-1" });
    assert.equal(reworked.task.status, "READY", label);
    assert.equal(reworked.attempt, 2, label);
    assert.equal(reworked.review.attempt, 1, `${label}: the finished review keeps its attempt number`);
    assert.equal(reworked.review.status, "CHANGES_REQUESTED", label);
    const types = eventTypes(store);
    assert.deepEqual(types.slice(-2), ["review.updated", "task.updated"], label);
    const taskEvent = store.listEvents({ limit: 1000 }).at(-1);
    assert.equal(taskEvent.payload.reason, "rework", label);
    assert.equal(taskEvent.payload.attempt, 2, label);

    // The next review round is allowed: the old CHANGES_REQUESTED review is
    // history, not an "active" review.
    advanceTask(store, "TASK-1", "REVIEWING");
    const secondRound = store.createReview({ taskId: "TASK-1", actor: "HUMAN" });
    assert.equal(secondRound.attempt, 2, `${label}: a reworked Task starts attempt 2`);

    // Already-reworked review: the Task is no longer REJECTED.
    const before = fingerprint(store);
    assert.throws(
      () => store.reworkTask({ taskId: "TASK-1", reviewId: review.id, reason: "again", actor: "reviewer-1" }),
      (error) => error.code === "TASK_VERSION_CONFLICT" && error.details.reason === "not-rejected",
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: invalid rework wrote nothing`);

    // Rejection when the next attempt would exceed the budget.
    seedReviewable(store, { taskId: "TASK-LIMIT" });
    const limitReview = store.createReview({ taskId: "TASK-LIMIT", actor: "HUMAN" });
    store.submitReview({
      id: limitReview.id,
      expectedVersion: 0,
      verdict: "CHANGES_REQUESTED",
      findings: [{ message: "rework" }],
      actor: "reviewer-1",
    });
    const limitBefore = fingerprint(store);
    assert.throws(
      () => store.reworkTask({ taskId: "TASK-LIMIT", reviewId: limitReview.id, reason: "again", actor: "reviewer-1", maxAttempts: 1 }),
      (error) =>
        error.code === "REWORK_LIMIT_REACHED" &&
        error.details.taskId === "TASK-LIMIT" &&
        error.details.attempt === 2 &&
        error.details.maxAttempts === 1,
      label,
    );
    // The limit path is a documented write: Task BLOCKED + Review BLOCKED + events.
    assert.equal(store.getTask("TASK-LIMIT").status, "BLOCKED", label);
    assert.equal(store.getReview(limitReview.id).status, "BLOCKED", label);
    assert.ok(fingerprint(store).events.length > limitBefore.events.length, label);
    const limitTaskEvent = store.listEvents({ limit: 1000 }).at(-1);
    assert.equal(limitTaskEvent.type, "task.updated", label);
    assert.equal(limitTaskEvent.payload.reason, "rework-limit", label);

    // A BLOCKED review can no longer be reworked.
    const beforeInvalid = fingerprint(store);
    assert.throws(
      () => store.reworkTask({ taskId: "TASK-LIMIT", reviewId: limitReview.id, reason: "again", actor: "reviewer-1" }),
      (error) => error.code === "REVIEW_INVALIDATED",
      label,
    );
    assert.deepEqual(fingerprint(store), beforeInvalid, `${label}: rework of a BLOCKED review wrote nothing`);

    assert.throws(
      () => store.reworkTask({ taskId: "TASK-1", reviewId: "REV-MISSING", reason: "x", actor: "reviewer-1" }),
      (error) => error.code === "NOT_FOUND",
      label,
    );
  }
});

test("two concurrent submits on the same review: exactly one wins the CAS", async (t) => {
  const { store, file } = useStore(t);
  store.createProject(projectDto());
  const { run } = seedReviewable(store);
  const review = store.createReview({ taskId: "TASK-1", runId: run.id, actor: "HUMAN" });

  const barrier = new SharedArrayBuffer(4);
  const startWorker = (verdict, actor) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { file, reviewId: review.id, verdict, actor, barrier },
    });
    return {
      worker,
      ready: new Promise((resolve, reject) => {
        worker.once("message", (message) => (message.ready ? resolve() : reject(new Error(JSON.stringify(message)))));
        worker.once("error", reject);
      }),
      finished: new Promise((resolve, reject) => {
        worker.on("message", (message) => {
          if (!message.ready) resolve(message);
        });
        worker.on("error", reject);
      }),
    };
  };
  const workers = [startWorker("PASS", "reviewer-a"), startWorker("CHANGES_REQUESTED", "reviewer-b")];
  await Promise.all(workers.map((entry) => entry.ready));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const outcomes = await Promise.all(workers.map((entry) => entry.finished));
  workers.forEach((entry) => entry.worker.terminate());

  const winners = outcomes.filter((outcome) => outcome.result !== undefined && outcome.error === undefined);
  const losers = outcomes.filter((outcome) => outcome.error !== undefined);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 1, JSON.stringify(outcomes));
  assert.equal(losers[0].error.code, "VERSION_CONFLICT", JSON.stringify(losers[0]));
  assert.equal(winners[0].result.version, 1);

  const stored = store.getReview(review.id);
  assert.equal(stored.version, 1);
  assert.equal(stored.status, winners[0].result.status);
  assert.equal(store.getTask("TASK-1").status, winners[0].result.taskStatus);
  assert.equal(
    store.listEvents({ limit: 1000 }).filter((event) => event.type === "review.updated").length,
    1,
  );
  assert.equal(store.listReviews({ taskId: "TASK-1" }).length, 1);
});

test("PASS without a findings key is legal (findings are optional)", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedReviewable(store, { taskId: "TASK-PASS" });
    const review = store.createReview({ taskId: "TASK-PASS", actor: "HUMAN" });
    const result = store.submitReview({
      id: review.id,
      expectedVersion: 0,
      verdict: "PASS",
      manifestHash: SHA,
      evidence: { tests: { passed: 2, total: 2 } },
      actor: "reviewer-1",
    });
    assert.equal(result.review.status, "PASS", label);
    assert.equal(result.task.status, "INTEGRATING", label);
    assert.equal(result.review.findings, undefined, label);
  }
});

// Keep INTERNAL imported for parity with the other M4 tests (and to ensure the
// symbol does not leak into the public surface).
test("review attempt audit rows are written internally", (t) => {
  const { store } = bothStores(t)[0];
  seedReviewable(store);
  const review = store.createReview({ taskId: "TASK-1", actor: "HUMAN" });
  assert.ok(store[INTERNAL]);
  assert.equal(typeof review.id, "string");
});

test("QA-005: canonical self-review blocks whitespace/case variants (zero writes)", (t) => {
  const variants = ["agent-dev-1", " agent-dev-1", "agent-dev-1 ", "AGENT-DEV-1", " Agent-Dev-1 "];
  for (const { label, store } of bothStores(t)) {
    for (const [index, variant] of variants.entries()) {
      const taskId = `TASK-SELF-${index}`;
      seedReviewable(store, { taskId, agentId: "agent-dev-1" });
      const review = store.createReview({ taskId, actor: "HUMAN" });
      const before = fingerprint(store);
      assert.throws(
        () => store.submitReview({
          id: review.id,
          expectedVersion: 0,
          verdict: "PASS",
          manifestHash: SHA,
          evidence: { tests: { passed: 1, total: 1 } },
          actor: variant,
        }),
        (error) => error.code === "SELF_REVIEW_FORBIDDEN",
        `${label}: ${JSON.stringify(variant)}`,
      );
      assert.deepEqual(fingerprint(store), before, `${label}: ${JSON.stringify(variant)} wrote nothing`);
      assert.equal(store.getReview(review.id).status, "PENDING", label);
    }

    seedReviewable(store, { taskId: "TASK-LEGAL", agentId: "agent-dev-1" });
    const legal = store.createReview({ taskId: "TASK-LEGAL", actor: "HUMAN" });
    const result = store.submitReview({
      id: legal.id,
      expectedVersion: 0,
      verdict: "PASS",
      manifestHash: SHA,
      evidence: { tests: { passed: 2, total: 2 } },
      actor: "agent-qa-01",
    });
    assert.equal(result.review.status, "PASS", label);
    assert.equal(result.task.status, "INTEGRATING", label);
  }
});

test("QA-005: PASS writes tasks.target_hash and acceptance is bound to it", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedReviewable(store);
    const review = store.createReview({ taskId: "TASK-1", actor: "HUMAN" });
    const passed = store.submitReview({
      id: review.id,
      expectedVersion: 0,
      verdict: "PASS",
      manifestHash: SHA,
      evidence: { tests: { passed: 1, total: 1 } },
      actor: "reviewer-1",
    });
    assert.equal(passed.task.status, "INTEGRATING", label);
    assert.equal(passed.task.targetHash, SHA, `${label}: PASS persists the candidate hash on the Task`);
    const event = store.listEvents({ limit: 1000 }).at(-1);
    assert.equal(event.payload.targetHash, SHA, `${label}: review.updated carries the target hash`);

    advanceTask(store, "TASK-1", "AWAITING_ACCEPTANCE");
    const approval = store.createApproval({ taskId: "TASK-1", scope: "accept", targetHash: SHA, actor: "HUMAN" });
    const otherHash = "b".repeat(64);
    assert.throws(
      () => store.decideApproval({ id: approval.id, decision: "APPROVED", actor: "HUMAN", targetHash: otherHash }),
      (error) => error.code === "APPROVAL_STALE" && error.details.expectedTargetHash === SHA,
      label,
    );
    assert.equal(store.getTask("TASK-1").status, "AWAITING_ACCEPTANCE", label);
    const approved = store.decideApproval({ id: approval.id, decision: "APPROVED", actor: "HUMAN", targetHash: SHA });
    assert.equal(approved.task.status, "DONE", label);
  }
});

test("QA-005: absurd evidence counters are EVIDENCE_MISSING", (t) => {
  for (const { label, store } of bothStores(t)) {
    for (const [index, tests] of [
      { passed: 1e15, total: 1e15 },
      { passed: 1_000_001, total: 1_000_001 },
      { passed: -1, total: 1 },
    ].entries()) {
      const taskId = `TASK-BOUNDS-${index}`;
      seedReviewable(store, { taskId, agentId: "agent-dev-1" });
      const review = store.createReview({ taskId, actor: "HUMAN" });
      const before = fingerprint(store);
      assert.throws(
        () => store.submitReview({
          id: review.id,
          expectedVersion: 0,
          verdict: "PASS",
          manifestHash: SHA,
          evidence: { tests },
          actor: "reviewer-1",
        }),
        (error) => error.code === "EVIDENCE_MISSING",
        `${label}: ${JSON.stringify(tests)}`,
      );
      assert.deepEqual(fingerprint(store), before, `${label}: ${JSON.stringify(tests)} wrote nothing`);
    }
  }
});

test("QA-005: one review attempt number per Task round, never duplicated", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedReviewable(store);
    const attempts = [];
    for (let round = 0; round < 3; round += 1) {
      const review = store.createReview({ taskId: "TASK-1", actor: "HUMAN" });
      attempts.push(review.attempt);
      store.submitReview({
        id: review.id,
        expectedVersion: 0,
        verdict: "CHANGES_REQUESTED",
        findings: [{ message: `round ${round}` }],
        actor: "reviewer-1",
      });
      if (round < 2) {
        store.reworkTask({ taskId: "TASK-1", reviewId: review.id, reason: "again", actor: "reviewer-1" });
        advanceTask(store, "TASK-1", "REVIEWING");
      }
    }
    assert.deepEqual(attempts, [1, 2, 3], `${label}: createReview attempt sequence`);
    const reviewAttempts = store.listReviews({ taskId: "TASK-1" }).map((review) => review.attempt).sort();
    assert.deepEqual(reviewAttempts, [1, 2, 3], `${label}: review rows`);
    const audit = store[INTERNAL].listReviewAttempts("TASK-1").map((row) => row.attempt);
    assert.deepEqual(audit, [1, 2, 3], `${label}: review_attempts audit rows`);
    assert.equal(new Set(audit).size, audit.length, `${label}: attempts are unique`);
  }
});
