// Durable dispatch commands + run leases (ATK-204 / ADR-003): idempotent
// enqueue, atomic claim semantics, generation fencing for complete/renew/events,
// and reconcile. Every scenario runs against SQLite and the in-memory store.
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

test("enqueueDispatchCommand is idempotent per idempotencyKey", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const first = seedDispatch(store, run.id, { idempotencyKey: "idem-key-1", payload: { prompt: "hi" } });
    assert.equal(first.status, "PENDING", label);
    assert.equal(first.attempts, 0, label);
    assert.equal(first.generation, 0, label);
    assert.equal(first.ownerId, null, label);
    assert.equal(first.claimedUntil, null, label);
    assert.deepEqual(first.payload, { prompt: "hi" }, label);
    assert.equal(first.commandType, "RUN_TASK", label);
    assert.equal(first.runId, run.id, label);
    assert.equal(first.taskId, "TASK-SEED", label);

    const second = seedDispatch(store, run.id, { idempotencyKey: "idem-key-1", payload: { prompt: "changed" } });
    assert.deepEqual(second, first, `${label}: same key returns the stored command, never a second row`);

    const other = seedDispatch(store, run.id, { idempotencyKey: "idem-key-2" });
    assert.notEqual(other.id, first.id, label);

    // Same key is shared across the whole command table (global uniqueness).
    const otherRun = seedRun(store);
    const sameKeyOtherRun = seedDispatch(store, otherRun.id, { idempotencyKey: "idem-key-1" });
    assert.deepEqual(sameKeyOtherRun, first, label);

    assert.throws(
      () => store.enqueueDispatchCommand({ runId: "RUN-MISSING", commandType: "RUN_TASK", payload: {}, idempotencyKey: "x" }),
      (error) => error.code === "NOT_FOUND",
      label,
    );
    for (const bad of [
      { runId: run.id, commandType: "", payload: {}, idempotencyKey: "x" },
      { runId: run.id, commandType: "RUN_TASK", payload: {}, idempotencyKey: "" },
      { runId: run.id, commandType: "RUN_TASK", payload: [1, 2], idempotencyKey: "x" },
      { runId: run.id, commandType: "RUN_TASK", payload: {}, idempotencyKey: "k".repeat(300) },
    ]) {
      assert.throws(() => store.enqueueDispatchCommand(bad), (error) => error.code === "VALIDATION_ERROR", label);
    }
  }
});

test("claimDispatchCommand returns { command, lease } once and then nothing", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    assert.equal(store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 }), null, label);

    const queued = seedDispatch(store, run.id, { idempotencyKey: `claim-${label}` });
    const claimed = store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 });
    assert.notEqual(claimed, null, label);
    assert.equal(claimed.command.id, queued.id, label);
    assert.equal(claimed.command.commandType, queued.commandType, label);
    assert.equal(claimed.command.idempotencyKey, queued.idempotencyKey, label);
    assert.equal(claimed.command.status, "CLAIMED", label);
    assert.equal(claimed.command.ownerId, "host-a", label);
    assert.equal(claimed.command.generation, 1, label);
    assert.equal(claimed.command.attempts, 1, label);
    assert.ok(!Number.isNaN(Date.parse(claimed.command.claimedUntil)), label);
    assert.equal(claimed.lease.runId, run.id, label);
    assert.equal(claimed.lease.ownerId, "host-a", label);
    assert.equal(claimed.lease.generation, 1, `${label}: first claim generation is 1`);
    assert.ok(!Number.isNaN(Date.parse(claimed.lease.claimedUntil)), `${label}: claimedUntil is an ISO string`);
    assert.ok(Date.parse(claimed.lease.claimedUntil) > Date.now(), `${label}: claimedUntil is in the future`);
    assert.ok(!Number.isNaN(Date.parse(claimed.lease.lastHeartbeatAt)), label);

    // A live claim is not handed out twice.
    assert.equal(store.claimDispatchCommand({ ownerId: "host-b", leaseMs: 60_000 }), null, label);
    assert.equal(commandState(store, queued.id).ownerId, "host-a", label);
    assert.throws(
      () => store.claimDispatchCommand({ ownerId: "", leaseMs: 1000 }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 0 }),
      (error) => error.code === "VALIDATION_ERROR",
    );
  }
});

test("a run never has two live leases: a second PENDING command waits", async (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const first = seedDispatch(store, run.id, { idempotencyKey: `two-1-${label}` });
    const second = seedDispatch(store, run.id, { idempotencyKey: `two-2-${label}` });

    const claimed = store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 30 });
    assert.equal(claimed.command.id, first.id, label);
    // The second command is PENDING, but the run already has a live holder.
    assert.equal(store.claimDispatchCommand({ ownerId: "host-b", leaseMs: 30 }), null, label);

    await sleep(60);
    // The abandoned lease expired: the *same* command is retried first (at-least
    // once delivery), with a bumped generation so the old holder is fenced out.
    const retried = store.claimDispatchCommand({ ownerId: "host-b", leaseMs: 60_000 });
    assert.equal(retried.command.id, first.id, label);
    assert.equal(retried.command.attempts, 2, label);
    assert.equal(retried.lease.generation, 2, label);
    assert.throws(
      () => store.completeDispatchCommand({ id: first.id, ownerId: "host-a", generation: 1, status: "DONE" }),
      (error) => error.code === "STALE_GENERATION",
      label,
    );

    // Once the retried command is finished, the queued follow-up command can be
    // claimed — still only one live lease for the run, generation keeps growing.
    store.completeDispatchCommand({
      id: first.id,
      ownerId: "host-b",
      generation: retried.lease.generation,
      status: "DONE",
      result: { ok: true },
    });
    const followUp = store.claimDispatchCommand({ ownerId: "host-c", leaseMs: 60_000 });
    assert.equal(followUp.command.id, second.id, label);
    assert.equal(followUp.lease.generation, 3, label);
    assert.equal(followUp.command.attempts, 1, label);
  }
});

test("an expired claim can be re-claimed; attempts and generation bump", async (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const queued = seedDispatch(store, run.id, { idempotencyKey: `expire-${label}` });
    const first = store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 10 });
    assert.equal(first.command.attempts, 1, label);
    assert.equal(first.lease.generation, 1, label);

    await sleep(30); // let the 10ms lease expire

    const second = store.claimDispatchCommand({ ownerId: "host-b", leaseMs: 60_000 });
    assert.notEqual(second, null, `${label}: expired command must be claimable again`);
    assert.equal(second.command.id, queued.id, label);
    assert.equal(second.command.attempts, 2, `${label}: attempts increments on re-claim`);
    assert.equal(second.command.generation, 2, label);
    assert.equal(second.command.ownerId, "host-b", label);
    assert.equal(second.lease.generation, 2, `${label}: lease generation is monotonic across claims`);
    assert.equal(second.lease.ownerId, "host-b", label);

    // The previous holder is fenced out by the generation bump.
    assert.throws(
      () => store.completeDispatchCommand({ id: queued.id, ownerId: "host-a", generation: 1, status: "DONE", result: {} }),
      (error) => error.code === "STALE_GENERATION",
      label,
    );
  }
});

test("completeDispatchCommand is generation-fenced and idempotent", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const queued = seedDispatch(store, run.id, { idempotencyKey: `complete-${label}` });
    const claimed = store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 });
    const eventsBefore = runEventCount(store);
    const stateBefore = commandState(store, queued.id);

    const done = store.completeDispatchCommand({
      id: queued.id,
      ownerId: "host-a",
      generation: 1,
      status: "DONE",
      result: { exitCode: 0, summary: "ok" },
    });
    assert.equal(done.status, "DONE", label);
    assert.deepEqual(done.result, { exitCode: 0, summary: "ok" }, label);
    assert.ok(typeof done.completedAt === "string", label);
    assert.equal(runEventCount(store), eventsBefore, `${label}: command result does not emit run events`);

    // Repeating the winning report is idempotent: same command, no new writes.
    const repeated = store.completeDispatchCommand({
      id: queued.id,
      ownerId: "host-a",
      generation: 1,
      status: "DONE",
      result: { exitCode: 0, summary: "ok" },
    });
    assert.deepEqual(repeated, done, label);
    assert.deepEqual(commandState(store, queued.id), done, label);

    // Stale generation (after a renew bump, simulated as generation 2) fails
    // before any write: the stored row is byte-for-byte unchanged.
    const doneSnapshot = commandState(store, queued.id);
    assert.throws(
      () => store.completeDispatchCommand({ id: queued.id, ownerId: "host-a", generation: 2, status: "DONE" }),
      (error) => error.code === "STALE_GENERATION" && error.details.commandId === queued.id,
      label,
    );
    assert.throws(
      () => store.completeDispatchCommand({ id: queued.id, ownerId: "host-b", generation: 1, status: "DONE" }),
      (error) => error.code === "STALE_GENERATION",
      label,
    );
    assert.deepEqual(commandState(store, queued.id), doneSnapshot, `${label}: stale report changed the row`);
    assert.notDeepEqual(stateBefore.status, "DONE", label);

    // Payload / state validation.
    assert.throws(
      () => store.completeDispatchCommand({ id: queued.id, ownerId: "host-a", generation: 1, status: "CANCELLED" }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => store.completeDispatchCommand({ id: "CMD-MISSING", ownerId: "host-a", generation: 1, status: "DONE" }),
      (error) => error.code === "NOT_FOUND",
    );

    // FAILED keeps its error summary in result_json.
    const run2 = seedRun(store);
    const queued2 = seedDispatch(store, run2.id, { idempotencyKey: `failed-${label}` });
    store.claimDispatchCommand({ ownerId: "host-c", leaseMs: 60_000 });
    const failed = store.completeDispatchCommand({
      id: queued2.id,
      ownerId: "host-c",
      generation: 1,
      status: "FAILED",
      result: { error: { code: "SPAWN_FAILED", message: "runtime failed to start" } },
    });
    assert.equal(failed.status, "FAILED", label);
    assert.equal(failed.result.error.code, "SPAWN_FAILED", label);
    assert.ok(typeof failed.completedAt === "string", label);

    // A command that was never claimed cannot be completed.
    const run3 = seedRun(store);
    const queued3 = seedDispatch(store, run3.id, { idempotencyKey: `pending-${label}` });
    const pendingSnapshot = commandState(store, queued3.id);
    assert.throws(
      () => store.completeDispatchCommand({ id: queued3.id, ownerId: "host-a", generation: 1, status: "DONE" }),
      (error) => error.code === "STALE_GENERATION" && error.details.reason === "command-not-claimed",
    );
    assert.deepEqual(commandState(store, queued3.id), pendingSnapshot, label);
    assert.equal(claimed.command.id, queued.id, label);
  }
});

test("renewRunLease advances generation and keeps complete/append fenced", async (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const queued = seedDispatch(store, run.id, { idempotencyKey: `renew-${label}` });
    store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 });
    const firstLease = store.reconcileRun({ runId: run.id }).lease;

    const renewed = store.renewRunLease({ runId: run.id, ownerId: "host-a", generation: 1, leaseMs: 120_000 });
    assert.equal(renewed.generation, 2, `${label}: renewal increments generation`);
    assert.equal(renewed.ownerId, "host-a", label);
    assert.ok(Date.parse(renewed.claimedUntil) > Date.parse(firstLease.claimedUntil), label);
    assert.ok(Date.parse(renewed.lastHeartbeatAt) >= Date.parse(firstLease.lastHeartbeatAt), label);
    assert.equal(commandState(store, queued.id).generation, 2, `${label}: command follows the lease generation`);

    // Old generation is fenced out for every reporting path.
    const snapshot = commandState(store, queued.id);
    const eventsBefore = runEventCount(store);
    assert.throws(
      () => store.completeDispatchCommand({ id: queued.id, ownerId: "host-a", generation: 1, status: "DONE" }),
      (error) => error.code === "STALE_GENERATION",
      label,
    );
    assert.throws(
      () => store.renewRunLease({ runId: run.id, ownerId: "host-a", generation: 1, leaseMs: 10_000 }),
      (error) => error.code === "STALE_GENERATION" && error.details.reason === "generation-mismatch",
      label,
    );
    assert.throws(
      () => store.appendRunEvent({ runId: run.id, generation: 1, events: [{ type: "run.log", payload: {} }] }),
      (error) => error.code === "STALE_GENERATION",
      label,
    );
    assert.deepEqual(commandState(store, queued.id), snapshot, `${label}: stale calls mutated the command`);
    assert.equal(runEventCount(store), eventsBefore, `${label}: stale calls wrote events`);

    // The current generation still works.
    const done = store.completeDispatchCommand({
      id: queued.id,
      ownerId: "host-a",
      generation: 2,
      status: "DONE",
      result: { ok: true },
    });
    assert.equal(done.status, "DONE", label);

    // Wrong holder / missing lease / expired lease are all STALE_GENERATION.
    const run2 = seedRun(store);
    seedDispatch(store, run2.id, { idempotencyKey: `renew2-${label}` });
    store.claimDispatchCommand({ ownerId: "host-b", leaseMs: 10 });
    await sleep(30);
    assert.throws(
      () => store.renewRunLease({ runId: run2.id, ownerId: "host-b", generation: 1, leaseMs: 1000 }),
      (error) => error.code === "STALE_GENERATION" && error.details.reason === "lease-expired",
      label,
    );
    const neverClaimed = seedRun(store);
    assert.throws(
      () => store.renewRunLease({ runId: neverClaimed.id, ownerId: "host-b", generation: 1, leaseMs: 1000 }),
      (error) => error.code === "STALE_GENERATION" && error.details.reason === "lease-missing",
      label,
    );
  }
});

test("appendRunEvent writes fenced runtime events without touching the Run", async (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const queued = seedDispatch(store, run.id, { idempotencyKey: `events-${label}` });
    store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 });
    const runBefore = store.getRun(run.id);

    const events = store.appendRunEvent({
      runId: run.id,
      generation: 1,
      events: [
        { type: "run.log", payload: { sessionId: "s-1", stream: "stdout", text: "hello" } },
        { type: "run.updated", payload: { note: "state hint only" } },
      ],
    });
    assert.equal(events.length, 2, label);
    assert.ok(events[1].seq > events[0].seq, label);
    for (const event of events) {
      assert.equal(event.aggregateType, "run", label);
      assert.equal(event.aggregateId, run.id, label);
      assert.equal(event.projectId, "proj-1", label);
      assert.equal(event.schemaVersion, 1, label);
    }
    assert.deepEqual(events[0].payload, { sessionId: "s-1", stream: "stdout", text: "hello" }, label);
    assert.equal(events[1].type, "run.updated", label);

    // appendRunEvent never advances the Run (Backend owns updateRunStatus).
    assert.deepEqual(store.getRun(run.id), runBefore, label);
    assert.deepEqual(
      store.listEvents({ projectId: "proj-1", afterSeq: 0, limit: 1000 }).filter((event) => event.aggregateId === run.id).map((event) => event.type),
      ["run.created", "run.log", "run.updated"],
      label,
    );

    // Unknown event types are rejected, not dropped.
    const before = runEventCount(store);
    assert.throws(
      () => store.appendRunEvent({ runId: run.id, generation: 1, events: [{ type: "run.exploded", payload: {} }] }),
      (error) => error.code === "VALIDATION_ERROR" && error.details.type === "run.exploded",
      label,
    );
    const badBatch = [
      { type: "run.log", payload: {} },
      { type: "run.log", payload: [1] },
    ];
    assert.throws(
      () => store.appendRunEvent({ runId: run.id, generation: 1, events: badBatch }),
      (error) => error.code === "VALIDATION_ERROR",
      label,
    );
    assert.equal(runEventCount(store), before, `${label}: rejected batches must not write partial events`);

    // An empty batch is a valid *pure fence*: it validates the generation and
    // writes nothing (lets Backend order "fence -> updateRunStatus").
    assert.deepEqual(store.appendRunEvent({ runId: run.id, generation: 1, events: [] }), [], label);
    assert.equal(runEventCount(store), before, label);
    assert.throws(
      () => store.appendRunEvent({ runId: run.id, generation: 1, events: "not-an-array" }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => store.appendRunEvent({ runId: run.id, generation: 2, events: [] }),
      (error) => error.code === "STALE_GENERATION",
      label,
    );

    // After the lease expires even the right generation is fenced out.
    const run2 = seedRun(store);
    seedDispatch(store, run2.id, { idempotencyKey: `events2-${label}` });
    store.claimDispatchCommand({ ownerId: "host-b", leaseMs: 10 });
    await sleep(30);
    const expiredBefore = runEventCount(store);
    assert.throws(
      () => store.appendRunEvent({ runId: run2.id, generation: 1, events: [{ type: "run.log", payload: {} }] }),
      (error) => error.code === "STALE_GENERATION" && error.details.reason === "lease-expired",
      label,
    );
    assert.equal(runEventCount(store), expiredBefore, label);
    assert.equal(commandState(store, queued.id).status, "CLAIMED", label);
  }
});

test("reconcileRun reports run, lease and (empty) sessions", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store);
    const beforeClaim = store.reconcileRun({ runId: run.id });
    assert.equal(beforeClaim.run.id, run.id, label);
    assert.equal(beforeClaim.run.status, "STARTING", label);
    assert.equal(beforeClaim.lease, null, label);
    assert.deepEqual(beforeClaim.sessions, [], label);

    seedDispatch(store, run.id, { idempotencyKey: `reconcile-${label}` });
    store.claimDispatchCommand({ ownerId: "host-a", leaseMs: 60_000 });
    const afterClaim = store.reconcileRun({ runId: run.id });
    assert.equal(afterClaim.lease.ownerId, "host-a", label);
    assert.equal(afterClaim.lease.generation, 1, label);
    assert.equal(afterClaim.run.status, "STARTING", label);
    assert.deepEqual(afterClaim.sessions, [], label);

    assert.throws(
      () => store.reconcileRun({ runId: "RUN-MISSING" }),
      (error) => error.code === "NOT_FOUND",
      label,
    );
  }
});

test("end-to-end run facts: create → enqueue → claim → events → COMPLETED → result", (t) => {
  for (const { label, store } of bothStores(t)) {
    const run = seedRun(store, { workspaceId: "ws-e2e" });
    const command = seedDispatch(store, run.id, { idempotencyKey: `e2e-${label}` });
    const claimed = store.claimDispatchCommand({ ownerId: "host-e2e", leaseMs: 60_000 });
    assert.equal(claimed.command.id, command.id, label);

    store.appendRunEvent({
      runId: run.id,
      generation: claimed.lease.generation,
      events: [{ type: "run.log", payload: { sessionId: "s-e2e", level: "info", message: "started" } }],
    });
    const running = store.updateRunStatus(run.id, { status: "RUNNING" });
    assert.equal(running.status, "RUNNING", label);
    assert.equal(running.version, 1, label);

    const completed = store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    assert.equal(completed.status, "COMPLETED", label);
    assert.equal(completed.version, 2, label);
    assert.equal(completed.exitCode, 0, label);

    const doneCommand = store.completeDispatchCommand({
      id: command.id,
      ownerId: "host-e2e",
      generation: claimed.lease.generation,
      status: "DONE",
      result: { exitCode: 0 },
    });
    assert.equal(doneCommand.status, "DONE", label);

    const reconciled = store.reconcileRun({ runId: run.id });
    assert.equal(reconciled.run.status, "COMPLETED", label);
    assert.equal(reconciled.run.version, 2, label);
    assert.notEqual(reconciled.lease, null, label);
    // Lead-approved semantics: "release" = expire, never delete. The lease is
    // reported as expired but its monotonic generation survives so a later
    // claim of the same run fences out the finished holder.
    assert.equal(reconciled.lease.generation, claimed.lease.generation, label);
    assert.ok(Date.parse(reconciled.lease.claimedUntil) <= Date.now(), label);

    const types = store
      .listEvents({ projectId: "proj-1", limit: 1000 })
      .filter((event) => event.aggregateId === run.id)
      .map((event) => event.type);
    assert.deepEqual(types, ["run.created", "run.log", "run.updated", "run.updated"], label);
    const overview = store.overview("proj-1");
    assert.equal(overview.counts.runsRunning, 0, label);
    assert.equal(overview.counts.runsTotal, 1, label);
  }
});

