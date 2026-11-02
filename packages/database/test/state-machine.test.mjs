// Task lifecycle state machine (implementation spec §5.2, QA2-01):
// the pure transition table plus the behaviour both stores must share.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TASK_STATUSES } from "@atk/contracts";
import { createMemoryStore } from "@atk/database";
import {
  TASK_MAIN_CHAIN,
  TASK_TERMINAL_STATUSES,
  allowedTransitionsFrom,
  canTransition,
  taskStatusMachine,
} from "../src/model.mjs";
import { advanceTask, projectDto, taskDto, useStore } from "./helpers.mjs";

/** Canonical table (what will be documented in m1-contracts). */
const EXPECTED_TRANSITIONS = {
  DRAFT: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["CLAIMED", "BLOCKED", "CANCELLED"],
  CLAIMED: ["RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["REVIEWING", "BLOCKED", "CANCELLED"],
  REVIEWING: ["INTEGRATING", "BLOCKED", "CANCELLED", "REJECTED"],
  INTEGRATING: ["AWAITING_ACCEPTANCE", "BLOCKED", "CANCELLED"],
  AWAITING_ACCEPTANCE: ["READY", "DONE", "BLOCKED", "CANCELLED", "REJECTED"],
  BLOCKED: ["READY", "CANCELLED"],
  REJECTED: ["READY", "BLOCKED", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

function openBothStores(t) {
  const { store: sqlite } = useStore(t);
  const memory = createMemoryStore();
  for (const store of [sqlite, memory]) store.createProject(projectDto());
  t.after(() => memory.close());
  return [sqlite, memory];
}

test("canTransition is a pure total function matching the documented table", () => {
  assert.deepEqual([...TASK_MAIN_CHAIN], [
    "DRAFT",
    "READY",
    "CLAIMED",
    "RUNNING",
    "REVIEWING",
    "INTEGRATING",
    "AWAITING_ACCEPTANCE",
    "DONE",
  ]);
  assert.deepEqual([...TASK_TERMINAL_STATUSES], ["DONE", "CANCELLED"]);
  assert.equal(taskStatusMachine.canTransition, canTransition);
  assert.equal(taskStatusMachine.allowedTransitions, allowedTransitionsFrom);

  for (const from of TASK_STATUSES) {
    assert.deepEqual(allowedTransitionsFrom(from), EXPECTED_TRANSITIONS[from], `allowed(${from})`);
    assert.deepEqual(
      taskStatusMachine.transitions[from],
      EXPECTED_TRANSITIONS[from],
      `table(${from})`,
    );
    for (const to of TASK_STATUSES) {
      const expected = from === to || EXPECTED_TRANSITIONS[from].includes(to);
      assert.equal(canTransition(from, to), expected, `canTransition(${from}, ${to})`);
    }
  }

  // Self-transitions are allowed (patchTask treats them as idempotent success),
  // but they are not part of the "what changes are legal" table.
  for (const status of TASK_STATUSES) {
    assert.equal(canTransition(status, status), true);
    assert.ok(!allowedTransitionsFrom(status).includes(status));
  }
  // DRAFT is the initial state only: nothing transitions into it.
  for (const from of TASK_STATUSES) {
    if (from !== "DRAFT") assert.equal(canTransition(from, "DRAFT"), false, `${from} -> DRAFT`);
  }
  // DONE/CANCELLED are terminal.
  for (const terminal of TASK_TERMINAL_STATUSES) {
    assert.deepEqual(allowedTransitionsFrom(terminal), []);
    for (const to of TASK_STATUSES) {
      if (to !== terminal) assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to}`);
    }
  }
  // Unknown values never throw and never pass.
  assert.equal(canTransition("NOPE", "READY"), false);
  assert.equal(canTransition("READY", "NOPE"), false);
  assert.deepEqual(allowedTransitionsFrom("NOPE"), []);
  // M4 rework waiting room: no bypass straight into DONE (acceptance is the
  // only entry), and it re-queues only through READY.
  assert.equal(canTransition("REJECTED", "DONE"), false);
  assert.equal(canTransition("REJECTED", "READY"), true);
  assert.equal(canTransition("REVIEWING", "REJECTED"), true);
  assert.equal(canTransition("AWAITING_ACCEPTANCE", "REJECTED"), true);
});

test("both stores walk the legal main chain step by step", (t) => {
  for (const [index, store] of openBothStores(t).entries()) {
    const label = index === 0 ? "sqlite" : "memory";
    store.createTask(taskDto("proj-1", { id: "TASK-CHAIN" }));
    assert.equal(store.getTask("TASK-CHAIN").status, "READY");
    // Same-state is an idempotent success (READY -> READY), not an error.
    const selfPatch = store.patchTask("TASK-CHAIN", {
      expectedVersion: store.getTask("TASK-CHAIN").version,
      changes: { status: "READY" },
    });
    assert.equal(selfPatch.status, "READY", label);

    // M6.1 F01: the generic patch API refuses every execution-state edge; the
    // owning service (or the internal writer for fixtures) advances the chain.
    for (const [from, to] of [
      ["READY", "CLAIMED"],
      ["CLAIMED", "RUNNING"],
      ["RUNNING", "REVIEWING"],
      ["REVIEWING", "INTEGRATING"],
      ["INTEGRATING", "AWAITING_ACCEPTANCE"],
    ]) {
      if (store.getTask("TASK-CHAIN").status !== from) advanceTask(store, "TASK-CHAIN", from);
      const before = store.getTask("TASK-CHAIN");
      assert.throws(
        () => store.patchTask("TASK-CHAIN", { expectedVersion: before.version, changes: { status: to } }),
        (error) =>
          error.code === "TASK_VERSION_CONFLICT" &&
          error.details.reason === "execution-state-guard" &&
          error.details.requestedStatus === to,
        `${label}: ${from} -> ${to}`,
      );
      assert.equal(store.getTask("TASK-CHAIN").status, from, `${label}: rejected ${from} -> ${to} writes nothing`);
    }
    // Finish the chain with the internal writer, then prove DONE is approval-only.
    advanceTask(store, "TASK-CHAIN", "AWAITING_ACCEPTANCE");
    const awaiting = store.getTask("TASK-CHAIN");
    assert.equal(awaiting.status, "AWAITING_ACCEPTANCE", label);
    assert.throws(
      () => store.patchTask("TASK-CHAIN", { expectedVersion: awaiting.version, changes: { status: "DONE" } }),
      (error) =>
        error.code === "TASK_VERSION_CONFLICT" &&
        error.details.reason === "execution-state-guard" &&
        error.details.requestedStatus === "DONE",
      label,
    );
    const done = advanceTask(store, "TASK-CHAIN", "DONE");
    assert.equal(done.status, "DONE", label);
  }
});

test("both stores reject illegal jumps, backwards moves and DRAFT", (t) => {
  for (const [index, store] of openBothStores(t).entries()) {
    const label = index === 0 ? "sqlite" : "memory";
    store.createTask(taskDto("proj-1", { id: "TASK-JUMPS" }));
    const before = store.getTask("TASK-JUMPS");

    for (const [from, to] of [
      ["READY", "DONE"],
      ["READY", "RUNNING"],
      ["READY", "REVIEWING"],
      ["READY", "AWAITING_ACCEPTANCE"],
      ["READY", "DRAFT"],
      ["READY", "INTEGRATING"],
    ]) {
      assert.throws(
        () => store.patchTask("TASK-JUMPS", { expectedVersion: before.version, changes: { status: to } }),
        (error) =>
          (to === "DONE"
            ? ["TASK_VERSION_CONFLICT", "VALIDATION_ERROR"].includes(error.code)
            : error.code === "VALIDATION_ERROR" &&
              error.details.from === from &&
              error.details.to === to &&
              assert.deepEqual(error.details.allowed, EXPECTED_TRANSITIONS[from]) === undefined),
        `${label}: ${from} -> ${to}`,
      );
    }
    // Rejected transitions must not write anything (version/title unchanged).
    const after = store.getTask("TASK-JUMPS");
    assert.equal(after.status, "READY", label);
    assert.equal(after.version, before.version, label);

    // An illegal transition in a mixed patch must not apply the other fields.
    const titleBefore = after.title;
    assert.throws(
      () =>
        store.patchTask("TASK-JUMPS", {
          expectedVersion: after.version,
          changes: { title: "should not apply", priority: 0, status: "DONE" },
        }),
      (error) => ["TASK_VERSION_CONFLICT", "VALIDATION_ERROR"].includes(error.code),
    );
    const unchanged = store.getTask("TASK-JUMPS");
    assert.equal(unchanged.title, titleBefore, label);
    assert.equal(unchanged.priority, 2, label);
    assert.equal(unchanged.version, after.version, label);

    // DONE is terminal: it can neither go back nor be "cancelled away".
    advanceTask(store, "TASK-JUMPS", "DONE");
    const done = store.getTask("TASK-JUMPS");
    for (const to of ["READY", "CANCELLED", "RUNNING", "DRAFT"]) {
      assert.throws(
        () => store.patchTask("TASK-JUMPS", { expectedVersion: done.version, changes: { status: to } }),
        (error) => error.code === "VALIDATION_ERROR" && error.details.from === "DONE",
        `${label}: DONE -> ${to}`,
      );
    }
    // Same-state is an idempotent success (version still advances).
    const idempotent = store.patchTask("TASK-JUMPS", {
      expectedVersion: done.version,
      changes: { status: "DONE" },
    });
    assert.equal(idempotent.status, "DONE", label);
    assert.equal(idempotent.version, done.version + 1, label);
  }
});

test("BLOCKED is a branch state with exactly one way back (READY)", (t) => {
  for (const [index, store] of openBothStores(t).entries()) {
    const label = index === 0 ? "sqlite" : "memory";
    store.createTask(taskDto("proj-1", { id: "TASK-BLOCK" }));
    const ready = store.getTask("TASK-BLOCK");
    const blocked = store.patchTask("TASK-BLOCK", {
      expectedVersion: ready.version,
      changes: { status: "BLOCKED" },
    });
    assert.equal(blocked.status, "BLOCKED", label);

    // BLOCKED → READY is the sanctioned re-entry.
    const reopened = store.patchTask("TASK-BLOCK", {
      expectedVersion: blocked.version,
      changes: { status: "READY" },
    });
    assert.equal(reopened.status, "READY", label);

    // Re-block and verify the rest of the exits.
    const blockedAgain = store.patchTask("TASK-BLOCK", {
      expectedVersion: reopened.version,
      changes: { status: "BLOCKED" },
    });
    for (const to of ["RUNNING", "DONE", "DRAFT", "CLAIMED", "AWAITING_ACCEPTANCE"]) {
      assert.throws(
        () =>
          store.patchTask("TASK-BLOCK", {
            expectedVersion: blockedAgain.version,
            changes: { status: to },
          }),
        (error) =>
          (to === "DONE"
            ? ["TASK_VERSION_CONFLICT", "VALIDATION_ERROR"].includes(error.code)
            : error.code === "VALIDATION_ERROR" && error.details.from === "BLOCKED"),
        `${label}: BLOCKED -> ${to}`,
      );
    }
    const cancelled = store.patchTask("TASK-BLOCK", {
      expectedVersion: blockedAgain.version,
      changes: { status: "CANCELLED" },
    });
    assert.equal(cancelled.status, "CANCELLED", label);

    // CANCELLED is terminal.
    for (const to of ["READY", "RUNNING", "BLOCKED", "DONE", "DRAFT"]) {
      assert.throws(
        () =>
          store.patchTask("TASK-BLOCK", {
            expectedVersion: cancelled.version,
            changes: { status: to },
          }),
        (error) =>
          (to === "DONE"
            ? ["TASK_VERSION_CONFLICT", "VALIDATION_ERROR"].includes(error.code)
            : error.code === "VALIDATION_ERROR" && error.details.from === "CANCELLED"),
        `${label}: CANCELLED -> ${to}`,
      );
    }
    const cancelledAgain = store.patchTask("TASK-BLOCK", {
      expectedVersion: cancelled.version,
      changes: { status: "CANCELLED" },
    });
    assert.equal(cancelledAgain.status, "CANCELLED", label);
  }
});

test("any non-terminal state can be cancelled; DONE cannot", (t) => {
  for (const [index, store] of openBothStores(t).entries()) {
    const label = index === 0 ? "sqlite" : "memory";
    const states = ["READY", "CLAIMED", "RUNNING", "REVIEWING", "INTEGRATING", "AWAITING_ACCEPTANCE"];
    states.forEach((state, position) => {
      const id = `TASK-CANCEL-${position}`;
      store.createTask(taskDto("proj-1", { id }));
      advanceTask(store, id, state);
      const task = store.getTask(id);
      const cancelled = store.patchTask(id, { expectedVersion: task.version, changes: { status: "CANCELLED" } });
      assert.equal(cancelled.status, "CANCELLED", `${label}: ${state} -> CANCELLED`);
    });
    // DONE → CANCELLED is not an allowed exit.
    store.createTask(taskDto("proj-1", { id: "TASK-DONE-CANCEL" }));
    advanceTask(store, "TASK-DONE-CANCEL", "DONE");
    const done = store.getTask("TASK-DONE-CANCEL");
    assert.throws(
      () =>
        store.patchTask("TASK-DONE-CANCEL", {
          expectedVersion: done.version,
          changes: { status: "CANCELLED" },
        }),
      (error) => error.code === "VALIDATION_ERROR" && error.details.allowed.length === 0,
      `${label}: DONE -> CANCELLED`,
    );
  }
});
