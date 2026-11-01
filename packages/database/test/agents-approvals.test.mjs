// Agents, approvals, reviews and runs: contract §1 read paths and the write
// paths M1 actually exposes (upsertAgent / createApproval).
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectDto, taskDto, useStore } from "./helpers.mjs";

const SHA = "a".repeat(64);

function openProject(t) {
  const { store } = useStore(t);
  store.createProject(projectDto());
  return store;
}

test("upsertAgent inserts, then updates with a version bump", (t) => {
  const store = openProject(t);
  const inserted = store.upsertAgent({
    id: "agent-dev-01",
    role: "DEV",
    capabilities: ["WORKER", "REVIEWER", "WORKER"],
    task: "TASK-1",
    detail: "working",
  });
  assert.equal(inserted.id, "agent-dev-01");
  assert.equal(inserted.role, "DEV");
  assert.deepEqual(inserted.capabilities, ["WORKER", "REVIEWER"]);
  assert.equal(inserted.status, "OFFLINE");
  assert.equal(inserted.version, 0);
  assert.equal(inserted.task, "TASK-1");

  const updated = store.upsertAgent({ id: "agent-dev-01", status: "BUSY", detail: "busy now" });
  assert.equal(updated.version, 1);
  assert.equal(updated.status, "BUSY");
  assert.equal(updated.detail, "busy now");
  assert.deepEqual(updated.capabilities, ["WORKER", "REVIEWER"]);
  assert.equal(updated.createdAt, inserted.createdAt);

  store.upsertAgent({ id: "agent-qa-01", role: "QA", capabilities: ["REVIEWER"], status: "IDLE" });
  assert.deepEqual(store.listAgents().map((agent) => agent.id), ["agent-dev-01", "agent-qa-01"]);
  assert.equal(store.health().counts.agents, 2);
});

test("upsertAgent rejects invalid capability/role/id/status", (t) => {
  const store = openProject(t);
  const base = { id: "agent-x", role: "DEV", capabilities: ["WORKER"] };
  assert.throws(
    () => store.upsertAgent({ ...base, capabilities: ["BUILDER"] }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.upsertAgent({ ...base, capabilities: [] }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.upsertAgent({ ...base, role: "dev" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.upsertAgent({ ...base, id: "agent with spaces" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.upsertAgent({ ...base, status: "SLEEPING" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("createApproval stores a HUMAN acceptance bound to a target hash", (t) => {
  const store = openProject(t);
  const task = store.createTask(taskDto("proj-1", { id: "TASK-1" }));
  const approval = store.createApproval({
    projectId: "proj-1",
    taskId: task.id,
    scope: "task acceptance",
    targetHash: SHA,
    actor: "HUMAN",
    status: "APPROVED",
    at: "2026-11-02T10:00:00.000Z",
  });
  assert.match(approval.id, /^APR-[A-Z0-9]+$/);
  assert.equal(approval.actor, "HUMAN");
  assert.equal(approval.status, "APPROVED");
  assert.equal(approval.targetHash, SHA);
  assert.equal(approval.taskId, "TASK-1");
  assert.equal(approval.projectId, "proj-1");
  assert.equal(approval.at, "2026-11-02T10:00:00.000Z");

  assert.deepEqual(store.listApprovals({ taskId: "TASK-1" }).map((row) => row.id), [approval.id]);
  assert.deepEqual(store.listApprovals({ status: "APPROVED" }).map((row) => row.id), [approval.id]);
  assert.deepEqual(store.listApprovals({ status: "REJECTED" }), []);

  assert.throws(
    () => store.createApproval({ scope: "x", targetHash: "not-a-sha", actor: "HUMAN", status: "APPROVED" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.createApproval({ scope: "x", targetHash: SHA, actor: "AGENT", status: "APPROVED" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.createApproval({ scope: "", targetHash: SHA, actor: "HUMAN", status: "APPROVED" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () =>
      store.createApproval({
        taskId: "TASK-MISSING",
        scope: "x",
        targetHash: SHA,
        actor: "HUMAN",
        status: "PENDING",
      }),
    (error) => error.code === "NOT_FOUND",
  );
  assert.throws(
    () =>
      store.createApproval({
        projectId: "proj-missing",
        scope: "x",
        targetHash: SHA,
        actor: "HUMAN",
        status: "PENDING",
      }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("runs and reviews are read-only in M1 and start empty", (t) => {
  const store = openProject(t);
  assert.deepEqual(store.listRuns(), []);
  assert.deepEqual(store.listReviews(), []);
  assert.throws(
    () => store.getRun("run-1"),
    (error) => error.code === "NOT_FOUND" && error.details.id === "run-1",
  );
  assert.throws(
    () => store.listRuns({ status: "BOGUS" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => store.listReviews({ status: "BOGUS" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.equal(store.health().counts.runs, 0);
});
