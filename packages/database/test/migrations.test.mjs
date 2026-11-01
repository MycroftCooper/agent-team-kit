// Migration, schema and connection-level guarantees (contracts 鎼?, ADR-006,
// ADR-009): WAL + busy_timeout + foreign_keys are really on, migrations are
// applied exactly once and re-opening a store neither re-creates tables nor
// duplicates schema_migrations rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openStore } from "@atk/database";
import { INTERNAL } from "../src/internal.mjs";
import { projectDto, taskDto, useStore } from "./helpers.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const REQUIRED_TABLES = [
  "projects",
  "requirements",
  "tasks",
  "task_dependencies",
  "agent_profiles",
  "agent_instances",
  "runs",
  "run_leases",
  "dispatch_commands",
  "plans",
  "reviews",
  "review_attempts",
  "approvals",
  "gate_results",
  "events",
  "schema_migrations",
];

function rawOpen(file) {
  return new DatabaseSync(file);
}

test("migrations are applied once and recorded in schema_migrations", (t) => {
  const { store, file } = useStore(t);
  assert.equal(store.health().schemaVersion, 5);
  assert.equal(store.health().ok, true);
  const raw = rawOpen(file);
  try {
    const rows = raw.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    assert.equal(rows.length, 5);
    assert.equal(Number(rows[0].version), 1);
    assert.equal(rows[0].name, "0001_init.sql");
    assert.equal(Number(rows[1].version), 2);
    assert.equal(rows[1].name, "0002_runs_dispatch.sql");
    assert.equal(Number(rows[2].version), 3);
    assert.equal(rows[2].name, "0003_scheduling.sql");
    assert.equal(Number(rows[3].version), 4);
    assert.equal(rows[3].name, "0004_reviews_approvals.sql");
    assert.equal(Number(rows[4].version), 5);
    assert.equal(rows[4].name, "0005_events_index.sql");
  } finally {
    raw.close();
  }
});

test("re-opening a store does not re-run migrations or lose data", (t) => {
  const { store, file, open } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1"));
  store.close();

  const second = open();
  assert.equal(second.health().schemaVersion, 5);
  assert.deepEqual(second.health().counts, { projects: 1, tasks: 1, runs: 0, events: 0, agents: 0 });
  assert.equal(second.listProjects().length, 1);
  assert.equal(second.listTasks({ projectId: "proj-1" }).length, 1);
  second.close();

  const raw = rawOpen(file);
  try {
    assert.equal(Number(raw.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get().c), 5);
  } finally {
    raw.close();
  }
});

test("migrate:false opens without touching the schema; migrate:true repairs it", (t) => {
  const { store: empty, open } = useStore(t, { migrate: false });
  assert.equal(empty.health().schemaVersion, 0);
  assert.deepEqual(empty.health().counts, { projects: 0, tasks: 0, runs: 0, events: 0, agents: 0 });
  assert.throws(
    () => empty.listProjects(),
    (error) => error.code === "INTERNAL_ERROR" && error.message === "database error",
  );
  empty.close();

  const migrated = open({ migrate: true });
  assert.equal(migrated.health().schemaVersion, 5);
  assert.deepEqual(migrated.listProjects(), []);
});

test("WAL, busy_timeout and foreign_keys are genuinely enabled", (t) => {
  const { store, file } = useStore(t);
  const pragmas = store[INTERNAL].debugPragmas();
  assert.equal(pragmas.journalMode, "wal");
  assert.equal(pragmas.foreignKeys, 1);
  assert.equal(pragmas.busyTimeout, 5000);
  assert.equal(pragmas.inTransaction, false);

  // WAL is a database-level mode: a second connection must observe it too.
  const raw = rawOpen(file);
  try {
    assert.equal(String(raw.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal");
  } finally {
    raw.close();
  }
});

test("foreign keys are declared and enforced by SQLite", (t) => {
  const { store, file } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1", { id: "T-1" }));
  store.close();

  const raw = rawOpen(file);
  try {
    const fks = raw.prepare("PRAGMA foreign_key_list(task_dependencies)").all();
    assert.equal(fks.length, 2);
    assert.deepEqual(fks.map((fk) => fk.from).sort(), ["depends_on_id", "task_id"]);
    // A dangling dependency is rejected by the DB itself, not only by the store.
    assert.throws(
      () =>
        raw
          .prepare(
            "INSERT INTO task_dependencies (task_id, depends_on_id, position, created_at) VALUES (?, ?, ?, ?)",
          )
          .run("T-1", "T-MISSING", 0, new Date().toISOString()),
      (error) => error.code === "ERR_SQLITE_ERROR",
    );
  } finally {
    raw.close();
  }
});

test("schema v1 contains every table the contract lists plus required indexes", (t) => {
  const { store, file } = useStore(t);
  store.close();
  const raw = rawOpen(file);
  try {
    const tables = new Set(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    for (const table of REQUIRED_TABLES) assert.ok(tables.has(table), `missing table ${table}`);

    const indexes = new Set(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => row.name),
    );
    for (const index of [
      "idx_tasks_project_status_priority",
      "idx_events_project_seq",
      "idx_dispatch_commands_status_claimed",
    ]) {
      assert.ok(indexes.has(index), `missing index ${index}`);
    }

    const eventsColumns = raw
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((column) => column.name);
    assert.ok(eventsColumns.includes("seq"));
    const projectsColumns = raw
      .prepare("PRAGMA table_info(projects)")
      .all()
      .map((column) => column.name);
    assert.ok(projectsColumns.includes("version"));
    assert.ok(projectsColumns.includes("created_at"));
  } finally {
    raw.close();
  }
});

test("the database file may live in a non-ASCII path", (t) => {
  const { store } = useStore(t, { prefix: "atk-\u4e2d\u6587\u76ee\u5f55-", subdir: "\u6570\u636e" });
  store.createProject(projectDto());
  assert.equal(store.listProjects().length, 1);
  assert.equal(store.health().schemaVersion, 5);
});

test("schema v2 adds the M2 execution columns to the M1 tables", (t) => {
  const { store, file } = useStore(t);
  store.close();
  const raw = rawOpen(file);
  try {
    const columnsOf = (table) =>
      raw
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
    assert.deepEqual(
      columnsOf("runs").filter((name) => ["role", "workspace_id", "exit_code"].includes(name)).sort(),
      ["exit_code", "role", "workspace_id"],
    );
    assert.ok(columnsOf("run_leases").includes("last_heartbeat_at"));
    assert.deepEqual(
      columnsOf("dispatch_commands")
        .filter((name) => ["command_type", "attempts", "result_json", "completed_at"].includes(name))
        .sort(),
      ["attempts", "command_type", "completed_at", "result_json"],
    );
    const indexes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes("idx_dispatch_commands_claim"));
    // v5 event filter index.
    assert.ok(indexes.includes("idx_events_type_seq"));
    // v3 scheduling columns.
    assert.ok(columnsOf("projects").includes("policy_json"));
    assert.ok(columnsOf("tasks").includes("files_json"));
    assert.ok(columnsOf("runs").includes("files_json"));
    // v4 review/approval columns.
    assert.ok(columnsOf("reviews").includes("reviewer"));
    assert.ok(columnsOf("reviews").includes("evidence_json"));
    assert.ok(columnsOf("review_attempts").includes("evidence_json"));
    assert.ok(columnsOf("approvals").includes("decided_at"));
    assert.ok(columnsOf("approvals").includes("version"));
    assert.ok(columnsOf("tasks").includes("target_hash"));
  } finally {
    raw.close();
  }
});

test("an M1 (v1) database upgrades in place and keeps its rows", (t) => {
  const { store, file, open } = useStore(t, { migrate: false });
  store.close();
  const initSql = readFileSync(path.join(MIGRATIONS_DIR, "0001_init.sql"), "utf8");
  const at = "2026-01-01T00:00:00.000Z";
  const raw = rawOpen(file);
  try {
    raw.exec(initSql);
    raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, '0001_init.sql', ?)").run(at);
    raw.prepare(
      "INSERT INTO projects (id, name, repo_path, default_branch, policy_version, version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)",
    ).run("legacy-proj", "Legacy", ".", "main", at, at);
    raw.prepare(
      `INSERT INTO tasks (id, project_id, title, description, function_required, role_required, priority, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'WORKER', 'DEV', 2, 'READY', 0, ?, ?)`,
    ).run("legacy-task", "legacy-proj", "Legacy task", "from M1", at, at);
    raw.prepare(
      `INSERT INTO runs (id, task_id, agent_id, function, status, attempt, version, created_at, updated_at)
       VALUES (?, ?, ?, 'WORKER', 'STARTING', 1, 0, ?, ?)`,
    ).run("legacy-run", "legacy-task", "agent-dev-01", at, at);
    raw.prepare(
      `INSERT INTO dispatch_commands (id, task_id, run_id, status, idempotency_key, generation, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?, 0, ?, ?)`,
    ).run("legacy-cmd", "legacy-task", "legacy-run", "legacy-key", at, at);
    raw.prepare(
      `INSERT INTO run_leases (run_id, owner_id, generation, claimed_until, created_at, updated_at)
       VALUES (?, 'host-old', 1, ?, ?, ?)`,
    ).run("legacy-run", at, at, at);
  } finally {
    raw.close();
  }

  const upgraded = open({ migrate: true });
  assert.equal(upgraded.health().schemaVersion, 5);
  assert.equal(upgraded.getProject("legacy-proj").name, "Legacy");
  assert.equal(upgraded.getTask("legacy-task").title, "Legacy task");
  const run = upgraded.getRun("legacy-run");
  assert.equal(run.status, "STARTING");
  assert.equal(run.taskId, "legacy-task");
  assert.equal(run.attempt, 1);
  // New columns are usable on the old row (NULL role/workspace before any write).
  assert.equal(run.role, null);
  upgraded.close();

  const verify = rawOpen(file);
  try {
    const rows = verify
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    assert.deepEqual(
      rows.map((row) => [Number(row.version), row.name]),
      [
        [1, "0001_init.sql"],
        [2, "0002_runs_dispatch.sql"],
        [3, "0003_scheduling.sql"],
        [4, "0004_reviews_approvals.sql"],
        [5, "0005_events_index.sql"],
      ],
    );
    const command = verify.prepare("SELECT * FROM dispatch_commands WHERE id = 'legacy-cmd'").get();
    assert.equal(command.command_type, "RUN_TASK");
    assert.equal(Number(command.attempts), 0);
    const lease = verify.prepare("SELECT * FROM run_leases WHERE run_id = 'legacy-run'").get();
    assert.ok(Object.prototype.hasOwnProperty.call(lease, "last_heartbeat_at"));
    // v3 columns exist on the upgraded M1 rows.
    const tasksColumns = verify
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((column) => column.name);
    assert.ok(tasksColumns.includes("files_json"));
    const projectsColumns = verify
      .prepare("PRAGMA table_info(projects)")
      .all()
      .map((column) => column.name);
    assert.ok(projectsColumns.includes("policy_json"));
    const runsColumns = verify
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((column) => column.name);
    assert.ok(runsColumns.includes("files_json"));
    // v4 columns exist on the upgraded M1 rows too.
    const reviewsColumns = verify
      .prepare("PRAGMA table_info(reviews)")
      .all()
      .map((column) => column.name);
    assert.ok(reviewsColumns.includes("reviewer"));
    assert.ok(reviewsColumns.includes("evidence_json"));
    const approvalsColumns = verify
      .prepare("PRAGMA table_info(approvals)")
      .all()
      .map((column) => column.name);
    assert.ok(approvalsColumns.includes("decided_at"));
    assert.ok(approvalsColumns.includes("version"));
  } finally {
    verify.close();
  }
});

test("a v4 database upgrades to v5 in place and keeps its rows", (t) => {
  const { store, file, open } = useStore(t, { migrate: false });
  store.close();
  const at = "2026-01-01T00:00:00.000Z";
  const raw = rawOpen(file);
  try {
    raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const [version, name] of [
      [1, "0001_init.sql"],
      [2, "0002_runs_dispatch.sql"],
      [3, "0003_scheduling.sql"],
      [4, "0004_reviews_approvals.sql"],
    ]) {
      raw.exec(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
      raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(version, name, at);
    }
    raw.prepare(
      "INSERT INTO projects (id, name, repo_path, default_branch, policy_version, version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)",
    ).run("v4-proj", "V4", ".", "main", at, at);
    raw.prepare(
      `INSERT INTO tasks (id, project_id, title, description, function_required, role_required, priority, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'WORKER', 'DEV', 2, 'READY', 0, ?, ?)`,
    ).run("v4-task", "v4-proj", "V4 task", "from v4", at, at);
  } finally {
    raw.close();
  }

  const upgraded = open({ migrate: true });
  assert.equal(upgraded.health().schemaVersion, 5);
  assert.equal(upgraded.getTask("v4-task").title, "V4 task");
  upgraded.close();

  const verify = rawOpen(file);
  try {
    const rows = verify.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5]);
    const indexes = verify
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes("idx_events_type_seq"));
    assert.equal(Number(verify.prepare("SELECT COUNT(*) AS c FROM tasks").get().c), 1);
  } finally {
    verify.close();
  }
});

test("migration runner self-heals when bookkeeping rows are lost (QA-003)", (t) => {
  const { store, file, open } = useStore(t);
  store.createProject(projectDto());
  store.createTask(taskDto("proj-1", { id: "TASK-KEEP" }));
  store.close();

  // Simulate a lost/rolled-back bookkeeping rows while the columns exist.
  const raw = rawOpen(file);
  raw.exec("DELETE FROM schema_migrations WHERE version IN (2, 3)");
  raw.close();

  const reopened = open();
  assert.equal(reopened.health().schemaVersion, 5);
  assert.equal(reopened.getProject("proj-1").id, "proj-1");
  assert.equal(reopened.getTask("TASK-KEEP").title, "Task title");
  const warnings = reopened[INTERNAL].migrationWarnings();
  assert.ok(
    warnings.some((warning) => warning.migration === "0002_runs_dispatch.sql" && warning.code === "MIGRATION_EXISTING_COLUMN"),
    JSON.stringify(warnings),
  );
  assert.ok(
    warnings.some((warning) => warning.migration === "0003_scheduling.sql" && warning.code === "MIGRATION_EXISTING_COLUMN"),
    JSON.stringify(warnings),
  );
  reopened.close();

  // A second loss (only the v3 row) is also repaired.
  const rawAgain = rawOpen(file);
  rawAgain.exec("DELETE FROM schema_migrations WHERE version = 3");
  rawAgain.close();
  const third = open();
  assert.equal(third.health().schemaVersion, 5);
  assert.equal(third.getTask("TASK-KEEP").title, "Task title");
  assert.ok(
    third[INTERNAL].migrationWarnings().some((warning) => warning.migration === "0003_scheduling.sql"),
    JSON.stringify(third[INTERNAL].migrationWarnings()),
  );
  third.close();

  const verify = rawOpen(file);
  try {
    const rows = verify.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5]);
    assert.equal(Number(verify.prepare("SELECT COUNT(*) AS c FROM tasks").get().c), 1);
    assert.equal(Number(verify.prepare("SELECT COUNT(*) AS c FROM projects").get().c), 1);
  } finally {
    verify.close();
  }
});

test("openStore validates its arguments with contract errors", () => {
  assert.throws(
    () => openStore({}),
    (error) => error.code === "VALIDATION_ERROR" && /file/.test(error.message),
  );
  assert.throws(
    () => openStore({ file: "   " }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => openStore({ file: "atk.db", migrate: "yes" }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("errors are contract-shaped objects with code/message/details", (t) => {
  const { store } = useStore(t);
  try {
    store.getProject("missing");
    assert.fail("expected NOT_FOUND");
  } catch (error) {
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(typeof error.message, "string");
    assert.deepEqual(error.details, { entity: "project", id: "missing" });
    assert.deepEqual(JSON.parse(JSON.stringify(error)), {
      code: "NOT_FOUND",
      message: 'project "missing" not found',
      details: { entity: "project", id: "missing" },
    });
  }
});



