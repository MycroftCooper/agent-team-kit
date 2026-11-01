#!/usr/bin/env node
// M6 gate: event aggregate filters and the JSON <-> SQLite switch.
//
// Everything here is verified against real SQLite files (and the real backend
// CLI), because the whole point of M6 is "can we switch without losing data".
//
// Usage: node scripts/m6-smoke.mjs
// Exit: 0 = all checks pass, 1 = a check failed, 2 = prerequisites missing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.join(ROOT, "apps", "backend", "cli.mjs");
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

if (!existsSync(BACKEND)) {
  process.stderr.write(`m6-smoke: missing ${BACKEND}\n`);
  process.exit(2);
}

const { openStore } = await load("packages/database/src/index.mjs");
const { verifySwitchReadiness } = await load("packages/database/src/index.mjs");

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
      expect(health.schemaVersion === 5, `expected schemaVersion 5 after replace, got ${health.schemaVersion}`);
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

  check("a v1 database upgrades in place to v5", async () => {
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
      expect(health.schemaVersion === 5, `expected v1 -> v5, got ${health.schemaVersion}`);
      expect(store.listProjects().length === 1, "the v1 project row must survive the upgrade");
      return `v1 migrated in place to v${health.schemaVersion}, rows preserved`;
    } finally {
      store.close();
    }
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
