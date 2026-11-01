// DAG tests: cycle detection, levelised topological order, ready candidates.
import assert from "node:assert/strict";
import test from "node:test";

import { detectCycles, readyCandidates, topologicalOrder } from "../src/index.mjs";
import { permutations, task } from "./helpers.mjs";

function byDeps(tasks) {
  return tasks.map(({ id, deps }) => ({ id, deps }));
}

test("detectCycles accepts a chain and a diamond", () => {
  assert.deepEqual(detectCycles(byDeps([task("A"), task("B", { deps: ["A"] }), task("C", { deps: ["A"] }), task("D", { deps: ["B", "C"] })])), {
    ok: true,
    cycles: [],
  });
});

test("detectCycles finds a direct two-node cycle", () => {
  const result = detectCycles(byDeps([task("A", { deps: ["B"] }), task("B", { deps: ["A"] })]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.cycles, [["A", "B"]]);
});

test("detectCycles finds an indirect three-node cycle", () => {
  const result = detectCycles(byDeps([task("A", { deps: ["B"] }), task("B", { deps: ["C"] }), task("C", { deps: ["A"] })]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.cycles, [["A", "B", "C"]]);
});

test("detectCycles treats a self-dependency as a cycle", () => {
  const result = detectCycles(byDeps([task("A", { deps: ["A"] })]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.cycles, [["A"]]);
});

test("detectCycles reports multiple disjoint cycles deterministically", () => {
  const tasks = byDeps([
    task("C", { deps: ["D"] }),
    task("A", { deps: ["B"] }),
    task("B", { deps: ["A"] }),
    task("D", { deps: ["C"] }),
  ]);
  assert.deepEqual(detectCycles(tasks).cycles, [
    ["A", "B"],
    ["C", "D"],
  ]);
});

test("detectCycles ignores dependencies on tasks outside the snapshot", () => {
  assert.deepEqual(detectCycles(byDeps([task("A", { deps: ["MISSING"] })])), { ok: true, cycles: [] });
});

test("detectCycles tolerates missing, duplicate and malformed deps", () => {
  assert.deepEqual(detectCycles(byDeps([{ id: "A" }, { id: "B", deps: ["A", "A", 42, ""] }])), { ok: true, cycles: [] });
});

test("detectCycles is independent of input order", () => {
  const tasks = byDeps([task("A", { deps: ["B"] }), task("B", { deps: ["A"] }), task("C", { deps: ["A"] })]);
  const results = permutations(tasks).map((value) => detectCycles(value));
  for (const result of results) assert.deepEqual(result, results[0]);
});

test("detectCycles sees a cycle through an otherwise valid chain", () => {
  const tasks = byDeps([
    task("A"),
    task("B", { deps: ["A", "D"] }),
    task("C", { deps: ["B"] }),
    task("D", { deps: ["C"] }),
  ]);
  const result = detectCycles(tasks);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cycles, [["B", "D", "C"]]);
});

test("topologicalOrder returns a valid levelised order", () => {
  const result = topologicalOrder(byDeps([task("A"), task("B", { deps: ["A"] }), task("C", { deps: ["A"] }), task("D", { deps: ["B", "C"] })]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.levels, [["A"], ["B", "C"], ["D"]]);
  assert.deepEqual(result.order, ["A", "B", "C", "D"]);
});

test("topologicalOrder guarantees each dep appears before its dependent", () => {
  const tasks = byDeps([
    task("A"),
    task("B", { deps: ["A"] }),
    task("C", { deps: ["A", "B"] }),
    task("D", { deps: ["C"] }),
    task("E"),
  ]);
  const result = topologicalOrder(tasks);
  assert.equal(result.ok, true);
  const position = new Map(result.order.map((id, index) => [id, index]));
  for (const { id, deps } of tasks) {
    for (const dep of deps) {
      assert.ok(position.get(dep) < position.get(id), `${dep} must precede ${id}`);
    }
  }
});

test("topologicalOrder fails the whole order on a cycle", () => {
  const result = topologicalOrder(byDeps([task("A", { deps: ["B"] }), task("B", { deps: ["A"] })]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.cycles, [["A", "B"]]);
});

test("topologicalOrder ignores external missing deps for ordering", () => {
  const result = topologicalOrder(byDeps([task("A", { deps: ["MISSING"] })]));
  assert.deepEqual(result, { ok: true, order: ["A"], levels: [["A"]] });
});

test("topologicalOrder is independent of input order", () => {
  const tasks = byDeps([task("C", { deps: ["A"] }), task("A"), task("B", { deps: ["A"] }), task("D", { deps: ["B", "C"] })]);
  const results = permutations(tasks).map((value) => topologicalOrder(value));
  for (const result of results) assert.deepEqual(result, results[0]);
});

test("topologicalOrder handles an empty graph", () => {
  assert.deepEqual(topologicalOrder([]), { ok: true, order: [], levels: [] });
});

test("readyCandidates returns READY tasks whose deps are all DONE", () => {
  const tasks = [task("A", { status: "DONE" }), task("B", { deps: ["A"] }), task("C", { deps: ["A"], status: "READY" })];
  const result = readyCandidates({ tasks });
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["B", "C"]);
  assert.deepEqual(result.missingDeps, []);
});

test("readyCandidates excludes tasks with unfinished dependencies", () => {
  const tasks = [task("A", { status: "RUNNING" }), task("B", { deps: ["A"] })];
  assert.deepEqual(readyCandidates({ tasks }), { candidates: [], missingDeps: [] });
});

test("readyCandidates reports missing dependencies separately", () => {
  const tasks = [task("A", { deps: ["MISSING-1", "MISSING-2"] })];
  const result = readyCandidates({ tasks });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.missingDeps, [
    { taskId: "A", depId: "MISSING-1" },
    { taskId: "A", depId: "MISSING-2" },
  ]);
});

test("readyCandidates ignores non-READY statuses", () => {
  const tasks = ["DRAFT", "CLAIMED", "RUNNING", "REVIEWING", "DONE", "BLOCKED", "CANCELLED"].map((status) => task(status, { status }));
  assert.deepEqual(readyCandidates({ tasks }), { candidates: [], missingDeps: [] });
});

test("readyCandidates treats a missing deps field as no dependencies", () => {
  const result = readyCandidates({ tasks: [{ id: "A", status: "READY" }] });
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["A"]);
});

test("readyCandidates output is independent of input order", () => {
  const tasks = [task("B"), task("A"), task("C"), task("D", { deps: ["A"] })];
  const results = permutations(tasks).map((value) => readyCandidates({ tasks: value }));
  for (const result of results) assert.deepEqual(result, results[0]);
});
