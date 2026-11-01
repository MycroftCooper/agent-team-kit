// M6 independent QA: switch safety, event filters/pagination and upgrade behavior (QA-007).
//
// Reviewed object: frozen commit 0abdee1 (M6), not the later Phase C commit.
// Tests use temp databases and random loopback ports; the developer instance on
// 1421 is never touched. Node < 22.5 (no node:sqlite) skips the whole file.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.join(REPO, "apps", "backend", "cli.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

if (!hasSqlite) {
  test("m6 adversarial suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5; this file is skipped, not passed" }, () => {});
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const database = await import(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href);
  const { openStore, importStateJson, exportStateJson, verifySwitchReadiness, createMemoryStore } = database;

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
  function cli(args, timeout = 120000) {
    const result = spawnSync(process.execPath, [BACKEND, ...args], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  function tempDir(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atk-m6-qa-"));
    t.after(() => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* busy */ }
      }
    });
    return dir;
  }
  function fingerprint(file) {
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = ["projects", "requirements", "tasks", "task_dependencies", "agent_instances", "runs", "run_leases", "dispatch_commands", "events", "reviews", "approvals", "gate_results", "plans"];
      const out = {};
      for (const table of tables) out[table] = Number(raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
      out.migrations = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version);
      return out;
    } finally {
      raw.close();
    }
  }
  function seedBase(store) {
    const project = store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    const task = store.createTask({ id: "T-KEEP", projectId: "P1", title: "keep", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    store.upsertAgent({ id: "A-KEEP", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    store.appendEvent({ projectId: "P1", aggregateType: "task", aggregateId: task.id, type: "task.updated" });
    return { project, task };
  }
  function legacyState(extra = {}) {
    return {
      schemaVersion: 1,
      project: { id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" },
      batch: { id: "B1", goal: "g" },
      packages: [],
      subitems: [],
      ...extra,
    };
  }
  function importReport(store, state, mode = "replace") {
    try {
      return importStateJson(store, { stateJson: state, runtime: { schemaVersion: 3, agents: [] }, mode, force: true, now: "2026-11-02T00:00:00Z" });
    } catch (error) {
      return { status: "THREW", error };
    }
  }
  function assertRefusedWithoutWrites(t, label, state, expectedCollection, expectedCode = "IMPORT_WRITE_FAILED") {
    const dir = tempDir(t);
    const file = path.join(dir, "atk.db");
    const store = openStore({ file, migrate: true });
    seedBase(store);
    const before = fingerprint(file);
    const report = importReport(store, state);
    const after = fingerprint(file);
    store.close();
    assert.notEqual(report.status, "PASS", `${label}: replace must be refused, got ${report.status}`);
    assert.ok(report.problems?.some((problem) => problem.code === expectedCode), `${label}: expected ${expectedCode}, got ${JSON.stringify(report.problems)}`);
    if (expectedCollection) assert.ok(report.problems.some((problem) => problem.detail?.collection === expectedCollection), `${label}: collection ${expectedCollection}`);
    assert.deepEqual(after, before, `${label}: a refused replace must not write/clear anything`);
  }

  // -------------------------------------------------------------------------
  // A. replace fail-closed
  // -------------------------------------------------------------------------
  test("A1 batch.tasks / top-level tasks / malformed tasks are refused before any write", async (t) => {
    assertRefusedWithoutWrites(t, "batch.tasks", legacyState({ batch: { id: "B1", tasks: [{ id: "X", stage: "todo" }] } }), "batch.tasks");
    assertRefusedWithoutWrites(t, "top-level tasks", legacyState({ tasks: [{ id: "X", stage: "todo" }] }), "tasks");
    assertRefusedWithoutWrites(t, "tasks object", legacyState({ tasks: { id: "X" } }), "tasks", "INVALID_RECORD");
  });

  test("A2 a non-empty requirements collection is an unknown collection and must be refused", async (t) => {
    assertRefusedWithoutWrites(t, "requirements", legacyState({ requirements: [{ id: "REQ-X", projectId: "P1", description: "must not disappear" }] }), "requirements");
  });

  test("A3 case variants, nested unknown collections and agents are refused", async (t) => {
    assertRefusedWithoutWrites(t, "Tasks (capital)", legacyState({ Tasks: [{ id: "X" }] }), "Tasks");
    assertRefusedWithoutWrites(t, "batch.Tasks (capital)", legacyState({ batch: { id: "B1", Tasks: [{ id: "X" }] } }), "batch.Tasks");
    assertRefusedWithoutWrites(t, "top-level agents", legacyState({ agents: [{ id: "A-X", role: "DEV" }] }), "agents");
    assertRefusedWithoutWrites(t, "nested unknown", legacyState({ batch: { id: "B1", nested: { tasks: [{ id: "X" }] } } }), "batch.nested");
  });

  test("A4 an empty tasks array is harmless and may proceed", async (t) => {
    const dir = tempDir(t);
    const store = openStore({ file: path.join(dir, "atk.db"), migrate: true });
    const report = importReport(store, legacyState({ tasks: [], batch: { id: "B1", tasks: [] } }));
    assert.equal(report.status, "PASS");
    assert.equal(store.listTasks({}).length, 0);
    store.close();
  });

  test("A5 an injected mid-write failure rolls back the whole replace and the ledger", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "atk.db");
    const store = openStore({ file, migrate: true });
    seedBase(store);
    const before = fingerprint(file);
    const state = legacyState({
      packages: [
        { id: "NEW-1", type: "feature", owner: "DEV", scope: "a", stage: "todo", priority: "P1", deps: [] },
        { id: "NEW-2", type: "feature", owner: "DEV", scope: "b", stage: "todo", priority: "P1", deps: [] },
      ],
    });
    const originalCreateTask = store.createTask;
    let calls = 0;
    store.createTask = (...args) => {
      calls += 1;
      if (calls === 2) throw new Error("qa injected mid-write failure");
      return originalCreateTask.apply(store, args);
    };
    let report;
    try {
      report = importReport(store, state);
    } finally {
      store.createTask = originalCreateTask;
    }
    const after = fingerprint(file);
    store.close();
    assert.equal(report.status, "SKIPPED");
    assert.ok(report.problems.some((problem) => problem.code === "IMPORT_WRITE_FAILED"));
    assert.deepEqual(after, before, "rollback must restore every business table and the migration ledger");
    assert.throws(() => openStore({ file, migrate: false }).getTask("NEW-1"), (error) => error.code === "NOT_FOUND");
    const reopened = openStore({ file, migrate: true });
    try {
      assert.equal(reopened.health().schemaVersion, 5);
      assert.equal(reopened.listTasks({}).length, 1);
      assert.equal(reopened.listEvents({}).length, 1);
    } finally {
      reopened.close();
    }
  });

  // -------------------------------------------------------------------------
  // B. switch safety / export-import
  // -------------------------------------------------------------------------
  test("B1 export -> replace reproduces tasks, dependencies and statuses exactly", async (t) => {
    const dir = tempDir(t);
    const source = path.join(dir, "source", "atk.db");
    const exportFile = path.join(dir, "export.json");
    const target = path.join(dir, "target", "atk.db");
    const store = openStore({ file: source, migrate: true });
    seedBase(store);
    const task = store.getTask("T-KEEP");
    store.patchTask("T-KEEP", { expectedVersion: task.version, changes: { status: "CLAIMED" } });
    store.close();
    assert.equal(cli(["export", "--data", source, "--to", exportFile, "--json"]).status, 0);
    assert.equal(cli(["import", "--from", exportFile, "--data", target, "--mode", "replace", "--force", "--json"]).status, 0);
    const restored = openStore({ file: target, migrate: false });
    try {
      assert.deepEqual(restored.listTasks({}).map((entry) => [entry.id, entry.status]), [["T-KEEP", "CLAIMED"]]);
      assert.deepEqual(restored.listProjects().map((entry) => entry.id), ["P1"]);
      assert.deepEqual(restored.listAgents().map((entry) => entry.id), ["A-KEEP"]);
    } finally {
      restored.close();
    }
    const again = path.join(dir, "again.json");
    assert.equal(cli(["export", "--data", target, "--to", again, "--json"]).status, 0);
    const a = JSON.parse(readFileSync(exportFile, "utf8"));
    const b = JSON.parse(readFileSync(again, "utf8"));
    assert.deepEqual(a.stateJson.packages.map((entry) => [entry.id, entry.stage]), b.stateJson.packages.map((entry) => [entry.id, entry.stage]));
    assert.deepEqual(a.stateJson.subitems, b.stateJson.subitems);
  });

  test("B2 merge is idempotent (two imports of the same document do not duplicate rows)", async (t) => {
    const dir = tempDir(t);
    const source = path.join(dir, "source", "atk.db");
    const exportFile = path.join(dir, "export.json");
    const target = path.join(dir, "target", "atk.db");
    const store = openStore({ file: source, migrate: true });
    seedBase(store);
    store.close();
    assert.equal(cli(["export", "--data", source, "--to", exportFile, "--json"]).status, 0);
    assert.equal(cli(["import", "--from", exportFile, "--data", target, "--json"]).status, 0);
    const first = fingerprint(target);
    assert.equal(cli(["import", "--from", exportFile, "--data", target, "--json"]).status, 0);
    assert.deepEqual(fingerprint(target), first);
  });

  test("B3 with an active RUNNING Run/command, import --mode replace must refuse", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "data", "atk.db");
    const exportFile = path.join(dir, "export.json");
    const store = openStore({ file, migrate: true });
    const project = store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    const task = store.createTask({ id: "T-ACT", projectId: project.id, title: "active", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    store.upsertAgent({ id: "A1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    const claim = store.claimTask({ taskId: task.id, agentId: "A1", expectedTaskVersion: task.version, idempotencyKey: "qa-m6-b3" });
    store.updateRunStatus(claim.run.id, { status: "RUNNING" });
    assert.equal(verifySwitchReadiness(store).ok, false, "fixture must be blocked");
    store.close();
    assert.equal(cli(["export", "--data", file, "--to", exportFile, "--json"]).status, 0);
    const before = fingerprint(file);
    const imported = cli(["import", "--from", exportFile, "--data", file, "--mode", "replace", "--force", "--json"]);
    assert.notEqual(imported.status, 0, `an active RUNNING Run must block the switch, got exit ${imported.status}: ${imported.stdout.slice(-300)}`);
    assert.deepEqual(fingerprint(file), before, "a blocked switch must not clear runs/commands/events");
  });

  // -------------------------------------------------------------------------
  // C. event filters / pagination
  // -------------------------------------------------------------------------
  function seedEvents(store) {
    store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    store.createTask({ id: "T1", projectId: "P1", title: "t", description: "d", functionRequired: "WORKER", roleRequired: "DEV", priority: 2, deps: [], acceptance: "x" });
    const types = ["task.updated", "run.created", "run.updated", "review.updated", "approval.recorded"];
    for (let index = 0; index < 25; index += 1) store.appendEvent({ projectId: "P1", aggregateType: "task", aggregateId: "T1", type: types[index % types.length] });
    for (let index = 0; index < 5; index += 1) store.appendEvent({ projectId: "P1", aggregateType: "run", aggregateId: "R1", type: "run.updated" });
  }
  test("C1 combined filters, empty results and store pagination boundaries", async (t) => {
    const dir = tempDir(t);
    const sqlite = openStore({ file: path.join(dir, "atk.db"), migrate: true });
    const memory = createMemoryStore();
    seedEvents(sqlite);
    seedEvents(memory);
    const cases = [
      { aggregateId: "T1" },
      { aggregateType: "run" },
      { aggregateType: "task", type: "task.updated" },
      { aggregateId: "T1", type: "task.updated", afterSeq: 5 },
      { projectId: "P1", type: "run.updated" },
      { aggregateId: "T1", afterSeq: 100000 },
      { aggregateId: "NOPE" },
      { aggregateId: "R1", limit: 5 },
    ];
    const project = (page) => ({ hasMore: page.hasMore, nextAfterSeq: page.nextAfterSeq, items: page.items.map((event) => ({ seq: event.seq, projectId: event.projectId, aggregateId: event.aggregateId, aggregateType: event.aggregateType, type: event.type, payload: event.payload })) });
    for (const filters of cases) {
      const left = sqlite.listEventsPage(filters);
      const right = memory.listEventsPage(filters);
      assert.deepEqual(project(left), project(right), `memory/sqlite mismatch for ${JSON.stringify(filters)}`);
      assert.deepEqual(left.items.map((event) => event.seq), [...left.items.map((event) => event.seq)].sort((a, b) => a - b));
      assert.equal(left.hasMore, false);
      assert.equal(left.nextAfterSeq, undefined);
    }
    const exact = sqlite.listEventsPage({ aggregateId: "R1", limit: 5 });
    assert.equal(exact.items.length, 5);
    assert.equal(exact.hasMore, false);
    assert.equal(exact.nextAfterSeq, undefined);
    const first = sqlite.listEventsPage({ aggregateId: "T1", limit: 1 });
    assert.equal(first.hasMore, true);
    assert.equal(first.nextAfterSeq, first.items[0].seq);
    sqlite.close();
  });

  test("C2 the HTTP events page is complete: hasMore/nextAfterSeq must match the returned items", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "data", "atk.db");
    const store = openStore({ file, migrate: true });
    store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    for (let index = 0; index < 4; index += 1) store.appendEvent({ projectId: "P1", aggregateType: "task", aggregateId: "T1", type: "task.updated" });
    store.close();
    const port = await freePort();
    const child = spawn(process.execPath, [BACKEND, "serve", "--port", String(port), "--data", file], { cwd: REPO, windowsHide: true, env: { ...process.env, LOCALAPPDATA: dir } });
    t.after(() => { try { child.kill(); } catch { /* gone */ } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/system/health`)).ok) { ready = true; break; } } catch { /* not up */ }
      await sleep(50);
    }
    assert.ok(ready, `backend did not start: ${output.slice(-300)}`);
    const session = await (await fetch(`http://127.0.0.1:${port}/api/v1/session`)).json();
    const get = async (query) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/events${query}`, { headers: { "x-atk-token": session.token } });
      return { status: response.status, body: await response.json() };
    };
    const first = await get("?limit=2");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.items.map((event) => event.seq), [1, 2]);
    assert.equal(first.body.hasMore, true, "4 events with limit 2 is not the last page");
    assert.equal(first.body.nextAfterSeq, 2, "nextAfterSeq must be the last RETURNED seq (3 skips event 3)");
    const second = await get(`?limit=2&afterSeq=${first.body.nextAfterSeq}`);
    assert.deepEqual(second.body.items.map((event) => event.seq), [3, 4]);
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.nextAfterSeq, undefined);
    // 3 events exactly == limit: the page is complete, so hasMore is false and no cursor.
    const exact = await get("?aggregateId=T1&limit=4");
    assert.equal(exact.body.items.length, 4);
    assert.equal(exact.body.hasMore, false);
    assert.equal(exact.body.nextAfterSeq, undefined);
  });

  test("C3 store caps limit at 1000; HTTP rejects >1000 and malformed filters", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "data", "atk.db");
    const store = openStore({ file, migrate: true });
    store.createProject({ id: "P1", name: "p1", repoPath: ".", defaultBranch: "main" });
    for (let index = 0; index < 1005; index += 1) store.appendEvent({ projectId: "P1", aggregateType: "task", aggregateId: "T1", type: "task.updated" });
    const capped = store.listEventsPage({ limit: 5000 });
    assert.equal(capped.items.length, 1000);
    assert.equal(capped.hasMore, true);
    for (const filters of [{ limit: 0 }, { limit: -1 }, { afterSeq: -1 }, { type: "" }, { aggregateType: "x".repeat(257) }]) {
      assert.throws(() => store.listEventsPage(filters), (error) => error.code === "VALIDATION_ERROR", JSON.stringify(filters));
    }
    store.close();
    const port = await freePort();
    const child = spawn(process.execPath, [BACKEND, "serve", "--port", String(port), "--data", file], { cwd: REPO, windowsHide: true, env: { ...process.env, LOCALAPPDATA: dir } });
    t.after(() => { try { child.kill(); } catch { /* gone */ } });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/system/health`)).ok) { ready = true; break; } } catch { /* not up */ }
      await sleep(50);
    }
    assert.ok(ready);
    const session = await (await fetch(`http://127.0.0.1:${port}/api/v1/session`)).json();
    for (const query of ["?limit=0", "?limit=1001", "?limit=abc", "?afterSeq=-1", "?aggregateId=bad%20id", "?type="]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/events${query}`, { headers: { "x-atk-token": session.token } });
      const body = await response.json();
      assert.equal(response.status, 400, `${query} must be 400`);
      assert.equal(body.error.code, "VALIDATION_ERROR");
    }
  });

  // -------------------------------------------------------------------------
  // D. upgrades
  // -------------------------------------------------------------------------
  const MIGRATION_FILES = ["0001_init.sql", "0002_runs_dispatch.sql", "0003_scheduling.sql", "0004_reviews_approvals.sql"];
  function makeLegacyDb(t, version) {
    const dir = tempDir(t);
    const file = path.join(dir, "atk.db");
    const raw = new DatabaseSync(file);
    try {
      for (let index = 0; index < version; index += 1) raw.exec(readFileSync(path.join(REPO, "packages", "database", "migrations", MIGRATION_FILES[index]), "utf8"));
      for (let index = 1; index <= version; index += 1) raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)").run(index, MIGRATION_FILES[index - 1], new Date().toISOString());
      raw.prepare("INSERT INTO projects (id, name, repo_path, default_branch, version, created_at, updated_at) VALUES ('V-P','v project','.','main',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
      raw.prepare("INSERT INTO tasks (id, project_id, title, description, function_required, role_required, priority, status, version, created_at, updated_at) VALUES ('V-T','V-P','v task','d','WORKER','DEV',2,'READY',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
      raw.prepare("INSERT INTO events (schema_version, project_id, aggregate_type, aggregate_id, type, payload_json, happened_at) VALUES (1,'V-P','task','V-T','task.updated','{}','2026-01-01T00:00:00Z')").run();
    } finally {
      raw.close();
    }
    return file;
  }
  test("D1 v1 and v4 databases upgrade to v5 with data AND old events still queryable", async (t) => {
    for (const version of [1, 4]) {
      const file = makeLegacyDb(t, version);
      const store = openStore({ file, migrate: true });
      try {
        assert.equal(store.health().schemaVersion, 5);
        assert.deepEqual(store.listProjects().map((project) => project.id), ["V-P"]);
        assert.deepEqual(store.listTasks({}).map((task) => task.id), ["V-T"]);
        assert.deepEqual(store.listEvents({ aggregateId: "V-T" }).map((event) => event.type), ["task.updated"]);
        assert.equal(store.listEventsPage({ aggregateId: "V-T" }).items.length, 1);
      } finally {
        store.close();
      }
      const raw = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_type_seq'").all().length, 1);
        assert.deepEqual(raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version), [1, 2, 3, 4, 5]);
      } finally {
        raw.close();
      }
    }
  });

  test("D2 a lost v5 migration row self-heals on reopen", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "atk.db");
    const store = openStore({ file, migrate: true });
    store.close();
    const raw = new DatabaseSync(file);
    raw.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
    raw.close();
    const reopened = openStore({ file, migrate: true });
    try {
      assert.equal(reopened.health().schemaVersion, 5);
      assert.equal(reopened.listEvents({}).length, 0);
    } finally {
      reopened.close();
    }
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT version FROM schema_migrations WHERE version = 5").all().length, 1);
      assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_type_seq'").all().length, 1);
    } finally {
      check.close();
    }
  });

  // -------------------------------------------------------------------------
  // E. backup / restore
  // -------------------------------------------------------------------------
  test("E1 tampered snapshot is refused without creating or changing the target", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "source", "atk.db");
    const store = openStore({ file, migrate: true });
    seedEvents(store);
    store.close();
    const backupDir = path.join(dir, "backup");
    assert.equal(cli(["backup", "--data", file, "--to", backupDir, "--json"]).status, 0);
    const snapshot = path.join(backupDir, "atk.db");
    const original = readFileSync(snapshot);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(snapshot, tampered);
    const target = path.join(dir, "target", "data", "atk.db");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "KEEP");
    const refused = cli(["restore", "--from", backupDir, "--data", target, "--force", "--json"]);
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(target, "utf8"), "KEEP");
    writeFileSync(snapshot, original);
  });

  test("E2 restore preserves exact counts and starts with health 200", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "source", "atk.db");
    const store = openStore({ file, migrate: true });
    seedEvents(store);
    const before = store.health().counts;
    store.close();
    const backupDir = path.join(dir, "backup");
    assert.equal(cli(["backup", "--data", file, "--to", backupDir, "--json"]).status, 0);
    const target = path.join(dir, "restored", "data", "atk.db");
    assert.equal(cli(["restore", "--from", backupDir, "--data", target, "--json"]).status, 0);
    const restored = openStore({ file: target, migrate: false });
    assert.deepEqual(restored.health().counts, before);
    restored.close();
    const port = await freePort();
    const child = spawn(process.execPath, [BACKEND, "serve", "--port", String(port), "--data", target], { cwd: REPO, windowsHide: true, env: { ...process.env, LOCALAPPDATA: dir } });
    t.after(() => { try { child.kill(); } catch { /* gone */ } });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/system/health`)).ok) { ready = true; break; } } catch { /* not up */ }
      await sleep(50);
    }
    assert.ok(ready);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/v1/system/health`)).json();
    assert.equal(health.db.counts.tasks, before.tasks);
    assert.equal(health.db.counts.events, before.events);
  });

  test("E3 a manifest with a too-new schemaVersion is refused", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "source", "atk.db");
    const store = openStore({ file, migrate: true });
    seedEvents(store);
    store.close();
    const backupDir = path.join(dir, "backup");
    assert.equal(cli(["backup", "--data", file, "--to", backupDir, "--json"]).status, 0);
    const manifestPath = path.join(backupDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 999 }));
    const target = path.join(dir, "target", "data", "atk.db");
    const refused = cli(["restore", "--from", backupDir, "--data", target, "--json"]);
    assert.equal(refused.status, 1);
    assert.match(`${refused.stdout}${refused.stderr}`, /schemaVersion|newer|upgrade/i);
    assert.equal(existsSync(target), false);
  });

  test("E4 a backup taken while the WAL holds uncheckpointed writes is consistent", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "source", "atk.db");
    const store = openStore({ file, migrate: true });
    seedEvents(store);
    const before = store.health().counts;
    try {
      const backupDir = path.join(dir, "backup");
      const backup = cli(["backup", "--data", file, "--to", backupDir, "--json"]);
      assert.equal(backup.status, 0, backup.stderr);
      const target = path.join(dir, "restored", "data", "atk.db");
      assert.equal(cli(["restore", "--from", backupDir, "--data", target, "--json"]).status, 0);
      const restored = openStore({ file: target, migrate: false });
      try {
        assert.deepEqual(restored.health().counts, before, "a plain .db copy loses the transactions that only existed in the WAL");
      } finally {
        restored.close();
      }
    } finally {
      store.close();
    }
  });

  // -------------------------------------------------------------------------
  // F. docs / CLI surface / privacy
  // -------------------------------------------------------------------------
  test("F1 documented M6 surface matches the CLI (export/import modes, non-PASS exit 1)", async (t) => {
    const contracts = readFileSync(path.join(REPO, "docs/architecture/m6-contracts.md"), "utf8");
    const cliText = readFileSync(BACKEND, "utf8");
    for (const token of ["listEvents", "listEventsPage", "importStateJson", "verifySwitchReadiness", "afterSeq", "limit"]) assert.ok(contracts.includes(token), `m6-contracts is missing ${token}`);
    for (const command of ["export", "import", "backup", "restore"]) assert.ok(cliText.includes(`case "${command}"`), `CLI is missing ${command}`);
    assert.match(cliText, /--mode merge\|replace/);
    const dir = tempDir(t);
    const invalid = path.join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ stateJson: { schemaVersion: 1, tasks: [{ id: "X" }] }, runtime: { schemaVersion: 3, agents: [] } }));
    const target = path.join(dir, "target", "atk.db");
    const imported = cli(["import", "--from", invalid, "--data", target, "--mode", "replace", "--force", "--json"]);
    assert.equal(imported.status, 1, "a non-PASS import must exit 1");
    assert.match(imported.stdout, /"status": "SKIPPED"/);
  });

  test("F2 M6 source/docs stay private (no token, no machine path)", async () => {
    const files = [
      "packages/database/src/import-export.mjs",
      "packages/database/src/sqlite.mjs",
      "packages/database/src/memory.mjs",
      "apps/backend/src/server.mjs",
      "scripts/m6-smoke.mjs",
      "docs/architecture/m6-contracts.md",
      "docs/roadmap/m6-status.md",
    ];
    const userName = process.env.USERNAME;
    for (const relative of files) {
      const text = readFileSync(path.join(REPO, relative), "utf8");
      assert.ok(!/\bsk-[A-Za-z0-9_-]{20,}/.test(text), `${relative}: secret-like token`);
      if (userName) assert.ok(!text.includes(userName), `${relative}: machine username`);
      assert.ok(!text.includes("C:\\Users\\"), `${relative}: absolute user path`);
    }
  });
}
