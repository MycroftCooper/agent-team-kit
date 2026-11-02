#!/usr/bin/env node
// M3 end-to-end gate: real backend + real SQLite + real scheduler + real host.
//
// It seeds a small dependency graph, then drives the scheduler and a mock runtime
// to prove the M3 promises:
//   1. dependency order  - only the root task is dispatched while its dependent is
//                          READY but blocked (and the block is reported, not hidden);
//   2. a cycle           - is refused wholesale, with zero claims;
//   3. no double claim   - re-running the scheduler (a restart) never dispatches
//                          an already claimed task twice;
//   4. one live lease    - per run, at every point;
//   5. full chain        - once the root is accepted (legal status transitions by
//                          a human/CLI), the next task is dispatched.
//
// Usage: node scripts/m3-smoke.mjs [--verbose]
// Exit: 0 = all checks pass, 1 = a check failed, 2 = prerequisites missing.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_CLI = path.join(ROOT, "apps", "backend", "cli.mjs");
const STATE = path.join(ROOT, ".agent-flow", "state.json");
const verbose = process.argv.includes("--verbose");
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

for (const required of [BACKEND_CLI, STATE]) {
  if (!existsSync(required)) {
    process.stderr.write(`m3-smoke: missing ${required}\n`);
    process.exit(2);
  }
}

const { openStore } = await load("packages/database/src/index.mjs");
const { INTERNAL } = await load("packages/database/src/internal.mjs");
const { planDispatch } = await load("packages/scheduler-core/src/index.mjs");
const { createSchedulerClient } = await load("apps/scheduler/src/client.mjs");
const { createScheduler } = await load("apps/scheduler/src/index.mjs");
const { createInternalClient } = await load("apps/runtime-host/src/client.mjs");
const { createHost } = await load("apps/runtime-host/src/host.mjs");
const { createMockRuntime } = await load("packages/runtime-sdk/src/mock.mjs");

const quietLogger = { info: () => {}, warn: () => {}, error: (m) => verbose && process.stderr.write(`${m}\n`) };
const checks = [];
const results = [];
function check(name, fn) {
  checks.push(async () => {
    try {
      return { name, ok: true, detail: (await fn()) ?? "" };
    } catch (error) {
      return { name, ok: false, detail: String(error?.message ?? error) };
    }
  });
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 20000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m3-smoke-"));
const dbFile = path.join(tmp, "atk.db");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const POLICIES = { maxConcurrentPerProject: 4, maxPerAgent: 1 };

const migrate = spawnSync(process.execPath, [BACKEND_CLI, "migrate", "--data", dbFile, "--from", STATE, "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  windowsHide: true,
});
if (migrate.status !== 0) {
  process.stderr.write(`m3-smoke: migrate failed (exit ${migrate.status})\n${migrate.stdout}\n${migrate.stderr}\n`);
  process.exit(1);
}

const store = openStore({ file: dbFile, migrate: true });
let backend = null;
let backendOut = "";
let internalTokens = { scheduler: "", host: "" };
let publicToken = "";
let csrf = "";

function seedTask({ id, title, deps = [], priority = 2, status = "READY" }) {
  const project = store.listProjects()[0];
  const task = store.createTask({
    id,
    projectId: project.id,
    title,
    description: `${title} (m3-smoke)`,
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority,
    deps,
    acceptance: "smoke",
  });
  if (status !== "READY") store[INTERNAL].setTaskStatus(task.id, status); // fixture seed (F01: no public direct transition)
  return store.getTask(task.id);
}

function seedAgents(count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const id = `agent-dev-${index + 1}`;
    ids.push(id);
    store.upsertAgent({ id, role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
  }
  // M6.2 F10: IDLE alone is not dispatchable - the scheduler also requires a
  // heartbeat inside the TTL, so the fixture registers one for its hosts.
  if (typeof store.recordHeartbeat === "function") {
    store.recordHeartbeat({ hostId: "m3-smoke", agentIds: ids, capacity: 1 });
  }
}

async function startBackend() {
  backend = spawn(process.execPath, [BACKEND_CLI, "serve", "--port", String(port), "--data", dbFile, "--web-dist", path.join(ROOT, "apps", "web", "dist")], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: tmp },
  });
  backend.stdout.on("data", (chunk) => (backendOut += chunk));
  backend.stderr.on("data", (chunk) => (backendOut += chunk));
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/api/v1/system/health`)).ok;
    } catch {
      return false;
    }
  }, 20000, "backend health");
  // M6.3: one credential per internal role; fleet them out where they belong.
  const both = backendOut.match(/internal tokens:\s*scheduler=(\S+)\s+runtime-host=(\S+)/);
  const legacy = backendOut.match(/internal token:\s*(\S+)/);
  if (!both && !legacy) throw new Error(`backend did not print internal credentials:\n${backendOut}`);
  internalTokens = both
    ? { scheduler: both[1], host: both[2] }
    : { scheduler: legacy[1], host: legacy[1] };
  const session = await (await fetch(`${base}/api/v1/session`)).json();
  publicToken = session.token;
  csrf = session.csrf;
}

async function getTask(taskId) {
  const response = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers: { "x-atk-token": publicToken } });
  if (!response.ok) throw new Error(`GET task ${taskId}: ${response.status}`);
  return response.json();
}
async function patchTask(taskId, changes) {
  const current = await getTask(taskId);
  const response = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: { "x-atk-token": publicToken, "x-atk-csrf": csrf, "content-type": "application/json", origin: base },
    body: JSON.stringify({ expectedVersion: current.version, ...changes }),
  });
  if (!response.ok) throw new Error(`PATCH task ${taskId}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function liveLeasesPerRun() {
  const snapshot = await createSchedulerClient({ baseUrl: base, token: internalTokens.scheduler }).snapshot();
  const counts = new Map();
  for (const lease of snapshot.leases ?? []) {
    const live = lease.claimedUntil && Date.parse(lease.claimedUntil) > Date.now();
    if (!live) continue;
    counts.set(lease.runId, (counts.get(lease.runId) ?? 0) + 1);
  }
  return counts;
}

function scheduler(core = { planDispatch }) {
  const client = createSchedulerClient({ baseUrl: base, token: internalTokens.scheduler });
  return createScheduler({ client, core, policies: POLICIES, ownerId: `scheduler-smoke-${Math.random().toString(36).slice(2, 7)}`, pollMs: 20, heartbeatMs: 500, logger: quietLogger });
}

try {
  // One dependency chain plus one cycle, and two idle agents.
  const A = seedTask({ id: "M3-A", title: "root task" });
  const B = seedTask({ id: "M3-B", title: "depends on A", deps: ["M3-A"] });
  const C = seedTask({ id: "M3-C", title: "depends on B", deps: ["M3-B"] });

  seedAgents(2);
  await startBackend();

  check("only the dependency root is dispatched; its dependents are reported blocked", async () => {
    const runner = scheduler();
    const round = await runner.runOnce();
    await runner.stop();
    expect(round.ok, "the scheduling round failed");
    const claimedIds = round.results.filter((result) => result.claimed).map((result) => result.taskId);
    expect(claimedIds.includes("M3-A"), `expected M3-A to be claimed, got ${claimedIds.join(",")}`);
    expect(!claimedIds.includes("M3-B"), "M3-B must not be claimed before M3-A is DONE");
    expect(!claimedIds.includes("M3-C"), "M3-C must not be claimed before M3-B is DONE");
    const a = await getTask(A.id);
    const b = await getTask(B.id);
    expect(a.status === "CLAIMED", `expected M3-A CLAIMED, got ${a.status}`);
    expect(b.status === "READY", `expected M3-B READY, got ${b.status}`);
    return `claimed ${claimedIds.join(",")}; M3-B stays ${b.status}`;
  });

  check("a cycle is refused wholesale: no claim is made for cycle members", async () => {
    // Deliberately a synthetic snapshot: seeding a real cycle into the database
    // would make every later round refuse everything (that is the point of the
    // rule), and would hide the dependency-order check.
    const task = (id, deps) => ({
      id,
      projectId: "p",
      title: id,
      status: "READY",
      version: 0,
      priority: 2,
      deps,
      functionRequired: "WORKER",
      roleRequired: "DEV",
    });
    const snapshot = {
      version: 1,
      projects: [],
      tasks: [task("M3-X", ["M3-Y"]), task("M3-Y", ["M3-X"]), task("M3-OK", [])],
      agents: [{ id: "agent-dev-01", role: "DEV", capabilities: ["WORKER"], status: "IDLE" }],
      runs: [],
      leases: [],
    };
    const plan = planDispatch({ snapshot, policies: POLICIES, now: new Date().toISOString() });
    const cycleSkipped = plan.skipped.filter((entry) => ["M3-X", "M3-Y"].includes(entry.taskId));
    expect(cycleSkipped.length === 2, `expected both cycle tasks in skipped, got ${JSON.stringify(plan.skipped.map((s) => s.taskId))}`);
    for (const entry of cycleSkipped) expect(entry.reason === "cycle", `expected reason cycle, got ${entry.reason}`);
    expect(plan.proposals.length === 0, `a cyclic snapshot must produce zero proposals, got ${plan.proposals.length}`);
    return `M3-X/M3-Y skipped as cycle; 0 proposals for the whole snapshot`;
  });

  check("a run holds exactly one live lease; a second claim gets nothing", async () => {
    // Give this probe its own task so it does not consume the root's command.
    const probe = seedTask({ id: "M3-L", title: "lease probe" });
    const runner = scheduler();
    await runner.runOnce();
    await runner.stop();

    const internal = createInternalClient({ baseUrl: base, token: internalTokens.host });
    // Claim every available command; a claim is global, so the invariant is "one
    // live lease per RUN", not "the second claim is empty".
    const claimedRuns = [];
    for (let index = 0; index < 6; index += 1) {
      const claim = await internal.claim({ ownerId: `host-lease-${index}`, leaseMs: 5000 });
      if (!claim) break;
      expect(claim.lease?.generation === 1, `expected generation 1 for a fresh claim, got ${JSON.stringify(claim.lease)}`);
      claimedRuns.push(claim);
    }
    expect(claimedRuns.length >= 1, "expected at least one claimable command");
    const runIds = claimedRuns.map((claim) => claim.run.id);
    expect(new Set(runIds).size === runIds.length, `the same run was claimed twice: ${runIds.join(",")}`);

    const counts = await liveLeasesPerRun();
    for (const claim of claimedRuns) {
      expect((counts.get(claim.run.id) ?? 0) === 1, `run ${claim.run.id} has ${counts.get(claim.run.id)} live leases`);
    }
    const first = claimedRuns[0];
    const extra = await internal.claim({ ownerId: "host-lease-extra", leaseMs: 5000 });
    expect(extra === null, `expected no claim while every command is leased, got ${extra?.run?.id}`);

    const snapshot = await createSchedulerClient({ baseUrl: base, token: internalTokens.scheduler }).snapshot();
    const perTask = new Map();
    for (const run of snapshot.runs) perTask.set(run.taskId, (perTask.get(run.taskId) ?? 0) + 1);
    for (const [taskId, count] of perTask) expect(count === 1, `task ${taskId} has ${count} active runs`);
    // Release the probe's capacity: cancel its run through the internal API so the
    // later dependency-order check is not starved by a leftover active run.
    for (const claim of claimedRuns) {
      await internal.events(claim.run.id, {
        generation: claim.lease.generation,
        events: [{ type: "session.ended", sessionId: "lease-probe", reason: "failed", exitCode: null, at: new Date().toISOString() }],
      });
      await internal.result(claim.command.id, {
        ownerId: claim.lease.ownerId,
        generation: claim.lease.generation,
        status: "FAILED",
        exitCode: null,
        summary: "lease-probe",
        error: "lease-probe",
      });
    }
    void probe;
    return `${claimedRuns.length} claim(s), 1 live lease per run, extra claim null, probe runs cancelled`;
  });

  check("a restarted scheduler does not dispatch an already claimed task twice", async () => {
    const before = (await createSchedulerClient({ baseUrl: base, token: internalTokens.scheduler }).snapshot()).runs.length;
    const restarted = scheduler(); // no state carried over: it only sees the snapshot
    const round = await restarted.runOnce();
    await restarted.stop();
    const claimedA = round.results.filter((result) => result.taskId === "M3-A" && result.claimed);
    expect(claimedA.length === 0, "a restarted scheduler must not claim the already claimed M3-A");
    const after = (await createSchedulerClient({ baseUrl: base, token: internalTokens.scheduler }).snapshot()).runs.length;
    expect(after === before, `active runs changed from ${before} to ${after}`);
    return `no duplicate claim; ${after} active run(s) unchanged`;
  });

  check("after the root is accepted, the next task is dispatched", async () => {
    // Run the root through its real lifecycle with a mock runtime.
    const host = createHost({
      client: createInternalClient({ baseUrl: base, token: internalTokens.host }),
      runtime: createMockRuntime({ scenario: "complete", sessionIdFactory: () => "mock-m3" }),
      ownerId: "host-m3",
      leaseMs: 5000,
      pollMs: 20,
      flushMs: 10,
      heartbeatMs: 1000,
      logger: quietLogger,
    });
    await host.tick();
    await waitFor(async () => (await getTask("M3-A")).status === "CLAIMED", 5000, "task claimed");
    await host.stop();

    // The scheduler does not auto-accept, and since M4 DONE is reachable only
    // through a human approval. This gate is about scheduling, not about the
    // review loop, so the candidate state is seeded through the internal writer
    // (F01 forbids PATCHing execution states); the approval itself is real HTTP.
    store[INTERNAL].setTaskStatus("M3-A", "AWAITING_ACCEPTANCE");
    const targetHash = "a".repeat(64); // contracts: a target hash is a sha256 hex digest
    // Since M4 an approval must bind to the task's real candidate hash, which a
    // PASS review normally writes. This gate is about scheduling, so it seeds the
    // hash directly in the throwaway database instead of replaying a whole review.
    {
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(dbFile);
      try {
        raw.prepare("UPDATE tasks SET target_hash = ? WHERE id = ?").run(targetHash, "M3-A");
      } finally {
        raw.close();
      }
    }
    const auth = { "x-atk-token": publicToken, "x-atk-csrf": csrf, "content-type": "application/json", origin: base };
    const created = await fetch(`${base}/api/v1/approvals`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ taskId: "M3-A", scope: "task", targetHash }),
    });
    if (!created.ok) throw new Error(`POST /approvals: ${created.status} ${await created.text()}`);
    const approval = await created.json();
    const decided = await fetch(`${base}/api/v1/approvals/${encodeURIComponent(approval.id)}/decide`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ decision: "APPROVED", targetHash }),
    });
    if (!decided.ok) throw new Error(`POST /approvals/:id/decide: ${decided.status} ${await decided.text()}`);
    expect((await getTask("M3-A")).status === "DONE", "expected M3-A DONE after the human approval");

    const runner = scheduler();
    const round = await runner.runOnce();
    await runner.stop();
    const claimed = round.results.filter((result) => result.claimed).map((result) => result.taskId);
    expect(claimed.includes("M3-B"), `expected M3-B to be dispatched after M3-A DONE, got ${claimed.join(",")}`);
    expect(!claimed.includes("M3-C"), "M3-C must wait for M3-B");
    return `M3-A accepted by legal transitions; claimed ${claimed.join(",")}`;
  });

  check("the scheduler CLI process starts and completes a round", async () => {
    // QA-004 found the CLI could not start at all while every library test stayed
    // green. The gate must therefore execute the real process entry point.
    const cli = path.join(ROOT, "apps", "scheduler", "cli.mjs");
    const result = spawnSync(process.execPath, [cli, "--once", "--owner", "cli-smoke"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, ATK_BACKEND_URL: base, ATK_INTERNAL_TOKEN: internalTokens.scheduler, SCHEDULER_OWNER: "cli-smoke" },
    });
    expect(result.status === 0, `the scheduler CLI exited ${result.status}: ${result.stderr}`);
    const line = result.stdout.trim().split("\n").pop();
    const payload = JSON.parse(line);
    expect(payload?.result?.ok === true, `expected a completed round, got ${line}`);
    return `CLI exit 0, round ok (${payload.result.proposals} proposal(s), ${payload.result.skipped} skipped)`;
  });
  // Run every check while the backend is still up (the finally block stops it).
  for (const runCheck of checks) results.push(await runCheck());
} finally {
  if (backend) {
    backend.kill();
    await sleep(300);
    backend.stdout?.destroy();
    backend.stderr?.destroy();
  }
  try {
    store.close();
  } catch {
    /* already closed */
  }
}

let failed = 0;
process.stdout.write("M3 smoke gate (scheduler + backend + SQLite + host)\n\n");
for (const result of results) {
  if (!result.ok) failed += 1;
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n`);
  if (result.detail) process.stdout.write(`      ${result.detail.split("\n").join("\n      ")}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
if (failed > 0) process.stdout.write(`\n--- backend output (tail) ---\n${backendOut.slice(-2000)}\n`);
rmSync(tmp, { recursive: true, force: true });
process.exitCode = failed === 0 ? 0 : 1;

