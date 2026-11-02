// M5 independent QA: launcher / process / filesystem adversarial suite (QA-006).
//
// Scope: the frozen M5 tree at 910bb08 - one-command start, ordered stop,
// credential isolation (env only), crash behaviour (host, supervisor, partial
// death), backup/restore, and the m5-smoke gate itself.
//
// Written against docs/architecture/m5-contracts.md and docs/operations/.
// Tests use a temp dataDir + a random loopback port; the developer instance on
// 1421 is never touched. Node < 22.5 (no node:sqlite) skips the whole file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(REPO, "apps", "launcher", "cli.mjs");
const BACKEND = path.join(REPO, "apps", "backend", "cli.mjs");
const HOST = path.join(REPO, "apps", "runtime-host", "cli.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

if (!hasSqlite) {
  test("m5 adversarial suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5; this file is skipped, not passed" }, () => {});
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { openStore } = await import(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href);

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
  function alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }
  function run(file, args, { env = {}, timeout = 120000 } = {}) {
    const result = spawnSync(process.execPath, [file, ...args], {
      cwd: REPO,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  function launch(args, env = {}) {
    return run(LAUNCHER, args, { env });
  }
  function status(dataDir) {
    const result = run(LAUNCHER, ["status", "--data", dataDir, "--json"], { timeout: 30000 });
    let json = null;
    try {
      json = JSON.parse(result.stdout.trim().split("\n").pop());
    } catch {
      json = null;
    }
    return { code: result.status, json, text: `${result.stdout}${result.stderr}` };
  }
  async function waitFor(predicate, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  }
  function walkFiles(dir) {
    const files = [];
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walkFiles(full));
      else if (entry.isFile()) files.push(full);
    }
    return files;
  }
  function textFiles(dir) {
    return walkFiles(dir).filter((file) => /\.(log|json|txt|md)$/i.test(file));
  }

  async function makeSandbox(t, { hosts = 2 } = {}) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m5-qa-"));
    const dataDir = path.join(tmp, "data");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const trackedPids = new Set();
    const env = { ATK_DATA_DIR: dataDir };
    const sandbox = {
      tmp,
      dataDir,
      port,
      base,
      env,
      dbFile: path.join(dataDir, "data", "atk.db"),
      trackedPids,
      start(extra = [], extraEnv = {}) {
        return launch(["start", "--port", String(port), "--data", dataDir, "--hosts", String(hosts), ...extra], { ...env, ...extraEnv });
      },
      status() {
        return status(dataDir);
      },
      watch() {
        for (const child of sandbox.status().json?.children ?? []) trackedPids.add(child.pid);
        return sandbox.status().json;
      },
      stop(force = false) {
        return launch(["stop", "--data", dataDir, ...(force ? ["--force"] : [])], env);
      },
      async health() {
        return fetch(`${base}/api/v1/system/health`).then(async (response) => ({ status: response.status, body: await response.json() })).catch((error) => ({ status: 0, error: error.message }));
      },
      seed(count = 2) {
        const store = openStore({ file: sandbox.dbFile, migrate: true });
        try {
          const project = store.createProject({ id: `QA-P-${Date.now()}`, name: "qa", repoPath: REPO, defaultBranch: "m0/baseline-and-p0" });
          // M6.3: Runtime Hosts register their own agents and heartbeat them;
          // seeding fake IDLE agents here would compete with the real workers
          // and reintroduce the "IDLE == dispatchable" assumption.
          for (let index = 0; index < count; index += 1) {
            store.createTask({ id: `QA-T-${Date.now()}-${index}`, projectId: project.id, title: `qa ${index}`, description: "qa", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "qa" });
          }
        } finally {
          store.close();
        }
      },
      runs() {
        const store = openStore({ file: sandbox.dbFile, migrate: false });
        try {
          return store.listRuns({ limit: 50 });
        } finally {
          store.close();
        }
      },
    };
    t.after(async () => {
      try {
        sandbox.stop();
      } catch {
        /* ignore */
      }
      try {
        const supervisor = JSON.parse(readFileSync(path.join(dataDir, "runtime", "launcher.pid"), "utf8")).pid;
        trackedPids.add(supervisor);
      } catch {
        /* no pid file */
      }
      for (const pid of trackedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(tmp, { recursive: true, force: true });
          return;
        } catch {
          await sleep(200);
        }
      }
    });
    return sandbox;
  }

  // -------------------------------------------------------------------------
  // A. start / status / stop
  // -------------------------------------------------------------------------
  test("A1 one command brings up backend, scheduler and N hosts, and work completes", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 2 });
    const started = sandbox.start();
    assert.equal(started.status, 0, `start failed:\n${started.stdout}\n${started.stderr}`);
    const snapshot = sandbox.watch();
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.health?.ok, true);
    const roles = snapshot.children.map((child) => child.role).sort();
    assert.deepEqual(roles, ["backend", "host", "host", "scheduler"]);
    assert.ok(snapshot.children.every((child) => child.alive));
    assert.equal((await sandbox.health()).status, 200);
    sandbox.seed(3);
    await waitFor(() => sandbox.runs().filter((run) => run.status === "COMPLETED").length >= 2, 45000, "two completed runs");
    // The tree must still be alive after the work (regression: keepAlive mode).
    await sleep(2500);
    const later = sandbox.status().json;
    assert.ok(later.children.every((child) => child.alive), `a long-lived child exited: ${JSON.stringify(later.children)}`);
  });

  test("A2 a second start is refused (exit 2) and does not spawn a second tree", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    assert.equal(sandbox.start().status, 0);
    const before = sandbox.status().json.children.map((child) => child.pid);
    const second = sandbox.start();
    assert.equal(second.status, 2, `double start must exit 2, got ${second.status}: ${second.stderr}`);
    const after = sandbox.status().json.children.map((child) => child.pid);
    assert.deepEqual(after, before);
    for (const pid of before) assert.ok(alive(pid));
  });

  test("A3 a dead host is reported down; stop then kills every recorded child and frees the port", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 2 });
    assert.equal(sandbox.start().status, 0);
    const snapshot = sandbox.watch();
    const host = snapshot.children.find((child) => child.role === "host");
    process.kill(host.pid);
    await sleep(500);
    const afterKill = sandbox.status();
    assert.equal(afterKill.json.children.find((child) => child.pid === host.pid).alive, false);
    assert.equal(afterKill.code, 1, "status must exit non-zero when a child is down");
    const pids = afterKill.json.children.map((child) => child.pid);
    const stopped = sandbox.stop();
    assert.equal(stopped.status, 0);
    await waitFor(() => pids.every((pid) => !alive(pid)), 10000, "all children to exit");
    assert.ok(pids.every((pid) => !alive(pid)));
    await assert.rejects(fetch(`${sandbox.base}/api/v1/system/health`).then((response) => {
      if (response.ok) throw new Error("backend still answering");
      return response;
    }));
    const second = sandbox.stop();
    assert.equal(second.status, 0, "stop must stay idempotent");
  });

  test("A4 stop --force also leaves no live child (port released)", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 2 });
    assert.equal(sandbox.start().status, 0);
    const pids = sandbox.watch().children.map((child) => child.pid);
    const stopped = sandbox.stop(true);
    assert.equal(stopped.status, 0);
    await waitFor(() => pids.every((pid) => !alive(pid)), 10000, "forced stop to kill children");
    assert.ok(pids.every((pid) => !alive(pid)));
  });

  test("A5 a stale state file with dead PIDs is cleaned up by the next start", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    assert.equal(sandbox.start().status, 0);
    const old = sandbox.watch().children.map((child) => child.pid);
    for (const pid of old) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await waitFor(() => old.every((pid) => !alive(pid)), 10000, "old children to die");
    const restart = sandbox.start();
    assert.equal(restart.status, 0, `start over stale state failed: ${restart.stderr}`);
    const fresh = sandbox.watch().children.map((child) => child.pid);
    assert.ok(fresh.every((pid) => alive(pid)));
    for (const pid of fresh) assert.ok(!old.includes(pid), "a stale PID was reused as a live child");
  });

  // -------------------------------------------------------------------------
  // B. credential isolation
  // -------------------------------------------------------------------------
  test("B1 the internal credential never reaches state, logs or status", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    assert.equal(sandbox.start().status, 0);
    sandbox.seed(1);
    await waitFor(() => sandbox.runs().length >= 1, 30000, "a run");
    const snapshot = sandbox.status();
    assert.doesNotMatch(JSON.stringify(snapshot.json), /"[^"]*(token|secret|credential)[^"]*"\s*:/i, "status JSON exposes a credential field");
    const state = JSON.parse(readFileSync(path.join(sandbox.dataDir, "launcher.json"), "utf8"));
    assert.deepEqual(Object.keys(state).sort(), ["children", "port", "startedAt", "version"]);
    for (const child of state.children) assert.deepEqual(Object.keys(child).sort(), ["name", "pid", "role"]);
    for (const file of textFiles(path.join(sandbox.dataDir, "logs")).concat([path.join(sandbox.dataDir, "launcher.json")])) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /internal token:\s*(?!\[REDACTED\])\S{10,}/i, `${file}: raw internal token line`);
      assert.doesNotMatch(text, /x-atk-internal:\s*\S{10,}/i, `${file}: raw internal credential header`);
    }
    // The redaction must actually happen, not just be absent because nothing was printed.
    const backendLog = readFileSync(path.join(sandbox.dataDir, "logs", "backend.log"), "utf8");
    assert.match(backendLog, /internal credential received|\[redacted\]/i, "the credential banner should be visibly redacted, not missing");
  });

  test("B2 the credential is passed through child env: a wrong parent token still works, a host without token refuses", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    const sentinel = `WRONG-PARENT-${"z".repeat(40)}`;
    const started = sandbox.start([], { ATK_INTERNAL_TOKEN: sentinel });
    assert.equal(started.status, 0, `start failed with a wrong parent token: ${started.stderr}`);
    sandbox.seed(2);
    await waitFor(() => sandbox.runs().filter((run) => run.status === "COMPLETED").length >= 1, 45000, "work under a wrong parent token");
    const state = readFileSync(path.join(sandbox.dataDir, "launcher.json"), "utf8");
    assert.ok(!state.includes(sentinel), "the parent token was persisted");
    for (const file of textFiles(path.join(sandbox.dataDir, "logs"))) assert.ok(!readFileSync(file, "utf8").includes(sentinel), `${file}: parent token leaked`);
    const noEnv = spawnSync(process.execPath, [HOST, "--once"], {
      cwd: REPO,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
      env: { ...process.env, ATK_INTERNAL_TOKEN: "" },
    });
    assert.equal(noEnv.status, 2, "a runtime host without ATK_INTERNAL_TOKEN must refuse to start");
    assert.match(noEnv.stderr, /ATK_INTERNAL_TOKEN/);
  });

  test("B3 status --json is machine-readable and carries no credential-shaped value", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    assert.equal(sandbox.start().status, 0);
    const snapshot = sandbox.status();
    assert.equal(snapshot.code, 0);
    const text = JSON.stringify(snapshot.json);
    assert.doesNotMatch(text, /internal token|x-atk-internal/i);
    // A 43-char base64url token value must not appear anywhere in the status payload.
    assert.doesNotMatch(text.replace(/"(startedAt|version)":"?[^",}]*"?/g, ""), /[A-Za-z0-9_-]{43}/, "status contains a token-shaped value");
  });

  // -------------------------------------------------------------------------
  // C. crash behaviour
  // -------------------------------------------------------------------------
  test("C1 killing the supervisor leaves no orphans after stop", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    assert.equal(sandbox.start().status, 0);
    const childPids = sandbox.watch().children.map((child) => child.pid);
    const pidFile = JSON.parse(readFileSync(path.join(sandbox.dataDir, "runtime", "launcher.pid"), "utf8"));
    process.kill(pidFile.pid, "SIGKILL");
    await sleep(300);
    assert.equal(alive(pidFile.pid), false);
    const stopped = sandbox.stop();
    assert.equal(stopped.status, 0, `stop after a dead supervisor must still succeed: ${stopped.stderr}`);
    await waitFor(() => childPids.every((pid) => !alive(pid)), 10000, "children after a dead supervisor");
    assert.ok(childPids.every((pid) => !alive(pid)));
    assert.equal(existsSync(path.join(sandbox.dataDir, "launcher.json")), false);
  });

  test("C2 the fallback stop path kills a live recorded child when no supervisor exists", async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m5-fallback-"));
    const port = await freePort();
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", `require('node:net').createServer(()=>{}).listen(${port},'127.0.0.1');setInterval(()=>{},1000);`], { stdio: "ignore", windowsHide: true });
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } try { rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ } });
    await sleep(600);
    writeFileSync(path.join(tmp, "launcher.json"), JSON.stringify({ version: 1, port, startedAt: new Date().toISOString(), children: [{ name: "backend", pid: child.pid, role: "backend" }] }, null, 2));
    const startedAt = Date.now();
    const stopped = launch(["stop", "--data", tmp]);
    assert.equal(stopped.status, 0);
    assert.ok(Date.now() - startedAt >= 5000, "the fallback path must wait for the supervisor rather than pretend");
    assert.equal(alive(child.pid), false, "the fallback must actually kill the recorded child");
    assert.equal(existsSync(path.join(tmp, "launcher.json")), false);
  });

  test("C3 a corrupt state file must not orphan a running tree", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    assert.equal(sandbox.start().status, 0);
    const snapshot = sandbox.watch();
    const childPids = snapshot.children.map((child) => child.pid);
    const supervisor = JSON.parse(readFileSync(path.join(sandbox.dataDir, "runtime", "launcher.pid"), "utf8")).pid;
    sandbox.trackedPids.add(supervisor);
    writeFileSync(path.join(sandbox.dataDir, "launcher.json"), "{ this file was truncated by a crash");
    const stopped = sandbox.stop();
    assert.equal(stopped.status, 0, "stop should not crash on a corrupt state file");
    await waitFor(() => childPids.every((pid) => !alive(pid)), 8000, "stop should still reach the recorded children").catch(() => {});
    assert.ok(childPids.every((pid) => !alive(pid)), "a corrupt launcher.json left the whole process tree running and unmanageable");
  });

  test("C4 status reports running=false once the backend is dead (partial death)", async (t) => {
    const sandbox = await makeSandbox(t, { hosts: 1 });
    assert.equal(sandbox.start().status, 0);
    const snapshot = sandbox.watch();
    const backend = snapshot.children.find((child) => child.role === "backend");
    process.kill(backend.pid);
    await sleep(600);
    const after = sandbox.status();
    const backendEntry = after.json.children.find((child) => child.pid === backend.pid);
    assert.equal(backendEntry.alive, false);
    assert.equal(after.code, 1, "status must exit 1 when the backend is dead");
    assert.equal(after.json.running, false, "a machine-readable status must not claim the system is running when its backend is dead");
    assert.notEqual(after.json.health?.ok, true);
  });

  // -------------------------------------------------------------------------
  // D. backup / restore
  // -------------------------------------------------------------------------
  async function makeDatabase(t) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m5-db-"));
    const dbFile = path.join(tmp, "data", "db", "atk.db");
    mkdirSync(path.dirname(dbFile), { recursive: true });
    const migrated = run(BACKEND, ["migrate", "--data", dbFile, "--from", path.join(REPO, ".agent-flow", "state.json"), "--json"]);
    assert.equal(migrated.status, 0, migrated.stderr);
    const store = openStore({ file: dbFile, migrate: true });
    const project = store.createProject({ id: "QA-BP", name: "qa backup", repoPath: REPO, defaultBranch: "main" });
    for (let index = 0; index < 5; index += 1) store.createTask({ id: `QA-BT-${index}`, projectId: project.id, title: `t${index}`, description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    store.close();
    t.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ } });
    return { tmp, dbFile };
  }
  const fileSha = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);
  const backup = (dbFile, to) => run(BACKEND, ["backup", "--data", dbFile, "--to", to, "--json"]);
  const restore = (from, data) => run(BACKEND, ["restore", "--from", from, "--data", data, "--json"]);
  function countTasks(file) {
    const store = openStore({ file, migrate: false });
    try {
      return store.listTasks({}).length;
    } finally {
      store.close();
    }
  }

  test("D1 backup does not modify the source database and writes a valid manifest", async (t) => {
    const { tmp, dbFile } = await makeDatabase(t);
    const before = { sha: fileSha(dbFile), bytes: statSync(dbFile).size, tasks: countTasks(dbFile) };
    const result = backup(dbFile, path.join(tmp, "backup"));
    assert.equal(result.status, 0, result.stderr);
    const after = { sha: fileSha(dbFile), bytes: statSync(dbFile).size, tasks: countTasks(dbFile) };
    assert.deepEqual(after, before, "backup changed the source database");
    const manifest = JSON.parse(readFileSync(path.join(tmp, "backup", "manifest.json"), "utf8"));
    assert.equal(manifest.sha256, fileSha(path.join(tmp, "backup", "atk.db")));
    assert.equal(manifest.bytes, statSync(path.join(tmp, "backup", "atk.db")).size);
    assert.ok(Number.isInteger(manifest.schemaVersion) && manifest.schemaVersion >= 4);
  });

  test("D2 a tampered snapshot is refused and the restore target is untouched", async (t) => {
    const { tmp, dbFile } = await makeDatabase(t);
    assert.equal(backup(dbFile, path.join(tmp, "backup")).status, 0);
    const snapshot = path.join(tmp, "backup", "atk.db");
    const original = readFileSync(snapshot);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(snapshot, tampered);
    const target = path.join(tmp, "target", "data", "atk.db");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "KEEP");
    const refused = restore(path.join(tmp, "backup"), target);
    assert.equal(refused.status, 1);
    assert.match(`${refused.stdout}${refused.stderr}`, /integrity|sha256|manifest/i);
    assert.equal(readFileSync(target, "utf8"), "KEEP");
  });

  test("D3 manifest sha/schemaVersion tampering and a too-new schema are refused", async (t) => {
    const { tmp, dbFile } = await makeDatabase(t);
    assert.equal(backup(dbFile, path.join(tmp, "backup")).status, 0);
    const manifestPath = path.join(tmp, "backup", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
    assert.equal(restore(path.join(tmp, "backup"), path.join(tmp, "a", "data", "atk.db")).status, 1);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 999 }));
    const tooNew = restore(path.join(tmp, "backup"), path.join(tmp, "b", "data", "atk.db"));
    assert.equal(tooNew.status, 1);
    assert.match(`${tooNew.stdout}${tooNew.stderr}`, /schemaVersion|newer|upgrade/i);
  });

  test("D4 restore into another directory preserves rows and starts there (health 200)", async (t) => {
    const { tmp, dbFile } = await makeDatabase(t);
    assert.equal(backup(dbFile, path.join(tmp, "backup")).status, 0);
    const restored = path.join(tmp, "restored");
    const restoredDb = path.join(restored, "data", "atk.db");
    const result = restore(path.join(tmp, "backup"), restoredDb);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(countTasks(restoredDb), countTasks(dbFile));
    const port = await freePort();
    const started = launch(["start", "--port", String(port), "--data", restored, "--hosts", "1"], { ATK_DATA_DIR: restored });
    t.after(() => launch(["stop", "--data", restored], { ATK_DATA_DIR: restored }));
    assert.equal(started.status, 0, started.stderr);
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/system/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.db.counts.tasks, countTasks(dbFile));
  });

  test("D5 backup refuses a non-empty directory without --force and overwrites with it", async (t) => {
    const { tmp, dbFile } = await makeDatabase(t);
    const to = path.join(tmp, "backup");
    mkdirSync(to, { recursive: true });
    writeFileSync(path.join(to, "keep.txt"), "keep");
    const refused = backup(dbFile, to);
    assert.equal(refused.status, 1);
    assert.match(`${refused.stdout}${refused.stderr}`, /not empty|force/i);
    const forced = run(BACKEND, ["backup", "--data", dbFile, "--to", to, "--force", "--json"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(readFileSync(path.join(to, "keep.txt"), "utf8"), "keep");
  });

  test("D6 restore refuses an existing target unless --force, and the old target survives", async (t) => {
    const { tmp, dbFile } = await makeDatabase(t);
    assert.equal(backup(dbFile, path.join(tmp, "backup")).status, 0);
    const target = path.join(tmp, "existing", "data", "atk.db");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "KEEP");
    const refused = restore(path.join(tmp, "backup"), target);
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(target, "utf8"), "KEEP");
    const forced = run(BACKEND, ["restore", "--from", path.join(tmp, "backup"), "--data", target, "--force", "--json"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.notEqual(readFileSync(target, "utf8"), "KEEP");
    assert.equal(countTasks(target), 6);
  });

  test("D7 a backup taken while the WAL holds uncheckpointed writes stays consistent", async (t) => {
    const { tmp, dbFile } = await makeDatabase(t);
    const store = openStore({ file: dbFile, migrate: true });
    try {
      const project = store.listProjects()[0];
      for (let index = 0; index < 3; index += 1) {
        store.createTask({ id: `QA-WAL-${index}`, projectId: project.id, title: `wal ${index}`, description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
      }
      const sourceCount = store.listTasks({}).length;
      assert.equal(backup(dbFile, path.join(tmp, "wal-backup")).status, 0);
      const restoredDb = path.join(tmp, "wal-restored", "data", "atk.db");
      assert.equal(restore(path.join(tmp, "wal-backup"), restoredDb).status, 0);
      assert.equal(countTasks(restoredDb), sourceCount, "a plain .db copy loses the transactions that only existed in the WAL");
    } finally {
      store.close();
    }
  });

  // -------------------------------------------------------------------------
  // E. edge cases
  // -------------------------------------------------------------------------
  test("E1 a busy port fails the start with a readable message and leaves no tree", async (t) => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = blocker.address().port;
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m5-busy-"));
    t.after(async () => {
      blocker.close();
      try { launch(["stop", "--data", path.join(tmp, "data")], { ATK_DATA_DIR: path.join(tmp, "data") }); } catch { /* ignore */ }
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ }
    });
    const started = launch(["start", "--port", String(port), "--data", path.join(tmp, "data"), "--hosts", "1"], { ATK_DATA_DIR: path.join(tmp, "data") });
    assert.equal(started.status, 1, `a busy port must exit 1, got ${started.status}`);
    assert.match(`${started.stdout}${started.stderr}`, /use|exited|port|token/i);
    assert.equal(existsSync(path.join(tmp, "data", "launcher.json")), false);
  });

  test("E2 --hosts 0 and 99 are usage errors (exit 2, nothing spawned)", async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m5-usage-"));
    t.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ } });
    for (const value of ["0", "99"]) {
      const result = launch(["start", "--data", path.join(tmp, "data"), "--hosts", value], { ATK_DATA_DIR: path.join(tmp, "data") });
      assert.equal(result.status, 2, `--hosts ${value} must be exit 2, got ${result.status}`);
      assert.match(result.stderr, /hosts must be/i);
    }
    assert.equal(existsSync(path.join(tmp, "data", "launcher.json")), false);
  });

  test("E3 an invalid data directory fails readably (no half-written state)", async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m5-baddir-"));
    t.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ } });
    const asFile = path.join(tmp, "data");
    writeFileSync(asFile, "not a directory");
    const result = launch(["start", "--port", String(await freePort()), "--data", asFile, "--hosts", "1"], { ATK_DATA_DIR: asFile });
    assert.equal(result.status, 1, `invalid data dir must exit 1, got ${result.status}`);
    assert.match(`${result.stdout}${result.stderr}`, /error|ENOTDIR|directory|EEXIST/i);
  });

  test("E4 docs and CLI agree on the M5 surface (flags, defaults, exit codes)", async () => {
    const contracts = readFileSync(path.join(REPO, "docs/architecture/m5-contracts.md"), "utf8");
    const cli = readFileSync(LAUNCHER, "utf8");
    for (const command of ["start", "stop", "status", "logs"]) {
      assert.match(contracts, new RegExp(`atk ${command}`), `m5-contracts does not document atk ${command}`);
      assert.match(cli, new RegExp(`case "${command}"`), `the CLI does not implement ${command}`);
    }
    for (const flag of ["--port", "--data", "--hosts", "--runtime", "--detach", "--force", "--json", "--follow"]) {
      assert.match(contracts, new RegExp(flag.replace("-", "\\-")), `m5-contracts is missing ${flag}`);
      assert.ok(cli.includes(`"${flag.slice(2)}"`), `the CLI is missing ${flag}`);
    }
    assert.match(cli, /Exit codes: 0 ok, 1 runtime failure, 2 usage/);
    const ops = readFileSync(path.join(REPO, "docs/operations/install-upgrade-rollback.md"), "utf8");
    for (const command of ["atk start", "atk stop", "backup", "restore"]) assert.ok(ops.includes(command), `install-upgrade-rollback.md is missing ${command}`);
  });

  test("E5 M5 source and docs stay private (no token, no machine path)", async () => {
    const files = [
      path.join(REPO, "apps/launcher/src/launcher.mjs"),
      path.join(REPO, "apps/launcher/src/state.mjs"),
      path.join(REPO, "apps/launcher/cli.mjs"),
      path.join(REPO, "scripts/m5-smoke.mjs"),
      path.join(REPO, "docs/architecture/m5-contracts.md"),
      path.join(REPO, "docs/operations/install-upgrade-rollback.md"),
    ];
    const userName = process.env.USERNAME;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.ok(!/\bsk-[A-Za-z0-9_-]{20,}/.test(text), `${file}: secret-like token`);
      const longTokenShapes = [...text.matchAll(/[A-Za-z0-9_-]{43,}/g)].map((match) => match[0]).filter((value) => !/^[-_]+$/.test(value) && !/^[0-9a-f]{40,}$/i.test(value) && !/^[a-z]+$/i.test(value));
      assert.deepEqual(longTokenShapes, [], `${file}: token-shaped literal`);
      if (userName) assert.ok(!text.includes(userName), `${file}: machine username`);
    }
  });
}


