// M6.3 QA: real Launcher multi-process chain.
//
// This suite starts the REAL apps/launcher/cli.mjs "start" (Backend +
// Scheduler + Runtime Host) on a random port with a temporary data directory
// and a temporary git repository. It seeds two independent tasks through the
// store (no patched statuses, no injected heartbeats, no injected results) and
// then waits for the system to do the work itself.
//
// The first delivery is intentionally allowed to be RED: if the real chain
// cannot dispatch yet, the failure message carries the child logs and DB state
// (the P0-1 reproduction). A red test here is evidence, never a pass.
//
// Node < 22.5 has no node:sqlite: the whole file is skipped, not passed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);
const LAUNCHER = path.join(REPO, "apps", "launcher", "cli.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

if (!hasSqlite) {
  test("qa-m63 launcher chain suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5" }, () => {});
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { openStore } = await import(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href);
  const { createHost } = await load("apps/runtime-host/src/host.mjs");
  const { createMockRuntime } = await load("packages/runtime-sdk/src/mock.mjs");
  const { InternalApiError } = await load("apps/runtime-host/src/client.mjs");
  const { createLauncher } = await load("apps/launcher/src/launcher.mjs");
  const launcherFakes = await load("apps/launcher/test/fake.mjs");

  function runLauncher(args, env = {}, timeout = 90000) {
    const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
      cwd: REPO,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  function freePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
  }
  function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return (result.stdout ?? "").trim();
  }
  function makeGitRepo(t) {
    const root = mkdtempSync(path.join(os.tmpdir(), "atk-m63-repo-"));
    const repo = path.join(root, "repo");
    t.after(() => { for (let attempt = 0; attempt < 6; attempt += 1) { try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return; } catch { /* busy */ } } });
    // git init can create the directory, but keep it explicit for clarity.
    spawnSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8", windowsHide: true });
    git(["config", "user.email", "qa@example.invalid"], repo);
    git(["config", "user.name", "QA"], repo);
    const file = path.join(repo, "README.md");
    spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, "base\\n")`], { encoding: "utf8" });
    git(["add", "-A"], repo);
    git(["commit", "-qm", "base"], repo);
    return { root, repo, head: git(["rev-parse", "HEAD"], repo) };
  }
  function statusOf(dataDir) {
    const result = runLauncher(["status", "--data", dataDir, "--json"], {}, 30000);
    let json = null;
    try { json = JSON.parse(result.stdout.trim().split("\n").pop()); } catch { json = null; }
    return { code: result.status, json, text: `${result.stdout}${result.stderr}` };
  }
  function readLogs(dataDir) {
    const dir = path.join(dataDir, "logs");
    const out = {};
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".log")) continue;
      try {
        out[name] = readFileSync(path.join(dir, name), "utf8").split("\n").slice(-80).join("\n");
      } catch {
        out[name] = "";
      }
    }
    return out;
  }
  function stopSandbox(dataDir) {
    try { runLauncher(["stop", "--data", dataDir, "--force"], {}, 45000); } catch { /* ignore */ }
  }
  async function makeSandbox(t, { hosts = 1 } = {}) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m63-launcher-"));
    const dataDir = path.join(tmp, "data");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const trackedPids = new Set();
    const sandbox = { tmp, dataDir, port, base, trackedPids };
    sandbox.start = () => {
      const result = runLauncher(["start", "--port", String(port), "--data", dataDir, "--hosts", String(hosts)]);
      for (const child of statusOf(dataDir).json?.children ?? []) trackedPids.add(child.pid);
      try {
        const supervisor = JSON.parse(readFileSync(path.join(dataDir, "runtime", "launcher.pid"), "utf8")).pid;
        if (Number.isInteger(supervisor)) trackedPids.add(supervisor);
      } catch { /* no supervisor pid yet */ }
      return result;
    };
    sandbox.status = () => statusOf(dataDir);
    sandbox.logs = () => readLogs(dataDir);
    sandbox.runs = () => {
      const store = openStore({ file: path.join(dataDir, "data", "atk.db"), migrate: true });
      try { return store.listRuns({ limit: 100 }); } finally { try { store.close(); } catch { /* closed */ } }
    };
    sandbox.tasks = () => {
      const store = openStore({ file: path.join(dataDir, "data", "atk.db"), migrate: true });
      try { return store.listTasks({ limit: 100 }); } finally { try { store.close(); } catch { /* closed */ } }
    };
    sandbox.agents = () => {
      const store = openStore({ file: path.join(dataDir, "data", "atk.db"), migrate: true });
      try { return store.listAgents(); } finally { try { store.close(); } catch { /* closed */ } }
    };
    sandbox.availability = () => {
      const store = openStore({ file: path.join(dataDir, "data", "atk.db"), migrate: true });
      try { return store.listAgents().map((agent) => ({ agentId: agent.id, availability: store.agentAvailability({ agentId: agent.id }) })); } finally { try { store.close(); } catch { /* closed */ } }
    };
    sandbox.events = (runId) => {
      const store = openStore({ file: path.join(dataDir, "data", "atk.db"), migrate: true });
      try { return store.listEvents({ aggregateId: runId, limit: 1000 }); } finally { try { store.close(); } catch { /* closed */ } }
    };
    sandbox.runSpec = (runId) => {
      const store = openStore({ file: path.join(dataDir, "data", "atk.db"), migrate: true });
      try { return store.getRunSpec(runId); } finally { try { store.close(); } catch { /* closed */ } }
    };
    sandbox.worktrees = (repo) => {
      const result = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8", windowsHide: true });
      if (result.status !== 0) return { error: result.stderr || result.stdout };
      return result.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => path.resolve(line.slice("worktree ".length)));
    };
    t.after(async () => {
      try { stopSandbox(dataDir); } catch { /* ignore */ }
      try {
        const supervisor = JSON.parse(readFileSync(path.join(dataDir, "runtime", "launcher.pid"), "utf8")).pid;
        if (Number.isInteger(supervisor)) trackedPids.add(supervisor);
      } catch { /* no pid file */ }
      for (const pid of trackedPids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return; } catch { await sleep(150); }
      }
    });
    return sandbox;
  }
  async function waitFor(predicate, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return true;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
  }
  function diagnostics(sandbox, repo) {
    return JSON.stringify({
      status: sandbox.status(),
      logs: sandbox.logs(),
      tasks: sandbox.tasks().map((task) => ({ id: task.id, status: task.status, version: task.version })),
      runs: sandbox.runs().map((run) => ({ id: run.id, taskId: run.taskId, status: run.status, workspace: run.workspace })),
      agents: sandbox.agents().map((agent) => ({ id: agent.id, status: agent.status, lastHeartbeatAt: agent.lastHeartbeatAt, capacity: agent.capacity })),
      availability: sandbox.availability(),
      worktrees: sandbox.worktrees(repo),
    }, null, 2);
  }

  function tempDir(t, prefix) {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => { for (let attempt = 0; attempt < 6; attempt += 1) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return; } catch { /* busy */ } } });
    return dir;
  }
  function specOf(runId) {
    return {
      schemaVersion: 1,
      taskId: `TASK-${runId}`,
      taskVersion: 1,
      title: "M6.3 fault task",
      description: "fault injection",
      acceptance: "ack is durable",
      files: [],
      deps: [],
      functionRequired: "WORKER",
      roleRequired: "DEV",
      project: { id: "P-M63", name: "qa", repoPath: ".", defaultBranch: "main" },
      workspace: { kind: "none", path: null, baseCommit: null, targetBranch: null },
      constraints: {},
      frozenAt: "2026-11-03T00:00:00.000Z",
    };
  }
  function claimOf({ runId = "run-1", commandId = "CMD-1" } = {}) {
    const spec = specOf(runId);
    return {
      command: { id: commandId, runId, commandType: "RUN_TASK", attempts: 1, payload: { spec } },
      run: { id: runId, taskId: spec.taskId, status: "STARTING", workspace: spec.workspace },
      lease: { ownerId: "qa-host", generation: 3, claimedUntil: new Date(Date.now() + 30000).toISOString() },
      spec,
    };
  }
  function faultClient({ claims = [claimOf()], onResult, onReconcile, onEvents } = {}) {
    const calls = { claim: 0, result: [], events: [], reconcile: [] };
    const queue = [...claims];
    return {
      calls,
      claim() { calls.claim += 1; return Promise.resolve(queue.length ? queue.shift() : null); },
      events(runId, body) { calls.events.push({ runId, ...body }); return onEvents ? onEvents(runId, body) : Promise.resolve({ applied: body.events, skipped: 0 }); },
      renew(runId, body) { return Promise.resolve({ lease: { ...body, generation: body.generation + 1 } }); },
      heartbeat(body) { return Promise.resolve({ ok: true, ...body }); },
      register(body) { return Promise.resolve({ agents: body.agents }); },
      result(commandId, body) { calls.result.push({ commandId, ...body }); return onResult ? onResult(commandId, body, calls) : Promise.resolve({ persisted: true }); },
      reconcile(runId) { calls.reconcile.push(runId); return onReconcile ? onReconcile(runId, calls) : Promise.resolve({ persisted: false }); },
    };
  }
  function makeHost(t, options = {}) {
    const dir = tempDir(t, "atk-m63-host-");
    const host = createHost({
      client: options.client,
      runtime: options.runtime ?? createMockRuntime({ scenario: "complete", sessionIdFactory: () => "m63-session" }),
      ownerId: "qa-m63-host",
      agents: [{ agentId: "qa-m63-agent", role: "DEV", function: "WORKER" }],
      allowNoneWorkspace: true,
      pollMs: 1000,
      flushMs: 5,
      heartbeatMs: 1000,
      stateFile: path.join(dir, "host.json"),
      outboxFile: path.join(dir, "host.outbox.json"),
      outboxRetryBaseMs: 5,
      outboxRetryMaxMs: 20,
      idFactory: () => "qa-fixed-idempotency",
      logger: { info() {}, warn() {}, error() {} },
    });
    t.after(async () => { try { await host.stop(); } catch { /* ignore */ } });
    return { host, dir };
  }

  test("QA-M63.1 the real Launcher starts Backend + Scheduler + Host on isolated paths", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    const started = sandbox.start();
    assert.equal(started.status, 0, `launcher start failed:\n${started.stdout}\n${started.stderr}`);
    const snapshot = sandbox.status().json;
    assert.ok(snapshot, "status --json must parse");
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.health?.ok, true, JSON.stringify(snapshot.health));
    const roles = snapshot.children.map((child) => child.role).sort();
    assert.deepEqual(roles, ["backend", "host", "scheduler"]);
    assert.ok(snapshot.children.every((child) => child.alive), JSON.stringify(snapshot.children));
    const health = await fetch(`${sandbox.base}/api/v1/system/health`).then((response) => response.status);
    assert.equal(health, 200);
  });

  test("QA-M63.2 auto-dispatch 鈫?independent worktrees 鈫?frozen spec 鈫?persisted events/ack", async (t) => {
    const { repo, head } = makeGitRepo(t);
    const sandbox = await makeSandbox(t, { hosts: 1 });
    const started = sandbox.start();
    assert.equal(started.status, 0, `launcher start failed:\n${started.stdout}\n${started.stderr}`);

    // Seed only the *inputs*: project + two independent tasks + two IDLE
    // agents. No status patching, no manual heartbeat, no manual run/result.
    const worktreeRoot = path.join(sandbox.tmp, "worktrees");
    const store = openStore({ file: path.join(sandbox.dataDir, "data", "atk.db"), migrate: true });
    try {
      store.createProject({
        id: "QA-M63-P",
        name: "m63",
        repoPath: repo,
        defaultBranch: "main",
        policy: { workspacePolicy: { kind: "worktree", root: worktreeRoot, baseCommit: head } },
      });
      for (const id of ["qa-m63-agent-1", "qa-m63-agent-2"]) {
        store.upsertAgent({ id, role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
      }
      store.createTask({ id: "QA-M63-FE", projectId: "QA-M63-P", title: "FE", description: "frontend", functionRequired: "WORKER", roleRequired: "DEV", priority: 1, deps: [], files: ["apps/web/src/App.tsx"], acceptance: "FE green" });
      store.createTask({ id: "QA-M63-BE", projectId: "QA-M63-P", title: "BE", description: "backend", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], files: ["apps/backend/src/server.mjs"], acceptance: "BE green" });
    } finally {
      store.close();
    }

    let dispatched = false;
    try {
      await waitFor(() => sandbox.runs().length >= 2, 30000, "two auto-dispatched Runs");
      dispatched = true;
    } catch { /* captured as red evidence below */ }
    if (!dispatched) {
      assert.fail(`M6.3 real chain did not auto-dispatch two tasks (no manual heartbeat/result injection was used).\nExpected: 2 Runs, 2 distinct git worktrees, frozen specs, run.log/run.updated + DONE results.\nActual:\n${diagnostics(sandbox, repo)}`);
    }

    const runs = sandbox.runs();
    assert.equal(runs.length, 2, `exactly two Runs expected, got ${runs.length}`);
    assert.equal(new Set(runs.map((run) => run.taskId)).size, 2);
    for (const run of runs) {
      assert.equal(run.workspace?.kind, "worktree", `Run ${run.id} must have a worktree workspace: ${JSON.stringify(run.workspace)}`);
    }
    assert.notEqual(runs[0].workspace.path, runs[1].workspace.path, "each Run needs its own worktree");
    let registered = sandbox.worktrees(repo);
    try {
      await waitFor(() => {
        registered = sandbox.worktrees(repo);
        if (registered.error) return false;
        return runs.every((run) => registered.includes(path.resolve(run.workspace.path)));
      }, 30000, "both Run worktrees registered");
    } catch { /* asserted below with the real list */ }
    if (registered.error) assert.fail(`git worktree list failed: ${registered.error}`);
    for (const run of runs) {
      assert.ok(registered.includes(path.resolve(run.workspace.path)), `git worktree list must contain ${run.workspace.path}: ${JSON.stringify(registered)}`);
      const frozen = sandbox.runSpec(run.id);
      assert.equal(frozen.spec.workspace.kind, "worktree");
      assert.deepEqual(frozen.spec.workspace, run.workspace, "the runtime gets the same workspace the DB pinned");
    }
    await waitFor(() => sandbox.runs().every((run) => run.status === "COMPLETED"), 30000, "both Runs COMPLETED");
    const logs = sandbox.logs();
    const specPattern = /execution-spec taskVersion=\d+ specHash=[0-9a-f]+ workspace=worktree/;
    const hostLogSeen = Object.values(logs).some((text) => specPattern.test(text));
    const eventLogSeen = runs.some((run) => sandbox.events(run.id).some((event) => event.type === "run.log" && specPattern.test(String(event.payload?.message ?? ""))));
    assert.ok(hostLogSeen || eventLogSeen, `the frozen spec must reach the Runtime (host log or run.log event):\n${JSON.stringify(logs)}`);
    for (const run of runs) {
      const events = sandbox.events(run.id);
      const types = events.map((event) => event.type);
      assert.ok(types.includes("run.updated"), `Run ${run.id} needs run.updated: ${JSON.stringify(types)}`);
      assert.ok(types.includes("run.log"), `Run ${run.id} needs run.log: ${JSON.stringify(types)}`);
      assert.ok(types.filter((type) => type === "run.updated").length >= 2, `Run ${run.id} needs start and end updates: ${JSON.stringify(types)}`);
    }
  });

  // Fault-injection skeleton. Each of these is deliberately a skip until the
  // real chain can dispatch at all; after the protocol freeze they become real
  // red/green gates, not decorative TODOs.
  test("QA-M63.3 network partition: the Outbox survives and retries with one idempotency key", async (t) => {
    let allow = false;
    const client = faultClient({
      onResult: () => {
        if (!allow) return Promise.reject(new Error("ECONNREFUSED"));
        return Promise.resolve({ persisted: true });
      },
    });
    const { host } = makeHost(t, { client });
    await host.tick();
    await waitFor(() => host.outbox().length === 1, 5000, "durable outbox");
    assert.equal(host.outbox().length, 1, "a network failure must keep the terminal fact durable");
    assert.equal(host.stats.completed, 0, "no ACK means no completion");
    allow = true;
    await host.flushOutbox();
    await waitFor(() => host.outbox().length === 0, 5000, "outbox after retry");
    assert.equal(host.stats.completed, 1);
    assert.equal(new Set(client.calls.result.map((call) => call.idempotencyKey)).size, 1, "the retry must reuse the same idempotency key");
  });

  test("QA-M63.4 backend timeout/5xx on the result ACK retries, then completes only after persisted", async (t) => {
    let allow = false;
    const client = faultClient({
      onResult: () => {
        if (!allow) return Promise.reject(new InternalApiError(500, "INTERNAL_ERROR", {}, "ack timeout"));
        return Promise.resolve({ persisted: true });
      },
    });
    const { host } = makeHost(t, { client });
    await host.tick();
    await waitFor(() => client.calls.result.length >= 1 && host.outbox().length === 1, 5000, "first failed ACK + outbox");
    assert.equal(host.stats.completed, 0, "a 5xx is not an acknowledgement");
    allow = true;
    await host.flushOutbox();
    await waitFor(() => host.outbox().length === 0 && host.stats.completed === 1, 6000, "ack after 5xx");
    assert.equal(new Set(client.calls.result.map((call) => call.idempotencyKey)).size, 1);
  });

  test("QA-M63.5 real Host SIGKILL during a worktree Run", async () => {
    const sourceFile = path.join(REPO, "apps/runtime-host/test/restart-recovery.test.mjs");
    const source = readFileSync(sourceFile, "utf8");
    assert.match(source, /SIGKILL/);
    assert.match(source, /RECOVERY_REQUIRED/);
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().includes("NODE_TEST")));
    const result = spawnSync(process.execPath, ["--test", sourceFile], { cwd: REPO, encoding: "utf8", timeout: 120000, windowsHide: true, env: cleanEnv });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /tests [2-9]/);
    assert.match(output, /pass [2-9]/);
    assert.match(output, /fail 0/);
  });

  test("QA-M63.6 an ACK lost after persistence is reconciled, not blindly re-posted", async (t) => {
    const client = faultClient({
      onResult: () => Promise.reject(new Error("socket hang up")),
      onReconcile: () => Promise.resolve({ run: { id: "run-1", status: "COMPLETED" }, command: { id: "CMD-1", status: "DONE", generation: 3, result: { eventId: "qa-fixed-idempotency" } }, persisted: true }),
    });
    const { host } = makeHost(t, { client });
    await host.tick();
    await waitFor(() => client.calls.reconcile.length >= 1, 5000, "reconcile after lost ACK");
    await waitFor(() => host.outbox().length === 0, 5000, "reconciled outbox");
    assert.equal(client.calls.result.length, 1, "a reconcilable lost response must not be re-posted");
    assert.equal(host.stats.completed, 1);
  });

  test("QA-M63.7 an expired lease fences the old generation; the new holder is the only writer", async (t) => {
    const dir = tempDir(t, "atk-m63-lease-");
    const dbFile = path.join(dir, "atk.db");
    const store = openStore({ file: dbFile, migrate: true });
    t.after(() => { try { store.close(); } catch { /* closed */ } });
    store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    store.upsertAgent({ id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const task = store.createTask({ id: "LEASE", projectId: "P1", title: "lease", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    const claimed = store.claimTask({ taskId: task.id, agentId: "agent-1", expectedTaskVersion: task.version, idempotencyKey: "m63-lease", workspace: { kind: "none" } });
    const command = store.claimDispatchCommand({ ownerId: "old-host", leaseMs: 1000 });
    const oldGeneration = command.lease.generation;
    const raw = new DatabaseSync(dbFile);
    try {
      const past = new Date(Date.now() - 5000).toISOString();
      raw.prepare("UPDATE run_leases SET claimed_until = ? WHERE run_id = ?").run(past, claimed.run.id);
      raw.prepare("UPDATE dispatch_commands SET claimed_until = ? WHERE id = ?").run(past, command.command.id);
    } finally { raw.close(); }
    const reclaimed = store.claimDispatchCommand({ ownerId: "new-host", leaseMs: 60000 });
    assert.equal(reclaimed.lease.generation, oldGeneration + 1, "the reclaim must bump the generation");
    await assert.rejects(
      async () => store.applyRuntimeEventBatch({ runId: claimed.run.id, generation: oldGeneration, events: [{ type: "run.log", payload: { line: "late" }, eventId: "OLD", sessionSeq: 1 }] }),
      (error) => error.code === "STALE_GENERATION",
      "the old holder must be fenced",
    );
    const applied = store.applyRuntimeEventBatch({ runId: claimed.run.id, generation: reclaimed.lease.generation, events: [{ type: "run.log", payload: { line: "new" }, eventId: "NEW", sessionSeq: 2 }] });
    assert.equal(applied.applied.length, 1);
    assert.equal(store.listEvents({ aggregateId: claimed.run.id, limit: 100 }).filter((event) => event.eventId).length, 1, "only the new holder may write");
  });

  test("QA-M63.8 a launcher stop failure is not silently reported as success", async (t) => {
    const dir = tempDir(t, "atk-m63-stop-");
    const spawn = launcherFakes.createFakeSpawn();
    const alive = launcherFakes.createAliveMap();
    const clock = launcherFakes.createClock();
    const stopTimeoutMs = 50;
    const launcher = createLauncher({
      dataDir: dir,
      port: 1462,
      hosts: 1,
      spawnImpl: spawn.spawnImpl,
      fetchImpl: launcherFakes.createHealthyFetch(),
      idFactory: () => "qa-fixed-idempotency",
      logger: { info() {}, warn() {}, error() {} },
      now: clock.now,
      sleep: clock.sleep,
      isAliveImpl: alive.isAlive,
      killImpl: () => { throw new Error("EPERM: stop is not permitted"); },
      settleMs: 0,
      healthTimeoutMs: 1000,
      healthIntervalMs: 10,
      tokenTimeoutMs: 1000,
      stopTimeoutMs,
      stopPollMs: 10,
      repoRoot: REPO,
    });
    await launcher.start();
    const result = await launcher.stop({ force: true });
    const survivors = (result.stopped ?? []).filter((entry) => entry.exited !== true);
    const statePresent = existsSync(path.join(dir, "launcher.json"));
    assert.ok(result.code !== 0 || survivors.length > 0 || statePresent, "a failed stop must not look like a clean success");
    assert.ok(survivors.length > 0 || statePresent, "the failed PID tree must not be silently forgotten");
    assert.ok(JSON.stringify(result).includes("EPERM") || statePresent || survivors.length > 0);
  });
}






