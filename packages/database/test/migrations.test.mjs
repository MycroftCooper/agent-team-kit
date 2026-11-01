// Migration, schema and connection-level guarantees (contracts §1, ADR-006,
// ADR-009): WAL + busy_timeout + foreign_keys are really on, migrations are
// applied exactly once and re-opening a store neither re-creates tables nor
// duplicates schema_migrations rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "@atk/database";
import { INTERNAL } from "../src/internal.mjs";
import { projectDto, taskDto, useStore } from "./helpers.mjs";

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
  assert.equal(store.health().schemaVersion, 1);
  assert.equal(store.health().ok, true);
  const raw = rawOpen(file);
  try {
    const rows = raw.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].version), 1);
    assert.equal(rows[0].name, "0001_init.sql");
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
  assert.equal(second.health().schemaVersion, 1);
  assert.deepEqual(second.health().counts, { projects: 1, tasks: 1, runs: 0, events: 0, agents: 0 });
  assert.equal(second.listProjects().length, 1);
  assert.equal(second.listTasks({ projectId: "proj-1" }).length, 1);
  second.close();

  const raw = rawOpen(file);
  try {
    assert.equal(Number(raw.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get().c), 1);
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
  assert.equal(migrated.health().schemaVersion, 1);
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
  assert.equal(store.health().schemaVersion, 1);
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
