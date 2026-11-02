// M6.2 F04/F05: the dispatched TaskExecutionSpec is the whole instruction, and
// the cwd can only come from the persisted run.workspace. These tests use real
// temporary git repositories, so a worktree is actually created and a Run's
// writes are observable on disk.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockRuntime } from "@atk/runtime-sdk/mock";
import { createTaskExecutionSpec } from "../../../packages/contracts/src/execution-spec.mjs";
import { removeWorktree, worktreeStatus } from "../../../packages/workspace/src/index.mjs";
import { createHost } from "../src/host.mjs";

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
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-host-f04-"));
  const repo = path.join(root, "repo");
  git(["init", "-q", "-b", "main", repo], root);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "init"], repo);
  return { root, repo, baseCommit: git(["rev-parse", "HEAD"], repo), worktrees: path.join(root, "worktrees") };
}

function hashSpec(spec) {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

function makeSpec({ taskId = "TASK-1", repoPath = "C:/repo", workspace = { kind: "none" }, taskVersion = 3, title = "Implement the feature", description = "Do the thing from the frozen spec." } = {}) {
  return createTaskExecutionSpec({
    task: {
      id: taskId,
      version: taskVersion,
      title,
      description,
      acceptance: "tests pass",
      files: ["src/feature.js"],
      deps: [],
      functionRequired: "DEV",
      roleRequired: "DEVELOPER",
    },
    project: { id: "proj-1", name: "Demo", repoPath, defaultBranch: "main" },
    workspace,
    frozenAt: "2026-01-01T00:00:00.000Z",
  });
}

function claimOf({ runId = "run-1", commandId = "CMD-1", spec, workspace, payload = {}, attempts = 1 } = {}) {
  return {
    command: { id: commandId, runId, commandType: "RUN_TASK", attempts, payload: { ...payload, ...(spec === undefined ? {} : { spec }) } },
    run: { id: runId, taskId: spec?.taskId ?? "TASK-1", status: "STARTING", ...(workspace === undefined ? {} : { workspace }) },
    lease: { ownerId: "host-a", generation: 4, claimedUntil: new Date(Date.now() + 30000).toISOString() },
  };
}

function fakeClient({ claims = [] } = {}) {
  const calls = { claim: 0, events: [], result: [], renew: [], heartbeat: [], reconcile: [] };
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
      calls.renew.push({ runId, ...body });
      return Promise.resolve({ lease: { ...body, generation: body.generation + 1 } });
    },
    result(commandId, body) {
      calls.result.push({ commandId, ...body });
      return Promise.resolve({ persisted: true });
    },
    heartbeat(body) {
      calls.heartbeat.push(body);
      return Promise.resolve({ ok: true });
    },
    reconcile(runId) {
      calls.reconcile.push(runId);
      return Promise.resolve({ run: { id: runId, status: "RUNNING" }, command: { id: "CMD-1", status: "CLAIMED" } });
    },
  };
}

function captureRuntime({ scenario = "complete", onStart } = {}) {
  let sequence = 0;
  const base = createMockRuntime({ scenario, sessionIdFactory: () => `session-${++sequence}` });
  const starts = [];
  const runtime = {
    ...base,
    start: async (input) => {
      starts.push(input);
      if (onStart) await onStart(input);
      return base.start(input);
    },
    stop: base.stop.bind(base),
    subscribe: base.subscribe.bind(base),
    probe: base.probe.bind(base),
    capabilities: base.capabilities.bind(base),
    kind: base.kind,
  };
  return { runtime, starts };
}

function waitFor(predicate, timeoutMs = 3000, label = "condition") {
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
      setTimeout(tick, 10);
    };
    tick();
  });
}

function makeHost({ client, runtime, dir, options = {} }) {
  return createHost({
    client,
    runtime,
    ownerId: "host-a",
    pollMs: 1000,
    flushMs: 5,
    heartbeatMs: 1000,
    stateFile: path.join(dir, "host.json"),
    outboxFile: path.join(dir, "host.outbox.json"),
    outboxRetryBaseMs: 5,
    outboxRetryMaxMs: 20,
    logger: quietLogger(),
    ...options,
  });
}

function eventsOf(client) {
  return client.calls.events.flatMap((batch) => batch.events ?? []);
}

function specLogMessage(client) {
  return eventsOf(client)
    .filter((event) => event.type === "log")
    .map((event) => event.message)
    .join("\n");
}

test("F05: a claim without a spec is rejected before runtime.start (no 'Execute task <ID>' fallback)", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-host-nospec-"));
  try {
    const client = fakeClient({ claims: [claimOf({ payload: { prompt: "Execute task TASK-1" }, workspace: { kind: "none" } })] });
    const { runtime, starts } = captureRuntime();
    const host = makeHost({ client, runtime, dir: root });
    await host.tick();
    await waitFor(() => client.calls.result.length >= 1 && host.outbox().length === 0, 3000, "rejected result");
    assert.equal(starts.length, 0, "the runtime must never be started without a valid spec");
    const result = client.calls.result[0];
    assert.equal(result.status, "FAILED");
    const text = JSON.stringify(result);
    assert.match(text, /missing-execution-spec|invalid-execution-spec/, `expected a spec rejection, got ${text}`);
    assert.doesNotMatch(text, /Execute task TASK-1/);
    assert.equal(host.stats.completed, 0);
    await host.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F05: an invalid spec is rejected; nothing starts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-host-badspec-"));
  try {
    const spec = makeSpec();
    delete spec.description;
    const client = fakeClient({ claims: [claimOf({ spec, workspace: { kind: "none" } })] });
    const { runtime, starts } = captureRuntime();
    const host = makeHost({ client, runtime, dir: root });
    await host.tick();
    await waitFor(() => client.calls.result.length >= 1 && host.outbox().length === 0, 3000, "invalid spec rejection");
    assert.equal(starts.length, 0);
    assert.match(JSON.stringify(client.calls.result[0]), /invalid-execution-spec/);
    await host.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F04: a worktree run gets cwd from run.workspace, creates the worktree and logs taskVersion + specHash", async () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  const worktreePath = path.join(worktrees, "proj-1", "run-1");
  const workspace = { kind: "worktree", path: worktreePath, baseCommit, targetBranch: "atk/run/run-1" };
  const spec = makeSpec({ repoPath: repo, workspace });
  const wrote = [];
  const client = fakeClient({ claims: [claimOf({ spec, workspace })] });
  const { runtime, starts } = captureRuntime({
    onStart: (input) => {
      wrote.push(input.cwd);
      writeFileSync(path.join(input.cwd, "run-1.txt"), "run one\n", "utf8");
    },
  });
  try {
    const host = makeHost({ client, runtime, dir: root });
    await host.tick();
    await waitFor(() => client.calls.result.length >= 1 && host.outbox().length === 0, 5000, "worktree run result");
    assert.equal(starts.length, 1);
    assert.equal(path.resolve(starts[0].cwd), path.resolve(worktreePath), "cwd must be the persisted run.workspace path");
    assert.equal(wrote[0], worktreePath);
    assert.ok(existsSync(path.join(worktreePath, "run-1.txt")), "the runtime must have written inside the worktree");
    assert.ok(!existsSync(path.join(repo, "run-1.txt")), "the base repository must stay untouched");
    assert.ok(starts[0].prompt.includes("Implement the feature"), "the prompt must be built from the spec");
    assert.match(starts[0].prompt, /Do the thing from the frozen spec/);
    assert.doesNotMatch(starts[0].prompt, /Execute task/);
    const log = specLogMessage(client);
    assert.match(log, /taskVersion=3/);
    assert.match(log, new RegExp(hashSpec(spec)));
    assert.match(log, /workspace=worktree/);
    await host.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F04: two Runs get different worktrees and cannot affect each other", async () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  const ws1 = { kind: "worktree", path: path.join(worktrees, "proj-1", "run-1"), baseCommit, targetBranch: "atk/run/run-1" };
  const ws2 = { kind: "worktree", path: path.join(worktrees, "proj-1", "run-2"), baseCommit, targetBranch: "atk/run/run-2" };
  const spec1 = makeSpec({ taskId: "TASK-1", repoPath: repo, workspace: ws1, title: "Run one" });
  const spec2 = makeSpec({ taskId: "TASK-2", repoPath: repo, workspace: ws2, title: "Run two" });
  const client = fakeClient({
    claims: [claimOf({ runId: "run-1", commandId: "CMD-1", spec: spec1, workspace: ws1 }), claimOf({ runId: "run-2", commandId: "CMD-2", spec: spec2, workspace: ws2 })],
  });
  const { runtime, starts } = captureRuntime({
    onStart: (input) => writeFileSync(path.join(input.cwd, `${input.runId}.txt`), `${input.runId}\n`, "utf8"),
  });
  try {
    const host = makeHost({ client, runtime, dir: root });
    await host.tick();
    await waitFor(() => host.outbox().length === 0 && client.calls.result.length === 1, 4000, "first run");
    await host.tick();
    await waitFor(() => host.outbox().length === 0 && client.calls.result.length === 2, 4000, "second run");
    assert.equal(starts.length, 2);
    assert.notEqual(path.resolve(starts[0].cwd), path.resolve(starts[1].cwd));
    assert.ok(existsSync(path.join(ws1.path, "run-1.txt")));
    assert.ok(existsSync(path.join(ws2.path, "run-2.txt")));
    assert.ok(!existsSync(path.join(ws1.path, "run-2.txt")), "run two must not write into run one's worktree");
    assert.ok(!existsSync(path.join(ws2.path, "run-1.txt")), "run one must not write into run two's worktree");
    assert.ok(!existsSync(path.join(repo, "run-1.txt")) && !existsSync(path.join(repo, "run-2.txt")));
    await host.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F04: spec.workspace disagreeing with run.workspace is rejected with workspace-mismatch (no worktree, no start)", async () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  const runPath = path.join(worktrees, "proj-1", "run-1");
  const specPath = path.join(worktrees, "proj-1", "run-evil");
  const spec = makeSpec({ repoPath: repo, workspace: { kind: "worktree", path: specPath, baseCommit, targetBranch: "atk/run/run-1" } });
  const client = fakeClient({ claims: [claimOf({ spec, workspace: { kind: "worktree", path: runPath, baseCommit, targetBranch: "atk/run/run-1" } })] });
  const { runtime, starts } = captureRuntime();
  try {
    const host = makeHost({ client, runtime, dir: root });
    await host.tick();
    await waitFor(() => client.calls.result.length >= 1 && host.outbox().length === 0, 3000, "mismatch rejection");
    assert.equal(starts.length, 0);
    assert.match(JSON.stringify(client.calls.result[0]), /workspace-mismatch/);
    assert.ok(!existsSync(runPath), "a rejected run must not create a worktree");
    assert.ok(!existsSync(specPath), "a rejected run must not create the spec's worktree");
    await host.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F04: a failed Run keeps its worktree and uncommitted files (no host-side cleanup)", async () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  const workspace = { kind: "worktree", path: path.join(worktrees, "proj-1", "run-fail"), baseCommit, targetBranch: "atk/run/run-fail" };
  const spec = makeSpec({ taskId: "TASK-FAIL", repoPath: repo, workspace });
  const client = fakeClient({ claims: [claimOf({ runId: "run-fail", commandId: "CMD-FAIL", spec, workspace })] });
  const { runtime } = captureRuntime({
    scenario: "fail",
    onStart: (input) => writeFileSync(path.join(input.cwd, "work-in-progress.txt"), "must survive\n", "utf8"),
  });
  try {
    const host = makeHost({ client, runtime, dir: root });
    await host.tick();
    await waitFor(() => client.calls.result.length >= 1 && host.outbox().length === 0, 5000, "failed run result");
    assert.equal(client.calls.result[0].status, "FAILED");
    await host.stop();
    assert.ok(existsSync(path.join(workspace.path, "work-in-progress.txt")), "failure must not delete uncommitted work");
    assert.equal(worktreeStatus({ path: workspace.path }).clean, false);
    assert.throws(
      () => removeWorktree({ repoPath: repo, worktreePath: workspace.path }),
      (error) => error.code === "WORKSPACE_DIRTY",
      "cleanup must still require an explicit force+confirmClean",
    );
    const removed = removeWorktree({ repoPath: repo, worktreePath: workspace.path, force: true, confirmClean: true });
    assert.equal(removed.forced, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F04: a restarted host reuses the recorded worktree and preserves its files", async () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  const workspace = { kind: "worktree", path: path.join(worktrees, "proj-1", "run-reuse"), baseCommit, targetBranch: "atk/run/run-reuse" };
  const spec = makeSpec({ taskId: "TASK-REUSE", repoPath: repo, workspace });
  // First incarnation creates the worktree and leaves an uncommitted file.
  const firstClient = fakeClient({ claims: [claimOf({ runId: "run-reuse", commandId: "CMD-R1", spec, workspace })] });
  const first = captureRuntime({ onStart: (input) => writeFileSync(path.join(input.cwd, "kept.txt"), "keep me\n", "utf8") });
  const host1 = makeHost({ client: firstClient, runtime: first.runtime, dir: root });
  await host1.tick();
  await waitFor(() => firstClient.calls.result.length >= 1 && host1.outbox().length === 0, 5000, "first incarnation");
  await host1.stop();

  const secondClient = fakeClient({ claims: [claimOf({ runId: "run-reuse", commandId: "CMD-R2", spec, workspace })] });
  let sawKept = false;
  const second = captureRuntime({
    onStart: (input) => {
      sawKept = existsSync(path.join(input.cwd, "kept.txt"));
      writeFileSync(path.join(input.cwd, "second.txt"), "second\n", "utf8");
    },
  });
  try {
    const host2 = makeHost({ client: secondClient, runtime: second.runtime, dir: root });
    await host2.tick();
    await waitFor(() => secondClient.calls.result.length >= 1 && host2.outbox().length === 0, 5000, "second incarnation");
    assert.equal(second.starts.length, 1, "the recorded worktree must be reused, not rejected");
    assert.equal(path.resolve(second.starts[0].cwd), path.resolve(workspace.path));
    assert.equal(sawKept, true, "reuse must preserve uncommitted files");
    assert.ok(existsSync(path.join(workspace.path, "second.txt")));
    await host2.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F04/F05: workspace kind none keeps Mock behaviour, ignores command.payload.cwd and marks workspace:none", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-host-none-"));
  try {
    const evilCwd = path.join(root, "client-supplied");
    const spec = makeSpec({ workspace: { kind: "none" } });
    const client = fakeClient({ claims: [claimOf({ spec, workspace: { kind: "none", path: null, baseCommit: null, targetBranch: null }, payload: { cwd: evilCwd } })] });
    const { runtime, starts } = captureRuntime();
    const host = makeHost({ client, runtime, dir: root });
    await host.tick();
    await waitFor(() => client.calls.result.length >= 1 && host.outbox().length === 0, 3000, "none run");
    assert.equal(starts.length, 1);
    assert.notEqual(path.resolve(starts[0].cwd), path.resolve(evilCwd), "client-supplied cwd must never be used");
    assert.equal(path.resolve(starts[0].cwd), path.resolve(process.cwd()));
    const log = specLogMessage(client);
    assert.match(log, /workspace=none/);
    assert.match(log, /taskVersion=3/);
    assert.match(log, new RegExp(hashSpec(spec)));
    await host.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});