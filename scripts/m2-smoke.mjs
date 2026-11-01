#!/usr/bin/env node
// M2 end-to-end gate: real backend, real SQLite, real internal HTTP, MockRuntime.
//
// It seeds dispatch commands straight into the database, boots the backend, then
// drives the Runtime Host through the three behaviours the M2 gate promises:
//   1. happy path   - claim -> session -> events -> COMPLETED, with exactly one
//                     run.updated per state transition (no duplicates);
//   2. crash/reclaim- a host dies mid-run; the next host must NOT start a second
//                     session and must report INTERRUPTED instead of guessing
//                     success;
//   3. fencing      - an outdated generation cannot append events and the run is
//                     left untouched.
//
// Usage: node scripts/m2-smoke.mjs [--verbose]
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
const { openStore } = await load("packages/database/src/index.mjs");
const { createInternalClient } = await load("apps/runtime-host/src/client.mjs");
const { createHost } = await load("apps/runtime-host/src/host.mjs");
const { createMockRuntime } = await load("packages/runtime-sdk/src/mock.mjs");

for (const required of [BACKEND_CLI, STATE]) {
  if (!existsSync(required)) {
    process.stderr.write(`m2-smoke: missing ${required}\n`);
    process.exit(2);
  }
}

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
async function waitFor(predicate, timeoutMs = 15000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m2-smoke-"));
const dbFile = path.join(tmp, "atk.db");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const LEASE_MS = 1200;

// ---------------------------------------------------------------------------
// seed: migrate the repository state into a throwaway database, then queue one
// dispatch command per phase
// ---------------------------------------------------------------------------
const migrate = spawnSync(process.execPath, [BACKEND_CLI, "migrate", "--data", dbFile, "--from", STATE, "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  windowsHide: true,
});
if (migrate.status !== 0) {
  process.stderr.write(`m2-smoke: migrate failed (exit ${migrate.status})\n${migrate.stdout}\n${migrate.stderr}\n`);
  process.exit(1);
}
const seed = openStore({ file: dbFile, migrate: true });

function taskOf(store) {
  const project = store.listProjects()[0];
  const tasks = store.listTasks({ projectId: project.id });
  if (!tasks.length) throw new Error("the migrated state carries no task to run");
  return tasks[0];
}

function seedRun(store, label) {
  const task = taskOf(store);
  const run = store.createRun({ taskId: task.id, agentId: "agent-dev-01", function: "WORKER", role: "DEV" });
  const command = store.enqueueDispatchCommand({
    runId: run.id,
    commandType: "START_RUN",
    payload: { prompt: `m2-smoke ${label}` },
    idempotencyKey: `m2-smoke-${label}-${run.id}`,
  });
  return { run: store.getRun(run.id), command };
}

let currentStore = seed;
let backend = null;
let backendOut = "";
let internalToken = "";
let publicToken = "";

async function startBackend(store) {
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
  const match = backendOut.match(/internal token:\s*(\S+)/);
  if (!match) throw new Error(`backend did not print an internal token:\n${backendOut}`);
  internalToken = match[1];
  const session = await (await fetch(`${base}/api/v1/session`)).json();
  publicToken = session.token;
  void store;
}

function publicHeaders() {
  return { "x-atk-token": publicToken };
}
async function getRun(runId) {
  const response = await fetch(`${base}/api/v1/runs/${encodeURIComponent(runId)}`, { headers: publicHeaders() });
  if (!response.ok) throw new Error(`GET run ${runId}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function getEvents() {
  const response = await fetch(`${base}/api/v1/events?limit=200`, { headers: publicHeaders() });
  if (!response.ok) throw new Error(`GET events: ${response.status}`);
  const body = await response.json();
  return body.items ?? body;
}

try {
  await startBackend(seed);

  // -------------------------------------------------------------------------
  // 1. happy path
  // -------------------------------------------------------------------------
  const happy = seedRun(seed, "happy");

  check("a dispatch command is claimed, the session runs and the run COMPLETES", async () => {
    const runtime = createMockRuntime({ scenario: "complete", sessionIdFactory: () => "mock-happy" });
    const client = createInternalClient({ baseUrl: base, token: internalToken });
    const host = createHost({ client, runtime, ownerId: "host-happy", leaseMs: LEASE_MS, pollMs: 20, flushMs: 10, heartbeatMs: 500, logger: quietLogger });
    await host.tick();
    await waitFor(async () => (await getRun(happy.run.id)).status === "COMPLETED", 15000, "run COMPLETED");
    await host.stop();
    const run = await getRun(happy.run.id);
    expect(run.status === "COMPLETED", `expected COMPLETED, got ${run.status}`);
    expect(run.exitCode === 0 || run.exitCode === null, `unexpected exitCode ${run.exitCode}`);
    const events = await getEvents();
    const runEvents = events.filter((event) => event.aggregateId === happy.run.id);
    const updated = runEvents.filter((event) => event.type === "run.updated");
    const statuses = updated.map((event) => event.payload?.status).filter(Boolean);
    expect(updated.length === 2, `expected exactly 2 run.updated (RUNNING, COMPLETED), got ${updated.length}: ${statuses.join(",")}`);
    expect(new Set(statuses).size === statuses.length, `duplicate run.updated for the same status: ${statuses.join(",")}`);
    expect(runEvents.some((event) => event.type === "run.log"), "expected at least one run.log event");
    return `COMPLETED, ${updated.length} run.updated (${statuses.join(" -> ")}), ${runEvents.filter((e) => e.type === "run.log").length} run.log`;
  });

  // -------------------------------------------------------------------------
  // 2. crash mid-run, then reclaim: never restart, report INTERRUPTED
  // -------------------------------------------------------------------------
  const crash = seedRun(seed, "crash");

  check("a dead host's command is reclaimed as INTERRUPTED and never restarted", async () => {
    const client = createInternalClient({ baseUrl: base, token: internalToken });
    const hangingRuntime = createMockRuntime({ scenario: "hang", sessionIdFactory: () => "mock-crash" });
    const deadHost = createHost({ client, runtime: hangingRuntime, ownerId: "host-dead", leaseMs: LEASE_MS, pollMs: 20, flushMs: 10, heartbeatMs: 500, logger: quietLogger });
    await deadHost.tick();
    expect(hangingRuntime._sessionCount === 1, `the dead host should have started exactly one session, got ${hangingRuntime._sessionCount}`);
    await deadHost.stop(); // simulates the process disappearing mid-run

    // Wait until the lease expires so the command becomes claimable again.
    await sleep(LEASE_MS + 600);

    const recoveryRuntime = createMockRuntime({ scenario: "complete", sessionIdFactory: () => "mock-recovery" });
    const recoveryHost = createHost({ client, runtime: recoveryRuntime, ownerId: "host-recovery", leaseMs: LEASE_MS, pollMs: 20, flushMs: 10, heartbeatMs: 500, logger: quietLogger });
    await recoveryHost.tick();
    await waitFor(async () => (await getRun(crash.run.id)).status === "INTERRUPTED", 15000, "run INTERRUPTED");
    await recoveryHost.stop();

    expect(recoveryRuntime._sessionCount === 0, `a reclaimed command must not start a session, got ${recoveryRuntime._sessionCount}`);
    expect(recoveryHost.stats.interrupted === 1, `expected 1 interrupted, got ${recoveryHost.stats.interrupted}`);
    const run = await getRun(crash.run.id);
    expect(run.status === "INTERRUPTED", `expected INTERRUPTED (never COMPLETED), got ${run.status}`);
    return "INTERRUPTED, 0 sessions started by the recovery host";
  });

  // -------------------------------------------------------------------------
  // 3. generation fencing: an outdated holder cannot append events
  // -------------------------------------------------------------------------
  const fenced = seedRun(seed, "fenced");

  check("an outdated generation is refused and leaves the run untouched", async () => {
    const client = createInternalClient({ baseUrl: base, token: internalToken });
    const claim = await client.claim({ ownerId: "host-stale", leaseMs: LEASE_MS });
    expect(claim?.command?.id, "expected to claim the seeded command");
    const renewed = await client.renew(claim.run.id, { ownerId: "host-stale", generation: claim.lease.generation, leaseMs: LEASE_MS });
    expect(renewed?.lease?.generation === claim.lease.generation + 1, "renew must advance the generation");
    const before = await getRun(fenced.run.id);
    let stale = null;
    try {
      await client.events(claim.run.id, { generation: claim.lease.generation, events: [{ type: "session.started", sessionId: "stale", at: new Date().toISOString() }] });
    } catch (error) {
      stale = error;
    }
    expect(stale?.code === "STALE_GENERATION", `expected STALE_GENERATION, got ${stale?.code ?? "no error"}`);
    const after = await getRun(fenced.run.id);
    expect(after.status === before.status && after.version === before.version, `stale write changed the run: ${before.status}@v${before.version} -> ${after.status}@v${after.version}`);
    return `409 ${stale.code}, run unchanged (${after.status} v${after.version})`;
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
    currentStore?.close();
  } catch {
    /* already closed */
  }
}

let failed = 0;
process.stdout.write("M2 smoke gate (backend + SQLite + internal API + runtime host)\n\n");
for (const result of results) {
  if (!result.ok) failed += 1;
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n`);
  if (result.detail) process.stdout.write(`      ${result.detail.split("\n").join("\n      ")}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
if (failed > 0) process.stdout.write(`\n--- backend output (tail) ---\n${backendOut.slice(-2000)}\n`);

rmSync(tmp, { recursive: true, force: true });
process.exitCode = failed === 0 ? 0 : 1;
