// Phase C (ADR-006): once the published lock says SQLite owns the data, the old
// CLI is READ-ONLY, reads the SQLite projection, and never silently bypasses a
// stale/invalid lock. These tests drive the real `bin/atk.mjs` process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createProject, minimalRuntime, minimalState, writeFiles } from "./helpers.mjs";

const ATK = fileURLToPath(new URL("../bin/atk.mjs", import.meta.url));
const DB_MODULE = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "database", "src", "index.mjs"),
).href;

let database = null;
try {
  database = await import(DB_MODULE);
} catch {
  database = null;
}
const SKIP = database === null ? "@atk/database is not available in this checkout" : false;

function runAtk(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [ATK, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

async function phaseCProject({ dataDir, dbFile, taskIds = ["PKG-01"], unicode = false }) {
  // Non-ASCII path is the real local condition, not just an ASCII temp dir.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), unicode ? "atk-阶段C-" : "atk-phasec-"));
  const project = await createProject({ dir: root, files: {} });
  await writeFiles(root, {
    "flow/state.json": minimalState(),
    "flow/runtime.json": minimalRuntime(),
  });

  const dbDir = dataDir ?? path.join(root, "data-root");
  await fsp.mkdir(path.join(dbDir, "data"), { recursive: true });
  await fsp.mkdir(path.join(dbDir, "runtime"), { recursive: true });
  const databaseFile = dbFile ?? path.join(dbDir, "data", "atk.db");
  const store = database.openStore({ file: databaseFile, migrate: true });
  const internal = store[Symbol.for("@atk/database.internal")];
  try {
    store.createProject({ id: "P-1", name: "Phase C project", repoPath: root, defaultBranch: "main" });
    store.upsertAgent({ id: "agent-1", role: "BE", capabilities: ["WORKER"], status: "IDLE" });
    for (const id of taskIds) {
      store.createTask({
        id,
        projectId: "P-1",
        title: `Task ${id}`,
        description: "from sqlite",
        functionRequired: "WORKER",
        roleRequired: "BE",
        priority: 2,
        deps: [],
      });
    }
    const run = store.createRun({ taskId: taskIds[0], agentId: "agent-1", function: "WORKER", role: "BE" });
    store.updateRunStatus(run.id, { status: "RUNNING" });
    store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    // A REVIEWING task so a Review can be projected too.
    internal.setTaskStatus(taskIds[0], "REVIEWING");
    store.createReview({ taskId: taskIds[0], runId: run.id, actor: "agent-1" });
    store.close();
  } catch (error) {
    store.close();
    throw error;
  }

  const lockPath = path.join(dbDir, "runtime", "migration.lock");
  return {
    root,
    configPath: project.configPath,
    dataDir: dbDir,
    dbFile: databaseFile,
    lockPath,
    env: { ATK_DATA_DIR: dbDir, ATK_DB_FILE: databaseFile },
    writeLock(lock) {
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    },
  };
}

function phaseCLock(pid = process.pid) {
  return { owner: "sqlite", phase: "C", pid, startedAt: new Date().toISOString(), toolVersion: "0.2.0" };
}

test("Phase C: every write entry point refuses with READ_ONLY_MODE and JSON files stay byte-identical", { skip: SKIP }, async () => {
  const fixture = await phaseCProject({});
  fixture.writeLock(phaseCLock());
  const statePath = path.join(fixture.root, "flow", "state.json");
  const runtimePath = path.join(fixture.root, "flow", "runtime.json");
  const before = {
    state: { text: fs.readFileSync(statePath, "utf8"), mtime: fs.statSync(statePath).mtimeMs },
    runtime: { text: fs.readFileSync(runtimePath, "utf8"), mtime: fs.statSync(runtimePath).mtimeMs },
  };

  const attempts = [
    ["state import", ["state", "import"]],
    ["init", ["init", "--force"]],
    ["evidence", ["evidence"]],
    ["ownership check", ["ownership", "check", "--files", "src/a.ts"]],
    ["batch apply", ["batch", "apply", "--manifest", "missing.json"]],
    ["gate fast", ["gate", "fast"]],
  ];
  for (const [label, args] of attempts) {
    const result = runAtk(args, { cwd: fixture.root, env: fixture.env });
    assert.notEqual(result.status, 0, `${label} must fail in Phase C: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /read-only compatibility mode; use atk export or the Backend API/, `${label}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`operation: [^\\n]*${label.split(" ")[0]}`), label);
  }

  // state.json / runtime.json were not touched by any refused command.
  const after = {
    state: { text: fs.readFileSync(statePath, "utf8"), mtime: fs.statSync(statePath).mtimeMs },
    runtime: { text: fs.readFileSync(runtimePath, "utf8"), mtime: fs.statSync(runtimePath).mtimeMs },
  };
  assert.deepEqual(after, before);
});

test("Phase C: read-only commands work and project SQLite (board/status/doctor/verify/export)", { skip: SKIP }, async () => {
  const fixture = await phaseCProject({ taskIds: ["PKG-01", "PKG-02"] });
  fixture.writeLock(phaseCLock());

  const board = runAtk(["board", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.equal(board.status, 0, board.stderr);
  const snapshot = JSON.parse(board.stdout);
  assert.ok(JSON.stringify(snapshot).includes("PKG-01"));
  assert.ok(JSON.stringify(snapshot).includes("PKG-02"));

  const status = runAtk(["status", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.equal(status.status, 0, status.stderr);
  const statusBody = JSON.parse(status.stdout);
  assert.equal(statusBody.mode, "read-only");
  assert.equal(statusBody.lock.owner, "sqlite");
  assert.equal(statusBody.database.ok, true);

  const doctor = runAtk(["doctor", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).ok, true);

  const verify = runAtk(["verify", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).integrity[0], "ok");

  const exported = path.join(fixture.root, "roundtrip.json");
  const exportRun = runAtk(["export", "--out", exported], { cwd: fixture.root, env: fixture.env });
  assert.equal(exportRun.status, 0, exportRun.stderr);
  const document = JSON.parse(fs.readFileSync(exported, "utf8"));
  assert.deepEqual(document.stateJson.packages.map((item) => item.id).sort(), ["PKG-01", "PKG-02"]);
  assert.equal(document.manifest.counts.tasks, 2);
  assert.equal(document.manifest.counts.runs, 1);
  assert.equal(document.manifest.counts.reviews, 1);
  assert.equal(document.runtime.agents.length, 1);

  // The projection must agree with the canonical @atk/database export, not
  // diverge into a second, hand-built JSON truth.
  const canonicalStore = database.openStore({ file: fixture.dbFile, migrate: false });
  let canonical;
  try {
    canonical = database.exportStateJson(canonicalStore, { projectId: "P-1" });
  } finally {
    canonicalStore.close();
  }
  assert.deepEqual(
    document.stateJson.packages.map((item) => item.id).sort(),
    canonical.state.packages.map((item) => item.id).sort(),
  );
  assert.equal(document.manifest.counts.tasks, canonical.manifest.counts.tasks);
  assert.equal(document.manifest.counts.projects, canonical.manifest.counts.projects);

  const check = runAtk(["state", "check", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.equal(check.status, 0, JSON.stringify({ status: check.status, stdout: check.stdout, stderr: check.stderr }));
  assert.equal(JSON.parse(check.stdout).ok, true);
});

test("Phase C: a stale lock is diagnosed with repair guidance, never bypassed", { skip: SKIP }, async () => {
  const fixture = await phaseCProject({});
  fixture.writeLock(phaseCLock(2_147_000_000)); // certainly dead on Windows/Linux

  const result = runAtk(["state", "check", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MIGRATION_LOCK_STALE/);
  assert.match(result.stderr, /not running; refusing to continue instead of silently bypassing/);
  assert.match(result.stderr, /delete .*migration\.lock/);
  assert.match(result.stderr, /atk migrate --resume/);

  const write = runAtk(["evidence"], { cwd: fixture.root, env: fixture.env });
  assert.notEqual(write.status, 0);
  assert.match(write.stderr, /MIGRATION_LOCK_STALE/);
});

test("no lock keeps the legacy JSON behaviour (regression)", { skip: SKIP }, async () => {
  const fixture = await phaseCProject({});
  // No lock: Phase B has not started.
  const check = runAtk(["state", "check", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.equal(check.status, 0, JSON.stringify({ status: check.status, stdout: check.stdout, stderr: check.stderr }));
  assert.equal(JSON.parse(check.stdout).checked, 2);

  // A no-op evidence run still works and does not create a lock.
  const evidence = runAtk(["evidence", "--dry"], { cwd: fixture.root, env: fixture.env });
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.equal(fs.existsSync(fixture.lockPath), false);
});

test("Phase C works from a non-ASCII data dir with a BOM state.json", { skip: SKIP }, async () => {
  const fixture = await phaseCProject({ taskIds: ["PKG-01"], unicode: true });
  fixture.writeLock(phaseCLock());
  // The old truth file is deliberately BOM-prefixed; Phase C must not depend on it.
  const statePath = path.join(fixture.root, "flow", "state.json");
  fs.writeFileSync(statePath, `\uFEFF${fs.readFileSync(statePath, "utf8")}`, "utf8");

  const board = runAtk(["board", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.equal(board.status, 0, board.stderr);
  assert.ok(board.stdout.includes("PKG-01"));

  const status = runAtk(["status", "--json"], { cwd: fixture.root, env: fixture.env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).database.ok, true);
  assert.ok(fixture.dataDir.includes("阶段C"));
});
