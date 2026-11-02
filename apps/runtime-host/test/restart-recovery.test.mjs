// QA-05.7: cross-process restart after a worktree Run.
//
// A real child Host process claims a worktree Run and is then killed (SIGKILL).
// The new Host must reuse the persisted recovery file (never a second state
// file), report the expired-lease Run as INTERRUPTED/manual instead of silently
// executing it again, and leave the worktree + uncommitted files untouched.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMockRuntime } from "@atk/runtime-sdk/mock";
import { createTaskExecutionSpec } from "../../../packages/contracts/src/execution-spec.mjs";
import { ensureWorktree, worktreeStatus } from "../../../packages/workspace/src/index.mjs";
import { createHost } from "../src/host.mjs";

const WORKER = fileURLToPath(new URL("./fixtures/restart-worker.mjs", import.meta.url));

function quietLogger() {
  const lines = [];
  return { lines, info: () => {}, warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-host-restart-"));
  const repo = path.join(root, "repo");
  git(["init", "-q", "-b", "main", repo], root);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "init"], repo);
  return { root, repo, baseCommit: git(["rev-parse", "HEAD"], repo), worktrees: path.join(root, "worktrees") };
}

function specFor({ repoPath, workspace }) {
  return createTaskExecutionSpec({
    task: {
      id: "TASK-RESTART",
      version: 4,
      title: "Restart me",
      description: "A worktree Run that must survive a host crash.",
      acceptance: "green",
      files: ["src/restart.js"],
      deps: [],
      functionRequired: "DEV",
      roleRequired: "DEVELOPER",
    },
    project: { id: "proj-restart", name: "Restart", repoPath, defaultBranch: "main" },
    workspace,
    frozenAt: "2026-01-01T00:00:00.000Z",
  });
}

function claimOf({ repoPath, workspace }) {
  return {
    command: { id: "CMD-RESTART", runId: "run-restart", commandType: "RUN_TASK", attempts: 1, payload: { spec: specFor({ repoPath, workspace }) } },
    run: { id: "run-restart", taskId: "TASK-RESTART", status: "STARTING", workspace },
    lease: { ownerId: "host-crashed", generation: 9, claimedUntil: new Date(Date.now() - 1000).toISOString() },
  };
}

function fakeClient({ claims = [] } = {}) {
  const calls = { claim: 0, result: [], events: [], reconcile: [] };
  const queue = [...claims];
  return {
    calls,
    claim() {
      calls.claim += 1;
      return Promise.resolve(queue.length ? queue.shift() : null);
    },
    events(runId, body) {
      calls.events.push({ runId, ...body });
      return Promise.resolve({ appended: body.events, skipped: 0 });
    },
    renew(runId, body) {
      return Promise.resolve({ lease: { ...body, generation: body.generation + 1 } });
    },
    heartbeat() {
      return Promise.resolve({ ok: true });
    },
    result(commandId, body) {
      calls.result.push({ commandId, ...body });
      return Promise.resolve({ persisted: true });
    },
    reconcile(runId) {
      calls.reconcile.push(runId);
      return Promise.resolve({
        run: { id: runId, status: "RUNNING" },
        lease: { ownerId: "host-crashed", generation: 9, claimedUntil: new Date(Date.now() - 1000).toISOString() },
        command: { id: "CMD-RESTART", status: "CLAIMED" },
        sessions: [{ sessionId: "session-crashed", status: "running" }],
      });
    },
  };
}

function captureRuntime() {
  const base = createMockRuntime({ scenario: "complete", sessionIdFactory: () => "new-session" });
  const starts = [];
  return {
    starts,
    runtime: {
      ...base,
      start: async (input) => {
        starts.push(input);
        return base.start(input);
      },
      stop: base.stop.bind(base),
      subscribe: base.subscribe.bind(base),
      probe: base.probe.bind(base),
      capabilities: base.capabilities.bind(base),
    },
  };
}

function waitFor(predicate, timeoutMs = 10000, label = "condition") {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        return reject(error);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit after kill")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function killHard(child) {
  const exited = waitExit(child);
  child.kill("SIGKILL");
  try {
    return await exited;
  } catch {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    return exited;
  }
}

test("QA-05.7: a killed Host leaves its worktree intact; the new Host reports the expired lease and never starts the Run twice", async () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  const dir = path.join(root, "host-state");
  const worktreePath = path.join(worktrees, "proj-restart", "run-restart");
  const workspace = { kind: "worktree", path: worktreePath, baseCommit, targetBranch: "atk/run/run-restart" };
  let child;
  try {
    child = spawn(process.execPath, [WORKER, dir, repo, baseCommit, worktreePath], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const stateFile = path.join(dir, "host.json");
    const persisted = await waitFor(() => {
      if (!existsSync(stateFile)) return null;
      const records = JSON.parse(readFileSync(stateFile, "utf8"));
      return records.find((record) => record.runId === "run-restart") ?? null;
    }, 10000, "child recovery record");
    assert.equal(persisted.runId, "run-restart");
    await waitFor(() => existsSync(path.join(worktreePath, "uncommitted.txt")), 10000, "child worktree write");
    assert.ok(existsSync(WORKER), "worker fixture exists");

    const killed = await killHard(child);
    child = null;
    assert.ok(killed.signal || killed.code !== null, `child should be killed, got ${JSON.stringify(killed)}`);
    assert.equal(readFileSync(path.join(dir, "child-starts.txt"), "utf8"), "1", "the killed Host started exactly one session");

    // New Host: same persisted state file/outbox, no second recovery file.
    const client = fakeClient();
    const { runtime, starts } = captureRuntime();
    const host = createHost({
      client,
      runtime,
      ownerId: "host-new",
      pollMs: 1000,
      flushMs: 5,
      heartbeatMs: 1000,
      stateFile,
      outboxFile: path.join(dir, "host.outbox.json"),
      logger: quietLogger(),
    });
    const summary = await host.recover();
    assert.ok(summary.interrupted.some((entry) => entry.runId === "run-restart"), `recover must report the expired-lease Run: ${JSON.stringify(summary)}`);
    assert.equal(summary.worktreeMissing.length, 0);
    const worktreeEntry = summary.worktrees.find((entry) => entry.runId === "run-restart");
    assert.ok(worktreeEntry, `recover must report the preserved worktree: ${JSON.stringify(summary.worktrees)}`);
    assert.equal(path.resolve(worktreeEntry.path), path.resolve(worktreePath));
    assert.equal(worktreeEntry.branch, "atk/run/run-restart");
    assert.notEqual(host.mode(), "RECOVERY_REQUIRED");

    assert.ok(existsSync(path.join(worktreePath, "uncommitted.txt")), "uncommitted work must survive the restart");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath), "atk/run/run-restart");
    assert.equal(worktreeStatus({ path: worktreePath }).clean, false);
    assert.ok(!existsSync(path.join(repo, "uncommitted.txt")), "the base repository must not contain the worktree's files");
    assert.equal(starts.length, 0, "recover() itself must never start a runtime");

    // A race where the backend offers the same Run again must not execute it:
    // the persisted, expired-lease record wins and the command is reported.
    client.claim = async () => claimOf({ repoPath: repo, workspace });
    await host.tick();
    assert.equal(starts.length, 0, "a recorded expired-lease Run must never be started twice");
    assert.ok(client.calls.result.length >= 1, "the duplicate claim must be reported (INTERRUPTED/MANUAL), not silently dropped");
    assert.equal(client.calls.result[0].status, "FAILED");
    assert.match(JSON.stringify(client.calls.result[0]), /reclaimed-after-lost-lease|lease|interrupted/i);

    // The same worktree manager can reuse the preserved directory (no reset).
    const reused = ensureWorktree({
      repoPath: repo,
      projectId: "proj-restart",
      runId: "run-restart",
      worktreePath,
      baseCommit,
      targetBranch: "atk/run/run-restart",
    });
    assert.equal(reused.reused, true);
    assert.ok(existsSync(path.join(worktreePath, "uncommitted.txt")));

    // Only the M6.1 state + outbox formats exist: no second recovery file.
    const recoveryFiles = readdirSync(dir).filter((name) => /recovery|state2|snapshot/i.test(name));
    assert.deepEqual(recoveryFiles, [], `unexpected second recovery format: ${recoveryFiles.join(",")}`);
    await host.stop();
  } finally {
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("QA-05.7: a missing worktree is RECOVERY_REQUIRED (never recreated at a guessed path)", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-host-missing-ws-"));
  const repoRoot = makeRepo();
  try {
    const { repo, baseCommit, worktrees } = repoRoot;
    const missingPath = path.join(worktrees, "proj-restart", "run-restart");
    const stateFile = path.join(root, "host.json");
    writeFileSync(
      stateFile,
      JSON.stringify([
        {
          runId: "run-restart",
          commandId: "CMD-RESTART",
          ownerId: "host-crashed",
          generation: 9,
          at: new Date(Date.now() - 5000).toISOString(),
          claimedUntil: new Date(Date.now() - 1000).toISOString(),
          workspace: { kind: "worktree", path: missingPath, baseCommit, targetBranch: "atk/run/run-restart", repoPath: repo, projectId: "proj-restart" },
        },
      ]),
    );
    const client = fakeClient();
    const { runtime, starts } = captureRuntime();
    const host = createHost({
      client,
      runtime,
      ownerId: "host-new",
      pollMs: 1000,
      flushMs: 5,
      heartbeatMs: 1000,
      stateFile,
      outboxFile: path.join(root, "host.outbox.json"),
      logger: quietLogger(),
    });
    const summary = await host.recover();
    assert.equal(host.mode(), "RECOVERY_REQUIRED");
    assert.equal(summary.recoveryRequired, true);
    assert.ok(summary.worktreeMissing.some((entry) => entry.runId === "run-restart"), JSON.stringify(summary));
    assert.match(JSON.stringify(summary.worktreeMissing), /workspace-missing|missing/i);
    assert.equal(existsSync(missingPath), false, "a missing worktree must NOT be recreated");
    const claimsBefore = client.calls.claim;
    await host.tick();
    assert.equal(client.calls.claim, claimsBefore, "RECOVERY_REQUIRED must block new claims");
    assert.equal(starts.length, 0);
    await host.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repoRoot.root, { recursive: true, force: true });
  }
});