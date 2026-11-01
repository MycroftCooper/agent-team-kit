// QA-003 MAJOR-1: an expired lease must fence BOTH updateRunStatus and
// completeDispatchCommand (matching generation is not enough: a slow/partitioned
// Host must not finish a Run that another Host may re-claim).
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERNAL } from "../src/internal.mjs";
import { bothStores, seedDispatch, seedRun, sleep } from "./helpers.mjs";

function commandState(store, id) {
  return store[INTERNAL].getDispatchCommand(id);
}

function runEventCount(store) {
  return store.listEvents({ projectId: "proj-1", limit: 1000 }).length;
}

test("an expired lease fences updateRunStatus and completeDispatchCommand", async (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const queued = seedDispatch(store, run.id, { idempotencyKey: `expiry-${label}` });
    const claimed = store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 10 });
    assert.equal(claimed.lease.generation, 1, label);
    await sleep(40); // lease expired, nobody reclaimed it (generation still 1)

    const runBefore = store.getRun(run.id);
    const commandBefore = commandState(store, queued.id);
    const eventsBefore = runEventCount(store);

    // Fenced state update: matching generation, expired lease.
    assert.throws(
      () => store.updateRunStatus(run.id, { status: "RUNNING", generation: 1 }),
      (error) =>
        error.code === "STALE_GENERATION" &&
        error.details.reason === "lease-expired" &&
        error.details.generation === 1 &&
        error.details.currentGeneration === 1 &&
        error.details.runId === run.id,
      `${label}: updateRunStatus on an expired lease`,
    );
    assert.deepEqual(store.getRun(run.id), runBefore, `${label}: run changed on stale state report`);
    assert.equal(runEventCount(store), eventsBefore, `${label}: stale state report wrote events`);

    // Fenced result write: matching generation, expired lease.
    assert.throws(
      () => store.completeDispatchCommand({ id: queued.id, ownerId: "host-a", generation: 1, status: "DONE", result: {} }),
      (error) =>
        error.code === "STALE_GENERATION" &&
        error.details.reason === "lease-expired" &&
        error.details.commandId === queued.id &&
        error.details.generation === 1 &&
        error.details.currentGeneration === 1,
      `${label}: complete on an expired lease`,
    );
    assert.deepEqual(commandState(store, queued.id), commandBefore, `${label}: command changed on stale result`);
    assert.equal(runEventCount(store), eventsBefore, label);

    // Recovery path: the expired command is re-claimed with a bumped generation,
    // and the *current* holder can finish both the state and the command.
    const reclaimed = store.claimDispatchCommand({ ownerId: "host-b", leaseMs: 60_000 });
    assert.equal(reclaimed.command.id, queued.id, label);
    assert.equal(reclaimed.command.attempts, 2, label);
    assert.equal(reclaimed.lease.generation, 2, label);
    assert.equal(store.updateRunStatus(run.id, { status: "RUNNING", generation: 2 }).status, "RUNNING", label);
    const done = store.completeDispatchCommand({
      id: queued.id,
      ownerId: "host-b",
      generation: 2,
      status: "DONE",
      result: { exitCode: 0 },
    });
    assert.equal(done.status, "DONE", label);

    // Successful completion expires the lease itself, but a repeat of the
    // winning report is still an idempotent success (terminal branch first).
    const repeated = store.completeDispatchCommand({
      id: queued.id,
      ownerId: "host-b",
      generation: 2,
      status: "DONE",
      result: { exitCode: 0 },
    });
    assert.deepEqual(repeated, done, `${label}: repeat after expiry must stay idempotent`);
  }
});
