// QA-003 D3 sweeper: a terminal Run proves its still-CLAIMED command can be
// closed (Run COMPLETED → DONE, FAILED/INTERRUPTED/CANCELLED → FAILED).
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERNAL } from "../src/internal.mjs";
import { bothStores, seedDispatch, seedRun } from "./helpers.mjs";

function commandState(store, id) {
  return store[INTERNAL].getDispatchCommand(id);
}

function claimFor(store, run, ownerId) {
  const command = seedDispatch(store, run.id, { idempotencyKey: `sweep-${run.id}` });
  const claimed = store.claimDispatchCommand({ ownerId, leaseMs: 60_000 });
  assert.equal(claimed.command.id, command.id);
  return { command, lease: claimed.lease };
}

function runToTerminal(store, run, status) {
  if (status === "COMPLETED" || status === "CANCELLED") {
    store.updateRunStatus(run.id, { status: "RUNNING" });
  }
  return store.updateRunStatus(run.id, { status, ...(status === "COMPLETED" ? { exitCode: 0 } : {}) });
}

test("sweepDispatchCommands closes CLAIMED commands from terminal Runs", (t) => {
  const now = "2026-11-02T00:00:00.000Z";
  for (const { label, store } of bothStores(t)) {
    const completed = seedRun(store);
    const completedClaim = claimFor(store, completed, "host-1");
    runToTerminal(store, completed, "COMPLETED");

    const failed = seedRun(store);
    const failedClaim = claimFor(store, failed, "host-2");
    runToTerminal(store, failed, "FAILED");

    const interrupted = seedRun(store);
    const interruptedClaim = claimFor(store, interrupted, "host-3");
    runToTerminal(store, interrupted, "INTERRUPTED");

    const cancelled = seedRun(store);
    const cancelledClaim = claimFor(store, cancelled, "host-4");
    runToTerminal(store, cancelled, "CANCELLED");

    // A still-RUNNING run's command must NOT be touched.
    const running = seedRun(store);
    const runningCommand = seedDispatch(store, running.id, { idempotencyKey: `sweep-running-${label}` });
    store.claimDispatchCommand({ ownerId: "host-5", leaseMs: 60_000 });
    store.updateRunStatus(running.id, { status: "RUNNING" });

    // A never-claimed command on a terminal run stays PENDING (only CLAIMED moves).
    const pendingRun = seedRun(store);
    runToTerminal(store, pendingRun, "FAILED");
    const pending = seedDispatch(store, pendingRun.id, { idempotencyKey: `sweep-pending-${label}` });

    const result = store.sweepDispatchCommands({ now });
    assert.equal(result.count, 4, label);
    assert.equal(result.closed.length, 4, label);
    const byId = new Map(result.closed.map((entry) => [entry.commandId, entry]));
    assert.deepEqual(byId.get(completedClaim.command.id), {
      commandId: completedClaim.command.id,
      runId: completed.id,
      status: "DONE",
    }, label);
    for (const claim of [failedClaim, interruptedClaim, cancelledClaim]) {
      assert.equal(byId.get(claim.command.id).status, "FAILED", label);
      assert.equal(byId.get(claim.command.id).runId, claim.lease.runId, label);
    }

    // Persisted shape: result summary + completedAt from the injected now.
    const swept = commandState(store, completedClaim.command.id);
    assert.equal(swept.status, "DONE", label);
    assert.deepEqual(swept.result, { derivedFrom: "run-terminal", runStatus: "COMPLETED" }, label);
    assert.equal(swept.completedAt, now, label);
    assert.equal(commandState(store, failedClaim.command.id).status, "FAILED", label);
    assert.deepEqual(commandState(store, failedClaim.command.id).result, {
      derivedFrom: "run-terminal",
      runStatus: "FAILED",
    }, label);

    // Untouched commands: the live RUNNING command stays CLAIMED, the
    // never-claimed command stays PENDING (sweep only moves CLAIMED).
    assert.equal(commandState(store, runningCommand.id).status, "CLAIMED", label);
    assert.equal(commandState(store, pending.id).status, "PENDING", label);

    // Idempotent second sweep.
    const again = store.sweepDispatchCommands({ now });
    assert.deepEqual(again, { closed: [], count: 0 }, `${label}: second sweep is a no-op`);
    assert.equal(commandState(store, completedClaim.command.id).completedAt, now, label);

    // Argument validation.
    assert.throws(
      () => store.sweepDispatchCommands({ now: "not-a-timestamp" }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
  }
});
