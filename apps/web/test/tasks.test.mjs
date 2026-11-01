// Task list helpers shared by the list and kanban views.
import test from "node:test";
import assert from "node:assert/strict";

import { countByStatus, filterTasks, matchesQuery } from "../src/domain/tasks.ts";

const TASKS = [
  { id: "T-1", title: "Wire the SSE client", status: "READY" },
  { id: "T-2", title: "Add the language toggle", status: "DONE" },
  { id: "T-3", title: "Kanban view", status: "READY" },
  { id: "T-4", title: "Blocked task", status: "BLOCKED" },
];

test("matchesQuery is case-insensitive over id and title", () => {
  assert.equal(matchesQuery(TASKS[0], "sse"), true);
  assert.equal(matchesQuery(TASKS[0], "SSE CLIENT"), true);
  assert.equal(matchesQuery(TASKS[0], "T-1"), true);
  assert.equal(matchesQuery(TASKS[0], "nope"), false);
  assert.equal(matchesQuery(TASKS[0], ""), true);
  assert.equal(matchesQuery(TASKS[0], "   "), true);
  assert.equal(matchesQuery(TASKS[0], null), true);
  assert.equal(matchesQuery(TASKS[0], undefined), true);
});

test("filterTasks keeps the matching subset and the input order", () => {
  assert.deepEqual(
    filterTasks(TASKS, "t-").map((task) => task.id),
    ["T-1", "T-2", "T-3", "T-4"],
  );
  assert.deepEqual(
    filterTasks(TASKS, "kanban").map((task) => task.id),
    ["T-3"],
  );
  assert.equal(filterTasks(TASKS, "").length, 4);
});

test("countByStatus counts every status and ignores nothing", () => {
  assert.deepEqual(countByStatus(TASKS), { READY: 2, DONE: 1, BLOCKED: 1 });
  assert.deepEqual(countByStatus([]), {});
});

test("countByStatus tolerates missing status fields", () => {
  assert.deepEqual(countByStatus([{ id: "T-9" }, { id: "T-10", status: "READY" }]), { "": 1, READY: 1 });
});
