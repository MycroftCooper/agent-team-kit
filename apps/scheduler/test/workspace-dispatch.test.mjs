// m6.3: the derived workspace policy must reach the claim the Scheduler sends,
// otherwise the Run is created as `none` and a real Host rejects it
// (WORKSPACE_REQUIRED) — the exact m5-smoke timeout this covers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planDispatch } from "@atk/scheduler-core";
import { createScheduler } from "../src/index.mjs";
import { deriveWorkspacePolicy } from "../src/workspace-policy.mjs";

const NOW_ISO = "2026-01-01T00:10:00.000Z";

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 20000 });
}

function tempGitRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-ws-dispatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const init = git(["init", "-q", "-b", "main"], dir);
  if (init.status !== 0) {
    t.skip("git is not available");
    return null;
  }
  git(["config", "user.email", "m63@example.invalid"], dir);
  git(["config", "user.name", "M63"], dir);
  spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "a.txt"))}, "a\\n")`], { encoding: "utf8" });
  git(["add", "-A"], dir);
  git(["commit", "-qm", "base"], dir);
  return { dir, head: git(["rev-parse", "HEAD"], dir).stdout.trim() };
}

function snapshotValue() {
  return {
    version: 1,
    generatedAt: NOW_ISO,
    projects: [{ id: "P-1", policy: null }],
    tasks: [
      {
        id: "T-1",
        projectId: "P-1",
        status: "READY",
        version: 1,
        priority: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        roleRequired: "DEV",
        functionRequired: "WORKER",
        deps: [],
        files: [],
      },
    ],
    agents: [
      {
        id: "agent-dev-1",
        role: "DEV",
        capabilities: ["WORKER"],
        status: "IDLE",
        version: 1,
        capacity: 1,
        lastHeartbeatAt: NOW_ISO,
      },
    ],
    runs: [],
    leases: [],
  };
}

function fakeClient(snapshot) {
  const claims = [];
  return {
    claims,
    async snapshot() {
      return snapshot;
    },
    async claim(taskId, body) {
      claims.push({ taskId, body });
      return { run: { id: "run-1" } };
    },
    async heartbeat() {
      return { ok: true };
    },
  };
}

function makeScheduler(t, client, policies) {
  const scheduler = createScheduler({
    client,
    core: { planDispatch },
    policies,
    ownerId: "scheduler-1",
    logger: { info() {}, warn() {}, error() {} },
    now: () => new Date(NOW_ISO),
  });
  t.after(() => scheduler.stop());
  return scheduler;
}

test("a git-backed project claims with a worktree policy carrying baseCommit", async (t) => {
  const repo = tempGitRepo(t);
  if (!repo) return;
  const worktreeRoot = path.join(path.dirname(repo.dir), `wt-${process.pid}`);
  const workspace = deriveWorkspacePolicy({ repoPath: repo.dir, worktreeRoot });
  assert.equal(workspace.policy.kind, "worktree");

  const client = fakeClient(snapshotValue());
  const scheduler = makeScheduler(t, client, { maxConcurrentPerProject: 4, maxPerAgent: 1, workspacePolicy: workspace.policy });
  const result = await scheduler.runOnce();

  assert.equal(result.ok, true);
  assert.equal(client.claims.length, 1);
  assert.deepEqual(client.claims[0].body.workspacePolicy, { kind: "worktree", root: path.resolve(worktreeRoot), baseCommit: repo.head });
  assert.match(client.claims[0].body.workspacePolicy.baseCommit, /^[0-9a-f]{40}$/);
});

test("a non-git project claims with none (never an incomplete worktree)", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-ws-plain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = deriveWorkspacePolicy({ repoPath: dir });
  assert.equal(workspace.policy.kind, "none");

  const client = fakeClient(snapshotValue());
  const scheduler = makeScheduler(t, client, { maxConcurrentPerProject: 4, maxPerAgent: 1, workspacePolicy: workspace.policy });
  const result = await scheduler.runOnce();

  assert.equal(result.ok, true);
  assert.deepEqual(client.claims[0].body.workspacePolicy, { kind: "none" });
});
