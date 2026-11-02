// M6.3 WP2 phase A audit (RED against baseline c20513c). Product code must not
// change until the Lead freezes the 0008 contract; these tests record the gaps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { INTERNAL } from "../src/internal.mjs";
import { bothStores, projectDto, taskDto, useStore } from "./helpers.mjs";

test("P0-3b duplicate workBranch is rejected per project and by the real unique index", (t) => {
  for (const { label, store } of bothStores(t)) {
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const claimed = store.claimTask({
      taskId: "TASK-SEED",
      agentId: "agent-1",
      expectedTaskVersion: store.getTask("TASK-SEED").version,
      idempotencyKey: "m63-branch-1",
    });
    store.createTask(taskDto("proj-1", { id: "TASK-BRANCH-2" }));
    const before = store.listRuns({ limit: 100 }).length;
    assert.throws(
      () =>
        store.createRun({
          taskId: "TASK-BRANCH-2",
          agentId: "agent-1",
          function: "WORKER",
          role: "DEV",
          workBranch: claimed.run.workBranch,
        }),
      (error) => error.code === "VALIDATION_ERROR" && error.details.field === "workBranch",
      label,
    );
    assert.equal(store.listRuns({ limit: 100 }).length, before, label);
  }
  // Real SQLite: the unique index itself must reject a duplicate.
  const { store, file } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1", { id: "TASK-RAW" }));
  const raw = new DatabaseSync(file);
  try {
    const at = new Date().toISOString();
    const insert = raw.prepare(
      `INSERT INTO runs (id, task_id, agent_id, function, status, attempt, version, created_at, updated_at, project_id, work_branch)
       VALUES (?, ?, ?, 'WORKER', 'STARTING', 1, 0, ?, ?, 'proj-1', 'atk/run/dup')`,
    );
    insert.run("RUN-RAW-1", "TASK-RAW", "agent-1", at, at);
    assert.throws(
      () => insert.run("RUN-RAW-2", "TASK-RAW", "agent-1", at, at),
      /UNIQUE|constraint/i,
    );
  } finally {
    raw.close();
  }
});

test("P1-8b submitReview only trusts a REVIEWER Run for the same task and agent", (t) => {
  for (const { label, store } of bothStores(t)) {
    store.upsertAgent({ id: "reviewer-1", role: "QA", capabilities: ["REVIEWER"], status: "IDLE" });
    store.upsertAgent({ id: "author-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const producer = store.createRun({ taskId: "TASK-SEED", agentId: "author-1", function: "WORKER", role: "DEV" });
    store.enqueueDispatchCommand({ runId: producer.id, commandType: "RUN_TASK", payload: {}, idempotencyKey: "m63-producer" });
    store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 60000 });
    store.updateRunStatus(producer.id, { status: "RUNNING", generation: 1 });
    store.updateRunStatus(producer.id, { status: "COMPLETED", exitCode: 0, generation: 1 });
    store[INTERNAL].setTaskStatus("TASK-SEED", "RUNNING");
    const workerReviewerRun = store.createRun({ taskId: "TASK-SEED", agentId: "reviewer-1", function: "WORKER", role: "DEV" });
    assert.throws(
      () =>
        store.createReview({
          taskId: "TASK-SEED",
          runId: producer.id,
          reviewerAgentId: "reviewer-1",
          reviewerRunId: workerReviewerRun.id,
          assignedTo: "AGENT",
          createdByRole: "scheduler",
        }),
      (error) => error.code === "REVIEW_RUN_NOT_REVIEWER",
      label,
    );
    const reviewerRun = store.createRun({ taskId: "TASK-SEED", agentId: "reviewer-1", function: "REVIEWER", role: "QA" });
    const otherTask = "TASK-OTHER";
    store.createTask(taskDto("proj-1", { id: otherTask }));
    const foreignRun = store.createRun({ taskId: otherTask, agentId: "reviewer-1", function: "REVIEWER", role: "QA" });
    assert.throws(
      () =>
        store.createReview({
          taskId: "TASK-SEED",
          runId: producer.id,
          reviewerAgentId: "reviewer-1",
          reviewerRunId: foreignRun.id,
          assignedTo: "AGENT",
          createdByRole: "scheduler",
        }),
      (error) => error.code === "REVIEW_RUN_NOT_REVIEWER",
      label,
    );
    const review = store.createReview({
      taskId: "TASK-SEED",
      runId: producer.id,
      reviewerAgentId: "reviewer-1",
      reviewerRunId: reviewerRun.id,
      assignedTo: "AGENT",
      createdByRole: "scheduler",
    });
    const submitted = store.submitReview({
      id: review.id,
      expectedVersion: review.version,
      verdict: "PASS",
      manifestHash: "a".repeat(64),
      evidence: { tests: { passed: 1, total: 1 } },
      actor: "reviewer-1",
      reviewerAgentId: "reviewer-1",
    });
    assert.equal(submitted.review.status, "PASS", label);
  }
});

test("P0-3 a Run has a unique workBranch, targetBranch stays the integration target", (t) => {
  for (const { label, store } of bothStores(t)) {
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const task = store.getTask("TASK-SEED");
    const claimed = store.claimTask({
      taskId: "TASK-SEED",
      agentId: "agent-1",
      expectedTaskVersion: task.version,
      idempotencyKey: "m63-work-branch",
      workspace: { kind: "worktree", root: "/tmp/atk-m63", baseCommit: "a".repeat(40), targetBranch: "dev" },
    });
    assert.equal(claimed.run.workspace.targetBranch, "dev", label);
    assert.equal(claimed.run.workBranch ?? claimed.run.workspace.workBranch, `atk/run/${claimed.run.id}`, label);
  }
});

test("P0-4 reconcileRun exposes the dispatch command result for Outbox accounting", (t) => {
  for (const { label, store } of bothStores(t)) {
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const task = store.getTask("TASK-SEED");
    const claimed = store.claimTask({
      taskId: "TASK-SEED",
      agentId: "agent-1",
      expectedTaskVersion: task.version,
      idempotencyKey: "m63-reconcile",
    });
    const reconciled = store.reconcileRun({ runId: claimed.run.id });
    assert.ok(reconciled.command, `${label}: reconcileRun command missing: ${JSON.stringify(Object.keys(reconciled))}`);
    for (const field of ["id", "generation", "status", "result", "idempotencyKey"]) {
      assert.ok(field in reconciled.command, `${label}: command.${field}`);
    }
  }
});

test("P1-5 events persist event_id/session_seq/legacy and enforce (run_id,event_id)", (t) => {
  const { file } = useStore(t);
  const raw = new DatabaseSync(file);
  try {
    const columns = raw.prepare("PRAGMA table_info(events)").all().map((row) => row.name);
    assert.ok(columns.includes("event_id"));
    assert.ok(columns.includes("session_seq"));
    assert.ok(columns.includes("legacy"), `legacy column missing; columns=${columns.join(",")}`);
    const index = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_events_run_event_id'")
      .get();
    assert.match(index?.sql ?? "", /UNIQUE INDEX/i);
  } finally {
    raw.close();
  }
});

test("P1-8 reviews bind a reviewer Run and submit can enforce REVIEWER function", (t) => {
  const { store } = useStore(t);
  store.createProject({ id: "P1", name: "P", repoPath: ".", defaultBranch: "main" });
  store.createTask({ id: "T1", projectId: "P1", title: "t", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [] });
  store.upsertAgent({ id: "reviewer-1", role: "QA", capabilities: ["REVIEWER"], status: "IDLE" });
  store.upsertAgent({ id: "author-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
  const producer = store.createRun({ taskId: "T1", agentId: "author-1", function: "WORKER", role: "DEV" });
  store.enqueueDispatchCommand({ runId: producer.id, commandType: "RUN_TASK", payload: {}, idempotencyKey: "m63-producer" });
  store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 60000 });
  store.updateRunStatus(producer.id, { status: "RUNNING", generation: 1 });
  store.updateRunStatus(producer.id, { status: "COMPLETED", exitCode: 0, generation: 1 });
  store[INTERNAL].setTaskStatus("T1", "RUNNING");
  const reviewerRun = store.createRun({ taskId: "T1", agentId: "reviewer-1", function: "REVIEWER", role: "QA" });
  const review = store.createReview({
    taskId: "T1",
    runId: producer.id,
    reviewerAgentId: "reviewer-1",
    reviewerRunId: reviewerRun.id,
    assignedTo: "AGENT",
    createdByRole: "scheduler",
  });
  assert.equal(review.reviewerRunId, reviewerRun.id, "review must remember the reviewer Run");
  const raw = new DatabaseSync(store.health().file);
  try {
    const columns = raw.prepare("PRAGMA table_info(reviews)").all().map((row) => row.name);
    assert.ok(columns.includes("reviewer_run_id"), `reviewer_run_id missing; columns=${columns.join(",")}`);
  } finally {
    raw.close();
  }
  assert.equal(store.getRun(reviewerRun.id).function, "REVIEWER", "store can expose Run.function");
});
