#!/usr/bin/env node
// M5 end-to-end gate: one command starts the local system.
//
// It drives the real launcher CLI (which spawns the real backend, scheduler and
// two runtime hosts), seeds tasks through the store, and asserts the properties
// M5 promises: the whole tree comes up, work is executed, the internal credential
// never touches the disk, the stop is ordered and idempotent, a dead host is
// reported, and a backup can be restored and started again.
//
// Usage: node scripts/m5-smoke.mjs [--verbose]
// Exit: 0 = all checks pass, 1 = a check failed, 2 = prerequisites missing.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "apps", "launcher", "cli.mjs");
const BACKEND = path.join(ROOT, "apps", "backend", "cli.mjs");
const verbose = process.argv.includes("--verbose");
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

for (const required of [LAUNCHER, BACKEND]) {
  if (!existsSync(required)) {
    process.stderr.write(`m5-smoke: missing ${required}\n`);
    process.exit(2);
  }
}

const { openStore } = await load("packages/database/src/index.mjs");

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 30000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
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

const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m5-smoke-"));
const dataDir = path.join(tmp, "data");
const restoredDir = path.join(tmp, "restored");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dbFile = path.join(dataDir, "data", "atk.db");

function runCli(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    env: { ...process.env, ATK_DATA_DIR: dataDir },
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`launcher ${args.join(" ")} exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
function status() {
  const result = runCli(["status", "--data", dataDir, "--json"], { allowFailure: true });
  try {
    return JSON.parse(result.stdout.trim().split("\n").pop());
  } catch {
    return { running: false, parseError: result.stdout };
  }
}
function health() {
  return fetch(`${base}/api/v1/system/health`).then(async (response) => ({ ok: response.ok, body: await response.json() }));
}
function walkFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) files.push(...walkFiles(full));
    else files.push(full);
  }
  return files;
}
function seedWork(count) {
  const store = openStore({ file: dbFile, migrate: true });
  try {
    const project = store.createProject({ id: `M5-P-${Date.now()}`, name: "m5-smoke project", repoPath: ROOT, defaultBranch: "m0/baseline-and-p0" });
    for (let index = 0; index < 2; index += 1) {
      store.upsertAgent({ id: `m5-agent-${index + 1}`, role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    // M6.2 F10: seed a heartbeat so the scheduler may dispatch to this agent.
    if (typeof store.recordHeartbeat === "function") {
      store.recordHeartbeat({ hostId: "m5-smoke", agentIds: [`m5-agent-${index + 1}`], capacity: 1 });
    }
    }
    const taskIds = [];
    for (let index = 0; index < count; index += 1) {
      const task = store.createTask({
        id: `M5-T-${index + 1}`,
        projectId: project.id,
        title: `m5 task ${index + 1}`,
        description: "m5 smoke",
        functionRequired: "WORKER",
        roleRequired: "DEV",
        priority: 2,
        deps: [],
        acceptance: "smoke",
      });
      taskIds.push(task.id);
    }
    return { projectId: project.id, taskIds };
  } finally {
    store.close();
  }
}
function readRuns() {
  const store = openStore({ file: dbFile, migrate: false });
  try {
    return store.listRuns?.({ limit: 50 }) ?? [];
  } finally {
    store.close();
  }
}
/** True while the PID is still running; `process.kill(pid, 0)` semantics. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Exact business counts, read straight from the SQLite file (no HTTP). */
function dbCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
    return { tasks: count("tasks"), runs: count("runs"), events: count("events") };
  } finally {
    db.close();
  }
}

let started = false;
try {
  // -----------------------------------------------------------------------
  // 1. one command starts the whole tree; work is executed by the hosts
  // -----------------------------------------------------------------------
  check("atk start brings up backend, scheduler and two hosts, and work runs", async () => {
    const out = runCli(["start", "--port", String(port), "--data", dataDir, "--hosts", "2"]);
    started = true;
    expect(/backend/.test(out.stdout), `start output did not mention backend:\n${out.stdout}`);
    const snapshot = status();
    expect(snapshot.running === true, `status says not running: ${JSON.stringify(snapshot)}`);
    const roles = snapshot.children.map((child) => child.role);
    expect(roles.filter((role) => role === "host").length === 2, `expected 2 hosts, got ${roles.join(",")}`);
    expect(roles.includes("backend") && roles.includes("scheduler"), `missing roles: ${roles.join(",")}`);
    expect(snapshot.children.every((child) => child.alive), `some child is not alive: ${JSON.stringify(snapshot.children)}`);
    expect(snapshot.health?.ok === true, `health not ok: ${JSON.stringify(snapshot.health)}`);

    seedWork(3);
    // The scheduler claims, a host runs the mock session, the run completes.
    await waitFor(async () => {
      const runs = readRuns();
      return runs.filter((run) => run.status === "COMPLETED").length >= 2;
    }, 60000, "two completed runs");
    const runs = readRuns();
    const completed = runs.filter((run) => run.status === "COMPLETED").length;
    const live = runs.filter((run) => ["STARTING", "RUNNING", "QUEUED"].includes(run.status));
    expect(completed >= 2, `expected at least 2 completed runs, got ${completed}`);
    expect(live.length <= 1, `expected at most one live run, got ${live.length}`);
    return `4 children alive, health ok, ${completed} completed run(s)`;
  });

  // -----------------------------------------------------------------------
  // 2. the internal credential never reaches the disk or the status output
  // -----------------------------------------------------------------------
  check("the internal credential is not persisted anywhere", async () => {
    const snapshot = status();
    const statusText = JSON.stringify(snapshot);
    expect(!/"[^"]*token[^"]*"\s*:/i.test(statusText), `status --json leaks a token field: ${statusText.slice(0, 400)}`);
    const stateText = readFileSync(path.join(dataDir, "launcher.json"), "utf8");
    expect(!/x-atk-internal|internal token/i.test(stateText), "launcher.json mentions the internal credential");
    // QA6-04: the scan scope is explicitly logs/ + launcher.json + status output.
    // It deliberately does NOT scan the whole data directory: agent-flow:sqlite
    // internal strings / legacy exports would create false positives, and the
    // credential lives in child env only. A 43-char base64url string is the token
    // shape, and an unredacted "internal token:" line is a leak.
    const offenders = [];
    for (const file of walkFiles(path.join(dataDir, "logs"))) {
      const text = readFileSync(file, "utf8");
      const leakedValue = /internal tokens?:\s*(?!\[REDACTED\])\S{20,}/i.test(text) || /[A-Za-z0-9_-]{40,}/.test(text.replace(/\[REDACTED\]/g, ""));
      if (leakedValue) offenders.push(path.basename(file));
    }
    expect(offenders.length === 0, `log files leak the internal credential value: ${offenders.join(",")}`);
    return "no credential value in launcher.json, logs or status output";
  });

  // -----------------------------------------------------------------------
  // 3. a dead host is reported, and stop stays ordered and idempotent
  // -----------------------------------------------------------------------
  check("a killed host is reported down and atk stop is idempotent", async () => {
    const before = status();
    const recordedPids = before.children.map((child) => child.pid);
    const host = before.children.find((child) => child.role === "host");
    expect(host?.pid, "no host pid in the status output");
    process.kill(host.pid);
    await waitFor(() => {
      const snapshot = status();
      const entry = snapshot.children.find((child) => child.pid === host.pid);
      return entry && entry.alive === false;
    }, 20000, "the killed host to be reported as down");

    runCli(["stop", "--data", dataDir]);
    started = false;
    const after = status();
    expect(after.running === false, `expected not running after stop, got ${JSON.stringify(after)}`);
    // QA6-03: the real "stop waits" proof is PID-level, not status/port-level.
    // A stop that merely deletes launcher.json would pass the old assertions.
    await waitFor(() => recordedPids.every((pid) => !pidAlive(pid)), 5000, "every recorded child PID to exit");
    const survivors = recordedPids.filter((pid) => pidAlive(pid));
    expect(survivors.length === 0, `stop returned while these recorded PIDs were still alive: ${survivors.join(",")}`);
    runCli(["stop", "--data", dataDir]); // idempotent: must still exit 0
    const leaked = await fetch(`${base}/api/v1/system/health`).then(() => true).catch(() => false);
    expect(!leaked, "the backend port is still answering after stop");
    return `host ${host.pid} reported down; ${recordedPids.length} recorded PID(s) confirmed dead; stop idempotent; port released`;
  });

  // -----------------------------------------------------------------------
  // 4. backup -> restore -> start on the restored database
  // -----------------------------------------------------------------------
  check("a backup can be restored, but a tampered snapshot is refused", async () => {
    const originalCounts = dbCounts(dbFile);
    const backupDir = path.join(tmp, "backup");
    const backup = spawnSync(process.execPath, [BACKEND, "backup", "--data", dbFile, "--to", backupDir, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(backup.status === 0, `backup failed (${backup.status}): ${backup.stdout}\n${backup.stderr}`);
    const manifest = JSON.parse(readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
    expect(manifest.sha256 && manifest.schemaVersion > 0, `bad manifest: ${JSON.stringify(manifest)}`);

    // QA6-03: a tampered snapshot must be refused and must not create/overwrite
    // the restore target (the sha256 in the manifest is the integrity check).
    const tamperedDir = path.join(tmp, "backup-tampered");
    cpSync(backupDir, tamperedDir, { recursive: true });
    const tamperedManifestPath = path.join(tamperedDir, "manifest.json");
    const tamperedManifest = JSON.parse(readFileSync(tamperedManifestPath, "utf8"));
    tamperedManifest.sha256 = "0".repeat(64);
    writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    const tamperedTarget = path.join(tmp, "tampered-restore", "data", "atk.db");
    const tamperedRestore = spawnSync(process.execPath, [BACKEND, "restore", "--from", tamperedDir, "--data", tamperedTarget, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(tamperedRestore.status !== 0, `restore of a tampered snapshot must fail, got ${tamperedRestore.status}: ${tamperedRestore.stdout}`);
    expect(!existsSync(tamperedTarget), "restore of a tampered snapshot must not create the target database");

    const restored = spawnSync(process.execPath, [BACKEND, "restore", "--from", backupDir, "--data", path.join(restoredDir, "data", "atk.db"), "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(restored.status === 0, `restore failed (${restored.status}): ${restored.stdout}\n${restored.stderr}`);

    // QA6-03: exact counts of the restored database, before any launcher starts
    // (starting hosts legitimately creates new runs, so compare the artifact).
    const restoredCounts = dbCounts(path.join(restoredDir, "data", "atk.db"));
    for (const table of ["tasks", "runs", "events"]) {
      expect(
        restoredCounts[table] === originalCounts[table],
        `restored ${table} count ${restoredCounts[table]} != original ${originalCounts[table]}`,
      );
    }

    const restoredPort = await freePort();
    const startRestored = spawnSync(process.execPath, [LAUNCHER, "start", "--port", String(restoredPort), "--data", restoredDir, "--hosts", "1"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      env: { ...process.env, ATK_DATA_DIR: restoredDir },
    });
    expect(startRestored.status === 0, `start on restored data failed: ${startRestored.stdout}\n${startRestored.stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${restoredPort}/api/v1/system/health`);
      expect(response.ok, `health on restored data: ${response.status}`);
      await response.json();
      return `manifest schemaVersion ${manifest.schemaVersion}; tampered snapshot refused; restored counts tasks=${restoredCounts.tasks} runs=${restoredCounts.runs} events=${restoredCounts.events} exact`;
    } finally {
      spawnSync(process.execPath, [LAUNCHER, "stop", "--data", restoredDir], { cwd: ROOT, encoding: "utf8", windowsHide: true, env: { ...process.env, ATK_DATA_DIR: restoredDir } });
    }
  });

  // Run every check while the system is up; the finally block guarantees cleanup.
  for (const runCheck of checks) results.push(await runCheck());
} finally {
  if (started) {
    try {
      runCli(["stop", "--data", dataDir, "--force"], { allowFailure: true });
    } catch {
      /* best effort */
    }
  }
  // Give the detached supervisor a moment to release ports before cleanup.
  await sleep(500);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle */
  }
}

let failed = 0;
process.stdout.write("M5 smoke gate (launcher + backend + scheduler + hosts)\n\n");
for (const result of results) {
  if (!result.ok) failed += 1;
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n`);
  if (result.detail) process.stdout.write(`      ${result.detail.split("\n").join("\n      ")}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
void verbose;
process.exitCode = failed === 0 ? 0 : 1;
