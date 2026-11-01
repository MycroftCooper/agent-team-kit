// Claim atomicity for real, not by sequential calls:
//  * two worker threads (two SQLite connections / two hosts) claim concurrently
//    and exactly one may win;
//  * a second store connection on the same file cannot steal a live claim;
//  * an expired claim is re-claimable by a different owner with attempts+1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { projectDto, seedDispatch, seedRun, sleep, taskDto, useStore } from "./helpers.mjs";

const WORKER_URL = new URL("./claim-worker.mjs", import.meta.url);

function startClaimWorker(workerData) {
  const worker = new Worker(WORKER_URL, { workerData });
  const ready = new Promise((resolve, reject) => {
    worker.once("message", (message) => {
      if (message.ready) resolve();
      else reject(new Error(`worker did not report ready: ${JSON.stringify(message)}`));
    });
    worker.once("error", reject);
  });
  const finished = new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.ready) return;
      resolve(message);
    });
    worker.on("error", reject);
  });
  return { worker, ready, finished };
}

test("two concurrent claimers: exactly one wins the same command", async (t) => {
  const { store, file } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1", { id: "TASK-ATOMIC" }));
  const run = store.createRun({ taskId: "TASK-ATOMIC", agentId: "agent-dev-01", function: "WORKER", role: "DEV" });
  const command = seedDispatch(store, run.id, { idempotencyKey: "atomic-1" });

  const barrier = new SharedArrayBuffer(4);
  const workers = [
    startClaimWorker({ file, ownerId: "host-a", barrier, leaseMs: 60_000 }),
    startClaimWorker({ file, ownerId: "host-b", barrier, leaseMs: 60_000 }),
  ];
  await Promise.all(workers.map((entry) => entry.ready));
  // Release both workers at the same instant.
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);

  const outcomes = await Promise.all(workers.map((entry) => entry.finished));
  for (const entry of workers) entry.worker.terminate();

  const errors = outcomes.filter((outcome) => outcome.error !== undefined);
  assert.deepEqual(errors, [], "no worker may crash");
  const results = outcomes.map((outcome) => outcome.result);
  const winners = results.filter((result) => result !== null);
  assert.equal(winners.length, 1, `exactly one claimer must win, got ${JSON.stringify(results)}`);
  assert.equal(results.filter((result) => result === null).length, 1);
  const winner = winners[0];
  assert.equal(winner.commandId, command.id);
  assert.equal(winner.commandStatus, "CLAIMED");
  assert.equal(winner.attempts, 1);
  assert.equal(winner.generation, 1);
  assert.equal(winner.commandOwnerId, winner.leaseOwnerId);

  // The database agrees with the winner and cannot hand the command out again.
  const reconciled = store.reconcileRun({ runId: run.id });
  assert.equal(reconciled.lease.generation, 1);
  assert.equal(reconciled.lease.ownerId, winner.leaseOwnerId);
  assert.equal(store.claimDispatchCommand({ ownerId: "host-c", leaseMs: 60_000 }), null);
});

test("a second store connection cannot steal a live claim", async (t) => {
  const { store, file, open } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1", { id: "TASK-CONN" }));
  const run = store.createRun({ taskId: "TASK-CONN", agentId: "agent-dev-01", function: "WORKER", role: "DEV" });
  seedDispatch(store, run.id, { idempotencyKey: "conn-1" });

  const other = open();
  const first = store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 });
  assert.notEqual(first, null);
  assert.equal(other.claimDispatchCommand({ ownerId: "host-b", leaseMs: 60_000 }), null);

  // Expired across connections: the other connection can re-claim.
  const run2 = store.createRun({ taskId: "TASK-CONN", agentId: "agent-dev-01", function: "WORKER", role: "DEV" });
  const queued2 = seedDispatch(store, run2.id, { idempotencyKey: "conn-2" });
  const ownerA = store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 10 });
  assert.equal(ownerA.command.id, queued2.id);
  assert.equal(ownerA.command.attempts, 1);
  await sleep(30);
  const ownerB = other.claimDispatchCommand({ ownerId: "host-b", leaseMs: 60_000 });
  assert.notEqual(ownerB, null);
  assert.equal(ownerB.command.id, queued2.id);
  assert.equal(ownerB.command.attempts, 2);
  assert.equal(ownerB.lease.generation, 2);
  assert.equal(ownerB.lease.ownerId, "host-b");
});
