// SQLite Store implementation (M1, ATK-104).
//
// Driver: built-in `node:sqlite` DatabaseSync (ADR-009). No native module, no
// ORM. Every write statement is a parameterised prepared statement; the only
// `exec()` calls are trusted DDL from `migrations/*.sql` and transaction
// control words, never user input.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_SCHEMA_VERSION, FUNCTIONS } from "@atk/contracts";
import { StoreError, fail, notFound } from "./errors.mjs";
import { INTERNAL } from "./internal.mjs";
import {
  MAX_EVENT_LIMIT,
  MAX_OVERVIEW_EVENTS,
  SCHEMA_VERSION,
  assertEnumFilter,
  buildOverview,
  compareTasks,
  ensurePlainObject,
  makeEvent,
  mergeAgent,
  mergeProject,
  mergeTask,
  normalizeAgent,
  normalizeApproval,
  normalizeLimit,
  normalizeProject,
  normalizeRequirement,
  normalizeTask,
  nowIso,
  parseJsonColumn,
  requireId,
  safeJson,
  validateTaskStatus,
} from "./model.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION_FILE_RE = /^(\d+)_.*\.sql$/;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function migrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new StoreError("INTERNAL_ERROR", `migrations directory is missing: ${MIGRATIONS_DIR}`, {});
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const seen = new Set();
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (seen.has(version)) {
      throw new StoreError("INTERNAL_ERROR", `duplicate migration version ${version}`, { file });
    }
    seen.add(version);
  }
  return files;
}

/** Map a raw node:sqlite failure onto the contract error envelope. */
function mapSqliteError(error) {
  if (error instanceof StoreError) return error;
  if (error && error.code === "ERR_SQLITE_ERROR") {
    const errcode = Number(error.errcode);
    const details = {
      sqlite: {
        code: error.code,
        errcode: Number.isFinite(errcode) ? errcode : null,
        errstr: error.errstr ?? null,
      },
    };
    // 2067 UNIQUE, 1555 PRIMARY KEY, 787 FOREIGN KEY — all caller/data problems.
    if (errcode === 2067 || errcode === 1555) {
      return new StoreError("VALIDATION_ERROR", `unique constraint violated: ${error.errstr ?? "constraint"}`, details);
    }
    if (errcode === 787) {
      return new StoreError("VALIDATION_ERROR", "foreign key constraint violated", details);
    }
    // Trigger RAISE(ABORT), disk I/O, ...: not a caller mistake.
    return new StoreError("INTERNAL_ERROR", "database error", details);
  }
  return error;
}

/** Resolve a path to a usable database file, creating its directory if needed. */
function resolveFile(file) {
  if (typeof file !== "string" || file.trim() === "") {
    fail("VALIDATION_ERROR", "openStore requires { file: string }", { file: file ?? null });
  }
  if (file.includes("\0")) {
    fail("VALIDATION_ERROR", "database file path must not contain NUL bytes", {});
  }
  if (file === ":memory:") return file;
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    fail("VALIDATION_ERROR", `cannot create database directory: ${error.message}`, { dir });
  }
  return resolved;
}

/**
 * Open (and by default migrate) a Store backed by SQLite.
 *
 * @param {{file: string, migrate?: boolean, busyTimeoutMs?: number}} options
 */
export function openStore(options = {}) {
  ensurePlainObject(options, "openStore options");
  const { file, migrate = true, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = options;
  if (typeof migrate !== "boolean") {
    fail("VALIDATION_ERROR", "openStore.migrate must be a boolean", { migrate });
  }
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    fail("VALIDATION_ERROR", "openStore.busyTimeoutMs must be a non-negative integer", { busyTimeoutMs });
  }
  const resolvedFile = resolveFile(file);
  const inMemory = resolvedFile === ":memory:";

  const db = new DatabaseSync(resolvedFile);
  const statements = new Map();
  let closed = false;
  let transactionDepth = 0;
  let schemaVersion = 0;

  function stmt(sql) {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  }

  function exec(sql) {
    db.exec(sql);
  }

  /** Write operations run inside BEGIN IMMEDIATE ... COMMIT (contract §1). */
  function transaction(work) {
    if (transactionDepth > 0) return work();
    exec("BEGIN IMMEDIATE");
    transactionDepth = 1;
    try {
      const result = work();
      exec("COMMIT");
      return result;
    } catch (error) {
      try {
        exec("ROLLBACK");
      } catch {
        // A failed ROLLBACK means the transaction is already gone; the original
        // error is the one worth surfacing.
      }
      throw mapSqliteError(error);
    } finally {
      transactionDepth = 0;
    }
  }

  function currentSchemaVersion() {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (!table) return 0;
    return Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version);
  }

  function applyMigrations() {
    exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
    );
    const applied = new Set(
      db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)),
    );
    for (const name of migrationFiles()) {
      const version = Number.parseInt(name, 10);
      if (applied.has(version)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
      exec("BEGIN IMMEDIATE");
      transactionDepth = 1;
      try {
        exec(sql);
        stmt("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          version,
          name,
          nowIso(),
        );
        exec("COMMIT");
      } catch (error) {
        try {
          exec("ROLLBACK");
        } catch {
          // ignore: see transaction()
        }
        throw mapSqliteError(error);
      } finally {
        transactionDepth = 0;
      }
      applied.add(version);
    }
    return currentSchemaVersion();
  }

  // --- PRAGMAs: prove they took effect instead of assuming -----------------
  let journalMode;
  let foreignKeys;
  let busyTimeout;
  try {
    journalMode = String(db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode ?? "").toLowerCase();
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? 0);
    busyTimeout = Number(db.prepare("PRAGMA busy_timeout").get()?.timeout ?? -1);
  } catch (error) {
    db.close();
    throw mapSqliteError(error);
  }
  if (!inMemory && journalMode !== "wal") {
    db.close();
    throw new StoreError("INTERNAL_ERROR", `could not enable WAL journal mode (got "${journalMode}")`, {
      journalMode,
    });
  }
  if (foreignKeys !== 1) {
    db.close();
    throw new StoreError("INTERNAL_ERROR", "could not enable SQLite foreign key enforcement", {
      foreignKeys,
    });
  }
  if (busyTimeout !== busyTimeoutMs) {
    db.close();
    throw new StoreError("INTERNAL_ERROR", "could not apply SQLite busy_timeout", {
      expected: busyTimeoutMs,
      actual: busyTimeout,
    });
  }

  schemaVersion = migrate ? applyMigrations() : currentSchemaVersion();

  // -------------------------------------------------------------------------
  // Row -> JSON converters (single source of truth for entity shapes)
  // -------------------------------------------------------------------------

  function projectJson(row) {
    return {
      id: row.id,
      name: row.name,
      repoPath: row.repo_path,
      defaultBranch: row.default_branch,
      policyVersion: Number(row.policy_version),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function requirementJson(row) {
    const requirement = {
      id: row.id,
      projectId: row.project_id,
      description: row.description,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.acceptance !== null && row.acceptance !== undefined) requirement.acceptance = row.acceptance;
    return requirement;
  }

  function depsOf(taskId) {
    return stmt("SELECT depends_on_id FROM task_dependencies WHERE task_id = ? ORDER BY position, depends_on_id")
      .all(taskId)
      .map((row) => row.depends_on_id);
  }

  function taskJson(row, deps = depsOf(row.id)) {
    const task = {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      functionRequired: row.function_required,
      roleRequired: row.role_required,
      priority: Number(row.priority),
      deps,
      status: row.status,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.acceptance !== null && row.acceptance !== undefined) task.acceptance = row.acceptance;
    if (row.plan_id !== null && row.plan_id !== undefined) task.planId = row.plan_id;
    return task;
  }

  function runJson(row) {
    const run = {
      id: row.id,
      taskId: row.task_id,
      agentId: row.agent_id,
      function: row.function,
      status: row.status,
      attempt: Number(row.attempt),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.started_at !== null && row.started_at !== undefined) run.startedAt = row.started_at;
    if (row.ended_at !== null && row.ended_at !== undefined) run.endedAt = row.ended_at;
    const error = parseJsonColumn(row.error_json);
    if (error !== null) run.error = error;
    return run;
  }

  function agentJson(row) {
    const agent = {
      id: row.id,
      role: row.role,
      capabilities: parseJsonColumn(row.capabilities_json) ?? [],
      status: row.status,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.task !== null && row.task !== undefined) agent.task = row.task;
    if (row.detail !== null && row.detail !== undefined) agent.detail = row.detail;
    if (row.since !== null && row.since !== undefined) agent.since = row.since;
    return agent;
  }

  function reviewJson(row) {
    const review = {
      id: row.id,
      taskId: row.task_id,
      status: row.status,
      attempt: Number(row.attempt),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.run_id !== null && row.run_id !== undefined) review.runId = row.run_id;
    if (row.verdict !== null && row.verdict !== undefined) review.verdict = row.verdict;
    if (row.manifest_hash !== null && row.manifest_hash !== undefined) review.manifestHash = row.manifest_hash;
    if (row.commit_sha !== null && row.commit_sha !== undefined) review.commitSha = row.commit_sha;
    const findings = parseJsonColumn(row.findings_json);
    if (findings !== null) review.findings = findings;
    return review;
  }

  function approvalJson(row) {
    const approval = {
      id: row.id,
      scope: row.scope,
      targetHash: row.target_hash,
      actor: row.actor,
      status: row.status,
      at: row.at,
      createdAt: row.created_at,
    };
    if (row.project_id !== null && row.project_id !== undefined) approval.projectId = row.project_id;
    if (row.task_id !== null && row.task_id !== undefined) approval.taskId = row.task_id;
    return approval;
  }

  function eventJson(row) {
    return {
      schemaVersion: Number(row.schema_version),
      seq: Number(row.seq),
      projectId: row.project_id ?? null,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      type: row.type,
      payload: parseJsonColumn(row.payload_json) ?? {},
      happenedAt: row.happened_at,
    };
  }

  // -------------------------------------------------------------------------
  // Lookup helpers
  // -------------------------------------------------------------------------

  function getProjectRow(id) {
    requireId(id, "project.id");
    return stmt("SELECT * FROM projects WHERE id = ?").get(id) ?? null;
  }

  function getTaskRow(id) {
    requireId(id, "task.id");
    return stmt("SELECT * FROM tasks WHERE id = ?").get(id) ?? null;
  }

  function requireProject(id) {
    const row = getProjectRow(id);
    if (!row) notFound("project", id);
    return row;
  }

  function requireTaskRow(id) {
    const row = getTaskRow(id);
    if (!row) notFound("task", id);
    return row;
  }

  function currentTaskJson(id) {
    return taskJson(requireTaskRow(id));
  }

  function assertDepsExist(deps, selfId) {
    const missing = [];
    for (const dep of deps) {
      if (dep === selfId) {
        fail("VALIDATION_ERROR", "task may not depend on itself", { taskId: selfId, dep });
      }
      if (!getTaskRow(dep)) missing.push(dep);
    }
    if (missing.length > 0) {
      fail("VALIDATION_ERROR", "task.deps references unknown tasks", { missingDeps: missing });
    }
  }

  function replaceDependencies(taskId, deps) {
    stmt("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    const insert = stmt(
      "INSERT INTO task_dependencies (task_id, depends_on_id, position, created_at) VALUES (?, ?, ?, ?)",
    );
    const at = nowIso();
    deps.forEach((dep, index) => insert.run(taskId, dep, index, at));
  }

  function filterTasks({ projectId, status, roleRequired, functionRequired, q, limit } = {}) {
    const where = [];
    const params = [];
    if (projectId !== undefined && projectId !== null) {
      requireId(projectId, "task.projectId");
      where.push("project_id = ?");
      params.push(projectId);
    }
    if (status !== undefined && status !== null) {
      validateTaskStatus(status);
      where.push("status = ?");
      params.push(status);
    }
    if (roleRequired !== undefined && roleRequired !== null) {
      if (typeof roleRequired !== "string" || roleRequired.trim() === "") {
        fail("VALIDATION_ERROR", "roleRequired must be a non-empty string", { roleRequired });
      }
      where.push("role_required = ?");
      params.push(roleRequired);
    }
    if (functionRequired !== undefined && functionRequired !== null) {
      if (!FUNCTIONS.includes(functionRequired)) {
        fail("VALIDATION_ERROR", "functionRequired must be a Function", { functionRequired });
      }
      where.push("function_required = ?");
      params.push(functionRequired);
    }
    if (q !== undefined && q !== null) {
      if (typeof q !== "string") fail("VALIDATION_ERROR", "q must be a string", { q });
      if (q.trim() !== "") {
        const escaped = q.replace(/[\\%_]/g, "\\$&");
        where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
        params.push(`%${escaped}%`, `%${escaped}%`);
      }
    }
    const sql = `SELECT * FROM tasks${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY priority ASC, created_at ASC, id ASC LIMIT ?`;
    params.push(normalizeLimit(limit));
    return stmt(sql)
      .all(...params)
      .map((row) => taskJson(row));
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  const store = {
    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      db.close();
    },

    health() {
      // Counts stay readable when opened with migrate:false (schemaVersion 0,
      // empty counts) instead of failing on a table that does not exist yet.
      const count = (table) => {
        try {
          return Number(stmt(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
        } catch {
          return 0;
        }
      };
      return {
        ok: true,
        file: resolvedFile,
        schemaVersion,
        counts: {
          projects: count("projects"),
          tasks: count("tasks"),
          runs: count("runs"),
          events: count("events"),
          agents: count("agent_instances"),
        },
      };
    },

    // --- Projects ---------------------------------------------------------
    listProjects() {
      return stmt("SELECT * FROM projects ORDER BY created_at ASC, id ASC").all().map(projectJson);
    },

    getProject(id) {
      return projectJson(requireProject(id));
    },

    createProject(dto) {
      ensurePlainObject(dto, "project");
      return transaction(() => {
        if (getProjectRow(dto.id)) {
          fail("VALIDATION_ERROR", `project "${dto.id}" already exists`, { entity: "project", id: dto.id });
        }
        const project = normalizeProject(dto, { now: nowIso() });
        stmt(
          `INSERT INTO projects
             (id, name, repo_path, default_branch, policy_version, version, legacy_json, settings_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          project.id,
          project.name,
          project.repoPath,
          project.defaultBranch,
          project.policyVersion,
          project.version,
          safeJson(dto.legacy, "project.legacy"),
          safeJson(dto.settings, "project.settings"),
          project.createdAt,
          project.updatedAt,
        );
        return projectJson(requireProject(project.id));
      });
    },

    updateProject(id, { expectedVersion, changes } = {}) {
      requireId(id, "project.id");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        fail("VALIDATION_ERROR", "expectedVersion must be a non-negative integer", { expectedVersion });
      }
      return transaction(() => {
        const currentRow = requireProject(id);
        const current = projectJson(currentRow);
        const merged = mergeProject(current, changes, { now: nowIso() });
        const result = stmt(
          `UPDATE projects
              SET name = ?, repo_path = ?, default_branch = ?, policy_version = ?,
                  version = ?, updated_at = ?
            WHERE id = ? AND version = ?`,
        ).run(
          merged.name,
          merged.repoPath,
          merged.defaultBranch,
          merged.policyVersion,
          merged.version,
          merged.updatedAt,
          id,
          expectedVersion,
        );
        if (Number(result.changes) === 0) {
          const row = getProjectRow(id);
          if (!row) notFound("project", id);
          fail("VERSION_CONFLICT", `project "${id}" version conflict`, {
            entity: "project",
            id,
            expectedVersion,
            currentVersion: Number(row.version),
          });
        }
        return projectJson(requireProject(id));
      });
    },

    // --- Requirements -----------------------------------------------------
    listRequirements({ projectId } = {}) {
      if (projectId !== undefined && projectId !== null) {
        requireId(projectId, "requirement.projectId");
        return stmt("SELECT * FROM requirements WHERE project_id = ? ORDER BY created_at ASC, id ASC")
          .all(projectId)
          .map(requirementJson);
      }
      return stmt("SELECT * FROM requirements ORDER BY created_at ASC, id ASC").all().map(requirementJson);
    },

    createRequirement(dto) {
      ensurePlainObject(dto, "requirement");
      return transaction(() => {
        requireProject(dto.projectId);
        if (stmt("SELECT id FROM requirements WHERE id = ?").get(dto.id)) {
          fail("VALIDATION_ERROR", `requirement "${dto.id}" already exists`, {
            entity: "requirement",
            id: dto.id,
          });
        }
        const requirement = normalizeRequirement(dto, { now: nowIso() });
        stmt(
          `INSERT INTO requirements (id, project_id, description, acceptance, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          requirement.id,
          requirement.projectId,
          requirement.description,
          requirement.acceptance ?? null,
          requirement.version,
          requirement.createdAt,
          requirement.updatedAt,
        );
        return requirementJson(stmt("SELECT * FROM requirements WHERE id = ?").get(requirement.id));
      });
    },

    // --- Tasks ------------------------------------------------------------
    listTasks(filters = {}) {
      ensurePlainObject(filters, "listTasks filters");
      return filterTasks(filters);
    },

    getTask(id) {
      requireId(id, "task.id");
      return taskJson(requireTaskRow(id));
    },

    createTask(dto) {
      ensurePlainObject(dto, "task");
      return transaction(() => {
        requireProject(dto.projectId);
        const task = normalizeTask(dto, { now: nowIso(), status: "READY" });
        if (getTaskRow(task.id)) {
          fail("VALIDATION_ERROR", `task "${task.id}" already exists`, { entity: "task", id: task.id });
        }
        assertDepsExist(task.deps, task.id);
        stmt(
          `INSERT INTO tasks
             (id, project_id, title, description, function_required, role_required, priority, status,
              acceptance, plan_id, parent_id, version, legacy_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          task.id,
          task.projectId,
          task.title,
          task.description,
          task.functionRequired,
          task.roleRequired,
          task.priority,
          task.status,
          task.acceptance ?? null,
          task.planId ?? null,
          dto.parentId ?? null,
          task.version,
          safeJson(dto.legacy, "task.legacy"),
          task.createdAt,
          task.updatedAt,
        );
        replaceDependencies(task.id, task.deps);
        return taskJson(requireTaskRow(task.id));
      });
    },

    patchTask(id, { expectedVersion, changes } = {}) {
      requireId(id, "task.id");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        fail("VALIDATION_ERROR", "expectedVersion must be a non-negative integer", { expectedVersion });
      }
      return transaction(() => {
        const current = currentTaskJson(id);
        const merged = mergeTask(current, changes, { now: nowIso() });
        const rewriteDeps = changes.deps !== undefined;
        if (rewriteDeps) assertDepsExist(merged.deps, id);
        const result = stmt(
          `UPDATE tasks
              SET title = ?, description = ?, function_required = ?, role_required = ?, priority = ?,
                  acceptance = ?, plan_id = ?, status = ?, version = ?, updated_at = ?
            WHERE id = ? AND version = ?`,
        ).run(
          merged.title,
          merged.description,
          merged.functionRequired,
          merged.roleRequired,
          merged.priority,
          merged.acceptance ?? null,
          merged.planId ?? null,
          merged.status,
          merged.version,
          merged.updatedAt,
          id,
          expectedVersion,
        );
        if (Number(result.changes) === 0) {
          const row = getTaskRow(id);
          if (!row) notFound("task", id);
          fail("TASK_VERSION_CONFLICT", `task "${id}" version conflict`, {
            taskId: id,
            expectedVersion,
            currentVersion: Number(row.version),
          });
        }
        if (rewriteDeps) replaceDependencies(id, merged.deps);
        return taskJson(requireTaskRow(id));
      });
    },

    // --- Runs / Agents / Reviews / Approvals ------------------------------
    listRuns({ taskId, status, limit } = {}) {
      const where = [];
      const params = [];
      if (taskId !== undefined && taskId !== null) {
        requireId(taskId, "run.taskId");
        where.push("task_id = ?");
        params.push(taskId);
      }
      if (status !== undefined && status !== null) {
        assertEnumFilter("run", status);
        where.push("status = ?");
        params.push(status);
      }
      params.push(normalizeLimit(limit, { fallback: 50 }));
      const sql = `SELECT * FROM runs${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`;
      return stmt(sql).all(...params).map(runJson);
    },

    getRun(id) {
      requireId(id, "run.id");
      const row = stmt("SELECT * FROM runs WHERE id = ?").get(id);
      if (!row) notFound("run", id);
      return runJson(row);
    },

    listAgents() {
      return stmt("SELECT * FROM agent_instances ORDER BY id ASC").all().map(agentJson);
    },

    upsertAgent(dto) {
      ensurePlainObject(dto, "agent");
      return transaction(() => {
        requireId(dto.id, "agent.id");
        const existing = stmt("SELECT * FROM agent_instances WHERE id = ?").get(dto.id);
        if (existing) {
          const merged = mergeAgent(agentJson(existing), dto, { now: nowIso() });
          stmt(
            `UPDATE agent_instances
                SET role = ?, capabilities_json = ?, status = ?, task = ?, detail = ?, since = ?,
                    version = ?, updated_at = ?
              WHERE id = ?`,
          ).run(
            merged.role,
            JSON.stringify(merged.capabilities),
            merged.status,
            merged.task ?? null,
            merged.detail ?? null,
            merged.since ?? null,
            merged.version,
            merged.updatedAt,
            merged.id,
          );
          return agentJson(stmt("SELECT * FROM agent_instances WHERE id = ?").get(merged.id));
        }
        const agent = normalizeAgent(dto, { now: nowIso() });
        stmt(
          `INSERT INTO agent_instances
             (id, role, capabilities_json, status, task, detail, since, legacy_json, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          agent.id,
          agent.role,
          JSON.stringify(agent.capabilities),
          agent.status,
          agent.task ?? null,
          agent.detail ?? null,
          agent.since ?? null,
          safeJson(dto.legacy, "agent.legacy"),
          agent.version,
          agent.createdAt,
          agent.updatedAt,
        );
        return agentJson(stmt("SELECT * FROM agent_instances WHERE id = ?").get(agent.id));
      });
    },

    listReviews({ status } = {}) {
      if (status !== undefined && status !== null) {
        assertEnumFilter("review", status);
        return stmt("SELECT * FROM reviews WHERE status = ? ORDER BY created_at DESC, id DESC")
          .all(status)
          .map(reviewJson);
      }
      return stmt("SELECT * FROM reviews ORDER BY created_at DESC, id DESC").all().map(reviewJson);
    },

    listApprovals({ taskId, status } = {}) {
      const where = [];
      const params = [];
      if (taskId !== undefined && taskId !== null) {
        requireId(taskId, "approval.taskId");
        where.push("task_id = ?");
        params.push(taskId);
      }
      if (status !== undefined && status !== null) {
        assertEnumFilter("acceptance", status);
        where.push("status = ?");
        params.push(status);
      }
      const sql = `SELECT * FROM approvals${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC`;
      return stmt(sql).all(...params).map(approvalJson);
    },

    createApproval(dto) {
      ensurePlainObject(dto, "approval");
      return transaction(() => {
        const approval = normalizeApproval(dto, { now: nowIso() });
        if (approval.projectId !== undefined) requireProject(approval.projectId);
        if (approval.taskId !== undefined) requireTaskRow(approval.taskId);
        stmt(
          `INSERT INTO approvals (id, project_id, task_id, scope, target_hash, actor, status, at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          approval.id,
          approval.projectId ?? null,
          approval.taskId ?? null,
          approval.scope,
          approval.targetHash,
          approval.actor,
          approval.status,
          approval.at,
          approval.createdAt,
        );
        return approvalJson(stmt("SELECT * FROM approvals WHERE id = ?").get(approval.id));
      });
    },

    // --- Overview ---------------------------------------------------------
    overview(projectId) {
      requireId(projectId, "project.id");
      const projectRow = requireProject(projectId);
      const taskRows = stmt(
        "SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC, id ASC",
      ).all(projectId);
      const tasks = taskRows.map((row) => taskJson(row));
      const runsRunning = Number(
        stmt(
          `SELECT COUNT(*) AS c FROM runs r JOIN tasks t ON t.id = r.task_id
            WHERE t.project_id = ? AND r.status IN ('STARTING', 'RUNNING')`,
        ).get(projectId).c,
      );
      const runsTotal = Number(
        stmt(
          "SELECT COUNT(*) AS c FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ?",
        ).get(projectId).c,
      );
      const recentEvents = stmt(
        "SELECT * FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT ?",
      )
        .all(projectId, MAX_OVERVIEW_EVENTS)
        .map(eventJson);
      return buildOverview({
        project: projectJson(projectRow),
        tasks,
        recentEvents,
        runsRunning,
        runsTotal,
      });
    },

    // --- Events -----------------------------------------------------------
    appendEvent(input) {
      ensurePlainObject(input, "event");
      const event = makeEvent({ ...input, now: nowIso() });
      return transaction(() => {
        const result = stmt(
          `INSERT INTO events
             (schema_version, project_id, aggregate_type, aggregate_id, type, payload_json, happened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          EVENT_SCHEMA_VERSION,
          event.projectId,
          event.aggregateType,
          event.aggregateId,
          event.type,
          JSON.stringify(event.payload),
          event.happenedAt,
        );
        const row = stmt("SELECT * FROM events WHERE seq = ?").get(Number(result.lastInsertRowid));
        return eventJson(row);
      });
    },

    listEvents({ projectId, afterSeq, limit } = {}) {
      const where = [];
      const params = [];
      if (projectId !== undefined && projectId !== null) {
        requireId(projectId, "event.projectId");
        where.push("project_id = ?");
        params.push(projectId);
      }
      if (afterSeq !== undefined && afterSeq !== null) {
        if (!Number.isInteger(afterSeq) || afterSeq < 0) {
          fail("VALIDATION_ERROR", "afterSeq must be a non-negative integer", { afterSeq });
        }
        where.push("seq > ?");
        params.push(afterSeq);
      }
      params.push(normalizeLimit(limit, { fallback: 200, max: MAX_EVENT_LIMIT }));
      const sql = `SELECT * FROM events${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
        ORDER BY seq ASC LIMIT ?`;
      return stmt(sql).all(...params).map(eventJson);
    },

    latestSeq() {
      return Number(stmt("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get().seq);
    },
  };

  // Every public method goes through mapSqliteError so callers only ever see
  // the contract envelope, even for read paths (busy/locked, missing table when
  // opened with migrate:false, ...). Writes already map inside transaction();
  // mapping twice is a no-op.
  const guarded = {};
  for (const [key, value] of Object.entries(store)) {
    guarded[key] =
      typeof value === "function"
        ? (...args) => {
            try {
              return value(...args);
            } catch (error) {
              throw mapSqliteError(error);
            }
          }
        : value;
  }

  // Internal, non-enumerable surface (never serialised into API responses).
  Object.defineProperty(guarded, INTERNAL, {
    value: {
      kind: "sqlite",
      schemaVersion: SCHEMA_VERSION,
      debugPragmas: () => ({
        journalMode: String(db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase(),
        foreignKeys: Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? 0),
        busyTimeout: Number(db.prepare("PRAGMA busy_timeout").get()?.timeout ?? -1),
        inTransaction: transactionDepth > 0,
      }),
      getProjectLegacy: (id) => {
        const row = getProjectRow(id);
        return row ? parseJsonColumn(row.legacy_json) : null;
      },
      getProjectSettings: (id) => {
        const row = getProjectRow(id);
        return row ? parseJsonColumn(row.settings_json) : null;
      },
      getTaskLegacy: (id) => {
        const row = getTaskRow(id);
        return row ? parseJsonColumn(row.legacy_json) : null;
      },
      listTasksAll: (projectId) =>
        stmt("SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC, id ASC")
          .all(projectId)
          .map((row) => taskJson(row)),
      listRunsAll: () =>
        stmt("SELECT * FROM runs ORDER BY created_at ASC, id ASC").all().map(runJson),
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return guarded;
}

export { SCHEMA_VERSION };
export { compareTasks };
export { StoreError };
