#!/usr/bin/env node
// v1.0 end-to-end demo: one command up, real work through the whole chain.
//
//   launcher up -> scheduler claims -> hosts execute -> run COMPLETED
//   -> review PASS (evidence) -> human approval -> task DONE
//   -> legacy CLI reads the same facts (read-only) and refuses to write
//
// Usage: node scripts/v1-demo.mjs [--keep]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "apps", "launcher", "cli.mjs");
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);
const { openStore } = await load("packages/database/src/index.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
function say(text) {
  lines.push(text);
  process.stdout.write(`${text}\n`);
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
async function waitFor(predicate, timeoutMs, label) {
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

const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-v1-demo-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, ATK_DATA_DIR: tmp };
let token = null;
let csrf = null;

function authHeaders(extra = {}) {
  return { "x-atk-token": token, ...(csrf ? { "x-atk-csrf": csrf } : {}), origin: base, "content-type": "application/json", ...extra };
}
async function api(method, route, body) {
  const response = await fetch(`${base}${route}`, { method, headers: authHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 300)}`);
  return payload;
}

let started = false;
try {
  const start = spawnSync(process.execPath, [LAUNCHER, "start", "--port", String(port), "--data", tmp, "--hosts", "2"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    env,
  });
  expect(start.status === 0, `launcher start failed: ${start.stdout}\n${start.stderr}`);
  started = true;
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/api/v1/system/health`)).ok;
    } catch {
      return false;
    }
  }, 30000, "health");
  const health = await (await fetch(`${base}/api/v1/system/health`)).json();
  say(`1. system up on ${base} (schema v${health.db.schemaVersion}, switchReadiness ${health.switchReadiness?.ok})`);

  const session = await (await fetch(`${base}/api/v1/session`)).json();
  token = session.token;
  csrf = session.csrf;

  const dbFile = path.join(tmp, "data", "atk.db");
  const store = openStore({ file: dbFile, migrate: true });
  try {
    store.createProject({ id: "DEMO", name: "demo project", repoPath: ROOT, defaultBranch: "m0/baseline-and-p0" });
    for (const index of [1, 2]) {
      store.upsertAgent({ id: `demo-dev-${index}`, role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    }
    for (const index of [1, 2, 3]) {
      store.createTask({
        id: `DEMO-T${index}`,
        projectId: "DEMO",
        title: `demo task ${index}`,
        description: "v1.0 demo",
        functionRequired: "WORKER",
        roleRequired: "DEV",
        priority: 2,
        deps: [],
        acceptance: "demo",
      });
    }
  } finally {
    store.close();
  }
  say("2. seeded 3 tasks and 2 idle agents");

  await waitFor(async () => {
    const runs = await api("GET", "/api/v1/runs?limit=10");
    return runs.items.filter((run) => run.status === "COMPLETED").length >= 2;
  }, 90000, "two completed runs");
  const runs = await api("GET", "/api/v1/runs?limit=10");
  const completed = runs.items.filter((run) => run.status === "COMPLETED");
  say(`3. scheduler dispatched, mock hosts executed: ${completed.length} COMPLETED of ${runs.items.length} run(s)`);

  const taskId = completed[0].taskId;
  for (const status of ["RUNNING", "REVIEWING"]) {
    const task = await api("GET", `/api/v1/tasks/${taskId}`);
    await api("PATCH", `/api/v1/tasks/${taskId}`, { expectedVersion: task.version, status });
  }
  say(`4. ${taskId} walked to REVIEWING (no automatic acceptance)`);

  const review = await api("POST", "/api/v1/reviews", { taskId, runId: completed[0].id, actor: "demo-qa" });
  const manifestHash = "a".repeat(64);
  await api("POST", `/api/v1/reviews/${review.id}/submit`, {
    expectedVersion: review.version,
    verdict: "PASS",
    manifestHash,
    evidence: { tests: { passed: 24, total: 24 } },
    actor: "demo-qa",
  });
  say("5. review PASS accepted (manifest hash + 24/24 tests), task -> INTEGRATING");

  const integrating = await api("GET", `/api/v1/tasks/${taskId}`);
  await api("PATCH", `/api/v1/tasks/${taskId}`, { expectedVersion: integrating.version, status: "AWAITING_ACCEPTANCE" });
  const approval = await api("POST", "/api/v1/approvals", { taskId, scope: "candidate", targetHash: manifestHash });
  await api("POST", `/api/v1/approvals/${approval.id}/decide`, { decision: "APPROVED", targetHash: manifestHash });
  const done = await api("GET", `/api/v1/tasks/${taskId}`);
  expect(done.status === "DONE", `expected DONE, got ${done.status}`);
  say(`6. human approval bound to the target hash -> ${taskId} = DONE`);

  const exportPath = path.join(tmp, "export.json");
  const exportRun = spawnSync(process.execPath, [path.join(ROOT, "bin", "atk.mjs"), "export", "--out", exportPath], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  expect(exportRun.status === 0, `legacy export failed: ${exportRun.stderr}`);
  const exported = JSON.parse(readFileSync(exportPath, "utf8"));
  const exportedText = JSON.stringify(exported);
  expect(exportedText.includes("DEMO-T"), "the read-only legacy CLI must project the SQLite tasks");
  say("7. legacy CLI reads the same facts through the SQLite projection (export, read-only)");

  // Phase C is driven by the migration lock; the launcher does not create it.
  mkdirSync(path.join(tmp, "runtime"), { recursive: true });
  writeFileSync(
    path.join(tmp, "runtime", "migration.lock"),
    JSON.stringify({ owner: "sqlite", phase: "C", pid: process.pid, startedAt: new Date().toISOString(), toolVersion: "0.2.0" }),
  );
  const writeAttempt = spawnSync(process.execPath, [path.join(ROOT, "bin", "atk.mjs"), "evidence"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  const writeOutput = `${writeAttempt.stdout}${writeAttempt.stderr}`;
  expect(writeAttempt.status !== 0, `the legacy write must be refused in phase C, got exit ${writeAttempt.status}: ${writeOutput.slice(0, 300)}`);
  expect(writeOutput.includes("READ_ONLY_MODE"), `the refusal must be READ_ONLY_MODE: ${writeOutput.slice(0, 300)}`);
  say("8. legacy CLI write refused with READ_ONLY_MODE (single fact source)");
} finally {
  if (started) {
    spawnSync(process.execPath, [LAUNCHER, "stop", "--data", tmp], { cwd: ROOT, encoding: "utf8", windowsHide: true, env, timeout: 60000 });
  }
  if (!process.argv.includes("--keep")) {
    await sleep(500);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows may hold a handle */
    }
  } else {
    process.stdout.write(`(kept ${tmp})\n`);
  }
}
process.stdout.write(`\nDEMO PASSED (${lines.length} steps)\n`);
