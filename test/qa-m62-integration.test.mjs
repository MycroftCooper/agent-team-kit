// M6.2 QA-05: real execution-chain integration (MockRuntime + real HTTP /
// SQLite / Scheduler / Host / git worktree).
//
// Nothing in this file uses the production P4/trading environment or real
// credentials. A stage that the M6.2 parallel implementation has not landed is
// registered as an explicit skip, never as a pass.
//
// Node < 22.5 has no node:sqlite: the whole file is skipped.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);
let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

if (!hasSqlite) {
  test("qa-m62 execution-chain suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5" }, () => {});
} else {
  const { openStore } = await load("packages/database/src/index.mjs");
  const { INTERNAL } = await load("packages/database/src/internal.mjs");
  const { createHost } = await load("apps/runtime-host/src/host.mjs");
  const { createInternalClient } = await load("apps/runtime-host/src/client.mjs");
  const { createMockRuntime } = await load("packages/runtime-sdk/src/mock.mjs");
  const { createScheduler } = await load("apps/scheduler/src/index.mjs");
  const core = await load("packages/scheduler-core/src/index.mjs");
  const { startServer, request, writeHeaders, internalHeaders, TEST_INTERNAL_TOKEN } = await load("apps/backend/test/helpers.mjs");
  const { ensureWorktree, listWorktrees, worktreeStatus } = await load("packages/workspace/src/index.mjs");

  const quiet = { info() {}, warn() {}, error() {} };
  function tempDir(t, prefix = "atk-m62-qa05-") {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => { for (let attempt = 0; attempt < 6; attempt += 1) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return; } catch { /* busy */ } } });
    return dir;
  }
  function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return (result.stdout ?? "").trim();
  }
  function makeGitRepo(t) {
    const repo = path.join(tempDir(t, "atk-m62-repo-"), "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "qa@example.invalid"], repo);
    git(["config", "user.name", "QA"], repo);
    writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
    git(["add", "."], repo);
    git(["commit", "-m", "base"], repo);
    return { repo, head: git(["rev-parse", "HEAD"], repo) };
  }
  function makeStoreTask(store, { id, repoPath = ".", files = [] }) {
    const project = store.getProject?.("P1") ?? null;
    if (!project) store.createProject({ id: "P1", name: "p1", repoPath, defaultBranch: "main" });
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    store.upsertAgent({ id: "agent-2", role: "QA", capabilities: ["WORKER"], status: "IDLE" });
    if (typeof store.recordHeartbeat === "function") store.recordHeartbeat({ hostId: "qa-host", agentIds: ["agent-1", "agent-2"], capacity: 2 });
    return store.createTask({
      id,
      projectId: "P1",
      title: `task ${id}`,
      description: `implement ${id}`,
      functionRequired: "WORKER",
      roleRequired: "DEV",
      priority: 2,
      deps: [],
      files,
      acceptance: "AC",
    });
  }
  async function backend(t, { repoPath = "." } = {}) {
    const dir = tempDir(t);
    const store = openStore({ file: path.join(dir, "atk.db"), migrate: true });
    store.createProject({ id: "P1", name: "p1", repoPath, defaultBranch: "main" });
    const ctx = await startServer({ store, logger: quiet });
    t.after(async () => { await ctx.server.close().catch(() => {}); try { store.close(); } catch { /* closed */ } });
    return { dir, store, ctx };
  }
  function claim(ctx, task, workspace) {
    return request(ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${task.id}/claim`,
      headers: internalHeaders(TEST_INTERNAL_TOKEN, "scheduler"),
      body: { agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: `qa05-${task.id}-${task.version}`, ...(workspace ? { workspace } : {}) },
    });
  }
  function captureRuntime(t, { scenario = "complete", onStart } = {}) {
    const base = createMockRuntime({ scenario, sessionIdFactory: (() => { let n = 0; return () => `qa-session-${++n}`; })() });
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
    };
    return { runtime, starts };
  }
  function hostFor(t, { dir, client, runtime, name = "host" }) {
    return createHost({
      client,
      runtime,
      ownerId: `qa-${name}`,
      pollMs: 1000,
      flushMs: 5,
      heartbeatMs: 1000,
      stateFile: path.join(dir, `${name}.state.json`),
      outboxFile: path.join(dir, `${name}.outbox.json`),
      outboxRetryBaseMs: 5,
      outboxRetryMaxMs: 20,
      logger: quiet,
    });
  }
  function waitFor(predicate, timeoutMs = 8000, label = "condition") {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        let value;
        try { value = predicate(); } catch (error) { return reject(error); }
        if (value) return resolve(value);
        if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  test("QA-05.1 a Scheduler auto-claims the FE/BE tasks over real HTTP", async (t) => {
    const f = await backend(t);
    const fe = makeStoreTask(f.store, { id: "FE", files: ["apps/web/src/App.tsx"] });
    const be = makeStoreTask(f.store, { id: "BE", files: ["apps/backend/src/server.mjs"] });
    const scheduler = createScheduler({
      client: (await load("apps/scheduler/src/client.mjs")).createSchedulerClient({ baseUrl: f.ctx.base, token: TEST_INTERNAL_TOKEN }),
      core: { planDispatch: core.planDispatch },
      policies: { maxConcurrentPerProject: 10, maxPerAgent: 5 },
      ownerId: "qa-scheduler",
      pollMs: 10,
      logger: quiet,
    });
    const round = await scheduler.runOnce();
    assert.equal(round.ok, true, JSON.stringify(round));
    assert.equal(round.proposals, 2, `both FE and BE should be proposed: ${JSON.stringify(round)}`);
    assert.equal(round.results.filter((entry) => entry.claimed).length, 2, JSON.stringify(round.results));
    assert.equal(f.store.getTask(fe.id).status, "CLAIMED");
    assert.equal(f.store.getTask(be.id).status, "CLAIMED");
    const runs = f.store.listRuns({ limit: 10 });
    assert.equal(runs.length, 2);
    assert.equal(new Set(runs.map((run) => run.id)).size, 2, "each task gets its own Run");
  });

  test("QA-05.2 a claimed Run reaches the Host with the frozen spec and runs in its worktree", async (t) => {
    const { repo, head } = makeGitRepo(t);
    const f = await backend(t, { repoPath: repo });
    const task = makeStoreTask(f.store, { id: "FE", files: ["apps/web/src/App.tsx"] });
    const worktreeRoot = tempDir(t, "atk-m62-worktrees-");
    const claimed = await claim(f.ctx, task, { kind: "worktree", root: worktreeRoot, baseCommit: head, targetBranch: "atk/qa/fe" });
    assert.equal(claimed.status, 200, claimed.text);
    const { run, command, spec, specHash } = claimed.json;
    assert.equal(run.workspace.kind, "worktree");
    assert.deepEqual(run.workspace, spec.workspace, "run.workspace and spec.workspace must agree");
    assert.equal(run.specHash, specHash);
    assert.equal(path.resolve(run.workspace.path).startsWith(path.resolve(worktreeRoot)), true);
    const { runtime, starts } = captureRuntime(t, { onStart: (input) => writeFileSync(path.join(input.cwd, "host-created.txt"), "host\\n", "utf8") });
    const host = hostFor(t, { dir: tempDir(t, "atk-m62-host-"), client: createInternalClient({ baseUrl: f.ctx.base, token: TEST_INTERNAL_TOKEN }), runtime });
    await host.tick();
    await waitFor(() => f.store.getRun(run.id).status === "COMPLETED" && f.store[INTERNAL].getDispatchCommand(command.id)?.status === "DONE" && host.outbox().length === 0, 10000, "host worktree completion");
    assert.equal(starts.length, 1, "the runtime must be started exactly once");
    assert.equal(path.resolve(starts[0].cwd), path.resolve(run.workspace.path), "cwd is the persisted run workspace, never a client directory");
    assert.match(starts[0].prompt, /task FE|implement FE/, "the full frozen spec must reach the runtime prompt");
    assert.match(starts[0].prompt, /apps\/web\/src\/App\.tsx/, "the file scope must reach the runtime");
    assert.equal(existsSync(path.join(run.workspace.path, "host-created.txt")), true);
    assert.equal(existsSync(path.join(repo, "host-created.txt")), false, "the base checkout must not receive run files");
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], run.workspace.path);
    assert.equal(branch, "atk/qa/fe");
    const events = f.store.listEvents({ aggregateId: run.id, type: "run.log", limit: 100 });
    assert.ok(events.some((event) => /execution-spec taskVersion=/.test(String(event.payload?.message))), "the run log must record taskVersion/specHash");
    assert.equal(f.store[INTERNAL].getDispatchCommand(command.id)?.status, "DONE");
    await host.stop();
  });

  test("QA-05.3 two Runs get independent worktrees and cannot see each other's files", async (t) => {
    const { repo, head } = makeGitRepo(t);
    const f = await backend(t, { repoPath: repo });
    const fe = makeStoreTask(f.store, { id: "FE", files: ["apps/web/App.tsx"] });
    const be = makeStoreTask(f.store, { id: "BE", files: ["apps/backend/server.mjs"] });
    const root = tempDir(t, "atk-m62-worktrees-");
    const feClaim = await claim(f.ctx, fe, { kind: "worktree", root, baseCommit: head, targetBranch: "atk/qa/fe" });
    const beClaim = await claim(f.ctx, be, { kind: "worktree", root, baseCommit: head, targetBranch: "atk/qa/be" });
    assert.equal(feClaim.status, 200, feClaim.text);
    assert.equal(beClaim.status, 200, beClaim.text);
    const runs = [feClaim.json.run, beClaim.json.run];
    assert.notEqual(runs[0].workspace.path, runs[1].workspace.path);
    const host = hostFor(t, {
      dir: tempDir(t, "atk-m62-host-"),
      client: createInternalClient({ baseUrl: f.ctx.base, token: TEST_INTERNAL_TOKEN }),
      runtime: captureRuntime(t, { onStart: (input) => writeFileSync(path.join(input.cwd, `${input.runId}.txt`), input.runId, "utf8") }).runtime,
    });
    await host.tick();
    await waitFor(() => f.store.getRun(runs[0].id).status === "COMPLETED" && host.outbox().length === 0, 10000, "first run");
    await host.tick();
    await waitFor(() => f.store.getRun(runs[1].id).status === "COMPLETED" && host.outbox().length === 0, 10000, "second run");
    assert.equal(existsSync(path.join(runs[0].workspace.path, `${runs[0].id}.txt`)), true);
    assert.equal(existsSync(path.join(runs[1].workspace.path, `${runs[1].id}.txt`)), true);
    assert.equal(existsSync(path.join(runs[0].workspace.path, `${runs[1].id}.txt`)), false);
    assert.equal(existsSync(path.join(runs[1].workspace.path, `${runs[0].id}.txt`)), false);
    const registered = listWorktrees({ repoPath: repo }).map((entry) => path.resolve(entry.path));
    assert.ok(registered.includes(path.resolve(runs[0].workspace.path)) && registered.includes(path.resolve(runs[1].workspace.path)), "both Run worktrees are registered");
    const status = worktreeStatus({ path: runs[0].workspace.path });
    assert.equal(status.clean, false, "each worktree has only its own uncommitted file");
    assert.ok(status.untracked.some((file) => file.endsWith(`${runs[0].id}.txt`)));
    await host.stop();
  });

  test("QA-05.4 independent AGENT review + integration + waiting for Human Approval", async (t) => {
    const f = await backend(t);
    const task = makeStoreTask(f.store, { id: "QA-FLOW", files: ["src/flow.js"] });
    f.store[INTERNAL].setTaskStatus(task.id, "RUNNING");
    const run = f.store.createRun({ taskId: task.id, agentId: "agent-1", function: "WORKER", role: "DEV" });
    f.store.updateRunStatus(run.id, { status: "RUNNING" });
    f.store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    const reviewerRun = f.store.createRun({ taskId: task.id, agentId: "agent-2", function: "WORKER", role: "QA" });
    const created = await request(f.ctx.base, {
      method: "POST",
      path: "/api/v1/reviews",
      headers: writeHeaders(f.ctx.base),
      body: { taskId: task.id, runId: run.id, assignedTo: "AGENT", reviewerAgentId: "agent-2" },
    });
    assert.equal(created.status, 201, created.text);
    const manifestHash = "a".repeat(64);
    const submitted = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/reviews/${created.json.id}/submit`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, "runtime-host"), "content-type": "application/json" },
      body: { expectedVersion: created.json.version, verdict: "PASS", manifestHash, evidence: { tests: { passed: 1, total: 1 } }, runId: reviewerRun.id },
    });
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(f.store.getTask(task.id).status, "INTEGRATING");
    const integration = await request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${task.id}/integration`,
      headers: { ...internalHeaders(TEST_INTERNAL_TOKEN, "user-action"), "content-type": "application/json" },
      body: { taskId: task.id, runId: run.id, commitSha: "b".repeat(40), manifestHash },
    });
    assert.equal(integration.status, 200, integration.text);
    assert.equal(f.store.getTask(task.id).status, "AWAITING_ACCEPTANCE");
    assert.notEqual(f.store.getTask(task.id).status, "DONE", "integration never self-approves");
    const approval = await request(f.ctx.base, {
      method: "POST",
      path: "/api/v1/approvals",
      headers: writeHeaders(f.ctx.base),
      body: { taskId: task.id, scope: "qa acceptance", targetHash: manifestHash },
    });
    assert.equal(approval.status, 201, approval.text);
    const approvalId = (approval.json.approval ?? approval.json).id;
    const decided = await request(f.ctx.base, {
      method: "POST",
      path: `/api/v1/approvals/${approvalId}/decide`,
      headers: writeHeaders(f.ctx.base),
      body: { decision: "APPROVED", targetHash: manifestHash },
    });
    assert.equal(decided.status, 200, decided.text);
    assert.equal(f.store.getTask(task.id).status, "DONE");
  });

  test("QA-05.5 a CHANGES_REQUESTED review is reworked to READY and re-claimed", async (t) => {
    const f = await backend(t);
    const task = makeStoreTask(f.store, { id: "REWORK", files: ["src/rework.js"] });
    f.store[INTERNAL].setTaskStatus(task.id, "RUNNING");
    const run = f.store.createRun({ taskId: task.id, agentId: "agent-1", function: "WORKER", role: "DEV" });
    f.store.updateRunStatus(run.id, { status: "RUNNING" });
    f.store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    const review = f.store.createReview({ taskId: task.id, runId: run.id, assignedTo: "HUMAN" });
    f.store.submitReview({ id: review.id, expectedVersion: review.version, verdict: "CHANGES_REQUESTED", findings: [{ code: "QA", message: "fix" }], actor: "HUMAN" });
    assert.equal(f.store.getTask(task.id).status, "REJECTED");
    const reworked = f.store.reworkTask({ taskId: task.id, reviewId: review.id, reason: "fix findings", actor: "HUMAN" });
    assert.equal(reworked.task.status, "READY");
    assert.equal(Number(reworked.attempt), 2);
    const scheduler = createScheduler({
      client: (await load("apps/scheduler/src/client.mjs")).createSchedulerClient({ baseUrl: f.ctx.base, token: TEST_INTERNAL_TOKEN }),
      core: { planDispatch: core.planDispatch },
      policies: { maxConcurrentPerProject: 10, maxPerAgent: 5 },
      ownerId: "qa-scheduler-rework",
      pollMs: 10,
      logger: quiet,
    });
    const round = await scheduler.runOnce();
    assert.equal(round.ok, true, JSON.stringify(round));
    assert.equal(round.results.some((entry) => entry.taskId === task.id && entry.claimed === true), true, `reworked task must be claimable again: ${JSON.stringify(round)}`);
    assert.equal(f.store.getTask(task.id).status, "CLAIMED");
    assert.equal(f.store.listRuns({ taskId: task.id, limit: 10 }).length, 2, "a rework gets a new Run (attempt 2)");
  });

  test("QA-05.5b a failed Runtime is reported as FAILED, never as a false completion", async (t) => {
    const f = await backend(t);
    const task = makeStoreTask(f.store, { id: "RUNTIME-FAIL" });
    const claimed = await claim(f.ctx, task);
    assert.equal(claimed.status, 200, claimed.text);
    const run = claimed.json.run;
    const { runtime, starts } = captureRuntime(t, { scenario: "fail" });
    const host = hostFor(t, {
      dir: tempDir(t, "atk-m62-host-"),
      client: createInternalClient({ baseUrl: f.ctx.base, token: TEST_INTERNAL_TOKEN }),
      runtime,
    });
    await host.tick();
    await waitFor(() => f.store.getRun(run.id).status === "FAILED" && ["DONE", "FAILED"].includes(f.store[INTERNAL].getDispatchCommand(claimed.json.command.id)?.status) && host.outbox().length === 0, 10000, "failed runtime result");
    assert.equal(starts.length, 1);
    assert.equal(f.store.getRun(run.id).status, "FAILED");
    assert.equal(f.store.getRun(run.id).status === "COMPLETED", false, "a failed execution must never be reported as success");
    await host.stop();
  });

  test("QA-05.7 real cross-process restart: SIGKILL, worktree preserved, no second start, missing worktree -> RECOVERY_REQUIRED", async () => {
    // The WP3 suite spawns a real Host child, writes a worktree, SIGKILLs it,
    // then recovers with a new Host. Running that suite here makes this a real
    // acceptance gate, not a claim by association; we also assert the source
    // still contains the two behaviours the gate is about.
    const sourceFile = path.join(REPO, "apps/runtime-host/test/restart-recovery.test.mjs");
    const source = readFileSync(sourceFile, "utf8");
    assert.match(source, /SIGKILL/, "the restart gate must kill a real child");
    assert.match(source, /RECOVERY_REQUIRED/, "the restart gate must assert the fail-closed path");
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().includes("NODE_TEST")));
    const result = spawnSync(process.execPath, ["--test", sourceFile], { cwd: REPO, encoding: "utf8", timeout: 120000, windowsHide: true, env: cleanEnv });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, `WP3 restart-recovery suite failed:\n${output}`);
    assert.match(output, /tests [2-9]/, "the restart suite must run its real tests");
    assert.match(output, /fail 0/, `restart suite has failures:\n${result.stdout}`);
    assert.match(output, /pass [2-9]/, "restart suite must actually pass tests");
  });

  test("QA-05.8 Scheduler workspacePolicy is translated to claim.workspace, and incomplete policy is refused", async (t) => {
    const { repo, head } = makeGitRepo(t);
    const f = await backend(t, { repoPath: repo });
    const worktreeRoot = tempDir(t, "atk-m62-policy-root-");
    const policy = { kind: "worktree", root: worktreeRoot, baseCommit: head, targetBranch: "atk/qa/policy" };
    const task = makeStoreTask(f.store, { id: "POLICY-FULL", files: ["apps/web/App.tsx"] });
    const scheduler = createScheduler({
      client: (await load("apps/scheduler/src/client.mjs")).createSchedulerClient({ baseUrl: f.ctx.base, token: TEST_INTERNAL_TOKEN }),
      core: { planDispatch: core.planDispatch },
      policies: { maxConcurrentPerProject: 10, maxPerAgent: 5, workspacePolicy: policy },
      ownerId: "qa-scheduler-policy",
      pollMs: 10,
      logger: quiet,
    });
    const round = await scheduler.runOnce();
    assert.equal(round.ok, true, JSON.stringify(round));
    const claimed = round.results.find((entry) => entry.taskId === task.id);
    assert.equal(claimed?.claimed, true, `the scheduler policy must reach the claim: ${JSON.stringify(round)}`);
    const run = f.store.getRun(claimed.runId);
    assert.equal(run.workspace.kind, "worktree", "a complete policy must not silently degrade to none");
    assert.ok(path.resolve(run.workspace.path).startsWith(path.resolve(worktreeRoot)));
    assert.equal(run.workspace.baseCommit, head);
    assert.deepEqual(run.workspace, f.store.getRunSpec(run.id).spec.workspace, "run.workspace and the frozen spec must agree");
    assert.equal(f.store.getTask(task.id).status, "CLAIMED");

    // Incomplete policy (no root, no baseCommit) is a 400 with the missing
    // fields, and must leave the Task READY with no Run.
    const incomplete = makeStoreTask(f.store, { id: "POLICY-PARTIAL" });
    const refused = await request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${incomplete.id}/claim`,
      headers: internalHeaders(TEST_INTERNAL_TOKEN, "scheduler"),
      body: {
        agentId: "agent-1",
        expectedTaskVersion: incomplete.version,
        idempotencyKey: "qa05-partial-policy",
        workspacePolicy: { kind: "worktree", targetBranch: "main" },
      },
    });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.error.details.reason, "workspace-policy-incomplete");
    assert.ok(refused.json.error.details.missing.includes("baseCommit"), "baseCommit is mandatory for a worktree policy");
    assert.ok(refused.json.error.details.missing.length >= 1);
    assert.equal(f.store.getTask(incomplete.id).status, "READY");
    assert.equal((f.store.listRuns({ taskId: incomplete.id, limit: 10 }) ?? []).length, 0);

    // Mock / explicit none keeps kind none.
    const mockTask = makeStoreTask(f.store, { id: "POLICY-MOCK" });
    const mockClaim = await request(f.ctx.base, {
      method: "POST",
      path: `/internal/v1/tasks/${mockTask.id}/claim`,
      headers: internalHeaders(TEST_INTERNAL_TOKEN, "scheduler"),
      body: { agentId: "agent-1", expectedTaskVersion: mockTask.version, idempotencyKey: "qa05-none-policy", workspacePolicy: { kind: "none" } },
    });
    assert.equal(mockClaim.status, 200, mockClaim.text);
    assert.equal(mockClaim.json.run.workspace.kind, "none");
  });
}











