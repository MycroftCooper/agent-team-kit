#!/usr/bin/env node
// M6 gate: event aggregate filters and the JSON <-> SQLite switch.
//
// Everything here is verified against real SQLite files (and the real backend
// CLI), because the whole point of M6 is "can we switch without losing data".
//
// Usage: node scripts/m6-smoke.mjs
// Exit: 0 = all checks pass, 1 = a check failed, 2 = prerequisites missing.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.join(ROOT, "apps", "backend", "cli.mjs");
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

if (!existsSync(BACKEND)) {
  process.stderr.write(`m6-smoke: missing ${BACKEND}\n`);
  process.exit(2);
}

const { openStore, verifySwitchReadiness, exportStateJson, importStateJson } = await load("packages/database/src/index.mjs");

// The expected schema version is derived from the migrations directory so an
// additive migration (0006 for M6.1 event identities) cannot make this gate
// report a regression - the same rule the M1 smoke and the QA suites follow.
const MIGRATIONS_DIR = path.join(ROOT, "packages", "database", "migrations");
const EXPECTED_SCHEMA_VERSION = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).length;
const EXPECTED_LEDGER = Array.from({ length: EXPECTED_SCHEMA_VERSION }, (_, index) => index + 1);

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
function cli(args) {
  return spawnSync(process.execPath, [BACKEND, ...args], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 120000 });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 30000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(100);
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
/** Run `fn` against a real backend serving `dbFile`, then always stop it. */
async function withBackend(dbFile, fn) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [BACKEND, "serve", "--port", String(port), "--data", dbFile], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: tmp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${base}/api/v1/system/health`)).ok;
      } catch {
        return false;
      }
    }, 30000, `backend health for ${dbFile}`);
    const session = await (await fetch(`${base}/api/v1/session`)).json();
    return await fn({ base, token: session.token });
  } finally {
    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000, "backend stop").catch(() => {});
  }
}
/** Seed a throwaway DB with exactly `count` events and nothing else (seq 1..count). */
function seedOnlyEvents(dbFile, count, aggregateId) {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const store = openStore({ file: dbFile, migrate: true });
  try {
    for (let index = 0; index < count; index += 1) {
      store.appendEvent({ type: "task.updated", aggregateType: "task", aggregateId, payload: { index } });
    }
  } finally {
    store.close();
  }
}
async function httpEvents(base, token, query) {
  const response = await fetch(`${base}/api/v1/events?${query}`, { headers: { "x-atk-token": token } });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}
/**
 * Page until hasMore is false. The assertion is the *concatenated seq list*
 * JSON-equal to `expected`, plus every page length <= the requested limit — a
 * single hasMore/nextAfterSeq value can be wrong without anyone noticing.
 */
async function collectEventSeqs({ base, token, aggregateId, limit, expected, pagesExpected }) {
  const pageSizes = [];
  const seqs = [];
  let afterSeq;
  for (let page = 0; page < 10; page += 1) {
    const params = [`aggregateId=${encodeURIComponent(aggregateId)}`];
    if (limit !== undefined) params.push(`limit=${limit}`);
    if (afterSeq !== undefined) params.push(`afterSeq=${afterSeq}`);
    const response = await httpEvents(base, token, params.join("&"));
    expect(response.status === 200, `page ${page + 1} expected 200, got ${response.status}: ${response.text.slice(0, 300)}`);
    expect(Array.isArray(response.body?.items), `page ${page + 1} has no items array: ${response.text.slice(0, 300)}`);
    const pageLimit = limit ?? 100; // backend default limit
    expect(
      response.body.items.length <= pageLimit,
      `page ${page + 1} returned ${response.body.items.length} items > limit ${pageLimit} (the pagination bug's direct symptom)`,
    );
    pageSizes.push(response.body.items.length);
    for (const event of response.body.items) seqs.push(Number(event.seq));
    if (response.body.hasMore === true) {
      expect(Number.isInteger(response.body.nextAfterSeq), `page ${page + 1} has hasMore:true but no integer nextAfterSeq: ${response.text.slice(0, 300)}`);
      expect(response.body.nextAfterSeq > (afterSeq ?? 0), `nextAfterSeq did not advance: ${afterSeq} -> ${response.body.nextAfterSeq}`);
      afterSeq = response.body.nextAfterSeq;
    } else if (response.body.hasMore === false) {
      expect(response.body.nextAfterSeq === undefined, `page ${page + 1} has hasMore:false but nextAfterSeq=${response.body.nextAfterSeq}`);
      break;
    } else {
      throw new Error(`page ${page + 1} has no boolean hasMore: ${response.text.slice(0, 300)}`);
    }
  }
  expect(pageSizes.length === pagesExpected, `expected ${pagesExpected} page(s), got ${pageSizes.length} (${pageSizes.join("/")})`);
  expect(new Set(seqs).size === seqs.length, `pagination returned duplicate seq: ${JSON.stringify(seqs)}`);
  expect(JSON.stringify(seqs) === JSON.stringify(expected), `paged seq mismatch: got ${JSON.stringify(seqs)} expected ${JSON.stringify(expected)}`);
  return `${pageSizes.join("/")} -> seq ${expected[0]}..${expected[expected.length - 1]} exactly once`;
}

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/** Execute raw DDL/DML against a fresh SQLite file (used to forge old schemas). */
function rawExec(file, statements) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

/** A fingerprint strong enough to prove a failed replace wrote nothing. */
function schemaFingerprint(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name")
      .all()
      .map((row) => row.name);
    const tables = names.map((name) => ({ name, rows: Number(db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c) }));
    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => Number(row.version));
    return { tables, versions };
  } finally {
    db.close();
  }
}

function hasSqliteIndex(file, indexName) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName));
  } finally {
    db.close();
  }
}

/**
 * Forge a database at schema v1..v4 (real migration SQL + ledger rows), with one
 * old project/task/event row, so openStore(migrate:true) can be tested for actual
 * data survival rather than just a schemaVersion number.
 */
function buildVersionedDb(file, maxVersion, { taskId = "V-T" } = {}) {
  const files = migrationFiles().filter((name) => Number(name.slice(0, 4)) <= maxVersion);
  const statements = files.map((name) => readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
  statements.push("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const name of files) {
    statements.push(
      `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${Number(name.slice(0, 4))}, '${name}', '2026-01-01T00:00:00.000Z')`,
    );
  }
  statements.push(
    "INSERT INTO projects (id, name, repo_path, default_branch, version, created_at, updated_at) VALUES ('V-P', 'legacy project', '.', 'main', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    `INSERT INTO tasks (id, project_id, title, description, function_required, role_required, priority, status, acceptance, version, created_at, updated_at) VALUES ('${taskId}', 'V-P', 'legacy task', 'legacy', 'WORKER', 'DEV', 2, 'READY', 'legacy acceptance', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    `INSERT INTO events (schema_version, project_id, aggregate_type, aggregate_id, type, payload_json, happened_at) VALUES (1, 'V-P', 'task', '${taskId}', 'task.updated', '{"index":7}', '2026-01-01T00:00:00.000Z')`,
  );
  rawExec(file, statements);
}
function countsOf(dbFile) {
  const store = openStore({ file: dbFile, migrate: false });
  try {
    return {
      projects: store.listProjects().length,
      tasks: store.listTasks({ limit: 1000 }).length,
      events: store.listEvents({ limit: 1000 }).length,
      agents: store.listAgents().length,
    };
  } finally {
    store.close();
  }
}
function seed(dbFile, { events = 105 } = {}) {
  const store = openStore({ file: dbFile, migrate: true });
  try {
    const project = store.createProject({ id: "M6-P", name: "m6", repoPath: ROOT, defaultBranch: "m0/baseline-and-p0" });
    const task = store.createTask({
      id: "M6-T",
      projectId: project.id,
      title: "m6 task",
      description: "m6",
      functionRequired: "WORKER",
      roleRequired: "DEV",
      priority: 2,
      deps: [],
      acceptance: "smoke",
    });
    store.upsertAgent({ id: "m6-agent", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    // M6.2 F10: a live heartbeat is required before dispatch.
    if (typeof store.recordHeartbeat === "function") {
      store.recordHeartbeat({ hostId: "m6-smoke", agentIds: ["m6-agent"], capacity: 1 });
    }
    const run = store.createRun({ taskId: task.id, agentId: "m6-agent", function: "WORKER", role: "DEV" });
    for (let index = 0; index < events; index += 1) {
      store.appendEvent({ type: "task.updated", aggregateType: "task", aggregateId: task.id, payload: { index } });
    }
    store.appendEvent({ type: "run.created", aggregateType: "run", aggregateId: run.id, payload: { runId: run.id } });
    store.updateRunStatus(run.id, { status: "RUNNING" });
    store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
    return { projectId: project.id, taskId: task.id, runId: run.id };
  } finally {
    store.close();
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m6-smoke-"));
const dbFile = path.join(tmp, "source", "atk.db");
const freshFile = path.join(tmp, "fresh", "atk.db");
const restoredFile = path.join(tmp, "restored", "atk.db");

try {
  const seeded = seed(dbFile);

  check("events filter by aggregate and page without gaps or duplicates", async () => {
    const store = openStore({ file: dbFile, migrate: false });
    try {
      const taskEvents = store.listEvents({ aggregateId: seeded.taskId, limit: 1000 });
      expect(taskEvents.items.length === 105, `expected 105 task events, got ${taskEvents.items.length}`);
      const runEvents = store.listEvents({ aggregateId: seeded.runId, limit: 1000 });
      expect(runEvents.items.length >= 1, `the run must have events, got ${runEvents.items.length}`);
      expect(runEvents.items.every((event) => event.aggregateId === seeded.runId), "a run filter returned a foreign event");
      expect(runEvents.items.some((event) => event.type === "run.created"), "run.created must be in the run timeline");
      const typed = store.listEvents({ aggregateType: "run", type: "run.created", limit: 1000 });
      expect(typed.items.length >= 1 && typed.items.every((event) => event.type === "run.created" && event.aggregateType === "run"), `aggregateType+type filter returned foreign events: ${typed.items.length}`);

      const page1 = store.listEventsPage({ aggregateId: seeded.taskId, limit: 40 });
      expect(page1.items.length === 40 && page1.hasMore === true, `bad first page: ${page1.items.length}/${page1.hasMore}`);
      const page2 = store.listEventsPage({ aggregateId: seeded.taskId, limit: 40, afterSeq: page1.nextAfterSeq });
      expect(page2.items.length === 40, `bad second page: ${page2.items.length}`);
      const page3 = store.listEventsPage({ aggregateId: seeded.taskId, limit: 40, afterSeq: page2.nextAfterSeq });
      expect(page3.items.length === 25 && page3.hasMore === false, `bad last page: ${page3.items.length}/${page3.hasMore}`);
      const all = [...page1.items, ...page2.items, ...page3.items].map((event) => event.seq);
      expect(new Set(all).size === all.length, "pagination returned a duplicate seq");
      expect(all.length === 105, `pagination lost events: ${all.length}`);
      let rejected = null;
      try {
        store.listEvents({ limit: 0 });
      } catch (error) {
        rejected = error;
      }
      expect(rejected?.code === "VALIDATION_ERROR", `limit 0 should be rejected, got ${rejected?.code}`);
      return `105 task events, 1 run event, 40/40/25 pages, no duplicate seq`;
    } finally {
      store.close();
    }
  });

  check("HTTP /api/v1/events pagination returns every seq exactly once (3/4/105)", async () => {
    const pageDir = path.join(tmp, "http-events");
    const cases = [
      { count: 3, limit: 2, pagesExpected: 2 },
      { count: 4, limit: 2, pagesExpected: 2 },
      { count: 105, limit: undefined, pagesExpected: 2 }, // default limit (100)
    ];
    const evidence = [];
    for (const { count, limit, pagesExpected } of cases) {
      const aggregateId = `M6-HTTP-${count}`;
      const file = path.join(pageDir, `events-${count}.db`);
      seedOnlyEvents(file, count, aggregateId);
      const expected = Array.from({ length: count }, (_, index) => index + 1);
      const detail = await withBackend(file, ({ base, token }) =>
        collectEventSeqs({ base, token, aggregateId, limit, expected, pagesExpected }),
      );
      evidence.push(`${count} events limit=${limit ?? "default"} => ${detail}`);
    }
    return evidence.join("; ");
  });

  check("HTTP /api/v1/events pagination rejects invalid parameters (400 naming the field)", async () => {
    const file = path.join(tmp, "http-events", "invalid.db");
    seedOnlyEvents(file, 3, "M6-HTTP-INVALID");
    return withBackend(file, async ({ base, token }) => {
      const cases = [
        ["limit=0", "limit"],
        ["limit=1001", "limit"],
        ["afterSeq=-1", "afterSeq"],
        ["aggregateId=not%20a%20valid%20id%21", "aggregateId"],
      ];
      const evidence = [];
      for (const [query, field] of cases) {
        const response = await httpEvents(base, token, query);
        expect(response.status === 400, `${query} expected 400, got ${response.status}: ${response.text.slice(0, 300)}`);
        expect(
          response.body?.error?.code === "VALIDATION_ERROR",
          `${query} expected VALIDATION_ERROR, got ${response.body?.error?.code}: ${response.text.slice(0, 300)}`,
        );
        expect(
          JSON.stringify(response.body?.error?.details ?? "").includes(field),
          `${query} details must name "${field}": ${response.text.slice(0, 300)}`,
        );
        evidence.push(`${query} -> 400 (${field})`);
      }
      return evidence.join("; ");
    });
  });

  check("switchReadiness blocks while a run is active and clears when it ends", async () => {
    const store = openStore({ file: dbFile, migrate: false });
    try {
      const idle = verifySwitchReadiness(store);
      expect(idle.ok === true, `idle readiness should be ok, got ${JSON.stringify(idle.blockers)}`);
      const run = store.createRun({ taskId: seeded.taskId, agentId: "m6-agent", function: "WORKER", role: "DEV" });
      const busy = verifySwitchReadiness(store);
      expect(busy.ok === false, "an active run must block the switch");
      const codes = busy.blockers.map((blocker) => blocker.code);
      expect(codes.includes("active-run"), `expected active-run blocker, got ${codes.join(",")}`);
      store.updateRunStatus(run.id, { status: "RUNNING" });
      store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0 });
      const done = verifySwitchReadiness(store);
      expect(done.ok === true, `readiness should clear after the run finishes, got ${JSON.stringify(done.blockers)}`);
      return `idle ok -> active-run blocked -> ok after completion`;
    } finally {
      store.close();
    }
  });

  check("export then import reproduces the same data", async () => {
    const exported = path.join(tmp, "export.json");
    const out = cli(["export", "--data", dbFile, "--to", exported, "--json"]);
    expect(out.status === 0, `export failed: ${out.stdout}\n${out.stderr}`);
    const payload = JSON.parse(readFileSync(exported, "utf8"));
    expect(payload.stateJson && payload.manifest, `export must contain stateJson and manifest: ${Object.keys(payload)}`);

    const imported = cli(["import", "--from", exported, "--data", freshFile, "--json"]);
    expect(imported.status === 0, `import failed: ${imported.stdout}\n${imported.stderr}`);
    const before = countsOf(dbFile);
    const after = countsOf(freshFile);
    for (const key of ["projects", "tasks", "agents"]) {
      expect(after[key] === before[key], `${key} changed across export/import: ${before[key]} -> ${after[key]}`);
    }
    return `exported and re-imported (projects ${after.projects}, tasks ${after.tasks}, agents ${after.agents})`;
  });

  check("a failing replace leaves the database intact", async () => {
    const before = countsOf(freshFile);
    const broken = path.join(tmp, "broken.json");
    writeFileSync(
      broken,
      JSON.stringify({
        stateJson: {
          schemaVersion: 1,
          project: { id: "BROKEN", name: "broken" },
          batch: { id: "B", tasks: [{ id: "DUP", status: "READY" }, { id: "DUP", status: "READY" }] },
          packages: [],
          subitems: [],
          slices: [],
          counts: {},
        },
        runtime: { schemaVersion: 3, agents: [] },
      }),
    );
    const out = cli(["import", "--from", broken, "--data", freshFile, "--mode", "replace", "--force", "--json"]);
    // The CLI must refuse the bad payload. Exit code is checked, and the report
    // status is checked too so a SKIPPED report cannot masquerade as success.
    let report = null;
    try {
      report = JSON.parse(out.stdout.trim().split("\n").pop());
    } catch {
      report = null;
    }
    expect(out.status !== 0 || report?.status !== "PASS", `a broken replace must be refused, got exit ${out.status}: ${out.stdout}`);
    const after = countsOf(freshFile);
    expect(after.tasks === before.tasks && after.events === before.events, `failed replace changed data: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    return `replace refused (exit ${out.status}); ${after.tasks} task(s) and ${after.events} event(s) intact`;
  });

  check("a successful replace keeps the migration bookkeeping", async () => {
    const exported = path.join(tmp, "export.json");
    const out = cli(["import", "--from", exported, "--data", freshFile, "--mode", "replace", "--force", "--json"]);
    expect(out.status === 0, `replace import failed: ${out.stdout}\n${out.stderr}`);
    const store = openStore({ file: freshFile, migrate: true });
    try {
      const health = store.health();
      expect(health.schemaVersion === EXPECTED_SCHEMA_VERSION, `expected schemaVersion ${EXPECTED_SCHEMA_VERSION} after replace, got ${health.schemaVersion}`);
      const warnings = store.migrationWarnings?.() ?? [];
      expect(warnings.length === 0, `replace must not force a migration replay: ${JSON.stringify(warnings)}`);
      return `schemaVersion ${health.schemaVersion}, no migration replay`;
    } finally {
      store.close();
    }
  });

  check("backup, tamper and restore", async () => {
    const backupDir = path.join(tmp, "backup");
    const backup = cli(["backup", "--data", dbFile, "--to", backupDir, "--json"]);
    expect(backup.status === 0, `backup failed: ${backup.stdout}\n${backup.stderr}`);
    const manifestPath = path.join(backupDir, "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    const tampered = JSON.parse(original);
    tampered.sha256 = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(tampered));
    const refused = cli(["restore", "--from", backupDir, "--data", restoredFile, "--json"]);
    expect(refused.status !== 0, `a tampered snapshot must be refused, got exit ${refused.status}`);
    expect(!existsSync(restoredFile), "a refused restore must not create the target database");

    writeFileSync(manifestPath, original);
    const restored = cli(["restore", "--from", backupDir, "--data", restoredFile, "--json"]);
    expect(restored.status === 0, `restore failed: ${restored.stdout}\n${restored.stderr}`);
    const before = countsOf(dbFile);
    const after = countsOf(restoredFile);
    for (const key of ["projects", "tasks", "events", "agents"]) {
      expect(after[key] === before[key], `${key} differs after restore: ${before[key]} -> ${after[key]}`);
    }
    return `tampered refused without creating a target; restored ${after.tasks} task(s), ${after.events} event(s) exactly`;
  });

  check(`a v1 database upgrades in place to v${EXPECTED_SCHEMA_VERSION}`, async () => {
    const v1File = path.join(tmp, "v1", "atk.db");
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(v1File), { recursive: true });
    const raw = new DatabaseSync(v1File);
    try {
      const init = readFileSync(path.join(ROOT, "packages", "database", "migrations", "0001_init.sql"), "utf8");
      raw.exec(init);
      raw.exec("INSERT INTO projects (id, name, repo_path, default_branch, version, created_at, updated_at) VALUES ('V1-P', 'v1 project', '.', 'main', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
    } finally {
      raw.close();
    }
    const store = openStore({ file: v1File, migrate: true });
    try {
      const health = store.health();
      expect(health.schemaVersion === EXPECTED_SCHEMA_VERSION, `expected v1 -> v${EXPECTED_SCHEMA_VERSION}, got ${health.schemaVersion}`);
      expect(store.listProjects().length === 1, "the v1 project row must survive the upgrade");
      return `v1 migrated in place to v${health.schemaVersion}, rows preserved`;
    } finally {
      store.close();
    }
  });

  check("events beyond 1000 page correctly through both store and real HTTP", async () => {
    const file = path.join(tmp, "http-events", "many.db");
    seedOnlyEvents(file, 1005, "M6-MANY");
    const expected = Array.from({ length: 1005 }, (_, index) => index + 1);

    const store = openStore({ file, migrate: false });
    let storeSeqs;
    try {
      const page1 = store.listEventsPage({ aggregateId: "M6-MANY", limit: 1000 });
      expect(page1.items.length === 1000, `store page1 expected 1000 items, got ${page1.items.length}`);
      expect(page1.hasMore === true, `store page1 expected hasMore:true, got ${page1.hasMore}`);
      expect(page1.nextAfterSeq === 1000, `store page1 expected nextAfterSeq 1000, got ${page1.nextAfterSeq}`);
      const page2 = store.listEventsPage({ aggregateId: "M6-MANY", limit: 1000, afterSeq: 1000 });
      expect(page2.items.length === 5, `store page2 expected 5 items, got ${page2.items.length}`);
      expect(page2.hasMore === false, `store page2 expected hasMore:false, got ${page2.hasMore}`);
      expect(page2.nextAfterSeq === undefined, `store page2 must not return nextAfterSeq, got ${page2.nextAfterSeq}`);
      storeSeqs = [...page1.items, ...page2.items].map((event) => Number(event.seq));
      expect(JSON.stringify(storeSeqs) === JSON.stringify(expected), `store paging lost seqs: got ${storeSeqs.length}, expected 1005`);
    } finally {
      store.close();
    }

    const httpDetail = await withBackend(file, async ({ base, token }) => {
      const first = await httpEvents(base, token, "aggregateId=M6-MANY&limit=1000");
      expect(first.status === 200, `HTTP page1 expected 200, got ${first.status}: ${first.text.slice(0, 200)}`);
      expect(first.body.items.length === 1000, `HTTP page1 expected 1000 items, got ${first.body.items.length}`);
      expect(first.body.items.length <= 1000, "HTTP page1 exceeded limit 1000");
      expect(first.body.hasMore === true, `HTTP page1 expected hasMore:true, got ${first.body.hasMore}`);
      expect(first.body.nextAfterSeq === 1000, `HTTP page1 expected nextAfterSeq 1000, got ${first.body.nextAfterSeq}`);
      const second = await httpEvents(base, token, "aggregateId=M6-MANY&limit=1000&afterSeq=1000");
      expect(second.status === 200, `HTTP page2 expected 200, got ${second.status}: ${second.text.slice(0, 200)}`);
      expect(second.body.items.length === 5, `HTTP page2 expected 5 items, got ${second.body.items.length}`);
      expect(second.body.hasMore === false, `HTTP page2 expected hasMore:false, got ${second.body.hasMore}`);
      expect(second.body.nextAfterSeq === undefined, `HTTP page2 must not return nextAfterSeq, got ${second.body.nextAfterSeq}`);
      const httpSeqs = [...first.body.items, ...second.body.items].map((event) => Number(event.seq));
      expect(JSON.stringify(httpSeqs) === JSON.stringify(expected), `HTTP paging lost seqs: got ${httpSeqs.length}, expected 1005`);
      return `HTTP 1000/5 -> seq 1..1005 exactly once`;
    });
    return `store 1000/5 and ${httpDetail}`;
  });

  check("a replace that fails mid-write rolls back to the same database fingerprint", async () => {
    const rollbackDir = path.join(tmp, "rollback");
    const sourceFile = path.join(rollbackDir, "source.db");
    const targetFile = path.join(rollbackDir, "target.db");
    const source = openStore({ file: sourceFile, migrate: true });
    let exported;
    try {
      const project = source.createProject({ id: "M6-RB-P", name: "rollback source", repoPath: ROOT, defaultBranch: "m0/baseline-and-p0" });
      for (const id of ["M6-RB-T1", "M6-RB-T2"]) {
        source.createTask({
          id,
          projectId: project.id,
          title: id,
          description: "rollback fixture",
          functionRequired: "WORKER",
          roleRequired: "DEV",
          priority: 2,
          deps: [],
          acceptance: "fixture",
        });
      }
      exported = exportStateJson(source);
    } finally {
      source.close();
    }

    const probe = openStore({ file: targetFile, migrate: true });
    probe.close();
    const before = schemaFingerprint(targetFile);

    const target = openStore({ file: targetFile, migrate: false });
    let createTaskCalls = 0;
    const failingStore = new Proxy(target, {
      get(object, property) {
        if (property === "createTask") {
          return (...args) => {
            createTaskCalls += 1;
            if (createTaskCalls === 2) throw new Error("injected createTask failure");
            return object.createTask(...args);
          };
        }
        const value = Reflect.get(object, property);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
    let result;
    try {
      result = importStateJson(failingStore, {
        stateJson: exported.state,
        mode: "replace",
        force: true,
        repoPath: ROOT,
        defaultBranch: "m0/baseline-and-p0",
      });
    } finally {
      target.close();
    }
    expect(result.status === "SKIPPED", `a mid-write failure must be SKIPPED, got ${result.status}`);
    expect(createTaskCalls >= 2, `the injected failure was never reached (createTask calls: ${createTaskCalls})`);
    const failedProblem = result.problems.find((problem) => problem.code === "IMPORT_WRITE_FAILED" && problem.level === "error");
    expect(failedProblem, `expected an IMPORT_WRITE_FAILED problem, got ${JSON.stringify(result.problems)}`);

    const after = schemaFingerprint(targetFile);
    expect(
      JSON.stringify(after) === JSON.stringify(before),
      `rollback changed the database fingerprint:\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`,
    );
    const reopened = openStore({ file: targetFile, migrate: false });
    try {
      expect(reopened.health().schemaVersion === EXPECTED_SCHEMA_VERSION, `reopened schemaVersion expected ${EXPECTED_SCHEMA_VERSION}, got ${reopened.health().schemaVersion}`);
      const warnings = typeof reopened.migrationWarnings === "function" ? reopened.migrationWarnings() : [];
      expect(Array.isArray(warnings) && warnings.length === 0, `reopened migrationWarnings expected [], got ${JSON.stringify(warnings)}`);
    } finally {
      reopened.close();
    }
    return `SKIPPED after ${createTaskCalls} createTask calls (IMPORT_WRITE_FAILED); ${before.tables.length} table counts + ledger ${JSON.stringify(before.versions)} deep-equal; reopen v${EXPECTED_SCHEMA_VERSION}, migrationWarnings []`;
  });

  check(`v1 and v4 databases upgrade to v${EXPECTED_SCHEMA_VERSION} with old tasks, events and indexes intact`, async () => {
    const evidence = [];
    for (const version of [1, 4]) {
      const file = path.join(tmp, `upgrade-v${version}`, "atk.db");
      buildVersionedDb(file, version);
      const store = openStore({ file, migrate: true });
      try {
        const health = store.health();
        expect(health.schemaVersion === EXPECTED_SCHEMA_VERSION, `v${version} -> expected v${EXPECTED_SCHEMA_VERSION}, got ${health.schemaVersion}`);
        const tasks = store.listTasks({ limit: 100 });
        const task = tasks.find((entry) => entry.id === "V-T");
        expect(task, `v${version} upgrade lost task V-T (tasks: ${tasks.map((entry) => entry.id).join(",")})`);
        expect(task.status === "READY", `v${version} task status changed: ${task.status}`);
        const events = store.listEvents({ aggregateId: "V-T", limit: 10 });
        expect(events.length === 1, `v${version} expected the old event, got ${events.length}`);
        expect(events[0].type === "task.updated", `v${version} event type changed: ${events[0].type}`);
        const warnings = typeof store.migrationWarnings === "function" ? store.migrationWarnings() : [];
        expect(Array.isArray(warnings) && warnings.length === 0, `v${version} migrationWarnings expected [], got ${JSON.stringify(warnings)}`);
      } finally {
        store.close();
      }
      expect(hasSqliteIndex(file, "idx_events_type_seq"), `v${version} upgrade did not create idx_events_type_seq`);
      const fingerprint = schemaFingerprint(file);
      expect(JSON.stringify(fingerprint.versions) === JSON.stringify(EXPECTED_LEDGER), `v${version} ledger versions expected ${JSON.stringify(EXPECTED_LEDGER)}, got ${JSON.stringify(fingerprint.versions)}`);
      evidence.push(`v${version}: v${EXPECTED_SCHEMA_VERSION}, task V-T + its event kept, idx_events_type_seq present, ledger ${JSON.stringify(EXPECTED_LEDGER)}`);
    }
    return evidence.join("; ");
  });

  for (const runCheck of checks) results.push(await runCheck());
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle */
  }
}

let failed = 0;
process.stdout.write("M6 smoke gate (events, switch, backup)\n\n");
for (const result of results) {
  if (!result.ok) failed += 1;
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n`);
  if (result.detail) process.stdout.write(`      ${result.detail.split("\n").join("\n      ")}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exitCode = failed === 0 ? 0 : 1;
