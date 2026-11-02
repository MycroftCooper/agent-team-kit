// M4 human acceptance (m4-contracts §1): approvals are bound to a target hash,
// only an APPROVED decision can move AWAITING_ACCEPTANCE -> DONE, and a changed
// target invalidates the approval. SQLite + memory share the semantics.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceTask, bothStores, taskDto } from "./helpers.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function seedAwaiting(store, { taskId = "TASK-1", targetHash } = {}) {
  store.createTask(taskDto("proj-1", { id: taskId, ...(targetHash === undefined ? {} : { targetHash }) }));
  advanceTask(store, taskId, "AWAITING_ACCEPTANCE");
  return store.getTask(taskId);
}

function fingerprint(store) {
  return {
    tasks: store.listTasks({ limit: 1000 }),
    approvals: store.listApprovals({ limit: 100 }),
    events: store.listEvents({ limit: 1000 }),
  };
}

test("createApproval records a PENDING human approval and approval.recorded", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedAwaiting(store);
    const approval = store.createApproval({
      taskId: "TASK-1",
      scope: "task acceptance",
      targetHash: SHA_A,
      actor: "HUMAN",
    });
    assert.match(approval.id, /^APR-[A-Z0-9]+$/, label);
    assert.equal(approval.status, "PENDING", label);
    assert.equal(approval.version, 0, label);
    assert.equal(approval.taskId, "TASK-1", label);
    assert.equal(approval.projectId, "proj-1", label);
    assert.equal(approval.targetHash, SHA_A, label);
    assert.equal(approval.actor, "HUMAN", label);
    assert.deepEqual(store.listApprovals({ taskId: "TASK-1" }).map((row) => row.id), [approval.id], label);
    assert.deepEqual(store.listApprovals({ status: "PENDING" }).map((row) => row.id), [approval.id], label);
    assert.deepEqual(store.listApprovals({ status: "APPROVED" }), [], label);
    const event = store.listEvents({ limit: 1000 }).at(-1);
    assert.equal(event.type, "approval.recorded", label);
    assert.deepEqual(event.payload, {
      taskId: "TASK-1",
      approvalId: approval.id,
      status: "PENDING",
      targetHash: SHA_A,
      actor: "HUMAN",
    }, label);

    // Not AWAITING_ACCEPTANCE / missing Task are contract conflicts.
    store.createTask(taskDto("proj-1", { id: "TASK-READY" }));
    const before = fingerprint(store);
    assert.throws(
      () => store.createApproval({ taskId: "TASK-READY", scope: "x", targetHash: SHA_A, actor: "HUMAN" }),
      (error) => error.code === "TASK_VERSION_CONFLICT" && error.details.reason === "not-awaiting-acceptance",
      label,
    );
    assert.throws(
      () => store.createApproval({ taskId: "TASK-MISSING", scope: "x", targetHash: SHA_A, actor: "HUMAN" }),
      (error) => error.code === "NOT_FOUND",
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: failed createApproval wrote nothing`);
  }
});

test("decideApproval APPROVED with the matching hash is the only DONE entrance", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedAwaiting(store, { targetHash: SHA_A });
    const approval = store.createApproval({ taskId: "TASK-1", scope: "accept", targetHash: SHA_A, actor: "HUMAN" });
    const result = store.decideApproval({
      id: approval.id,
      decision: "APPROVED",
      actor: "HUMAN",
      targetHash: SHA_A,
    });
    assert.equal(result.approval.status, "APPROVED", label);
    assert.equal(result.approval.decision, "APPROVED", label);
    assert.equal(result.approval.version, 1, label);
    assert.ok(result.approval.decidedAt, label);
    assert.equal(result.task.status, "DONE", label);
    const event = store.listEvents({ limit: 1000 }).at(-1);
    assert.equal(event.type, "approval.recorded", label);
    assert.equal(event.payload.taskId, "TASK-1", label);
    assert.equal(event.payload.approvalId, approval.id, label);
    assert.equal(event.payload.decision, "APPROVED", label);
    assert.equal(event.payload.status, "APPROVED", label);
    assert.equal(event.payload.targetHash, SHA_A, label);
    assert.equal(event.payload.actor, "HUMAN", label);
    assert.equal(event.payload.principal, "HUMAN", label);
    assert.equal(event.payload.operation, "approval.decide", label);
    assert.equal(event.payload.targetVersion, result.task.version, label);
    assert.equal(event.payload.at, event.payload.at, label);
    assert.ok(event.payload.at, label);

    // Task DONE is terminal: a second decision on the same approval is rejected.
    const before = fingerprint(store);
    assert.throws(
      () => store.decideApproval({ id: approval.id, decision: "APPROVED", actor: "HUMAN", targetHash: SHA_A }),
      (error) => error.code === "REVIEW_INVALIDATED",
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: repeated decision wrote nothing`);
  }
});

test("a changed target is APPROVAL_STALE and keeps the Task awaiting", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedAwaiting(store, { targetHash: SHA_A });
    const approval = store.createApproval({ taskId: "TASK-1", scope: "accept", targetHash: SHA_A, actor: "HUMAN" });
    const before = fingerprint(store);
    assert.throws(
      () => store.decideApproval({ id: approval.id, decision: "APPROVED", actor: "HUMAN", targetHash: SHA_B }),
      (error) =>
        error.code === "APPROVAL_STALE" &&
        error.details.expectedTargetHash === SHA_A &&
        error.details.receivedTargetHash === SHA_B,
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: stale decision wrote nothing`);
    assert.equal(store.getTask("TASK-1").status, "AWAITING_ACCEPTANCE", label);
    assert.equal(store.listApprovals({ status: "PENDING" }).length, 1, label);

    // The Task itself moved on (targetHash C) while the approval still says A.
    seedAwaiting(store, { taskId: "TASK-2", targetHash: SHA_C });
    const staleApproval = store.createApproval({ taskId: "TASK-2", scope: "accept", targetHash: SHA_A, actor: "HUMAN" });
    assert.throws(
      () => store.decideApproval({ id: staleApproval.id, decision: "APPROVED", actor: "HUMAN", targetHash: SHA_A }),
      (error) =>
        error.code === "APPROVAL_STALE" &&
        error.details.expectedTargetHash === SHA_C &&
        error.details.receivedTargetHash === SHA_A,
      label,
    );
    assert.equal(store.getTask("TASK-2").status, "AWAITING_ACCEPTANCE", label);
  }
});

test("REJECTED decisions re-queue the Task for rework, invalid args write nothing", (t) => {
  for (const { label, store } of bothStores(t)) {
    seedAwaiting(store);
    const approval = store.createApproval({ taskId: "TASK-1", scope: "accept", targetHash: SHA_A, actor: "HUMAN" });
    const beforeDecision = fingerprint(store);
    const rejected = store.decideApproval({
      id: approval.id,
      decision: "REJECTED",
      actor: "HUMAN",
      targetHash: SHA_A,
    });
    assert.equal(rejected.approval.status, "REJECTED", label);
    assert.equal(rejected.task.status, "READY", `${label}: rejected acceptance re-queues the Task`);
    assert.equal(rejected.task.version, beforeDecision.tasks.find((task) => task.id === "TASK-1").version + 1, label);
    const taskEvent = store
      .listEvents({ limit: 1000 })
      .filter((event) => event.type === "task.updated")
      .at(-1);
    assert.equal(taskEvent.payload.reason, "rework", label);
    assert.equal(taskEvent.payload.status, "READY", label);
    assert.equal(taskEvent.payload.previousStatus, "AWAITING_ACCEPTANCE", label);
    // Task.REJECTED is NOT used here: an acceptance rejection has a PASS review,
    // so parking the Task there would leave it with no legal exit.
    assert.notEqual(store.getTask("TASK-1").status, "REJECTED", label);
    assert.ok(fingerprint(store).events.length > beforeDecision.events.length, label);

    // Invalid decision / missing target are validation errors.
    seedAwaiting(store, { taskId: "TASK-2" });
    const pending = store.createApproval({ taskId: "TASK-2", scope: "accept", targetHash: SHA_A, actor: "HUMAN" });
    const before = fingerprint(store);
    assert.throws(
      () => store.decideApproval({ id: pending.id, decision: "MAYBE", actor: "HUMAN", targetHash: SHA_A }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.throws(
      () => store.decideApproval({ id: pending.id, decision: "APPROVED", actor: "HUMAN", targetHash: "" }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.throws(
      () => store.decideApproval({ id: "APR-MISSING", decision: "APPROVED", actor: "HUMAN", targetHash: SHA_A }),
      (error) => error.code === "NOT_FOUND",
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: invalid decisions wrote nothing`);
  }
});

test("QA-005: patchTask can never set DONE; approval is the only door", (t) => {
  for (const { label, store } of bothStores(t)) {
    const task = seedAwaiting(store);
    const before = fingerprint(store);
    assert.throws(
      () => store.patchTask("TASK-1", { expectedVersion: task.version, changes: { status: "DONE" } }),
      (error) =>
        error.code === "TASK_VERSION_CONFLICT" &&
        error.details.reason === "execution-state-guard" &&
        error.details.requestedStatus === "DONE",
      label,
    );
    assert.deepEqual(fingerprint(store), before, `${label}: rejected DONE patch wrote nothing`);

    const approval = store.createApproval({ taskId: "TASK-1", scope: "accept", targetHash: SHA_A, actor: "HUMAN" });
    const approved = store.decideApproval({ id: approval.id, decision: "APPROVED", actor: "HUMAN", targetHash: SHA_A });
    assert.equal(approved.task.status, "DONE", label);
  }
});
