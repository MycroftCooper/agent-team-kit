// M3 independent QA: adversarial regression suite (QA-004).
//
// Scope: the M3 "scheduling layer" frozen at 25559b2 - deterministic DAG planning,
// the consistent snapshot, the atomic claimTask, the Scheduler process and the
// m3-smoke gate itself.
//
// Conventions
// - real SQLite and, where the claim is about HTTP, a real `cli.mjs serve`;
// - every test gets its own temp database/directory and cleans up afterwards;
// - tests are written against the M3 contract (docs/architecture/m3-contracts.md),
//   not the implementation. A failing test here is a finding in the report.
//
// Node < 22.5 has no `node:sqlite`: the whole file is skipped, never "passed".
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { INTERNAL } from "../packages/database/src/internal.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "apps", "backend", "cli.mjs");
const STATE = path.join(REPO, ".agent-flow", "state.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

if (!hasSqlite) {
  test("m3 adversarial suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5; this file is skipped, not passed" }, () => {});
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { openStore } = await import(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href);
  const core = await import(pathToFileURL(path.join(REPO, "packages/scheduler-core/src/index.mjs")).href);
  const { createScheduler } = await import(pathToFileURL(path.join(REPO, "apps/scheduler/src/index.mjs")).href);
  const { createSchedulerClient } = await import(pathToFileURL(path.join(REPO, "apps/scheduler/src/client.mjs")).href);
  const quiet = { info() {}, warn() {}, error() {} };
  const NOW = "2026-11-02T00:00:00.000Z";

  function migrate(dbFile) {
    const result = spawnSync(process.execPath, [CLI, "migrate", "--data", dbFile, "--from", STATE, "--json"], { cwd: REPO, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `migrate failed: ${result.stderr || result.stdout}`);
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

  async function makeEnv(t) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m3-qa-"));
    const dbFile = path.join(tmp, "atk.db");
    migrate(dbFile);
    const store = openStore({ file: dbFile, migrate: true });
    const project = store.listProjects()[0];
    const env = {
      tmp,
      dbFile,
      store,
      project,
      nextId: 0,
      backend: null,
      async startBackend() {
        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        const child = spawn(process.execPath, [CLI, "serve", "--port", String(port), "--data", dbFile], {
          cwd: REPO,
          windowsHide: true,
          env: { ...process.env, LOCALAPPDATA: tmp },
        });
        env.backend = child;
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        let healthy = false;
        for (let i = 0; i < 120; i += 1) {
          try {
            if ((await fetch(`${base}/api/v1/system/health`)).ok) {
              healthy = true;
              break;
            }
          } catch {
            /* not up yet */
          }
          await sleep(50);
        }
        assert.ok(healthy, `backend did not start: ${output.slice(-400)}`);
        const token = output.match(/internal token:\s*(\S+)/)?.[1];
        assert.ok(token, `backend did not print an internal token: ${output.slice(-400)}`);
        env.base = base;
        env.internalToken = token;
        env.client = createSchedulerClient({ baseUrl: base, token });
        return env;
      },
      async stopBackend() {
        if (env.backend) {
          env.backend.kill();
          for (let i = 0; i < 60 && env.backend.exitCode === null; i += 1) await sleep(25);
          env.backend = null;
        }
      },
      makeAgent(id, overrides = {}) {
        return store.upsertAgent({ id, role: "DEV", capabilities: ["WORKER"], status: "IDLE", ...overrides });
      },
      makeTask(id, deps = [], overrides = {}) {
        env.nextId += 1;
        store.createTask({
          id,
          projectId: project.id,
          title: id,
          description: `qa ${id}`,
          functionRequired: "WORKER",
          roleRequired: "DEV",
          priority: 2,
          deps,
          acceptance: "qa",
          ...overrides,
        });
        return store.getTask(id);
      },
      fingerprint() {
        const snapshot = store.schedulingSnapshot();
        const raw = new DatabaseSync(dbFile);
        try {
          return {
            version: snapshot.version,
            tasks: snapshot.tasks.map((entry) => `${entry.id}:${entry.status}:${entry.version}`).sort(),
            runs: Number(raw.prepare("SELECT COUNT(*) AS c FROM runs").get().c),
            events: Number(raw.prepare("SELECT COUNT(*) AS c FROM events").get().c),
            commands: Number(raw.prepare("SELECT COUNT(*) AS c FROM dispatch_commands").get().c),
          };
        } finally {
          raw.close();
        }
      },
      counts() {
        const raw = new DatabaseSync(dbFile);
        try {
          return {
            runs: Number(raw.prepare("SELECT COUNT(*) AS c FROM runs").get().c),
            commands: Number(raw.prepare("SELECT COUNT(*) AS c FROM dispatch_commands").get().c),
            perTask: raw.prepare("SELECT task_id, COUNT(*) AS c FROM runs GROUP BY task_id ORDER BY task_id").all(),
            leaseRows: raw.prepare("SELECT COUNT(*) AS c FROM run_leases").get().c,
          };
        } finally {
          raw.close();
        }
      },
      storeClient() {
        return {
          snapshot: async () => store.schedulingSnapshot(),
          claim: async (taskId, proposal) =>
            store.claimTask({
              taskId,
              agentId: proposal.agentId,
              expectedTaskVersion: proposal.expectedTaskVersion,
              policies: proposal.policies,
              idempotencyKey: proposal.idempotencyKey,
              workspacePolicy: proposal.workspacePolicy,
            }),
          heartbeat: async () => ({ ok: true }),
        };
      },
      scheduler(ownerId, policies = { maxConcurrentPerProject: 10, maxPerAgent: 5 }) {
        return createScheduler({ client: env.storeClient(), core: { planDispatch: core.planDispatch }, policies, ownerId, pollMs: 10, logger: quiet });
      },
    };
    t.after(async () => {
      if (env.backend && env.backend.exitCode === null) {
        env.backend.kill();
        for (let i = 0; i < 40 && env.backend.exitCode === null; i += 1) await sleep(25);
      }
      try {
        store.close();
      } catch {
        /* already closed */
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(tmp, { recursive: true, force: true });
          return;
        } catch {
          await sleep(150);
        }
      }
    });
    return env;
  }

  const taskRow = (id, overrides = {}) => ({
    id,
    projectId: "p",
    title: id,
    status: "READY",
    version: 0,
    priority: 2,
    createdAt: "2026-11-01T23:00:00.000Z",
    deps: [],
    files: [],
    functionRequired: "WORKER",
    roleRequired: "DEV",
    ...overrides,
  });
  const agentRow = (id, overrides = {}) => ({ id, role: "DEV", capabilities: ["WORKER"], status: "IDLE", ...overrides });
  const policies = { maxConcurrentPerProject: 10, maxPerAgent: 5 };
  const plan = (tasks, agents = [agentRow("a1")], extra = {}) =>
    core.planDispatch({ snapshot: { version: 1, projects: [{ id: "p", policy: {} }], tasks, agents, runs: [], leases: [], ...extra }, policies, now: NOW });

  // -------------------------------------------------------------------------
  // A. scheduling algorithm (pure)
  // -------------------------------------------------------------------------
  test("A1 every cycle shape is refused wholesale with zero proposals", async () => {
    const shapes = {
      direct: [taskRow("A", { deps: ["B"] }), taskRow("B", { deps: ["A"] })],
      self: [taskRow("A", { deps: ["A"] })],
      indirect: [taskRow("A", { deps: ["B"] }), taskRow("B", { deps: ["C"] }), taskRow("C", { deps: ["A"] })],
      disjoint: [taskRow("A", { deps: ["B"] }), taskRow("B", { deps: ["A"] }), taskRow("C", { deps: ["D"] }), taskRow("D", { deps: ["C"] })],
    };
    for (const [name, tasks] of Object.entries(shapes)) {
      const detected = core.detectCycles(tasks);
      assert.equal(detected.ok, false, `${name}: cycles must be detected`);
      const result = plan(tasks);
      assert.deepEqual(result.proposals, [], `${name}: a cyclic snapshot must produce no proposals`);
      assert.equal(result.skipped.length, tasks.length, `${name}: every task must be reported`);
      assert.ok(result.skipped.every((entry) => entry.reason === "cycle"), `${name}: all skipped reasons must be cycle`);
    }
  });

  test("A2 detectCycles reports every simple cycle (not just one per DFS branch)", async () => {
    // A depends on B and C; B and C both depend on D; D depends on A. There are
    // two simple cycles: A->B->D->A and A->C->D->A.
    const tasks = [taskRow("A", { deps: ["B", "C"] }), taskRow("B", { deps: ["D"] }), taskRow("C", { deps: ["D"] }), taskRow("D", { deps: ["A"] })];
    const detected = core.detectCycles(tasks);
    assert.equal(detected.ok, false);
    assert.equal(detected.cycles.length, 2, `expected both simple cycles, got ${JSON.stringify(detected.cycles)}`);
  });

  test("A3 topological order is dependency-correct and input-order independent", async () => {
    const tasks = [taskRow("A"), taskRow("B", { deps: ["A"] }), taskRow("C", { deps: ["A"] }), taskRow("D", { deps: ["B", "C"] })];
    const forward = core.topologicalOrder(tasks);
    const shuffled = core.topologicalOrder([tasks[3], tasks[1], tasks[0], tasks[2]]);
    assert.equal(forward.ok, true);
    assert.deepEqual(forward, shuffled, "the topological order must not depend on input order");
    const position = new Map(forward.order.map((id, index) => [id, index]));
    for (const item of tasks) for (const dep of item.deps) assert.ok(position.get(dep) < position.get(item.id), `${dep} must come before ${item.id}`);
    assert.deepEqual(forward.levels, [["A"], ["B", "C"], ["D"]]);
  });

  test("A4 planDispatch is deterministic under shuffled tasks/agents/runs", async () => {
    const tasks = [taskRow("A", { priority: 1 }), taskRow("B", { priority: 1 }), taskRow("C", { priority: 2 }), taskRow("D", { deps: ["A"] })];
    const agents = [agentRow("a1"), agentRow("a2")];
    const one = plan(tasks, agents);
    const two = plan([...tasks].reverse(), [...agents].reverse());
    assert.equal(JSON.stringify(one), JSON.stringify(two), "same snapshot must give a byte-identical plan");
    assert.deepEqual(one.proposals.map((entry) => entry.taskId), ["A", "B", "C"]);
    assert.deepEqual(one.skipped.map((entry) => `${entry.taskId}:${entry.reason}`), ["D:deps-incomplete"]);
  });

  test("A5 100 tasks / 20 agents stays fast, bounded and deterministic", async () => {
    const bigTasks = [];
    for (let index = 0; index < 100; index += 1) {
      bigTasks.push(taskRow(`T${String(index).padStart(3, "0")}`, { deps: index < 10 ? [] : [`T${String(index - 10).padStart(3, "0")}`], priority: (index % 5) + 1 }));
    }
    const bigAgents = Array.from({ length: 20 }, (_, index) => agentRow(`agent-${String(index).padStart(2, "0")}`));
    const started = Date.now();
    const one = core.planDispatch({ snapshot: { version: 1, projects: [{ id: "p", policy: {} }], tasks: bigTasks, agents: bigAgents, runs: [], leases: [] }, policies: { maxConcurrentPerProject: 100, maxPerAgent: 2 }, now: NOW });
    const two = core.planDispatch({ snapshot: { version: 1, projects: [{ id: "p", policy: {} }], tasks: [...bigTasks].reverse(), agents: [...bigAgents].reverse(), runs: [], leases: [] }, policies: { maxConcurrentPerProject: 100, maxPerAgent: 2 }, now: NOW });
    assert.equal(JSON.stringify(one), JSON.stringify(two));
    assert.ok(Date.now() - started < 5000, "100x20 planning must not be pathological");
    assert.ok(one.proposals.length <= 10, `dependency roots are at most 10, got ${one.proposals.length}`);
    const positions = new Map(one.proposals.map((entry, index) => [entry.taskId, index]));
    for (const entry of one.proposals) assert.ok(positions.has(entry.taskId));
  });

  test("A6 skip reasons distinguish dependencies, capacity, agents and write scope", async () => {
    const base = { version: 1, projects: [{ id: "p", policy: {} }], leases: [] };
    // dependency
    const depPlan = core.planDispatch({ snapshot: { ...base, tasks: [taskRow("A", { status: "READY" }), taskRow("B", { deps: ["A"] })], agents: [agentRow("a1")], runs: [] }, policies, now: NOW });
    assert.equal(depPlan.skipped.find((entry) => entry.taskId === "B")?.reason, "deps-incomplete");
    // capacity (agent is idle on paper but already owns a live Run)
    const capPlan = core.planDispatch({ snapshot: { ...base, tasks: [taskRow("C")], agents: [agentRow("a1")], runs: [{ id: "R1", taskId: "X", agentId: "a1", status: "RUNNING", files: [] }] }, policies: { maxConcurrentPerProject: 10, maxPerAgent: 1 }, now: NOW });
    assert.equal(capPlan.skipped.find((entry) => entry.taskId === "C")?.reason, "capacity");
    // write scope
    const wsPlan = core.planDispatch({ snapshot: { ...base, tasks: [taskRow("D", { files: ["src/a.ts"] })], agents: [agentRow("a1")], runs: [{ id: "R1", taskId: "X", agentId: "other", status: "RUNNING", files: ["src/a.ts"] }] }, policies, now: NOW });
    assert.equal(wsPlan.skipped.find((entry) => entry.taskId === "D")?.reason, "write-scope-conflict");
    // no idle agent
    const busyPlan = core.planDispatch({ snapshot: { ...base, tasks: [taskRow("E")], agents: [agentRow("a1", { status: "BUSY" })], runs: [] }, policies, now: NOW });
    assert.equal(busyPlan.skipped.find((entry) => entry.taskId === "E")?.reason, "no-idle-agent");
  });

  // -------------------------------------------------------------------------
  // B. claimTask atomicity / idempotency / zero-write failures
  // -------------------------------------------------------------------------
  test("B1 a successful claim creates one Run, one PENDING command, two events", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    const task = env.makeTask("K1");
    const before = env.fingerprint();
    const result = env.store.claimTask({ taskId: "K1", agentId: "agent-A", expectedTaskVersion: task.version, policies: { maxConcurrentPerProject: 5, maxPerAgent: 5 }, idempotencyKey: "claim-K1" });
    const after = env.fingerprint();
    assert.equal(result.run.status, "STARTING");
    assert.equal(result.command.status, "PENDING");
    assert.equal(result.task.status, "CLAIMED");
    assert.equal(result.task.version, 1);
    assert.equal(after.version - before.version, 2, "claim appends task.updated + run.created, so snapshot version moves by 2");
    assert.equal(after.runs - before.runs, 1);
    assert.equal(after.events - before.events, 2);
  });

  test("B2 two real processes claiming the same task produce one winner and one conflict", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    const task = env.makeTask("K2");
    const child = path.join(env.tmp, "claim-child.mjs");
    writeFileSync(
      child,
      `import { openStore } from ${JSON.stringify(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href)};
const [db, taskId, version, key, startAt] = process.argv.slice(2);
const store = openStore({ file: db, migrate: true });
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));
let out;
try {
  const result = store.claimTask({ taskId, agentId: "agent-A", expectedTaskVersion: Number(version), policies: {}, idempotencyKey: key });
  out = { ok: true, runId: result.run.id };
} catch (error) {
  out = { ok: false, code: error.code, reason: error.details?.reason ?? null };
}
store.close();
process.stdout.write(JSON.stringify(out));
`,
    );
    const startAt = Date.now() + 600;
    const childRun = (key) =>
      new Promise((resolve) => {
        const childProcess = spawn(process.execPath, [child, env.dbFile, "K2", String(task.version), key, String(startAt)], { cwd: env.tmp, windowsHide: true });
        let output = "";
        childProcess.stdout.on("data", (chunk) => (output += chunk));
        childProcess.on("close", () => {
          try {
            resolve(JSON.parse(output));
          } catch {
            resolve({ raw: output });
          }
        });
      });
    const results = await Promise.all([childRun("race-a-K2"), childRun("race-b-K2")]);
    const winners = results.filter((entry) => entry.ok);
    assert.equal(winners.length, 1, `exactly one claim may win: ${JSON.stringify(results)}`);
    const counts = env.counts();
    assert.equal(counts.runs, 1);
    assert.equal(counts.perTask.length, 1);
    assert.equal(counts.perTask[0].c, 1);
  });

  test("B3 idempotencyKey replay returns the original run/command without writes", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    const task = env.makeTask("K3");
    const first = env.store.claimTask({ taskId: "K3", agentId: "agent-A", expectedTaskVersion: task.version, policies: {}, idempotencyKey: "idem-K3" });
    const before = env.fingerprint();
    const second = env.store.claimTask({ taskId: "K3", agentId: "agent-A", expectedTaskVersion: task.version, policies: {}, idempotencyKey: "idem-K3" });
    const after = env.fingerprint();
    assert.equal(second.run.id, first.run.id);
    assert.equal(second.command.id, first.command.id);
    assert.deepEqual(after, before, "a replay must not write anything");

    env.makeTask("K3-other");
    assert.throws(
      () => env.store.claimTask({ taskId: "K3-other", agentId: "agent-A", expectedTaskVersion: 0, policies: {}, idempotencyKey: "idem-K3" }),
      (error) => error.code === "VALIDATION_ERROR" && error.details?.existingTaskId === "K3",
      "reusing a key for another task must be a validation error",
    );
  });

  test("B4 the five claim failure classes are zero-write and correctly coded", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeAgent("agent-B");
    env.makeAgent("agent-BUSY", { status: "BUSY" });
    env.makeAgent("agent-WRONG", { role: "QA" });
    env.makeAgent("agent-CAP");
    env.makeTask("F1");
    const dep = env.makeTask("F2");
    const blocked = env.makeTask("F3", [dep.id]);
    const busyTask = env.makeTask("F4");
    const roleTask = env.makeTask("F5");
    const capacityTarget = env.makeTask("F6b");
    env.store.claimTask({ taskId: "F6b", agentId: "agent-CAP", expectedTaskVersion: capacityTarget.version, policies: { maxPerAgent: 1 }, idempotencyKey: "f-cap-1" });
    const capacitySecond = env.makeTask("F6c");
    const wsOwner = env.makeTask("F7", [], { files: ["src/shared.js"] });
    env.store.claimTask({ taskId: "F7", agentId: "agent-B", expectedTaskVersion: wsOwner.version, policies: {}, idempotencyKey: "f-ws-owner" });
    const wsTarget = env.makeTask("F8", [], { files: ["src/shared.js"] });

    const cases = [
      ["version-mismatch", () => env.store.claimTask({ taskId: "F1", agentId: "agent-A", expectedTaskVersion: 99, policies: {}, idempotencyKey: "f-version" }), "TASK_VERSION_CONFLICT"],
      ["dependency-blocked", () => env.store.claimTask({ taskId: "F3", agentId: "agent-A", expectedTaskVersion: blocked.version, policies: {}, idempotencyKey: "f-dep" }), "TASK_DEPENDENCY_BLOCKED"],
      ["agent-not-idle", () => env.store.claimTask({ taskId: "F4", agentId: "agent-BUSY", expectedTaskVersion: busyTask.version, policies: {}, idempotencyKey: "f-busy" }), "CAPABILITY_UNAVAILABLE"],
      ["role-mismatch", () => env.store.claimTask({ taskId: "F5", agentId: "agent-WRONG", expectedTaskVersion: roleTask.version, policies: {}, idempotencyKey: "f-role" }), "CAPABILITY_UNAVAILABLE"],
      ["capacity", () => env.store.claimTask({ taskId: "F6c", agentId: "agent-CAP", expectedTaskVersion: capacitySecond.version, policies: { maxPerAgent: 1 }, idempotencyKey: "f-cap-2" }), "CAPABILITY_UNAVAILABLE"],
      ["write-scope", () => env.store.claimTask({ taskId: "F8", agentId: "agent-A", expectedTaskVersion: wsTarget.version, policies: {}, idempotencyKey: "f-ws" }), "CAPABILITY_UNAVAILABLE"],
    ];
    for (const [name, fn, expectedCode] of cases) {
      const before = env.fingerprint();
      let error = null;
      try {
        fn();
      } catch (caught) {
        error = caught;
      }
      const after = env.fingerprint();
      assert.ok(error, `${name}: claim must fail`);
      assert.equal(error.code, expectedCode, `${name}: wrong error code`);
      assert.deepEqual(after, before, `${name}: a failed claim must be byte-for-byte zero-write`);
    }
  });

  test("B5 HTTP claim: success, same-process replay, dependency refusal and zero writes", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeTask("H1");
    const blockedDep = env.makeTask("H2");
    env.makeTask("H3", [blockedDep.id]);
    await env.startBackend();
    const snapshot = await env.client.snapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ["agents", "generatedAt", "leases", "projects", "runs", "tasks", "version"]);
    const h1 = snapshot.tasks.find((entry) => entry.id === "H1");
    const body = (taskId, version, key) => ({ agentId: "agent-A", expectedTaskVersion: version, policies: { maxConcurrentPerProject: 5, maxPerAgent: 5 }, idempotencyKey: key });
    const first = await env.client.claim("H1", body("H1", h1.version, "http-H1"));
    assert.equal(first.run.status, "STARTING");
    assert.equal(first.command.status, "PENDING");
    assert.equal(first.task.status, "CLAIMED");
    const replay = await env.client.claim("H1", body("H1", h1.version, "http-H1"));
    assert.equal(replay.run.id, first.run.id);
    assert.equal(replay.command.id, first.command.id);

    const before = env.fingerprint();
    await assert.rejects(() => env.client.claim("H3", body("H3", 0, "http-H3")), (error) => error.code === "TASK_DEPENDENCY_BLOCKED");
    const after = env.fingerprint();
    assert.deepEqual(after, before, "the backend's pre-check must not write on a refused claim");
  });

  test("B6 an idempotencyKey replay survives a Backend restart (m3-contracts §5)", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeTask("R1");
    await env.startBackend();
    const snapshot = await env.client.snapshot();
    const r1 = snapshot.tasks.find((entry) => entry.id === "R1");
    const body = { agentId: "agent-A", expectedTaskVersion: r1.version, policies: { maxConcurrentPerProject: 5, maxPerAgent: 5 }, idempotencyKey: "restart-R1" };
    const first = await env.client.claim("R1", body);
    await env.stopBackend();
    await env.startBackend();
    let replay;
    try {
      replay = await env.client.claim("R1", body);
    } catch (error) {
      assert.fail(`a replay after a Backend restart must return the original result, got ${error.status} ${error.code} ${JSON.stringify(error.details)}`);
    }
    assert.equal(replay.run.id, first.run.id, "the replay must return the original Run");
    assert.equal(replay.command.id, first.command.id);
  });

  // -------------------------------------------------------------------------
  // C. single lease / capacity
  // -------------------------------------------------------------------------
  test("C1 one Run never has two live leases even with concurrent hosts", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeTask("L1");
    const scheduler = env.scheduler("lease-scheduler");
    await scheduler.runOnce();
    await scheduler.stop();
    const counts = env.counts();
    assert.equal(counts.runs, 1);
    const run = env.store.listRuns({})[0];
    const runId = run.id;
    const first = env.store.claimDispatchCommand({ ownerId: "host-1", leaseMs: 5000 });
    assert.ok(first);
    assert.equal(env.store.claimDispatchCommand({ ownerId: "host-2", leaseMs: 5000 }), null, "a second host must not get a live lease");
    const raw = new DatabaseSync(env.dbFile);
    try {
      const live = raw.prepare("SELECT COUNT(*) AS c FROM run_leases WHERE run_id = ? AND claimed_until > ?").get(runId, new Date().toISOString()).c;
      assert.equal(Number(live), 1);
    } finally {
      raw.close();
    }
  });

  test("C2 the backend enforces maxPerAgent and maxConcurrentPerProject", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeTask("CAP1");
    env.makeTask("CAP2");
    const task1 = env.store.getTask("CAP1");
    env.store.claimTask({ taskId: "CAP1", agentId: "agent-A", expectedTaskVersion: task1.version, policies: { maxPerAgent: 1, maxConcurrentPerProject: 1 }, idempotencyKey: "cap-1" });
    const task2 = env.store.getTask("CAP2");
    assert.throws(
      () => env.store.claimTask({ taskId: "CAP2", agentId: "agent-A", expectedTaskVersion: task2.version, policies: { maxPerAgent: 1, maxConcurrentPerProject: 1 }, idempotencyKey: "cap-2" }),
      (error) => error.code === "CAPABILITY_UNAVAILABLE" && error.details?.reason === "capacity",
    );
    assert.equal(env.counts().runs, 1);
  });

  // -------------------------------------------------------------------------
  // D. Scheduler process
  // -------------------------------------------------------------------------
  test("D1 the Scheduler CLI is a runnable process (--help and --once)", async () => {
    const cli = path.join(REPO, "apps", "scheduler", "cli.mjs");
    const help = spawnSync(process.execPath, [cli, "--help"], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(help.status, 0, `scheduler --help must exit 0, got ${help.status}: ${help.stderr.slice(0, 600)}`);
    assert.match(`${help.stdout}${help.stderr}`, /Usage: atk-scheduler/);
    const once = spawnSync(process.execPath, [cli, "--once", "--owner", "cli-probe"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: { ...process.env, ATK_BACKEND_URL: "http://127.0.0.1:1", ATK_INTERNAL_TOKEN: "probe-token" },
    });
    assert.equal(once.status, 0, `scheduler --once with an unreachable backend must still exit 0, got ${once.status}: ${once.stderr.slice(0, 600)}`);
    const parsed = JSON.parse(once.stdout.trim());
    assert.equal(parsed.result.ok, false);
    assert.equal(parsed.result.reason, "snapshot-failed");
  });

  test("D2 two Scheduler instances running at once never dispatch the same task twice", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeAgent("agent-B");
    env.makeTask("S1");
    env.makeTask("S2");
    env.makeTask("S3");
    const one = env.scheduler("sched-one");
    const two = env.scheduler("sched-two");
    const [first, second] = await Promise.all([one.runOnce(), two.runOnce()]);
    await one.stop();
    await two.stop();
    const counts = env.counts();
    assert.equal(counts.runs, 3, "each task may have at most one Run");
    for (const entry of counts.perTask) assert.equal(entry.c, 1, `task ${entry.task_id} has ${entry.c} runs`);
    const claimedIds = [...first.results, ...second.results].filter((entry) => entry.claimed).map((entry) => entry.taskId);
    assert.deepEqual([...new Set(claimedIds)].sort(), ["S1", "S2", "S3"]);
  });

  test("D3 a restarted Scheduler neither duplicates nor loses READY work; stop keeps in-flight Runs", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeTask("RS1");
    const first = env.scheduler("sched-first");
    await first.runOnce();
    await first.stop();
    env.makeTask("RS2");
    const restarted = env.scheduler("sched-restarted");
    const round = await restarted.runOnce();
    await restarted.stop();
    assert.deepEqual(round.results.filter((entry) => entry.claimed).map((entry) => entry.taskId), ["RS2"], "the restarted scheduler must only claim new READY work");
    const counts = env.counts();
    assert.equal(counts.runs, 2);
    for (const entry of counts.perTask) assert.equal(entry.c, 1);
    const afterStop = env.counts().perTask.find((entry) => entry.task_id === "RS1");
    assert.equal(afterStop.c, 1, "stop() must not cancel or delete the dispatched Run");
  });

  test("D4 snapshot failures back off exponentially and never throw", async (t) => {
    let calls = 0;
    const failing = {
      snapshot: async () => {
        calls += 1;
        throw new Error("snapshot down");
      },
      claim: async () => {
        throw new Error("claim must not be called without a snapshot");
      },
      heartbeat: async () => ({ ok: true }),
    };
    const scheduler = createScheduler({ client: failing, core: { planDispatch: core.planDispatch }, policies, ownerId: "backoff", pollMs: 10, logger: quiet });
    const one = await scheduler.runOnce();
    const two = await scheduler.runOnce();
    const three = await scheduler.runOnce();
    await scheduler.stop();
    assert.deepEqual([one.backoffMs, two.backoffMs, three.backoffMs], [1000, 2000, 4000]);
    assert.equal(one.ok, false);
    assert.equal(scheduler.failures().length, 3);
    assert.equal(calls, 3);
  });

  // -------------------------------------------------------------------------
  // E. migration and snapshot version
  // -------------------------------------------------------------------------
  test("E1 a v2 database upgrades to v3 in place and keeps its rows", async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m3-mig-"));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const db = path.join(dir, "atk.db");
    const raw = new DatabaseSync(db);
    raw.exec(readFileSync(path.join(REPO, "packages/database/migrations/0001_init.sql"), "utf8"));
    raw.exec(readFileSync(path.join(REPO, "packages/database/migrations/0002_runs_dispatch.sql"), "utf8"));
    raw.exec(`INSERT INTO schema_migrations (version,name,applied_at) VALUES (1,'0001_init.sql','${new Date().toISOString()}')`);
    raw.exec(`INSERT INTO schema_migrations (version,name,applied_at) VALUES (2,'0002_runs_dispatch.sql','${new Date().toISOString()}')`);
    raw.exec("INSERT INTO projects (id,name,repo_path,default_branch,created_at,updated_at) VALUES ('V2P','v2','.','main','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    raw.exec("INSERT INTO tasks (id,project_id,title,description,function_required,role_required,priority,status,created_at,updated_at) VALUES ('V2T','V2P','v2 task','d','WORKER','DEV',2,'READY','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    raw.close();
    const upgraded = openStore({ file: db, migrate: true });
    try {
      assert.ok(upgraded.health().schemaVersion >= 3, "a v2 database must upgrade to at least schema v3");
      assert.equal(upgraded.getTask("V2T").status, "READY");
      assert.equal(upgraded.getProject("V2P").name, "v2");
    } finally {
      upgraded.close();
    }
    const reopened = openStore({ file: db, migrate: true });
    try {
      assert.ok(reopened.health().schemaVersion >= 3);
    } finally {
      reopened.close();
    }
    const check = new DatabaseSync(db);
    try {
      assert.ok(check.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name = 'policy_json'").get());
      assert.ok(check.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'files_json'").get());
      assert.ok(check.prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name = 'files_json'").get());
    } finally {
      check.close();
    }
  });

  test("E2 a lost 0003 bookkeeping row self-heals instead of failing", async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m3-heal-"));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const db = path.join(dir, "atk.db");
    migrate(db);
    const first = openStore({ file: db, migrate: true });
    first.close();
    const raw = new DatabaseSync(db);
    raw.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
    raw.close();
    let healed;
    try {
      healed = openStore({ file: db, migrate: true });
    } catch (error) {
      assert.fail(`a lost bookkeeping row must self-heal, got ${error.message}`);
    }
    try {
      assert.ok(healed.health().schemaVersion >= 3);
      assert.ok(healed.listProjects().length >= 1, "data must survive the self-heal");
    } finally {
      healed.close();
    }
  });

  test("E3 snapshot.version never moves on failure and grows by two per claim", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeTask("V1");
    const before = env.store.schedulingSnapshot().version;
    assert.throws(() => env.store.claimTask({ taskId: "V1", agentId: "agent-A", expectedTaskVersion: 9, policies: {}, idempotencyKey: "v-fail" }));
    const afterFailure = env.store.schedulingSnapshot().version;
    const task = env.store.getTask("V1");
    env.store.claimTask({ taskId: "V1", agentId: "agent-A", expectedTaskVersion: task.version, policies: {}, idempotencyKey: "v-ok" });
    const afterSuccess = env.store.schedulingSnapshot().version;
    assert.equal(afterFailure, before, "a failed claim must not move the snapshot version");
    assert.equal(afterSuccess - afterFailure, 2, "task.updated + run.created are exactly two events");
  });

  // -------------------------------------------------------------------------
  // F. contract shapes, gate self-audit and real-DB cycle
  // -------------------------------------------------------------------------
  test("F1 readyCandidates reports missingDeps in the contract §5 shape", async () => {
    const ready = core.readyCandidates({ tasks: [taskRow("A", { deps: ["MISSING"] }), taskRow("B")] });
    assert.deepEqual(ready.candidates.map((entry) => entry.id), ["B"]);
    assert.deepEqual(ready.missingDeps, [{ taskId: "A", missing: ["MISSING"] }]);
  });

  test("F2 a real database containing a cycle yields zero claims end to end", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeTask("C-OK");
    env.makeTask("C-B");
    env.makeTask("C-A", ["C-B"]);
    const raw = new DatabaseSync(env.dbFile);
    try {
      raw.prepare("INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)").run("C-B", "C-A", new Date().toISOString());
    } finally {
      raw.close();
    }
    const snapshot = env.store.schedulingSnapshot();
    const planResult = core.planDispatch({ snapshot, policies, now: new Date().toISOString() });
    assert.deepEqual(planResult.proposals, [], "the whole plan must be refused");
    assert.ok(planResult.skipped.every((entry) => entry.reason === "cycle"));
    const scheduler = env.scheduler("cycle-scheduler");
    const round = await scheduler.runOnce();
    await scheduler.stop();
    assert.equal(round.proposals, 0);
    assert.deepEqual(round.results, []);
    const counts = env.counts();
    assert.equal(counts.runs, 0, "a cyclic snapshot must not produce a Run");
    for (const task of ["C-OK", "C-B", "C-A"]) assert.equal(env.store.getTask(task).status, "READY");
  });

  test("F3 the m3 gate itself is green and every check is a real PASS", async (t) => {
    const result = spawnSync(process.execPath, [path.join(REPO, "scripts", "m3-smoke.mjs")], { cwd: REPO, encoding: "utf8", timeout: 180000, windowsHide: true });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `m3-smoke failed:\n${combined.slice(-2000)}`);
    assert.doesNotMatch(result.stdout, /^FAIL/m);
    const summary = result.stdout.match(/(\d+)\/(\d+) checks passed/);
    assert.ok(summary, `missing N/N summary:\n${result.stdout.slice(-500)}`);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[1]) >= 5, "the gate must keep its five checks");
    // Privacy: M3 sources/docs must not embed tokens or the current machine name.
    const files = [];
    const collect = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.isFile() && /\.(mjs|js|ts|json|md)$/.test(entry.name)) files.push(full);
      }
    };
    for (const relative of ["apps/scheduler", "packages/scheduler-core"]) collect(path.join(REPO, relative));
    for (const relative of ["docs/architecture/m3-contracts.md", "docs/roadmap/m3-status.md", "scripts/m3-smoke.mjs"]) files.push(path.join(REPO, relative));
    const userName = process.env.USERNAME;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.ok(!/\bsk-[A-Za-z0-9_-]{12,}/.test(text), `${file} contains an sk-* secret`);
      if (userName) assert.ok(!text.includes(userName), `${file} contains the machine username`);
    }
  });

  test("F4 acceptance is still manual: a COMPLETED Run does not advance the Task (documented limitation)", async (t) => {
    const env = await makeEnv(t);
    env.makeAgent("agent-A");
    env.makeTask("ACC1");
    env.makeTask("ACC2", ["ACC1"]);
    await env.startBackend();
    const snapshot = await env.client.snapshot();
    const acc1 = snapshot.tasks.find((entry) => entry.id === "ACC1");
    await env.client.claim("ACC1", { agentId: "agent-A", expectedTaskVersion: acc1.version, policies, idempotencyKey: "acc-1" });
    const { createInternalClient } = await import(pathToFileURL(path.join(REPO, "apps/runtime-host/src/client.mjs")).href);
    const internal = createInternalClient({ baseUrl: env.base, token: env.internalToken });
    const hostClaim = await internal.claim({ ownerId: "host-acc", leaseMs: 5000 });
    assert.ok(hostClaim, "the scheduler-created command must be claimable by a host");
    // Finish the Run through the real internal API: the Task must NOT move on its own.
    await internal.events(hostClaim.run.id, {
      generation: hostClaim.lease.generation,
      events: [
        { type: "session.started", sessionId: "acc", at: new Date().toISOString() },
        { type: "session.ended", sessionId: "acc", reason: "completed", exitCode: 0, at: new Date().toISOString() },
      ],
    });
    await internal.result(hostClaim.command.id, { ownerId: hostClaim.lease.ownerId, generation: hostClaim.lease.generation, status: "DONE", exitCode: 0 });
    const afterRun = env.store.getTask("ACC1");
    assert.equal(afterRun.status, "CLAIMED", "M3 has no automatic acceptance: a COMPLETED Run leaves the Task CLAIMED (documented in m3-status §5.1)");
    // Manual legal chain. Since M4, DONE is reachable only through a human
    // approval, so the chain stops at AWAITING_ACCEPTANCE and the test goes
    // through a real PASS review plus an APPROVED approval (Lead updated this
    // file after QA-005 changed the invariant; QA was informed).
    // M6.1 F01: execution-state edges are service-only; this test seeds the
    // state through the internal store hatch (fixture, not an assertion).
    env.store[INTERNAL].setTaskStatus("ACC1", "REVIEWING");
    const manifestHash = "a".repeat(64);
    const review = env.store.createReview({ taskId: "ACC1", actor: "agent-QA-01" });
    env.store.submitReview({
      id: review.id,
      expectedVersion: review.version,
      verdict: "PASS",
      manifestHash,
      evidence: { tests: { passed: 1, total: 1 } },
      actor: "agent-QA-01",
    });
    env.store[INTERNAL].setTaskStatus("ACC1", "AWAITING_ACCEPTANCE");
    const approval = env.store.createApproval({ taskId: "ACC1", scope: "candidate", targetHash: manifestHash, actor: "HUMAN" });
    env.store.decideApproval({ id: approval.id, decision: "APPROVED", actor: "HUMAN", targetHash: manifestHash });
    assert.equal(env.store.getTask("ACC1").status, "DONE", "the approved task must reach DONE");
    const scheduler = env.scheduler("acceptance-scheduler");
    const round = await scheduler.runOnce();
    await scheduler.stop();
    assert.ok(round.results.some((entry) => entry.claimed && entry.taskId === "ACC2"), "the dependent task must be dispatched once the root is DONE by hand");
  });
}
