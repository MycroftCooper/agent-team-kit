// M5 backup/restore CLI tests: consistent snapshots (WAL-safe), manifest
// integrity, schema-version gate, atomic restore and --pidfile lifecycle.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

let database = null;
try {
  database = await import("@atk/database");
} catch {
  database = null;
}
const DB_SKIP = database === null ? "@atk/database is not available in this checkout" : false;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000, windowsHide: true });
}

function tempDir(prefix = "atk-backup-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Seed a real SQLite database with N tasks and return its path. */
function seedDatabase(dir, taskCount, name = "source.db") {
  const file = path.join(dir, name);
  const store = database.openStore({ file, migrate: true });
  try {
    store.createProject({ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" });
    for (let index = 0; index < taskCount; index += 1) {
      store.createTask({
        id: `T-${index + 1}`,
        projectId: "P-1",
        title: `Task ${index + 1}`,
        description: "d",
        functionRequired: "WORKER",
        roleRequired: "BE",
        priority: 2,
        deps: [],
      });
    }
  } finally {
    store.close();
  }
  return file;
}

function taskCount(file) {
  const store = database.openStore({ file, migrate: false });
  try {
    return store.listTasks({}).length;
  } finally {
    store.close();
  }
}

test("backup writes a consistent snapshot + manifest and does not modify the source", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, 2);
  const before = fs.statSync(source);
  const beforeSha = sha256(source);
  const backupDir = path.join(dir, "backup");

  const result = runCli(["backup", "--data", source, "--to", backupDir, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "backup");
  assert.equal(output.sourceUnchanged, true);

  const snapshot = path.join(backupDir, "atk.db");
  const manifestFile = path.join(backupDir, "manifest.json");
  assert.ok(fs.existsSync(snapshot));
  assert.ok(fs.existsSync(manifestFile));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["bytes", "createdAt", "schemaVersion", "sha256", "source"]);
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)));
  assert.equal(manifest.schemaVersion, database.SCHEMA_VERSION);
  assert.equal(manifest.bytes, fs.statSync(snapshot).size);
  assert.equal(manifest.sha256, sha256(snapshot), "sha256 is the snapshot file hash");
  assert.equal(manifest.source, source);
  assert.equal(output.manifest.sha256, manifest.sha256);

  // Snapshot content is complete (not a half-written WAL copy).
  assert.equal(taskCount(snapshot), 2);

  const after = fs.statSync(source);
  assert.equal(after.mtimeMs, before.mtimeMs, "backup must not touch the source mtime");
  assert.equal(after.size, before.size);
  assert.equal(sha256(source), beforeSha, "backup must not change the source bytes");
});

test("backup refuses a non-empty destination; --force overwrites it", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, 2);
  const backupDir = path.join(dir, "backup");
  assert.equal(runCli(["backup", "--data", source, "--to", backupDir]).status, 0);

  // Add a task to the source so the forced snapshot is observably different.
  const store = database.openStore({ file: source, migrate: true });
  try {
    store.createTask({
      id: "T-3",
      projectId: "P-1",
      title: "Task 3",
      description: "d",
      functionRequired: "WORKER",
      roleRequired: "BE",
      priority: 2,
      deps: [],
    });
  } finally {
    store.close();
  }

  const refused = runCli(["backup", "--data", source, "--to", backupDir]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not empty/);
  assert.equal(taskCount(path.join(backupDir, "atk.db")), 2, "the refused backup kept the old snapshot");

  const forced = runCli(["backup", "--data", source, "--to", backupDir, "--force", "--json"]);
  assert.equal(forced.status, 0, forced.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
  assert.equal(manifest.sha256, sha256(path.join(backupDir, "atk.db")));
  assert.equal(taskCount(path.join(backupDir, "atk.db")), 3, "--force wrote the new snapshot");
});

test("restore verifies the manifest and installs the database; existing targets need --force", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, 2);
  const backupDir = path.join(dir, "backup");
  assert.equal(runCli(["backup", "--data", source, "--to", backupDir]).status, 0);

  const restored = path.join(dir, "restored.db");
  const result = runCli(["restore", "--from", backupDir, "--data", restored, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "restore");
  assert.equal(output.forced, false);
  assert.equal(output.migrationPending, false);
  assert.equal(taskCount(restored), 2);

  const refused = runCli(["restore", "--from", backupDir, "--data", restored]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.equal(taskCount(restored), 2);

  const forced = runCli(["restore", "--from", backupDir, "--data", restored, "--force", "--json"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(forced.stdout).forced, true);
  assert.equal(taskCount(restored), 2);
});

test("a tampered snapshot is refused and the target is untouched", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, 2);
  const backupDir = path.join(dir, "backup");
  assert.equal(runCli(["backup", "--data", source, "--to", backupDir]).status, 0);
  const tamperedDir = path.join(dir, "tampered");
  fs.cpSync(backupDir, tamperedDir, { recursive: true });
  fs.appendFileSync(path.join(tamperedDir, "atk.db"), Buffer.from([0]));

  const newTarget = path.join(dir, "new-target.db");
  const refused = runCli(["restore", "--from", tamperedDir, "--data", newTarget]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /integrity check failed/);
  assert.equal(fs.existsSync(newTarget), false, "a rejected restore must not create the target");

  // With --force the existing target must still be byte-identical afterwards.
  const existing = path.join(dir, "existing.db");
  assert.equal(runCli(["restore", "--from", backupDir, "--data", existing]).status, 0);
  const existingSha = sha256(existing);
  const forced = runCli(["restore", "--from", tamperedDir, "--data", existing, "--force"]);
  assert.equal(forced.status, 1);
  assert.equal(sha256(existing), existingSha, "a rejected --force restore leaves the old database");
});

test("restore refuses a newer schemaVersion and allows an older one (migration pending)", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, 1);
  const backupDir = path.join(dir, "backup");
  assert.equal(runCli(["backup", "--data", source, "--to", backupDir]).status, 0);

  const newerDir = path.join(dir, "newer");
  fs.cpSync(backupDir, newerDir, { recursive: true });
  const newerManifest = JSON.parse(fs.readFileSync(path.join(newerDir, "manifest.json"), "utf8"));
  newerManifest.schemaVersion = database.SCHEMA_VERSION + 1;
  fs.writeFileSync(path.join(newerDir, "manifest.json"), JSON.stringify(newerManifest));
  const newerTarget = path.join(dir, "newer.db");
  const newer = runCli(["restore", "--from", newerDir, "--data", newerTarget]);
  assert.equal(newer.status, 1);
  assert.match(newer.stderr, /newer than this build/);
  assert.match(newer.stderr, /upgrade the code first/);
  assert.equal(fs.existsSync(newerTarget), false);

  const olderDir = path.join(dir, "older");
  fs.cpSync(backupDir, olderDir, { recursive: true });
  const olderManifest = JSON.parse(fs.readFileSync(path.join(olderDir, "manifest.json"), "utf8"));
  olderManifest.schemaVersion = 1;
  fs.writeFileSync(path.join(olderDir, "manifest.json"), JSON.stringify(olderManifest));
  const olderTarget = path.join(dir, "older.db");
  const older = runCli(["restore", "--from", olderDir, "--data", olderTarget, "--json"]);
  assert.equal(older.status, 0, older.stderr);
  assert.equal(JSON.parse(older.stdout).migrationPending, true);
  // The snapshot itself is still schema v4; a normal open migrates on start.
  assert.equal(testCountAtVersion(olderTarget), database.SCHEMA_VERSION);
});

function testCountAtVersion(file) {
  const store = database.openStore({ file, migrate: true });
  try {
    return store.health().schemaVersion;
  } finally {
    store.close();
  }
}

test("human-readable output carries the key numbers; usage errors exit 2", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, 1);
  const backupDir = path.join(dir, "backup");
  const result = runCli(["backup", "--data", source, "--to", backupDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /backup ok:/);
  assert.match(result.stdout, /schema v\d+/);
  assert.match(result.stdout, /sha256 [0-9a-f]{64}/);
  assert.match(result.stdout, /source unchanged: yes/);

  const restored = path.join(dir, "restored.db");
  const restoreResult = runCli(["restore", "--from", backupDir, "--data", restored]);
  assert.equal(restoreResult.status, 0, restoreResult.stderr);
  assert.match(restoreResult.stdout, /restore ok:/);
  assert.match(restoreResult.stdout, /schema v\d+/);

  assert.equal(runCli(["backup", "--data", source]).status, 2, "missing --to is a usage error");
  assert.equal(runCli(["restore", "--data", restored]).status, 2, "missing --from is a usage error");
});

test("serve --pidfile writes the current PID and removes it on graceful shutdown", { skip: DB_SKIP }, async (t) => {
  const dir = tempDir("atk-pidfile-");
  const dataFile = path.join(dir, "serve.db");
  const pidfile = path.join(dir, "run", "backend.pid");
  const cliUrl = new URL("../cli.mjs", import.meta.url).href;
  const wrapper = `
    import(${JSON.stringify(cliUrl)}).then((module) => {
      module.run(["serve", "--port", "0", "--data", ${JSON.stringify(dataFile)}, "--pidfile", ${JSON.stringify(pidfile)}])
        .then((code) => { process.exitCode = code ?? 0; });
      setTimeout(() => process.emit("SIGINT"), 2500);
    });
  `;
  const child = spawn(process.execPath, ["-e", wrapper], {
    cwd: dir,
    env: { ...process.env, LOCALAPPDATA: dir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      // already exited
    }
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !fs.existsSync(pidfile)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(fs.existsSync(pidfile), `pidfile was not written; stdout=${stdout}`);
  assert.equal(fs.readFileSync(pidfile, "utf8").trim(), String(child.pid));
  assert.match(stdout, /pidfile:/);

  const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  assert.equal(exitCode, 0, `serve exited ${exitCode}`);
  assert.equal(fs.existsSync(pidfile), false, "graceful shutdown removes the pidfile");
});
