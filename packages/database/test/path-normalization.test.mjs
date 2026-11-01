// Path canonicalisation for write scopes (Lead QA MINOR-2): "./src/a.js",
// "src\a.js" and "src/../src/a.js" must all alias the same repository path, so
// the scheduler's write-scope conflict check cannot be bypassed by spelling.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStore } from "@atk/database";
import { bothStores, taskDto, useStore } from "./helpers.mjs";

test("task.files are canonicalised at the boundary", (t) => {
  for (const { label, store } of bothStores(t)) {
    const task = store.createTask(
      taskDto("proj-1", {
        id: "TASK-NORM",
        files: ["./src/a.mjs", "src\\b.mjs", "src/../src/c.mjs", "src/a.mjs"],
      }),
    );
    assert.deepEqual(task.files, ["src/a.mjs", "src/b.mjs", "src/c.mjs"], label);
    assert.deepEqual(store.getTask("TASK-NORM").files, ["src/a.mjs", "src/b.mjs", "src/c.mjs"], label);

    for (const bad of ["../escape.mjs", "src/../../escape.mjs", "..\\escape.mjs", "/abs/path.mjs", "C:\\abs\\path.mjs"]) {
      assert.throws(
        () => store.createTask(taskDto("proj-1", { id: `TASK-BAD-${Math.random()}`, files: [bad] })),
        (error) => error.code === "VALIDATION_ERROR",
        `${label}: ${bad}`,
      );
    }
  }
});

test("write-scope conflicts compare canonical paths, not raw spellings", (t) => {
  for (const { label, store } of bothStores(t)) {
    store.createTask(taskDto("proj-1", { id: "TASK-A", files: ["./src/shared.mjs"] }));
    store.createTask(taskDto("proj-1", { id: "TASK-B", files: ["src\\shared.mjs"] }));
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    store.claimTask({ taskId: "TASK-A", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "norm-a" });
    assert.throws(
      () => store.claimTask({ taskId: "TASK-B", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "norm-b" }),
      (error) =>
        error.code === "CAPABILITY_UNAVAILABLE" &&
        error.details.reason === "write-scope-conflict" &&
        assert.deepEqual(error.details.files, ["src/shared.mjs"]) === undefined,
      label,
    );
  }
});

test("directory scopes conflict with files, but sibling prefixes do not (QA4-03)", (t) => {
  for (const { label, store } of bothStores(t)) {
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    // ["src"] is a directory scope that must conflict with ["src/a.js"].
    store.createTask(taskDto("proj-1", { id: "TASK-DIR", files: ["src"] }));
    store.createTask(taskDto("proj-1", { id: "TASK-FILE", files: ["src\\a.js"] }));
    store.claimTask({ taskId: "TASK-DIR", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "dir-1" });
    assert.throws(
      () => store.claimTask({ taskId: "TASK-FILE", agentId: "agent-1", expectedTaskVersion: 0, idempotencyKey: "dir-2" }),
      (error) =>
        error.code === "CAPABILITY_UNAVAILABLE" &&
        error.details.reason === "write-scope-conflict" &&
        assert.deepEqual(error.details.files, ["src", "src/a.js"]) === undefined,
      `${label}: directory scope`,
    );

    // "src2/a.js" is NOT under "src": no conflict.
    store.createTask(taskDto("proj-1", { id: "TASK-SIBLING", files: ["src2/a.js"] }));
    const sibling = store.claimTask({
      taskId: "TASK-SIBLING",
      agentId: "agent-1",
      expectedTaskVersion: 0,
      idempotencyKey: "sibling-1",
    });
    assert.equal(sibling.task.id, "TASK-SIBLING", `${label}: sibling prefix is not a conflict`);

    // Case-sensitive: "Src/a.js" does not conflict with "src/a.js" on any OS.
    store.createTask(taskDto("proj-1", { id: "TASK-CASE", files: ["Src/a.js"] }));
    const cased = store.claimTask({
      taskId: "TASK-CASE",
      agentId: "agent-1",
      expectedTaskVersion: 0,
      idempotencyKey: "case-1",
    });
    assert.equal(cased.task.id, "TASK-CASE", `${label}: path comparison is case-sensitive`);
  }
});

test("memory store keeps the same canonicalisation", (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  store.createProject({ id: "p", name: "P", repoPath: ".", defaultBranch: "main" });
  const task = store.createTask(taskDto("p", { id: "TASK-M", files: ["./x/./y.mjs", "x\\z.mjs"] }));
  assert.deepEqual(task.files, ["x/y.mjs", "x/z.mjs"]);
});
