// M6.2 WP1: F05 (frozen execution spec on dispatch) + F10 (runtime heartbeat).
// Stage A: these tests are expected to be RED against the pre-M6.2 backend.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { validateTaskExecutionSpec } from "@atk/contracts";

import { internalHeaders, readHeaders, request, startServer } from "./helpers.mjs";

async function openRealStore(t, prefix) {
  const { openStore } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "..", "..", "packages", "database", "src", "index.mjs")).href
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "atk.db");
  const store = openStore({ file, migrate: true });
  store.createProject({ id: "P-1", name: "P", repoPath: ".", defaultBranch: "main" });
  const task = store.createTask({
    id: "T-1",
    projectId: "P-1",
    title: "Spec task",
    description: "do the thing",
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority: 2,
    deps: [],
    acceptance: "it works",
  });
  store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
  const ctx = await startServer({ store });
  t.after(async () => {
    await ctx.server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { store, task, ctx, file };
}

function claimBody(task, overrides = {}) {
  return { agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: `m62-${task.id}`, ...overrides };
}

test("F05: claim response carries a validated frozen spec, and later Task edits do not change it", async (t) => {
  const { store, task, ctx, file } = await openRealStore(t, "atk-m62-f05-");
  const claimed = await request(ctx.base, {
    method: "POST",
    path: `/internal/v1/tasks/${task.id}/claim`,
    headers: internalHeaders(undefined, "scheduler"),
    body: claimBody(task),
  });
  assert.equal(claimed.status, 200, claimed.text);
  const payload = claimed.json.command ?? claimed.json;
  assert.equal(typeof payload.specHash, "string", `claim response must carry specHash: ${claimed.text}`);
  assert.ok(payload.spec, `claim response must carry spec: ${claimed.text}`);
  assert.deepEqual(validateTaskExecutionSpec(payload.spec), { ok: true, errors: [] });

  const runId = claimed.json.run?.id;
  assert.ok(runId, "claim must return the Run");
  const frozen = store.getRunSpec(runId);
  assert.equal(frozen.specHash, payload.specHash);
  assert.deepEqual(frozen.spec, payload.spec);

  // Idempotent replay must NOT freeze again (no pending NULL-run spec row) and
  // must serve the Run-bound spec.
  const { DatabaseSync } = await import("node:sqlite");
  const pendingSpecRows = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return Number(db.prepare("SELECT COUNT(*) AS count FROM run_specs WHERE run_id IS NULL").get().count);
    } finally {
      db.close();
    }
  };
  assert.equal(pendingSpecRows(), 0);
  const replayed = await request(ctx.base, {
    method: "POST",
    path: `/internal/v1/tasks/${task.id}/claim`,
    headers: internalHeaders(undefined, "scheduler"),
    body: claimBody(task),
  });
  assert.equal(replayed.status, 200, replayed.text);
  assert.equal(replayed.json.command.specHash, payload.specHash);
  assert.equal(pendingSpecRows(), 0, "an idempotent replay must not leave a pending spec row");

  // Editing the live Task after dispatch must not mutate the frozen spec.
  const live = store.getTask(task.id);
  store.patchTask(task.id, { expectedVersion: live.version, changes: { title: "Edited after dispatch" } });
  assert.deepEqual(store.getRunSpec(runId).spec, payload.spec, "the Run keeps executing the spec it was dispatched with");
});

test("F05: a dispatch without a frozen spec fails 500 instead of sending a partial command", async (t) => {
  const { store, task, ctx } = await openRealStore(t, "atk-m62-f05-missing-");
  const originalClaim = store.claimTask;
  // A store bug that returns a Run without a bound spec must never leak out as
  // a usable dispatch command.
  store.claimTask = () => ({
    run: { id: "RUN-WITHOUT-SPEC", taskId: task.id, agentId: "agent-1", status: "STARTING", version: 0 },
    command: { id: "CMD-WITHOUT-SPEC", runId: "RUN-WITHOUT-SPEC", taskId: task.id, commandType: "RUN_TASK", payload: {}, status: "PENDING" },
    task: store.getTask(task.id),
  });
  t.after(() => {
    store.claimTask = originalClaim;
  });
  const claimed = await request(ctx.base, {
    method: "POST",
    path: `/internal/v1/tasks/${task.id}/claim`,
    headers: internalHeaders(undefined, "scheduler"),
    body: claimBody(task),
  });
  assert.equal(claimed.status, 500, `no spec means no dispatch: ${claimed.text}`);
  assert.equal(claimed.json.command, undefined, "a 500 must not include a partial command");
});

test("F10: heartbeat validates fields and records availability", async (t) => {
  const { store, ctx } = await openRealStore(t, "atk-m62-f10-");
  const heartbeat = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/runtime/heartbeat",
    headers: internalHeaders(undefined, "runtime-host"),
    body: { hostId: "host-1", agentIds: ["agent-1"], capacity: 2 },
  });
  assert.equal(heartbeat.status, 200, heartbeat.text);
  assert.equal(typeof heartbeat.json.at, "string");
  assert.ok(Array.isArray(heartbeat.json.agents), "response must list the host's agents");
  const availability = store.agentAvailability({ agentId: "agent-1", now: heartbeat.json.at });
  assert.equal(availability.available, true, JSON.stringify(availability));

  const invalidField = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/runtime/heartbeat",
    headers: internalHeaders(undefined, "runtime-host"),
    body: { hostId: "host-1", agentIds: "agent-1", capacity: 2 },
  });
  assert.equal(invalidField.status, 400, invalidField.text);
  assert.equal(invalidField.json.error.details.field, "agentIds");

  const wrongRole = await request(ctx.base, {
    method: "POST",
    path: "/internal/v1/runtime/heartbeat",
    headers: internalHeaders(undefined, "scheduler"),
    body: { hostId: "host-1", agentIds: ["agent-1"], capacity: 2 },
  });
  assert.equal(wrongRole.status, 403, wrongRole.text);
});

test("F04: claim pins the workspace on the Run and in the frozen spec", async (t) => {
  const { store, task, ctx, file } = await openRealStore(t, "atk-m62-f04-");
  const claimed = await request(ctx.base, {
    method: "POST",
    path: `/internal/v1/tasks/${task.id}/claim`,
    headers: internalHeaders(undefined, "scheduler"),
    body: claimBody(task),
  });
  assert.equal(claimed.status, 200, claimed.text);
  const payload = claimed.json.command ?? claimed.json;
  const run = claimed.json.run;
  assert.ok(run?.id, "claim response must carry the Run (runId)");
  assert.ok(run.workspace, `claim response must carry run.workspace: ${claimed.text}`);
  assert.deepEqual(run.workspace, payload.spec.workspace, "run.workspace is the authoritative cwd and must match the spec");
  assert.equal(run.specHash, payload.specHash);
  // This project is not a git repository, so the mock workspace is kind "none".
  assert.equal(run.workspace.kind, "none");
  // And the workspace is persisted on the run record, not only in the response.
  const storedRun = store.getRun(run.id);
  assert.deepEqual(storedRun.workspace, run.workspace);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT workspace_path FROM runs WHERE id = ?").get(run.id);
    assert.equal(row.workspace_path, run.workspace.path);
  } finally {
    db.close();
  }

  // Worktree case: the workspace path is generated by the store under the
  // caller-provided root and must be identical in run.workspace and spec.workspace.
  const second = store.createTask({
    id: "T-2",
    projectId: "P-1",
    title: "Worktree task",
    description: "isolated",
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority: 2,
    deps: [],
    acceptance: "isolated",
  });
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "atk-m62-worktrees-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const worktreeClaim = await request(ctx.base, {
    method: "POST",
    path: `/internal/v1/tasks/${second.id}/claim`,
    headers: internalHeaders(undefined, "scheduler"),
    body: {
      ...claimBody(second),
      workspace: { kind: "worktree", root: workspaceRoot, baseCommit: "0".repeat(40), targetBranch: null },
    },
  });
  assert.equal(worktreeClaim.status, 200, worktreeClaim.text);
  const worktreeRun = worktreeClaim.json.run;
  const worktreeCommand = worktreeClaim.json.command;
  assert.equal(worktreeRun.workspace.kind, "worktree");
  assert.ok(worktreeRun.workspace.path, worktreeClaim.text);
  assert.ok(
    path.resolve(worktreeRun.workspace.path).startsWith(path.resolve(workspaceRoot)),
    `worktree path ${worktreeRun.workspace.path} must live under ${workspaceRoot}`,
  );
  assert.deepEqual(worktreeRun.workspace, worktreeCommand.payload.spec.workspace);
  assert.deepEqual(worktreeRun.workspace, worktreeCommand.spec.workspace);
  assert.equal(worktreeRun.specHash, worktreeCommand.specHash);
  assert.deepEqual(store.getRun(worktreeRun.id).workspace, worktreeRun.workspace);
});
