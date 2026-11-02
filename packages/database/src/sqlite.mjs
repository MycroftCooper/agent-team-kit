// SQLite Store implementation (M1/M2: schema, migrations, repositories).
//
// Driver: built-in `node:sqlite` DatabaseSync (ADR-009). No native module, no
// ORM. Every write statement is a parameterised prepared statement; the only
// `exec()` calls are trusted DDL from `migrations/*.sql` and transaction
// control words, never user input.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_SCHEMA_VERSION, FUNCTIONS, ID_RE, eventDedupeKey } from "@atk/contracts";
import { StoreError, fail, notFound } from "./errors.mjs";
import { INTERNAL } from "./internal.mjs";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  DEFAULT_MAX_REVIEW_ATTEMPTS,
  MAX_EVENT_LIMIT,
  MAX_EVENT_PAGE_LIMIT,
  MAX_LIST_LIMIT,
  MAX_OVERVIEW_EVENTS,
  SCHEMA_VERSION,
  applyReviewVerdict,
  assertEnumFilter,
  assertRunTransition,
  assertTaskTransition,
  buildFrozenExecutionSpec,
  buildOverview,
  canTransition,
  canonicalAgentId,
  compareTasks,
  ensurePlainObject,
  filesIntersection,
  generateId,
  isPlainObject,
  leaseExpiryAfter,
  makeEvent,
  mergeAgent,
  mergeProject,
  mergeRunStatus,
  mergeTask,
  normalizeAgent,
  normalizeApproval,
  normalizeEventFilters,
  normalizeLimit,
  normalizeProject,
  normalizeProjectPolicy,
  normalizeRequirement,
  normalizeReview,
  normalizeRun,
  normalizeTask,
  nowIso,
  parseJsonColumn,
  planRuntimeEventBatch,
  requireId,
  safeJson,
  validateActor,
  validateApprovalDecision,
  validateTargetHash,
  validateCommandPayload,
  validateCommandType,
  validateIdempotencyKey,
  validateLeaseMs,
  validateOwnerId,
  validateSchedulingPolicies,
  validateTaskStatus,
} from "./model.mjs";
import { verifySwitchReadiness } from "./import-export.mjs";

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
    // 2067 UNIQUE, 1555 PRIMARY KEY, 787 FOREIGN KEY 鈥?all caller/data problems.
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

  /** Write operations run inside BEGIN IMMEDIATE ... COMMIT (contract 搂1). */
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

  // Migration self-heal bookkeeping (QA-003): if a migration's bookkeeping row
  // is lost but its columns already exist, we must not die on "duplicate column
  // name". Warnings are recorded here and exposed via the INTERNAL diagnostics.
  const migrationWarnings = [];

  /** Split a .sql file into statements (ignores -- comments and quoted ';'). */
  function splitSqlStatements(sql) {
    const statements = [];
    let current = "";
    let inString = false;
    let inLineComment = false;
    for (let index = 0; index < sql.length; index += 1) {
      const char = sql[index];
      const next = sql[index + 1];
      if (inLineComment) {
        if (char === "\n") {
          inLineComment = false;
          current += char;
        }
        continue;
      }
      if (!inString && char === "-" && next === "-") {
        inLineComment = true;
        index += 1;
        continue;
      }
      if (char === "'") {
        if (inString && next === "'") {
          current += "''";
          index += 1;
          continue;
        }
        inString = !inString;
        current += char;
        continue;
      }
      if (!inString && char === ";") {
        const statement = current.trim();
        if (statement !== "") statements.push(statement);
        current = "";
        continue;
      }
      current += char;
    }
    const tail = current.trim();
    if (tail !== "") statements.push(tail);
    return statements;
  }

  function hasColumn(table, column) {
    try {
      return db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row) => row.name === column);
    } catch {
      return false;
    }
  }

  const ALTER_ADD_COLUMN_RE =
    /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+["`]?(\w+)["`]?/i;

  /** Drop ALTER ... ADD COLUMN statements whose column already exists. */
  function prepareMigrationStatements(rawSql) {
    const kept = [];
    const skipped = [];
    for (const statement of splitSqlStatements(rawSql)) {
      const alter = ALTER_ADD_COLUMN_RE.exec(statement);
      if (alter && hasColumn(alter[1], alter[2])) {
        skipped.push({ table: alter[1], column: alter[2] });
        continue;
      }
      kept.push(statement);
    }
    return { statements: kept, skipped };
  }

  function isDuplicateColumnError(error) {
    const text = `${error?.details?.sqlite?.errstr ?? ""} ${error?.message ?? ""}`;
    return /duplicate column name/i.test(text);
  }

  /** Run one migration's statements + bookkeeping row in one transaction. */
  function runMigration(version, name, statements) {
    exec("BEGIN IMMEDIATE");
    transactionDepth = 1;
    try {
      // Two processes may open the same fresh database at the same time: the
      // write lock serialises them, so re-check inside the transaction that the
      // other opener did not already apply this migration.
      const already = stmt("SELECT version FROM schema_migrations WHERE version = ?").get(version);
      if (already) {
        exec("COMMIT");
        return "already";
      }
      for (const statement of statements) exec(statement);
      stmt("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        version,
        name,
        nowIso(),
      );
      exec("COMMIT");
      return "applied";
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
  }

  /** Repair only the bookkeeping row when the schema is already complete. */
  function recordMigrationOnly(version, name) {
    exec("BEGIN IMMEDIATE");
    transactionDepth = 1;
    try {
      const already = stmt("SELECT version FROM schema_migrations WHERE version = ?").get(version);
      if (!already) {
        stmt("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          version,
          name,
          nowIso(),
        );
      }
      exec("COMMIT");
    } catch (error) {
      try {
        exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw mapSqliteError(error);
    } finally {
      transactionDepth = 0;
    }
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
      const rawSql = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
      let prepared = prepareMigrationStatements(rawSql);
      if (prepared.skipped.length > 0) {
        migrationWarnings.push({
          migration: name,
          code: "MIGRATION_EXISTING_COLUMN",
          skipped: prepared.skipped,
        });
        console.warn(
          `[atk/database] WARN ${name}: bookkeeping row was missing but column(s) already exist; ` +
            `skipping ${prepared.skipped.map((entry) => `${entry.table}.${entry.column}`).join(", ")}`,
        );
      }
      try {
        runMigration(version, name, prepared.statements);
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
        // Raced with another opener between the pre-check and the ALTER: inspect
        // again and retry once. If it still reports a duplicate, the schema is
        // complete and only the bookkeeping row needs repairing.
        migrationWarnings.push({ migration: name, code: "MIGRATION_DUPLICATE_COLUMN_RETRY" });
        prepared = prepareMigrationStatements(rawSql);
        try {
          runMigration(version, name, prepared.statements);
        } catch (retryError) {
          if (!isDuplicateColumnError(retryError)) throw retryError;
          migrationWarnings.push({ migration: name, code: "MIGRATION_BOOKKEEPING_REPAIRED" });
          recordMigrationOnly(version, name);
        }
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
    const files = parseJsonColumn(row.files_json);
    if (Array.isArray(files) && files.length > 0) task.files = files;
    if (row.target_hash !== null && row.target_hash !== undefined) task.targetHash = row.target_hash;
    return task;
  }

  function runJson(row) {
    const run = {
      id: row.id,
      taskId: row.task_id,
      agentId: row.agent_id,
      function: row.function,
      role: row.role ?? null,
      status: row.status,
      attempt: Number(row.attempt),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.workspace_id !== null && row.workspace_id !== undefined) run.workspaceId = row.workspace_id;
    if (row.workspace_path !== null && row.workspace_path !== undefined) {
      run.workspace = {
        kind: "worktree",
        path: row.workspace_path,
        baseCommit: row.base_commit ?? null,
        targetBranch: row.target_branch ?? null,
      };
    }
    if (row.started_at !== null && row.started_at !== undefined) run.startedAt = row.started_at;
    if (row.ended_at !== null && row.ended_at !== undefined) run.endedAt = row.ended_at;
    if (row.exit_code !== null && row.exit_code !== undefined) run.exitCode = Number(row.exit_code);
    const files = parseJsonColumn(row.files_json);
    if (Array.isArray(files) && files.length > 0) run.files = files;
    const error = parseJsonColumn(row.error_json);
    if (error !== null) run.error = error;
    return run;
  }

  function commandJson(row) {
    const command = {
      id: row.id,
      runId: row.run_id,
      taskId: row.task_id ?? null,
      commandType: row.command_type ?? "RUN_TASK",
      payload: parseJsonColumn(row.payload_json) ?? {},
      status: row.status,
      idempotencyKey: row.idempotency_key,
      ownerId: row.owner_id ?? null,
      generation: Number(row.generation ?? 0),
      claimedUntil: row.claimed_until ?? null,
      attempts: Number(row.attempts ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const result = parseJsonColumn(row.result_json);
    if (result !== null) command.result = result;
    if (row.completed_at !== null && row.completed_at !== undefined) command.completedAt = row.completed_at;
    return command;
  }

  function leaseJson(row) {
    // Lease JSON uses the names the internal API forwards to the Runtime Host
    // (m2-contracts 搂2: `{ ownerId, generation, claimedUntil }`); the DB columns
    // are the 搂3 names (`owner_id` / `claimed_until`).
    return {
      runId: row.run_id,
      ownerId: row.owner_id,
      generation: Number(row.generation),
      claimedUntil: row.claimed_until,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
    if (row.host_id !== null && row.host_id !== undefined) agent.hostId = row.host_id;
    if (row.last_heartbeat_at !== null && row.last_heartbeat_at !== undefined) {
      agent.lastHeartbeatAt = row.last_heartbeat_at;
    }
    if (row.capacity !== null && row.capacity !== undefined) agent.capacity = Number(row.capacity);
    return agent;
  }

  function integrationJson(row) {
    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      commitSha: row.commit_sha,
      manifestHash: row.manifest_hash,
      ...(row.actor === null || row.actor === undefined ? {} : { actor: row.actor }),
      at: row.at,
    };
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
    if (row.reviewer !== null && row.reviewer !== undefined) review.actor = row.reviewer;
    const evidence = parseJsonColumn(row.evidence_json);
    if (evidence !== null) review.evidence = evidence;
    if (row.submitted_at !== null && row.submitted_at !== undefined) review.submittedAt = row.submitted_at;
    review.assignedTo = row.assigned_to ?? "HUMAN";
    if (row.reviewer_agent_id !== null && row.reviewer_agent_id !== undefined) {
      review.reviewerAgentId = row.reviewer_agent_id;
    }
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
    if (row.decided_at !== null && row.decided_at !== undefined) approval.decidedAt = row.decided_at;
    if (row.decision !== null && row.decision !== undefined) approval.decision = row.decision;
    approval.version = Number(row.version ?? 0);
    return approval;
  }

  function eventJson(row) {    const eventId = row.event_id ?? null;
    return {
      schemaVersion: Number(row.schema_version),
      seq: Number(row.seq),
      projectId: row.project_id ?? null,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      type: row.type,
      payload: parseJsonColumn(row.payload_json) ?? {},
      happenedAt: row.happened_at,
      ...(eventId === null ? { legacy: true } : { eventId }),
      ...(row.session_seq === null || row.session_seq === undefined
        ? {}
        : { sessionSeq: Number(row.session_seq) }),
    };
  }

  /**
   * Shared event pagination (M6): strict afterSeq, ascending seq, limit capped
   * at 1000. Fetches one extra row to compute `hasMore` without a COUNT query.
   */
  function buildEventPage(filters = {}) {
    const normalized = normalizeEventFilters(filters);
    const where = [];
    const params = [];
    if (normalized.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(normalized.projectId);
    }
    if (normalized.aggregateId !== undefined) {
      where.push("aggregate_id = ?");
      params.push(normalized.aggregateId);
    }
    if (normalized.aggregateType !== undefined) {
      where.push("aggregate_type = ?");
      params.push(normalized.aggregateType);
    }
    if (normalized.type !== undefined) {
      where.push("type = ?");
      params.push(normalized.type);
    }
    if (normalized.afterSeq !== undefined) {
      where.push("seq > ?");
      params.push(normalized.afterSeq);
    }
    params.push(normalized.limit + 1);
    const sql = `SELECT * FROM events${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY seq ASC LIMIT ?`;
    const rows = stmt(sql).all(...params);
    const hasMore = rows.length > normalized.limit;
    const items = (hasMore ? rows.slice(0, normalized.limit) : rows).map(eventJson);
    const nextAfterSeq = hasMore ? items[items.length - 1].seq : undefined;
    return { items, hasMore, ...(nextAfterSeq === undefined ? {} : { nextAfterSeq }) };
  }

  /** Insert one event (caller owns the transaction) and return its JSON. */
  function insertEvent(event) {
    const runId = event.aggregateType === "run" ? event.aggregateId : null;
    const result = stmt(
      `INSERT INTO events
         (schema_version, project_id, aggregate_type, aggregate_id, type, payload_json, happened_at,
          run_id, event_id, session_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      EVENT_SCHEMA_VERSION,
      event.projectId,
      event.aggregateType,
      event.aggregateId,
      event.type,
      JSON.stringify(event.payload),
      event.happenedAt,
      runId,
      event.eventId ?? null,
      event.sessionSeq ?? null,
    );
    return eventJson(stmt("SELECT * FROM events WHERE seq = ?").get(Number(result.lastInsertRowid)));
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

  function getRunRow(id) {
    requireId(id, "run.id");
    return stmt("SELECT * FROM runs WHERE id = ?").get(id) ?? null;
  }

  function requireRunRow(id) {
    const row = getRunRow(id);
    if (!row) notFound("run", id);
    return row;
  }

  function getLeaseRow(runId) {
    return stmt("SELECT * FROM run_leases WHERE run_id = ?").get(runId) ?? null;
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

  function getReviewRow(id) {
    requireId(id, "review.id");
    return stmt("SELECT * FROM reviews WHERE id = ?").get(id) ?? null;
  }

  function requireReviewRow(id) {
    const row = getReviewRow(id);
    if (!row) notFound("review", id);
    return row;
  }

  function getApprovalRow(id) {
    requireId(id, "approval.id");
    return stmt("SELECT * FROM approvals WHERE id = ?").get(id) ?? null;
  }

  function requireApprovalRow(id) {
    const row = getApprovalRow(id);
    if (!row) notFound("approval", id);
    return row;
  }

  /**
   * Self-review proxy (Lead ruling, no `tasks.assignee` column): the producer of
   * the reviewed work is the agent of the Run. Prefer an active Run, fall back to
   * the latest Run of the Task. This is only used to forbid self-review; it is
   * never persisted.
   */
  function latestProducerAgentId(taskId) {
    const latest = stmt(
      `SELECT agent_id FROM runs
        WHERE task_id = ? AND status = 'COMPLETED'
        ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1`,
    ).get(taskId);
    return latest ? latest.agent_id : null;
  }

  /**
   * Task transition inside the caller's transaction: validates via the shared
   * state machine and bumps the version with a CAS so a concurrent writer cannot
   * be silently overwritten.
   */
  function transitionTaskInTx(taskId, to, { targetHash } = {}) {
    const row = requireTaskRow(taskId);
    assertTaskTransition(row.status, to);
    const at = nowIso();
    const sets = ["status = ?", "version = version + 1", "updated_at = ?"];
    const params = [to, at];
    if (targetHash !== undefined) {
      sets.push("target_hash = ?");
      params.push(targetHash);
    }
    const result = stmt(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND version = ?`,
    ).run(...params, taskId, Number(row.version));
    if (Number(result.changes) === 0) {
      const fresh = requireTaskRow(taskId);
      fail("TASK_VERSION_CONFLICT", `task "${taskId}" version conflict`, {
        taskId,
        currentVersion: Number(fresh.version),
      });
    }
    return taskJson(requireTaskRow(taskId));
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

    /** JSON -> SQLite switch pre-flight (m6-contracts §1); shared with CLI. */
    verifySwitchReadiness: () => verifySwitchReadiness(guarded),

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
        // M3 scheduling policy (optional, additive to the M1 Project DTO).
        const policy = normalizeProjectPolicy(dto.policy, "project.policy");
        stmt(
          `INSERT INTO projects
             (id, name, repo_path, default_branch, policy_version, version, legacy_json, settings_json,
              policy_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          project.id,
          project.name,
          project.repoPath,
          project.defaultBranch,
          project.policyVersion,
          project.version,
          safeJson(dto.legacy, "project.legacy"),
          safeJson(dto.settings, "project.settings"),
          Object.keys(policy).length > 0 ? safeJson(policy, "project.policy") : null,
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
              acceptance, plan_id, parent_id, version, legacy_json, files_json, target_hash,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          task.files === undefined ? null : JSON.stringify(task.files),
          task.targetHash ?? null,
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
                  acceptance = ?, plan_id = ?, status = ?, files_json = ?, target_hash = ?, version = ?,
                  updated_at = ?
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
          merged.files === undefined ? null : JSON.stringify(merged.files),
          merged.targetHash ?? null,
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

    // --- Run lifecycle (m2-contracts 搂2/搂3) -------------------------------
    /**
     * M6.2 F05: freeze the current Task + project into an immutable
     * TaskExecutionSpec v1. The pending row is bound to the next Run of the
     * Task (or one created with this specHash) and never follows Task edits.
     */
    freezeTaskSpec(taskId, { now, workspace, constraints } = {}) {
      requireId(taskId, "task.id");
      return transaction(() => {
        const taskRow = requireTaskRow(taskId);
        const projectRow = requireProject(taskRow.project_id);
        const { spec, specHash, frozenAt } = buildFrozenExecutionSpec({
          task: taskJson(taskRow),
          project: projectJson(projectRow),
          workspace,
          constraints,
          now,
        });
        stmt("DELETE FROM run_specs WHERE run_id IS NULL AND task_id = ?").run(taskId);
        stmt(
          `INSERT INTO run_specs (run_id, task_id, task_version, spec_json, spec_hash, frozen_at)
           VALUES (NULL, ?, ?, ?, ?, ?)`,
        ).run(taskId, spec.taskVersion, JSON.stringify(spec), specHash, frozenAt);
        return { spec, specHash, frozenAt };
      });
    },

    /** The frozen spec a Run is executing (immutable across Task edits). */
    getRunSpec(runId) {
      requireId(runId, "run.id");
      const row = stmt("SELECT * FROM run_specs WHERE run_id = ?").get(runId);
      if (!row) {
        fail("NOT_FOUND", `run "${runId}" has no frozen spec`, { runId, reason: "spec-not-frozen" });
      }
      return {
        spec: parseJsonColumn(row.spec_json),
        specHash: row.spec_hash,
        frozenAt: row.frozen_at,
        taskId: row.task_id,
        taskVersion: Number(row.task_version),
      };
    },

    createRun(dto) {
      ensurePlainObject(dto, "run");
      return transaction(() => {
        // The task is the anchor of a Run: it must exist (and gives us the
        // projectId the run.created event is streamed under).
        const taskRow = requireTaskRow(dto.taskId);
        const attempt = Number(stmt("SELECT COUNT(*) AS c FROM runs WHERE task_id = ?").get(dto.taskId).c) + 1;
        const run = normalizeRun(dto, { now: nowIso(), attempt, id: dto.id });
        if (getRunRow(run.id)) {
          fail("VALIDATION_ERROR", `run "${run.id}" already exists`, { entity: "run", id: run.id });
        }
        stmt(
          `INSERT INTO runs
             (id, task_id, agent_id, function, status, attempt, started_at, ended_at, error_json,
              version, role, workspace_id, exit_code, files_json, created_at, updated_at,
              workspace_path, base_commit, target_branch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          run.id,
          run.taskId,
          run.agentId,
          run.function,
          run.status,
          run.attempt,
          null,
          null,
          null,
          run.version,
          run.role,
          run.workspaceId ?? null,
          null,
          run.files === undefined ? null : JSON.stringify(run.files),
          run.createdAt,
          run.updatedAt,
          run.workspace?.path ?? null,
          run.workspace?.baseCommit ?? null,
          run.workspace?.targetBranch ?? null,
        );
        // F05: bind the frozen spec from freezeTaskSpec to this Run. The copy is
        // immutable, so later Task edits cannot change what the Run executes.
        const pendingSpec = dto.specHash
          ? stmt(
              "SELECT rowid, * FROM run_specs WHERE run_id IS NULL AND spec_hash = ? ORDER BY frozen_at DESC LIMIT 1",
            ).get(dto.specHash)
          : stmt(
              "SELECT rowid, * FROM run_specs WHERE run_id IS NULL AND task_id = ? ORDER BY frozen_at DESC LIMIT 1",
            ).get(dto.taskId);
        if (pendingSpec) {
          stmt("UPDATE run_specs SET run_id = ? WHERE rowid = ?").run(run.id, pendingSpec.rowid);
        }
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "run",
            aggregateId: run.id,
            type: "run.created",
            payload: {
              runId: run.id,
              taskId: run.taskId,
              agentId: run.agentId,
              function: run.function,
              role: run.role,
              status: run.status,
              attempt: run.attempt,
              version: run.version,
              ...(run.workspaceId === undefined ? {} : { workspaceId: run.workspaceId }),
            },
            now: run.createdAt,
          }),
        );
        return runJson(requireRunRow(run.id));
      });
    },

    /**
     * Advance a Run along the 搂2 state machine. Illegal transitions throw
     * VALIDATION_ERROR + {from,to,allowed}; every legal transition appends one
     * `run.updated` event (the SSE/UI producer). Same-status calls are an
     * idempotent no-op (no version bump, no duplicate event).
     *
     * Optional `generation` (m2-integration): when the caller reports a state
     * change from a Runtime Host, the current lease is checked **inside the same
     * transaction** before any write; a stale generation OR an expired lease
     * throws STALE_GENERATION and leaves status/version/events byte-for-byte
     * unchanged. This makes even a pure state batch (no run.log to append)
     * fenced, without read-then-act. Omitting `generation` keeps the
     * user/tool-facing behaviour unchanged.
     */
    updateRunStatus(id, { status, exitCode, endedAt, generation } = {}) {
      requireId(id, "run.id");
      if (generation !== undefined && generation !== null) {
        if (!Number.isInteger(generation) || generation < 1) {
          fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
        }
      }
      return transaction(() => {
        const now = nowIso();
        if (generation !== undefined && generation !== null) {
          const lease = getLeaseRow(id);
          if (!lease) {
            fail("STALE_GENERATION", `run "${id}" state report is fenced out`, {
              runId: id,
              generation,
              currentGeneration: null,
              reason: "lease-missing",
            });
          }
          if (Number(lease.generation) !== generation) {
            fail("STALE_GENERATION", `run "${id}" state report is fenced out`, {
              runId: id,
              generation,
              currentGeneration: Number(lease.generation),
              reason: "generation-mismatch",
            });
          }
          // QA-003 MAJOR-1: a slow/partitioned host with a *matching but
          // expired* generation must not finish the Run. The lease must still
          // be live; otherwise another host may re-claim it after this write.
          if (lease.claimed_until <= now) {
            fail("STALE_GENERATION", `run "${id}" lease has expired`, {
              runId: id,
              generation,
              currentGeneration: Number(lease.generation),
              claimedUntil: lease.claimed_until,
              reason: "lease-expired",
            });
          }
        }
        const row = requireRunRow(id);
        const current = runJson(row);
        const merge = mergeRunStatus(current, { status, exitCode, endedAt }, { now });
        if (!merge.updated) return current;
        const next = merge.run;
        const result = stmt(
          `UPDATE runs
              SET status = ?, exit_code = ?, started_at = ?, ended_at = ?, version = ?, updated_at = ?
            WHERE id = ? AND version = ?`,
        ).run(
          next.status,
          next.exitCode ?? null,
          next.startedAt ?? null,
          next.endedAt ?? null,
          next.version,
          next.updatedAt,
          id,
          current.version,
        );
        if (Number(result.changes) === 0) {
          const latest = requireRunRow(id);
          fail("VERSION_CONFLICT", `run "${id}" version conflict`, {
            entity: "run",
            id,
            expectedVersion: current.version,
            currentVersion: Number(latest.version),
          });
        }
        const taskRow = requireTaskRow(next.taskId);
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "run",
            aggregateId: id,
            type: "run.updated",
            payload: {
              runId: id,
              taskId: next.taskId,
              status: next.status,
              previousStatus: current.status,
              version: next.version,
              ...(next.exitCode === undefined ? {} : { exitCode: next.exitCode }),
              ...(next.endedAt === undefined ? {} : { endedAt: next.endedAt }),
            },
            now: next.updatedAt,
          }),
        );
        return runJson(requireRunRow(id));
      });
    },

    // --- Durable dispatch commands + leases (ADR-003 / m2-contracts 搂3) ---
    enqueueDispatchCommand({ runId, commandType, payload, idempotencyKey } = {}) {
      const commandTypeValue = validateCommandType(commandType);
      const key = validateIdempotencyKey(idempotencyKey);
      const payloadValue = validateCommandPayload(payload);
      return transaction(() => {
        const run = runJson(requireRunRow(runId));
        const existing = stmt("SELECT * FROM dispatch_commands WHERE idempotency_key = ?").get(key);
        if (existing) return commandJson(existing);
        const id = generateId("CMD");
        const at = nowIso();
        stmt(
          `INSERT INTO dispatch_commands
             (id, task_id, run_id, agent_id, status, idempotency_key, owner_id, generation,
              claimed_until, payload_json, command_type, attempts, result_json, completed_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 'PENDING', ?, NULL, 0, NULL, ?, ?, 0, NULL, NULL, ?, ?)`,
        ).run(
          id,
          run.taskId,
          run.id,
          run.agentId,
          key,
          JSON.stringify(payloadValue),
          commandTypeValue,
          at,
          at,
        );
        return commandJson(stmt("SELECT * FROM dispatch_commands WHERE id = ?").get(id));
      });
    },

    /**
     * Atomically claim the oldest runnable command. BEGIN IMMEDIATE serialises
     * writers across connections, so two hosts (or two processes) can never get
     * the same command: the loser blocks on the write lock and then finds it
     * CLAIMED and not yet expired. Expired claims are re-claimable and bump
     * `attempts`; the lease generation is monotonic across claims so the old
     * holder is fenced out (ADR-003).
     */
    claimDispatchCommand({ ownerId, leaseMs } = {}) {
      const owner = validateOwnerId(ownerId);
      const ttl = validateLeaseMs(leaseMs, { fallback: DEFAULT_LEASE_MS });
      return transaction(() => {
        const now = nowIso();
        const row = stmt(
          `SELECT c.* FROM dispatch_commands c
             JOIN runs r ON r.id = c.run_id
             LEFT JOIN run_leases l ON l.run_id = c.run_id
            WHERE r.status IN ('QUEUED', 'STARTING', 'RUNNING')
              AND (
                    -- fresh command: only when the run has no live lease (a run
                    -- must never have two effective holders; ADR-003)
                    (c.status = 'PENDING' AND (l.run_id IS NULL OR l.claimed_until <= ?))
                    -- abandoned claim: the lease expired and may be re-claimed
                 OR (c.status = 'CLAIMED' AND c.claimed_until IS NOT NULL AND c.claimed_until <= ?)
              )
            ORDER BY c.created_at ASC, c.id ASC
            LIMIT 1`,
        ).get(now, now);
        if (!row) return null;
        const existingLease = getLeaseRow(row.run_id);
        const generation = existingLease === null ? 1 : Number(existingLease.generation) + 1;
        const claimedUntil = leaseExpiryAfter(now, ttl);
        stmt(
          `UPDATE dispatch_commands
              SET status = 'CLAIMED', owner_id = ?, generation = ?, claimed_until = ?,
                  attempts = attempts + 1, updated_at = ?
            WHERE id = ?`,
        ).run(owner, generation, claimedUntil, now, row.id);
        stmt(
          `INSERT INTO run_leases
             (run_id, owner_id, generation, claimed_until, last_heartbeat_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             generation = excluded.generation,
             claimed_until = excluded.claimed_until,
             last_heartbeat_at = excluded.last_heartbeat_at,
             updated_at = excluded.updated_at`,
        ).run(row.run_id, owner, generation, claimedUntil, now, now, now);
        return {
          command: commandJson(stmt("SELECT * FROM dispatch_commands WHERE id = ?").get(row.id)),
          lease: leaseJson(getLeaseRow(row.run_id)),
        };
      });
    },

    /**
     * Persist a command result under generation fencing. A stale generation
     * throws STALE_GENERATION before any write (the row is byte-for-byte
     * unchanged). Repeating the call with the winning generation is idempotent:
     * it returns the stored command and writes no event.
     */
    completeDispatchCommand({ id, ownerId, generation, status, result } = {}) {
      requireId(id, "dispatchCommand.id");
      const owner = validateOwnerId(ownerId);
      if (!Number.isInteger(generation) || generation < 1) {
        fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
      }
      if (status !== "DONE" && status !== "FAILED") {
        fail("VALIDATION_ERROR", "dispatch result status must be DONE or FAILED", {
          status: status ?? null,
          allowed: ["DONE", "FAILED"],
        });
      }
      if (result !== undefined && result !== null && !isPlainObject(result)) {
        fail("VALIDATION_ERROR", "dispatch result must be an object", { resultType: typeof result });
      }
      return transaction(() => {
        const now = nowIso();
        const row = stmt("SELECT * FROM dispatch_commands WHERE id = ?").get(id);
        if (!row) notFound("dispatchCommand", id);
        const stale = (details) => {
          fail("STALE_GENERATION", `dispatch command "${id}" report is fenced out`, {
            commandId: id,
            runId: row.run_id,
            ownerId: owner,
            generation,
            ...details,
          });
        };
        if (row.status === "DONE" || row.status === "FAILED") {
          if (Number(row.generation) === generation && row.owner_id === owner) return commandJson(row);
          stale({
            currentGeneration: Number(row.generation),
            currentOwnerId: row.owner_id,
            reason: "generation-mismatch",
          });
        }
        if (row.status !== "CLAIMED") {
          stale({ currentGeneration: Number(row.generation), reason: "command-not-claimed" });
        }
        const lease = getLeaseRow(row.run_id);
        if (!lease) stale({ currentGeneration: null, reason: "lease-missing" });
        if (Number(lease.generation) !== generation || lease.owner_id !== owner) {
          stale({
            currentGeneration: Number(lease.generation),
            currentOwnerId: lease.owner_id,
            reason: "generation-mismatch",
          });
        }
        // QA-003 MAJOR-1: an expired lease must not be able to finish the
        // command (slow host / GC pause / partition). Checked BEFORE the write
        // that expires the lease itself, so the winning call above still works.
        if (lease.claimed_until <= now) {
          stale({
            currentGeneration: Number(lease.generation),
            claimedUntil: lease.claimed_until,
            reason: "lease-expired",
          });
        }
        // FAILED keeps its error summary in the same result_json column.
        stmt(
          `UPDATE dispatch_commands
              SET status = ?, result_json = ?, completed_at = ?, claimed_until = ?, updated_at = ?
            WHERE id = ?`,
        ).run(status, JSON.stringify(result ?? {}), now, now, now, id);
        // "Release" the lease by EXPIRING it, never by deleting the row: the
        // monotonic generation must survive completion so a later claim of the
        // same run bumps past the finished holder. Deleting would restart the
        // sequence at 1 and let a stale host match again (fencing lost). This is
        // why reconcileRun reports this expired lease instead of null.
        stmt(
          "UPDATE run_leases SET claimed_until = ?, last_heartbeat_at = ?, updated_at = ? WHERE run_id = ?",
        ).run(now, now, now, row.run_id);
        return commandJson(stmt("SELECT * FROM dispatch_commands WHERE id = ?").get(id));
      });
    },

    /**
     * D3 crash-window sweeper (QA-003): a Run can be terminal while its command
     * is still CLAIMED (the Host died before writing the result). The truth is
     * the Run, so close those commands without needing lease/owner: COMPLETED 鈫?     * DONE, FAILED/INTERRUPTED/CANCELLED 鈫?FAILED. Already-terminal commands are
     * untouched (idempotent). Single transaction, one indexed scan.
     */
    sweepDispatchCommands({ now } = {}) {
      let requestedNow = null;
      if (now !== undefined && now !== null) {
        if (typeof now !== "string" || Number.isNaN(Date.parse(now))) {
          fail("VALIDATION_ERROR", "now must be an ISO-8601 timestamp", { now });
        }
        requestedNow = now;
      }
      return transaction(() => {
        const at = requestedNow ?? nowIso();
        const rows = stmt(
          `SELECT c.id AS command_id, c.run_id, r.status AS run_status
             FROM dispatch_commands c JOIN runs r ON r.id = c.run_id
            WHERE c.status = 'CLAIMED'
              AND r.status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')
            ORDER BY c.created_at ASC, c.id ASC`,
        ).all();
        if (rows.length === 0) return { closed: [], count: 0 };
        const updateCommand = stmt(
          `UPDATE dispatch_commands
              SET status = ?, result_json = ?, completed_at = ?, claimed_until = ?, updated_at = ?
            WHERE id = ? AND status = 'CLAIMED'`,
        );
        const expireLease = stmt(
          "UPDATE run_leases SET claimed_until = ?, last_heartbeat_at = ?, updated_at = ? WHERE run_id = ?",
        );
        const closed = [];
        for (const row of rows) {
          const status = row.run_status === "COMPLETED" ? "DONE" : "FAILED";
          const result = { derivedFrom: "run-terminal", runStatus: row.run_status };
          const changes = Number(
            updateCommand.run(status, JSON.stringify(result), at, at, at, row.command_id).changes,
          );
          if (changes === 0) continue; // another connection won the same sweep
          expireLease.run(at, at, at, row.run_id);
          closed.push({ commandId: row.command_id, runId: row.run_id, status });
        }
        return { closed, count: closed.length };
      });
    },

    renewRunLease({ runId, ownerId, generation, leaseMs } = {}) {
      requireId(runId, "run.id");
      const owner = validateOwnerId(ownerId);
      if (!Number.isInteger(generation) || generation < 1) {
        fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
      }
      const ttl = validateLeaseMs(leaseMs, { fallback: DEFAULT_LEASE_MS });
      return transaction(() => {
        const now = nowIso();
        const lease = getLeaseRow(runId);
        const stale = (details) => {
          fail("STALE_GENERATION", `run "${runId}" lease is fenced out`, {
            runId,
            ownerId: owner,
            generation,
            ...details,
          });
        };
        if (!lease) stale({ currentGeneration: null, reason: "lease-missing" });
        if (lease.owner_id !== owner) {
          stale({
            currentGeneration: Number(lease.generation),
            currentHolderId: lease.owner_id,
            reason: "holder-mismatch",
          });
        }
        if (Number(lease.generation) !== generation) {
          stale({ currentGeneration: Number(lease.generation), reason: "generation-mismatch" });
        }
        if (lease.claimed_until <= now) {
          stale({
            currentGeneration: Number(lease.generation),
            claimedUntil: lease.claimed_until,
            reason: "lease-expired",
          });
        }
        const nextGeneration = generation + 1;
        const claimedUntil = leaseExpiryAfter(now, ttl);
        stmt(
          `UPDATE run_leases
              SET generation = ?, claimed_until = ?, last_heartbeat_at = ?, updated_at = ?
            WHERE run_id = ?`,
        ).run(nextGeneration, claimedUntil, now, now, runId);
        // Keep the command's lease window/generation in step so the claim scan
        // never hands a live run to a second host.
        stmt(
          "UPDATE dispatch_commands SET generation = ?, claimed_until = ?, updated_at = ? WHERE run_id = ? AND status = 'CLAIMED'",
        ).run(nextGeneration, claimedUntil, now, runId);
        return leaseJson(getLeaseRow(runId));
      });
    },

    /**
     * Append runtime events under generation fencing. Does NOT advance the Run
     * status (Backend owns that via updateRunStatus, single responsibility).
     * An empty `events` array is a valid *pure fence* call: it proves the caller
     * still holds the current generation without writing anything, which lets
     * Backend order "verify generation 鈫?updateRunStatus" safely.
     * Unknown event types are rejected by contracts.createEvent(), never dropped.
     */
    appendRunEvent({ runId, generation, events } = {}) {
      requireId(runId, "run.id");
      if (!Number.isInteger(generation) || generation < 1) {
        fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
      }
      if (!Array.isArray(events)) {
        fail("VALIDATION_ERROR", "run.events must be an array", { events: events ?? null });
      }
      if (events.length > 1000) {
        fail("VALIDATION_ERROR", "run.events accepts at most 1000 events per call", { length: events.length });
      }
      return transaction(() => {
        const run = runJson(requireRunRow(runId));
        const taskRow = requireTaskRow(run.taskId);
        const now = nowIso();
        const lease = getLeaseRow(runId);
        const stale = (details) => {
          fail("STALE_GENERATION", `run "${runId}" event report is fenced out`, {
            runId,
            generation,
            ...details,
          });
        };
        if (!lease) stale({ currentGeneration: null, reason: "lease-missing" });
        if (Number(lease.generation) !== generation) {
          stale({ currentGeneration: Number(lease.generation), reason: "generation-mismatch" });
        }
        if (lease.claimed_until <= now) {
          stale({
            currentGeneration: Number(lease.generation),
            claimedUntil: lease.claimed_until,
            reason: "lease-expired",
          });
        }
        const inserted = [];
        events.forEach((raw, index) => {
          if (!isPlainObject(raw)) {
            fail("VALIDATION_ERROR", `run.events[${index}] must be an object`, { index });
          }
          if (typeof raw.type !== "string" || raw.type.trim() === "") {
            fail("VALIDATION_ERROR", `run.events[${index}].type is required`, { index });
          }
          const payload = raw.payload ?? {};
          if (!isPlainObject(payload)) {
            fail("VALIDATION_ERROR", `run.events[${index}].payload must be an object`, { index });
          }
          const event = makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "run",
            aggregateId: runId,
            type: raw.type,
            payload,
            now,
          });
          inserted.push(insertEvent(event));
        });
        return inserted;
      });
    },

    /**
     * M6.1 F03/F08: apply one runtime-event batch atomically.
     * Validation happens before the transaction; fencing, dedupe (eventId then
     * legacy composite), Run transitions and event inserts all happen inside a
     * single BEGIN IMMEDIATE. Any failure rolls the whole batch back.
     */
    applyRuntimeEventBatch({ runId, generation, events, now } = {}) {
      requireId(runId, "run.id");
      if (!Number.isInteger(generation) || generation < 1) {
        fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
      }
      const plan = planRuntimeEventBatch({ runId, events });
      return transaction(() => {
        const at = nowIso(now);
        const lease = getLeaseRow(runId);
        const stale = (details) => {
          fail("STALE_GENERATION", `run "${runId}" event report is fenced out`, {
            runId,
            generation,
            ...details,
          });
        };
        if (!lease) stale({ currentGeneration: null, reason: "lease-missing" });
        if (Number(lease.generation) !== generation) {
          stale({ currentGeneration: Number(lease.generation), reason: "generation-mismatch" });
        }
        if (lease.claimed_until <= at) {
          stale({
            currentGeneration: Number(lease.generation),
            claimedUntil: lease.claimed_until,
            reason: "lease-expired",
          });
        }
        const taskRow = requireTaskRow(runJson(requireRunRow(runId)).taskId);
        const seen = new Set(
          stmt("SELECT * FROM events WHERE run_id = ?").all(runId).map((row) => eventDedupeKey(eventJson(row))),
        );
        const batchSeen = new Set();
        let run = runJson(requireRunRow(runId));
        let stateChanged = false;
        let skipped = 0;
        const applied = [];
        for (const entry of plan) {
          const hasEventId = entry.eventId !== null && entry.eventId !== undefined;
          if (seen.has(entry.dedupeKey) || (hasEventId && batchSeen.has(entry.dedupeKey))) {
            skipped += 1;
            continue;
          }
          if (hasEventId) batchSeen.add(entry.dedupeKey);
          if (entry.status !== undefined) {
            if (entry.status === run.status) continue; // idempotent warm start / repeated end
            try {
              assertRunTransition(run.status, entry.status);
            } catch (error) {
              if (error?.code === "VALIDATION_ERROR") {
                fail("VALIDATION_ERROR", `run.events[${entry.index}] has an illegal run transition`, {
                  index: entry.index,
                  field: "type",
                  from: run.status,
                  to: entry.status,
                });
              }
              throw error;
            }
            const current = run;
            const merge = mergeRunStatus(current, {
              status: entry.status,
              exitCode: entry.exitCode,
              endedAt: entry.endedAt,
            }, { now: at });
            if (!merge.updated) continue;
            const next = merge.run;
            const result = stmt(
              `UPDATE runs
                  SET status = ?, exit_code = ?, started_at = ?, ended_at = ?, version = ?, updated_at = ?
                WHERE id = ? AND version = ?`,
            ).run(
              next.status,
              next.exitCode ?? null,
              next.startedAt ?? null,
              next.endedAt ?? null,
              next.version,
              next.updatedAt,
              runId,
              current.version,
            );
            if (Number(result.changes) === 0) {
              const latest = requireRunRow(runId);
              fail("VERSION_CONFLICT", `run "${runId}" version conflict`, {
                entity: "run",
                id: runId,
                expectedVersion: current.version,
                currentVersion: Number(latest.version),
              });
            }
            run = runJson(requireRunRow(runId));
            stateChanged = true;
            applied.push(
              insertEvent(
                makeEvent({
                  projectId: taskRow.project_id,
                  aggregateType: "run",
                  aggregateId: runId,
                  type: "run.updated",
                  payload: {
                    runId,
                    taskId: run.taskId,
                    status: next.status,
                    previousStatus: current.status,
                    version: next.version,
                    sessionId: entry.sessionId ?? undefined,
                    ...(next.exitCode === undefined ? {} : { exitCode: next.exitCode }),
                    ...(next.endedAt === undefined ? {} : { endedAt: next.endedAt }),
                  },
                  eventId: entry.eventId,
                  sessionSeq: entry.sessionSeq,
                  now: at,
                }),
              ),
            );
          }
          if (entry.status === undefined) {
            applied.push(
              insertEvent(
                makeEvent({
                  projectId: taskRow.project_id,
                  aggregateType: "run",
                  aggregateId: runId,
                  type: entry.type,
                  payload: entry.payload,
                  eventId: entry.eventId,
                  sessionSeq: entry.sessionSeq,
                  now: at,
                }),
              ),
            );
          }
        }
        return { ok: true, run, applied, skipped, duplicate: skipped, stateChanged };
      });
    },

    /**
     * Reconcile facts for a restarted Host. `sessions` stays empty until M4.
     */
    reconcileRun({ runId } = {}) {
      requireId(runId, "run.id");
      const run = runJson(requireRunRow(runId));
      const lease = getLeaseRow(runId);
      return { run, lease: lease === null ? null : leaseJson(lease), sessions: [] };
    },

    // --- Scheduling (m3-contracts 搂2: snapshot + atomic claim) ------------
    /**
     * Consistent read model for the Scheduler (it is stateless and rebuilds from
     * this on every round). `version` = MAX(events.seq): every successful
     * claimTask appends task.updated + run.created, so the sequence strictly
     * increases on each claim and a Scheduler can detect a newer snapshot.
     * Read in one transaction so tasks/runs/leases cannot be a torn mix.
     */
    schedulingSnapshot({ projectId } = {}) {
      if (projectId !== undefined && projectId !== null) requireId(projectId, "project.id");
      return transaction(() => {
        const generatedAt = nowIso();
        const version = Number(stmt("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get().seq);
        const projectRows =
          projectId === undefined || projectId === null
            ? stmt("SELECT * FROM projects ORDER BY id ASC").all()
            : stmt("SELECT * FROM projects WHERE id = ?").all(projectId);
        const projects = projectRows.map((row) => {
          const stored = parseJsonColumn(row.policy_json);
          return { id: row.id, policy: isPlainObject(stored) ? stored : {} };
        });
        const tasks = filterTasks({ projectId: projectId ?? undefined, limit: MAX_LIST_LIMIT });
        const agents = store.listAgents();
        const projectFilter = projectId !== undefined && projectId !== null;
        const runRows = projectFilter
          ? stmt(
              `SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
                WHERE t.project_id = ? AND r.status IN ('QUEUED', 'STARTING', 'RUNNING')
                ORDER BY r.created_at ASC, r.id ASC`,
            ).all(projectId)
          : stmt(
              `SELECT * FROM runs WHERE status IN ('QUEUED', 'STARTING', 'RUNNING')
                ORDER BY created_at ASC, id ASC`,
            ).all();
        const leaseRows = projectFilter
          ? stmt(
              `SELECT l.* FROM run_leases l
                 JOIN runs r ON r.id = l.run_id
                 JOIN tasks t ON t.id = r.task_id
                WHERE t.project_id = ? ORDER BY l.run_id ASC`,
            ).all(projectId)
          : stmt("SELECT * FROM run_leases ORDER BY run_id ASC").all();
        return {
          generatedAt,
          version,
          projects,
          tasks,
          agents,
          runs: runRows.map(runJson),
          leases: leaseRows.map(leaseJson),
        };
      });
    },

    /**
     * Atomic task claim (m3-contracts 搂2, 7 ordered checks). Runs in ONE
     * transaction: any failed check (or the CAS losing a race) rolls back to
     * byte-for-byte no change. Same idempotencyKey replays the original result.
     */
    claimTask({ taskId, agentId, expectedTaskVersion, policies, idempotencyKey, workspacePolicy } = {}) {
      requireId(taskId, "task.id");
      requireId(agentId, "agent.id");
      if (!Number.isInteger(expectedTaskVersion) || expectedTaskVersion < 0) {
        fail("VALIDATION_ERROR", "expectedTaskVersion must be a non-negative integer", {
          expectedTaskVersion: expectedTaskVersion ?? null,
        });
      }
      const limits = validateSchedulingPolicies(policies);
      const key = validateIdempotencyKey(idempotencyKey);
      let workspacePolicyValue = null;
      if (workspacePolicy !== undefined && workspacePolicy !== null) {
        if (!isPlainObject(workspacePolicy)) {
          fail("VALIDATION_ERROR", "workspacePolicy must be an object", { value: workspacePolicy });
        }
        workspacePolicyValue = workspacePolicy;
      }
      return transaction(() => {
        // Idempotent replay: the same key returns the original run/command/task
        // even though the task is CLAIMED and its version moved on.
        const existingCommand = stmt("SELECT * FROM dispatch_commands WHERE idempotency_key = ?").get(key);
        if (existingCommand) {
          const existingRun = runJson(requireRunRow(existingCommand.run_id));
          if (existingRun.taskId !== taskId) {
            fail("VALIDATION_ERROR", "idempotencyKey was already used for another task", {
              idempotencyKey: key,
              taskId,
              existingTaskId: existingRun.taskId,
            });
          }
          return {
            run: existingRun,
            command: commandJson(existingCommand),
            task: taskJson(requireTaskRow(taskId)),
          };
        }

        // 1. Task exists, READY, expected version.
        const taskRow = getTaskRow(taskId);
        if (!taskRow) {
          fail("TASK_VERSION_CONFLICT", `task "${taskId}" is not claimable`, {
            taskId,
            currentVersion: null,
            expectedVersion: expectedTaskVersion,
            reason: "task-not-found",
          });
        }
        const task = taskJson(taskRow);
        if (task.status !== "READY") {
          fail("TASK_VERSION_CONFLICT", `task "${taskId}" is not READY`, {
            taskId,
            status: task.status,
            currentVersion: task.version,
            expectedVersion: expectedTaskVersion,
            reason: "not-ready",
          });
        }
        if (task.version !== expectedTaskVersion) {
          fail("TASK_VERSION_CONFLICT", `task "${taskId}" version conflict`, {
            taskId,
            currentVersion: task.version,
            expectedVersion: expectedTaskVersion,
            reason: "version-mismatch",
          });
        }

        // 2. Every dependency must exist and be DONE (missing = not done).
        const blockingTaskIds = task.deps.filter((dep) => {
          const depRow = getTaskRow(dep);
          return !depRow || depRow.status !== "DONE";
        });
        if (blockingTaskIds.length > 0) {
          fail("TASK_DEPENDENCY_BLOCKED", `task "${taskId}" has unfinished dependencies`, {
            taskId,
            blockingTaskIds,
          });
        }

        // 3. Agent exists, IDLE, role/Function match the task.
        const agentRow = stmt("SELECT * FROM agent_instances WHERE id = ?").get(agentId);
        if (!agentRow) {
          fail("CAPABILITY_UNAVAILABLE", `agent "${agentId}" is not registered`, {
            reason: "agent-not-found",
            agentId,
            taskId,
          });
        }
        const agent = agentJson(agentRow);
        if (agent.status !== "IDLE") {
          fail("CAPABILITY_UNAVAILABLE", `agent "${agentId}" is not IDLE`, {
            reason: "agent-not-idle",
            agentId,
            status: agent.status,
            taskId,
          });
        }
        if (agent.role !== task.roleRequired) {
          fail("CAPABILITY_UNAVAILABLE", `agent "${agentId}" has the wrong role`, {
            reason: "role-mismatch",
            agentId,
            agentRole: agent.role,
            roleRequired: task.roleRequired,
            taskId,
          });
        }
        if (!agent.capabilities.includes(task.functionRequired)) {
          fail("CAPABILITY_UNAVAILABLE", `agent "${agentId}" lacks the required Function`, {
            reason: "function-mismatch",
            agentId,
            capabilities: agent.capabilities,
            functionRequired: task.functionRequired,
            taskId,
          });
        }

        // 4. At most one active Run per task.
        const activeRun = stmt(
          "SELECT id FROM runs WHERE task_id = ? AND status IN ('QUEUED', 'STARTING', 'RUNNING') ORDER BY created_at DESC LIMIT 1",
        ).get(taskId);
        if (activeRun) {
          fail("TASK_VERSION_CONFLICT", `task "${taskId}" already has an active run`, {
            taskId,
            currentVersion: task.version,
            expectedVersion: expectedTaskVersion,
            activeRunId: activeRun.id,
            reason: "active-run",
          });
        }

        // 5. Capacity (limits travel with the claim; absent = unchecked).
        if (limits.maxConcurrentPerProject !== undefined) {
          const projectActive = Number(
            stmt(
              `SELECT COUNT(*) AS c FROM runs r JOIN tasks t ON t.id = r.task_id
                WHERE t.project_id = ? AND r.status IN ('QUEUED', 'STARTING', 'RUNNING')`,
            ).get(task.projectId).c,
          );
          if (projectActive + 1 > limits.maxConcurrentPerProject) {
            fail("CAPABILITY_UNAVAILABLE", "project concurrency capacity reached", {
              reason: "capacity",
              scope: "project",
              projectId: task.projectId,
              active: projectActive,
              limit: limits.maxConcurrentPerProject,
              taskId,
            });
          }
        }
        if (limits.maxPerAgent !== undefined) {
          const agentActive = Number(
            stmt(
              `SELECT COUNT(*) AS c FROM runs
                WHERE agent_id = ? AND status IN ('QUEUED', 'STARTING', 'RUNNING')`,
            ).get(agentId).c,
          );
          if (agentActive + 1 > limits.maxPerAgent) {
            fail("CAPABILITY_UNAVAILABLE", "agent concurrency capacity reached", {
              reason: "capacity",
              scope: "agent",
              agentId,
              active: agentActive,
              limit: limits.maxPerAgent,
              taskId,
            });
          }
        }

        // 6. Write-scope conflict with active runs of the same project (run
        //    files are snapshotted from the task at claim time; fall back to the
        //    run's task files for rows written before this snapshot existed).
        const candidateFiles = task.files ?? [];
        if (candidateFiles.length > 0) {
          const activeRunRows = stmt(
            `SELECT r.id AS run_id, COALESCE(r.files_json, t.files_json) AS files_json
               FROM runs r JOIN tasks t ON t.id = r.task_id
              WHERE t.project_id = ? AND r.status IN ('QUEUED', 'STARTING', 'RUNNING')`,
          ).all(task.projectId);
          const conflictFiles = [];
          const conflictRunIds = [];
          for (const row of activeRunRows) {
            const files = parseJsonColumn(row.files_json);
            if (!Array.isArray(files)) continue;
            const overlap = filesIntersection(candidateFiles, files);
            if (overlap.length > 0) {
              conflictFiles.push(...overlap);
              conflictRunIds.push(row.run_id);
            }
          }
          if (conflictRunIds.length > 0) {
            fail("CAPABILITY_UNAVAILABLE", `task "${taskId}" write scope conflicts with an active run`, {
              reason: "write-scope-conflict",
              taskId,
              files: [...new Set(conflictFiles)].sort((a, b) => a.localeCompare(b)),
              activeRunIds: [...new Set(conflictRunIds)].sort((a, b) => a.localeCompare(b)),
            });
          }
        }

        // 7. Commit: CAS task -> CLAIMED, run (STARTING), durable command, events.
        if (!canTransition(task.status, "CLAIMED")) {
          fail("VALIDATION_ERROR", `task.status cannot transition from ${task.status} to CLAIMED`, {
            from: task.status,
            to: "CLAIMED",
            allowed: ["CLAIMED"],
          });
        }
        const at = nowIso();
        const update = stmt(
          "UPDATE tasks SET status = 'CLAIMED', version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'READY'",
        ).run(at, taskId, expectedTaskVersion);
        if (Number(update.changes) === 0) {
          const latest = getTaskRow(taskId);
          fail("TASK_VERSION_CONFLICT", `task "${taskId}" was claimed concurrently`, {
            taskId,
            currentVersion: latest ? Number(latest.version) : null,
            expectedVersion: expectedTaskVersion,
            reason: "cas-lost",
          });
        }
        const run = store.createRun({
          taskId,
          agentId,
          function: task.functionRequired,
          role: task.roleRequired,
          files: candidateFiles,
        });
        const command = store.enqueueDispatchCommand({
          runId: run.id,
          commandType: "RUN_TASK",
          payload: {
            taskId,
            agentId,
            functionRequired: task.functionRequired,
            roleRequired: task.roleRequired,
            workspacePolicy: workspacePolicyValue,
            files: candidateFiles,
          },
          idempotencyKey: key,
        });
        insertEvent(
          makeEvent({
            projectId: task.projectId,
            aggregateType: "task",
            aggregateId: taskId,
            type: "task.updated",
            payload: {
              taskId,
              status: "CLAIMED",
              previousStatus: "READY",
              version: task.version + 1,
              runId: run.id,
              agentId,
            },
            now: at,
          }),
        );
        return { run, command, task: taskJson(requireTaskRow(taskId)) };
      });
    },

    listAgents() {
      return stmt("SELECT * FROM agent_instances ORDER BY id ASC").all().map(agentJson);
    },

    /** M6.2 F10: host heartbeat updates every listed agent's liveness + capacity. */
    recordHeartbeat({ hostId, agentIds, capacity, now } = {}) {
      if (typeof hostId !== "string" || hostId.trim() === "") {
        fail("VALIDATION_ERROR", "heartbeat.hostId is required", { field: "hostId" });
      }
      if (!Array.isArray(agentIds) || agentIds.length === 0) {
        fail("VALIDATION_ERROR", "heartbeat.agentIds must be a non-empty array", { field: "agentIds" });
      }
      if (!Number.isInteger(capacity) || capacity < 0) {
        fail("VALIDATION_ERROR", "heartbeat.capacity must be a non-negative integer", { field: "capacity" });
      }
      const at = nowIso(now);
      return transaction(() => {
        for (const agentId of agentIds) {
          requireId(agentId, "agent.id");
          const result = stmt(
            `UPDATE agent_instances
                SET host_id = ?, last_heartbeat_at = ?, capacity = ?, updated_at = ?
              WHERE id = ?`,
          ).run(hostId, at, capacity, at, agentId);
          if (Number(result.changes) === 0) notFound("agent", agentId);
        }
        return { hostId, agentIds: [...agentIds], capacity, at };
      });
    },

    /**
     * F10: availability comes from a fresh heartbeat + capacity, NEVER from
     * `status === "IDLE"`. With no agentId this is the project-wide gate.
     */
    agentAvailability({ agentId, now, ttlMs = DEFAULT_HEARTBEAT_TTL_MS } = {}) {
      if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
        fail("VALIDATION_ERROR", "agentAvailability.ttlMs must be a positive integer", { ttlMs });
      }
      const at = nowIso(now);
      const rows = agentId === undefined || agentId === null
        ? stmt("SELECT * FROM agent_instances").all()
        : [stmt("SELECT * FROM agent_instances WHERE id = ?").get(agentId)].filter(Boolean);
      if (rows.length === 0) return { available: false, reason: "no-heartbeat" };
      const withHeartbeat = rows.filter(
        (row) => row.last_heartbeat_at !== null && row.last_heartbeat_at !== undefined,
      );
      if (withHeartbeat.length === 0) return { available: false, reason: "no-heartbeat" };
      const fresh = withHeartbeat.filter(
        (row) => Date.parse(row.last_heartbeat_at) + ttlMs >= Date.parse(at),
      );
      if (fresh.length === 0) return { available: false, reason: "stale-heartbeat" };
      if (!fresh.some((row) => Number(row.capacity ?? 0) > 0)) {
        return { available: false, reason: "no-capacity" };
      }
      return { available: true, reason: "ok" };
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

    getReview(id) {
      return reviewJson(requireReviewRow(id));
    },

    listReviews({ taskId, status, limit } = {}) {
      const where = [];
      const params = [];
      if (taskId !== undefined && taskId !== null) {
        requireId(taskId, "review.taskId");
        where.push("task_id = ?");
        params.push(taskId);
      }
      if (status !== undefined && status !== null) {
        assertEnumFilter("review", status);
        where.push("status = ?");
        params.push(status);
      }
      const capped = normalizeLimit(limit, { fallback: 50, max: 100 });
      const sql = `SELECT * FROM reviews${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`;
      return stmt(sql).all(...params, capped).map(reviewJson);
    },

    /**
     * M6.1 F11: filter first, then keyset-paginate. `cursor` is opaque
     * base64url("<createdAt>|<id>"); `listReviews` stays array-compatible.
     */
    listReviewsPage({ taskId, status, limit, cursor } = {}) {
      const where = [];
      const params = [];
      if (taskId !== undefined && taskId !== null) {
        requireId(taskId, "review.taskId");
        where.push("task_id = ?");
        params.push(taskId);
      }
      if (status !== undefined && status !== null) {
        assertEnumFilter("review", status);
        where.push("status = ?");
        params.push(status);
      }
      if (cursor !== undefined && cursor !== null && cursor !== "") {
        let decoded;
        try {
          decoded = Buffer.from(String(cursor), "base64url").toString("utf8");
        } catch {
          decoded = "";
        }
        const split = decoded.lastIndexOf("|");
        const createdAt = split > 0 ? decoded.slice(0, split) : "";
        const id = split > 0 ? decoded.slice(split + 1) : "";
        if (!createdAt || !ID_RE.test(id) || Number.isNaN(Date.parse(createdAt))) {
          fail("VALIDATION_ERROR", "review.cursor is invalid", { field: "cursor", cursor });
        }
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(createdAt, createdAt, id);
      }
      const capped = normalizeLimit(limit, { fallback: 50, max: 100 });
      const sql = `SELECT * FROM reviews${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`;
      const rows = stmt(sql).all(...params, capped + 1);
      const hasMore = rows.length > capped;
      const items = rows.slice(0, capped).map(reviewJson);
      const last = items.at(-1);
      return {
        items,
        hasMore,
        ...(hasMore && last
          ? { nextCursor: Buffer.from(`${last.createdAt}|${last.id}`, "utf8").toString("base64url") }
          : {}),
      };
    },

    createReview(dto = {}) {
      ensurePlainObject(dto, "review");
      requireId(dto.taskId, "review.taskId");
      if (dto.actor !== undefined && dto.actor !== null) validateActor(dto.actor, "review.actor");
      return transaction(() => {
        const taskRow = getTaskRow(dto.taskId);
        if (!taskRow) {
          fail("TASK_VERSION_CONFLICT", `task "${dto.taskId}" is not reviewable`, {
            taskId: dto.taskId,
            currentVersion: null,
            reason: "task-not-found",
          });
        }
        const needsTransition = taskRow.status !== "REVIEWING";
        let producerAgentId = null;
        if (needsTransition) {
          // M6.1 F06: a review needs a COMPLETED Run for THIS task.
          let runRow = null;
          if (dto.runId !== undefined && dto.runId !== null) {
            requireId(dto.runId, "review.runId");
            runRow = getRunRow(dto.runId);
            if (!runRow || runRow.task_id !== taskRow.id) {
              fail("VALIDATION_ERROR", `run "${dto.runId}" does not belong to task "${taskRow.id}"`, {
                runId: dto.runId,
                taskId: taskRow.id,
              });
            }
          } else {
            runRow = stmt(
              "SELECT * FROM runs WHERE task_id = ? AND status = 'COMPLETED' ORDER BY updated_at DESC, id DESC LIMIT 1",
            ).get(taskRow.id);
          }
          if (!runRow || runRow.status !== "COMPLETED") {
            fail("VALIDATION_ERROR", "task has no COMPLETED run to review", {
              taskId: taskRow.id,
              reason: "no-completed-run",
            });
          }
          if (!["RUNNING", "CLAIMED"].includes(taskRow.status)) {
            fail("TASK_VERSION_CONFLICT", `task "${dto.taskId}" is not reviewable`, {
              taskId: dto.taskId,
              status: taskRow.status,
              currentVersion: Number(taskRow.version),
              reason: "not-reviewable",
            });
          }
          producerAgentId = runRow.agent_id;
          if (dto.assignedTo === "AGENT" && dto.reviewerAgentId) {
            if (canonicalAgentId(dto.reviewerAgentId) === canonicalAgentId(producerAgentId)) {
              fail("SELF_REVIEW_FORBIDDEN", "a reviewer cannot review their own work", {
                taskId: taskRow.id,
                assignedAgentId: producerAgentId,
                presentedAgentId: dto.reviewerAgentId,
              });
            }
          }
        }
        if (dto.runId !== undefined && dto.runId !== null) {
          requireId(dto.runId, "review.runId");
          const runRow = getRunRow(dto.runId);
          if (!runRow) {
            fail("VALIDATION_ERROR", `run "${dto.runId}" does not exist`, { entity: "run", id: dto.runId });
          }
          if (runRow.task_id !== taskRow.id) {
            fail("VALIDATION_ERROR", `run "${dto.runId}" does not belong to task "${taskRow.id}"`, {
              runId: dto.runId,
              taskId: taskRow.id,
              runTaskId: runRow.task_id,
            });
          }
        }
        const active = stmt(
          "SELECT * FROM reviews WHERE task_id = ? AND status = 'PENDING' ORDER BY created_at DESC, id DESC LIMIT 1",
        ).get(taskRow.id);
        if (active) {
          fail("TASK_VERSION_CONFLICT", `task "${taskRow.id}" already has an active review`, {
            taskId: taskRow.id,
            reviewId: active.id,
            status: active.status,
            reason: "review-exists",
          });
        }
        const nextAttempt =
          Number(
            stmt("SELECT COUNT(*) AS count FROM reviews WHERE task_id = ?").get(taskRow.id).count,
          ) + 1;
        const at = nowIso();
        const { review } = normalizeReview(
          {
            taskId: dto.taskId,
            runId: dto.runId ?? (needsTransition ? undefined : undefined),
            actor: dto.actor,
            reviewerAgentId: dto.reviewerAgentId,
            assignedTo: dto.assignedTo,
            createdByRole: dto.createdByRole,
          },
          { now: at, attempt: nextAttempt },
        );
        stmt(
          `INSERT INTO reviews
             (id, task_id, run_id, status, verdict, manifest_hash, commit_sha, findings_json, attempt,
              version, reviewer, evidence_json, submitted_at, created_at, updated_at,
              reviewer_agent_id, assigned_to)
           VALUES (?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?)`,
        ).run(
          review.id,
          review.taskId,
          review.runId ?? null,
          review.attempt,
          at,
          at,
          review.reviewerAgentId ?? null,
          review.assignedTo ?? "HUMAN",
        );
        stmt(
          `INSERT INTO review_attempts
             (id, review_id, run_id, attempt, status, verdict, manifest_hash, findings_json,
              evidence_json, created_at)
           VALUES (?, ?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL, ?)`,
        ).run(generateId("RVA"), review.id, review.runId ?? null, review.attempt, at);
        if (needsTransition) {
          const previousStatus = taskRow.status;
          transitionTaskInTx(taskRow.id, "REVIEWING");
          insertEvent(
            makeEvent({
              projectId: taskRow.project_id,
              aggregateType: "task",
              aggregateId: taskRow.id,
              type: "task.updated",
              payload: { taskId: taskRow.id, status: "REVIEWING", previousStatus, reviewId: review.id },
              now: at,
            }),
          );
        }
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "review",
            aggregateId: review.id,
            type: "review.requested",
            payload: { taskId: review.taskId, reviewId: review.id, attempt: review.attempt },
            now: at,
          }),
        );
        return reviewJson(requireReviewRow(review.id));
      });
    },

    submitReview({
      id,
      expectedVersion,
      verdict,
      manifestHash,
      commitSha,
      findings,
      evidence,
      actor,
      reviewerAgentId,
      targetHash,
    } = {}) {
      requireId(id, "review.id");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        fail("VALIDATION_ERROR", "expectedVersion must be a non-negative integer", { expectedVersion });
      }
      return transaction(() => {
        const row = requireReviewRow(id);
        if (Number(row.version) !== expectedVersion) {
          fail("VERSION_CONFLICT", `review "${id}" version conflict`, {
            entity: "review",
            id,
            expectedVersion,
            currentVersion: Number(row.version),
          });
        }
        if (row.status !== "PENDING") {
          fail("REVIEW_INVALIDATED", `review "${id}" is not pending`, {
            reviewId: id,
            taskId: row.task_id,
            status: row.status,
          });
        }
        if ((row.assigned_to ?? "HUMAN") === "AGENT") {
          const assigned = row.reviewer_agent_id ?? null;
          const presented = typeof reviewerAgentId === "string" ? reviewerAgentId : null;
          if (!presented || !assigned || canonicalAgentId(presented) !== canonicalAgentId(assigned)) {
            fail("SELF_REVIEW_FORBIDDEN", "review must be submitted by its assigned reviewer", {
              reviewId: id,
              taskId: row.task_id,
              assignedAgentId: assigned,
              presentedAgentId: presented,
            });
          }
        }
        const taskRow = requireTaskRow(row.task_id);
        // QA-005: compare producer identity on canonical ids (trim + casefold)
        // BEFORE actor-shape validation, so a whitespace/case variant of the
        // author is still explicitly 403 SELF_REVIEW_FORBIDDEN instead of merely
        // "invalid". The stored/displayed actor keeps the caller's spelling.
        const rawActor = typeof actor === "string" ? actor : "";
        const canonicalActor = canonicalAgentId(rawActor);
        const authors = new Map();
        // Author = the Run under review (`review.runId`). Legacy rows without a
        // runId fall back to the latest COMPLETED producer; never an active Run.
        let producerAgentId = null;
        if (row.run_id !== null && row.run_id !== undefined) {
          const producerRow = getRunRow(row.run_id);
          if (producerRow) producerAgentId = producerRow.agent_id;
        }
        if (!producerAgentId) producerAgentId = latestProducerAgentId(row.task_id);
        if (!producerAgentId) {
          fail("VALIDATION_ERROR", "cannot resolve the reviewed producer Run", {
            reviewId: id,
            taskId: row.task_id,
            reason: "review-run-unknown",
          });
        }
        authors.set(canonicalAgentId(producerAgentId), producerAgentId);
        if (canonicalActor !== "" && authors.has(canonicalActor)) {
          fail("SELF_REVIEW_FORBIDDEN", "an actor cannot review their own work", {
            actor: rawActor,
            authorAgentId: authors.get(canonicalActor),
            taskId: row.task_id,
            reviewId: id,
          });
        }
        const current = reviewJson(row);
        const next = applyReviewVerdict(
          current,
          { verdict, manifestHash, commitSha, findings, evidence, actor },
          { now: nowIso() },
        );
        // PASS binds the Task to the reviewed candidate hash (QA-005): the
        // approval can only ever succeed against this same hash. An explicit
        // targetHash wins; otherwise the manifestHash is the candidate identity.
        let passTargetHash;
        if (verdict === "PASS") {
          passTargetHash =
            targetHash !== undefined && targetHash !== null
              ? validateTargetHash(targetHash, "review.targetHash")
              : next.manifestHash;
        }
        const taskTo = verdict === "PASS" ? "INTEGRATING" : verdict === "CHANGES_REQUESTED" ? "REJECTED" : "BLOCKED";
        const task = transitionTaskInTx(
          row.task_id,
          taskTo,
          verdict === "PASS" ? { targetHash: passTargetHash } : undefined,
        );
        stmt(
          `UPDATE reviews
              SET status = ?, verdict = ?, manifest_hash = ?, commit_sha = ?, findings_json = ?,
                  evidence_json = ?, reviewer = ?, submitted_at = ?, version = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          next.status,
          next.verdict,
          next.manifestHash ?? null,
          next.commitSha ?? null,
          next.findings === undefined ? null : JSON.stringify(next.findings),
          next.evidence === undefined ? null : JSON.stringify(next.evidence),
          next.reviewer,
          next.submittedAt,
          next.version,
          next.updatedAt,
          id,
        );
        stmt(
          `UPDATE review_attempts
              SET status = ?, verdict = ?, manifest_hash = ?, findings_json = ?, evidence_json = ?
            WHERE review_id = ? AND attempt = ?`,
        ).run(
          next.status,
          next.verdict,
          next.manifestHash ?? null,
          next.findings === undefined ? null : JSON.stringify(next.findings),
          next.evidence === undefined ? null : JSON.stringify(next.evidence),
          id,
          Number(row.attempt),
        );
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "review",
            aggregateId: id,
            type: "review.updated",
            payload: {
              taskId: row.task_id,
              reviewId: id,
              status: next.status,
              verdict: next.verdict,
              actor: next.reviewer,
              attempt: Number(row.attempt),
              ...(passTargetHash === undefined ? {} : { targetHash: passTargetHash }),
            },
            now: next.updatedAt,
          }),
        );
        return { review: reviewJson(requireReviewRow(id)), task };
      });
    },

    reworkTask({ taskId, reviewId, reason, actor, maxAttempts } = {}) {
      requireId(taskId, "task.id");
      requireId(reviewId, "review.id");
      if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
        fail("VALIDATION_ERROR", "maxAttempts must be a positive integer", { maxAttempts });
      }
      const limit = maxAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
      const reviewer = validateActor(actor, "review.actor");
      const outcome = transaction(() => {
        const taskRow = requireTaskRow(taskId);
        const reviewRow = getReviewRow(reviewId);
        if (!reviewRow) notFound("review", reviewId);
        if (reviewRow.task_id !== taskId) {
          fail("VALIDATION_ERROR", "review does not belong to the task", { taskId, reviewId });
        }
        if (reviewRow.status !== "CHANGES_REQUESTED") {
          fail("REVIEW_INVALIDATED", `review "${reviewId}" is not CHANGES_REQUESTED`, {
            reviewId,
            taskId,
            status: reviewRow.status,
          });
        }
        if (taskRow.status !== "REJECTED") {
          fail("TASK_VERSION_CONFLICT", `task "${taskId}" is not REJECTED`, {
            taskId,
            status: taskRow.status,
            currentVersion: Number(taskRow.version),
            reason: "not-rejected",
          });
        }
        const at = nowIso();
        const nextAttempt = Number(reviewRow.attempt) + 1;
        if (nextAttempt > limit) {
          const task = transitionTaskInTx(taskId, "BLOCKED");
          stmt("UPDATE reviews SET status = 'BLOCKED', version = version + 1, updated_at = ? WHERE id = ?").run(
            at,
            reviewId,
          );
          insertEvent(
            makeEvent({
              projectId: taskRow.project_id,
              aggregateType: "review",
              aggregateId: reviewId,
              type: "review.updated",
              payload: {
                taskId,
                reviewId,
                status: "BLOCKED",
                verdict: "CHANGES_REQUESTED",
                actor: reviewer,
                attempt: nextAttempt,
                reason: reason ?? null,
              },
              now: at,
            }),
          );
          insertEvent(
            makeEvent({
              projectId: taskRow.project_id,
              aggregateType: "task",
              aggregateId: taskId,
              type: "task.updated",
              payload: {
                taskId,
                status: "BLOCKED",
                previousStatus: "REJECTED",
                reason: "rework-limit",
                attempt: nextAttempt,
              },
              now: at,
            }),
          );
          return {
            limitReached: true,
            review: reviewJson(requireReviewRow(reviewId)),
            task,
            attempt: nextAttempt,
          };
        }
        const task = transitionTaskInTx(taskId, "READY");
        // QA-005: do NOT insert a new review_attempts row here. The next round's
        // attempt row is created by the next createReview (attempt = number of
        // review rows for this Task + 1), so a Task can never have two rows for
        // the same attempt number. The finished review keeps its own attempt.
        stmt("UPDATE reviews SET version = version + 1, updated_at = ? WHERE id = ?").run(at, reviewId);
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "review",
            aggregateId: reviewId,
            type: "review.updated",
            payload: {
              taskId,
              reviewId,
              status: "CHANGES_REQUESTED",
              verdict: "CHANGES_REQUESTED",
              actor: reviewer,
              attempt: nextAttempt,
              reason: reason ?? null,
            },
            now: at,
          }),
        );
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "task",
            aggregateId: taskId,
            type: "task.updated",
            payload: {
              taskId,
              status: "READY",
              previousStatus: "REJECTED",
              reason: "rework",
              attempt: nextAttempt,
            },
            now: at,
          }),
        );
        return { review: reviewJson(requireReviewRow(reviewId)), task, attempt: nextAttempt };
      });
      if (outcome.limitReached) {
        fail("REWORK_LIMIT_REACHED", `task "${taskId}" exhausted its rework budget`, {
          taskId,
          attempt: outcome.attempt,
          maxAttempts: limit,
        });
      }
      return outcome;
    },

    listApprovals({ taskId, status, limit } = {}) {
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
      const capped = normalizeLimit(limit, { fallback: 50, max: 100 });
      const sql = `SELECT * FROM approvals${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`;
      return stmt(sql).all(...params, capped).map(approvalJson);
    },

    createApproval(dto = {}) {
      ensurePlainObject(dto, "approval");
      return transaction(() => {
        requireId(dto.taskId, "approval.taskId");
        const taskRow = getTaskRow(dto.taskId);
        if (!taskRow) notFound("task", dto.taskId);
        if (taskRow.status !== "AWAITING_ACCEPTANCE") {
          fail("TASK_VERSION_CONFLICT", `task "${dto.taskId}" is not AWAITING_ACCEPTANCE`, {
            taskId: dto.taskId,
            status: taskRow.status,
            currentVersion: Number(taskRow.version),
            reason: "not-awaiting-acceptance",
          });
        }
        const approval = normalizeApproval(
          { ...dto, projectId: taskRow.project_id, taskId: taskRow.id, status: dto.status ?? "PENDING" },
          { now: nowIso() },
        );
        stmt(
          `INSERT INTO approvals
             (id, project_id, task_id, scope, target_hash, actor, status, decision, decided_at, version,
              at, legacy_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
        ).run(
          approval.id,
          approval.projectId ?? null,
          approval.taskId ?? null,
          approval.scope,
          approval.targetHash,
          approval.actor,
          approval.status,
          approval.at,
          safeJson(dto.legacy, "approval.legacy"),
          approval.createdAt,
        );
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "approval",
            aggregateId: approval.id,
            type: "approval.recorded",
            payload: {
              taskId: taskRow.id,
              approvalId: approval.id,
              status: approval.status,
              targetHash: approval.targetHash,
              actor: approval.actor,
            },
            now: approval.createdAt,
          }),
        );
        return approvalJson(requireApprovalRow(approval.id));
      });
    },

    /**
     * M6.1 F01: persist integration evidence and advance INTEGRATING ->
     * AWAITING_ACCEPTANCE in one transaction. (taskId, manifestHash) is
     * idempotent; a hash that does not match task.target_hash is APPROVAL_STALE.
     */
    recordIntegration({ taskId, runId, commitSha, manifestHash, actor } = {}) {
      requireId(taskId, "integration.taskId");
      requireId(runId, "integration.runId");
      if (typeof commitSha !== "string" || !/^[0-9a-fA-F]{7,64}$/.test(commitSha)) {
        fail("VALIDATION_ERROR", "integration.commitSha must be a git commit sha", { commitSha });
      }
      const manifest = validateTargetHash(manifestHash, "integration.manifestHash");
      const actorValue = actor === undefined || actor === null ? null : validateActor(actor, "integration.actor");
      return transaction(() => {
        const taskRow = requireTaskRow(taskId);
        const runRow = getRunRow(runId);
        if (!runRow) notFound("run", runId);
        if (runRow.task_id !== taskId) {
          fail("VALIDATION_ERROR", `run "${runId}" does not belong to task "${taskId}"`, { runId, taskId });
        }
        const existing = stmt(
          "SELECT * FROM integrations WHERE task_id = ? AND manifest_hash = ?",
        ).get(taskId, manifest);
        if (existing) {
          return { integration: integrationJson(existing), task: taskJson(requireTaskRow(taskId)) };
        }
        if (taskRow.target_hash === null || taskRow.target_hash === undefined || taskRow.target_hash !== manifest) {
          fail("APPROVAL_STALE", "integration manifestHash does not match task.target_hash", {
            taskId,
            manifestHash: manifest,
            targetHash: taskRow.target_hash ?? null,
          });
        }
        if (taskRow.status !== "INTEGRATING") {
          fail("TASK_VERSION_CONFLICT", `task "${taskId}" is not INTEGRATING`, {
            taskId,
            status: taskRow.status,
            currentVersion: Number(taskRow.version),
            reason: "not-integrating",
          });
        }
        const at = nowIso();
        const id = generateId("INT");
        stmt(
          `INSERT INTO integrations (id, task_id, run_id, commit_sha, manifest_hash, actor, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, taskId, runId, commitSha, manifest, actorValue, at);
        const task = transitionTaskInTx(taskId, "AWAITING_ACCEPTANCE");
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "task",
            aggregateId: taskId,
            type: "task.updated",
            payload: {
              taskId,
              status: "AWAITING_ACCEPTANCE",
              previousStatus: "INTEGRATING",
              reason: "integration",
              integrationId: id,
              runId,
              manifestHash: manifest,
            },
            now: at,
          }),
        );
        return { integration: integrationJson(stmt("SELECT * FROM integrations WHERE id = ?").get(id)), task };
      });
    },

    decideApproval({ id, decision: rawDecision, actor, targetHash } = {}) {
      requireId(id, "approval.id");
      const decision = validateApprovalDecision(rawDecision);
      const reviewer = validateActor(actor, "approval.actor");
      const receivedTargetHash = validateTargetHash(targetHash, "approval.targetHash");
      return transaction(() => {
        const row = requireApprovalRow(id);
        if (row.status !== "PENDING") {
          fail("REVIEW_INVALIDATED", `approval "${id}" is not pending`, {
            approvalId: id,
            taskId: row.task_id,
            status: row.status,
          });
        }
        const taskRow = requireTaskRow(row.task_id);
        if (taskRow.status !== "AWAITING_ACCEPTANCE") {
          fail("TASK_VERSION_CONFLICT", `task "${row.task_id}" is not AWAITING_ACCEPTANCE`, {
            taskId: row.task_id,
            status: taskRow.status,
            currentVersion: Number(taskRow.version),
            reason: "not-awaiting-acceptance",
          });
        }
        if (receivedTargetHash !== row.target_hash) {
          fail("APPROVAL_STALE", `approval "${id}" is bound to a different target`, {
            approvalId: id,
            taskId: row.task_id,
            expectedTargetHash: row.target_hash,
            receivedTargetHash,
          });
        }
        if (taskRow.target_hash !== null && taskRow.target_hash !== undefined && taskRow.target_hash !== receivedTargetHash) {
          fail("APPROVAL_STALE", `task "${row.task_id}" moved to a different target`, {
            approvalId: id,
            taskId: row.task_id,
            expectedTargetHash: taskRow.target_hash,
            receivedTargetHash,
          });
        }
        const at = nowIso();
        // m4-contracts 搂1 line 50 + Lead ruling: a rejected acceptance re-queues
        // the Task directly (AWAITING_ACCEPTANCE -> READY). It must NOT go
        // through Task.REJECTED: that state means "review requested changes" and
        // can only be left by reworkTask (which requires a CHANGES_REQUESTED
        // Review), while an acceptance rejection happens with a PASS Review.
        const taskTo = decision === "APPROVED" ? "DONE" : "READY";
        const task = transitionTaskInTx(row.task_id, taskTo);
        if (decision === "REJECTED") {
          insertEvent(
            makeEvent({
              projectId: taskRow.project_id,
              aggregateType: "task",
              aggregateId: row.task_id,
              type: "task.updated",
              payload: {
                taskId: row.task_id,
                status: "READY",
                previousStatus: "AWAITING_ACCEPTANCE",
                reason: "rework",
              },
              now: at,
            }),
          );
        }
        stmt(
          `UPDATE approvals
              SET status = ?, decision = ?, actor = ?, at = ?, decided_at = ?, version = version + 1
            WHERE id = ?`,
        ).run(decision, decision, reviewer, at, at, id);
        insertEvent(
          makeEvent({
            projectId: taskRow.project_id,
            aggregateType: "approval",
            aggregateId: id,
            type: "approval.recorded",
            payload: {
              taskId: row.task_id,
              approvalId: id,
              decision,
              status: decision,
              targetHash: receivedTargetHash,
              actor: reviewer,
              principal: "HUMAN",
              operation: "approval.decide",
              targetVersion: task.version,
              at,
            },
            now: at,
          }),
        );
        return { approval: approvalJson(requireApprovalRow(id)), task };
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
      return transaction(() => insertEvent(event));
    },

    listEvents(filters = {}) {
      const page = buildEventPage(filters);
      // Backward compatibility: M1-M5 callers treat listEvents() as an array
      // (`.map`, `.filter`, `Array.isArray`). The M6 pagination metadata is
      // attached as non-enumerable properties so both `result[0]` and
      // `result.items` / `result.hasMore` work. New code should call
      // listEventsPage() for a plain page object.
      const result = page.items.slice();
      Object.defineProperties(result, {
        items: { value: result, enumerable: false },
        hasMore: { value: page.hasMore, enumerable: false },
        nextAfterSeq: { value: page.nextAfterSeq, enumerable: false },
      });
      return result;
    },

    listEventsPage(filters = {}) {
      return buildEventPage(filters);
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
      /** Migration self-heal warnings recorded while opening this store. */
      migrationWarnings: () => migrationWarnings.map((warning) => structuredClone(warning)),
      /** Run `work` inside one BEGIN IMMEDIATE transaction (import replace). */
      transaction: (work) => transaction(work),
      /**
       * Delete every business row but NOT schema_migrations: a replace-import
       * must keep the migration ledger intact or the next open would re-run
       * migrations against an already-migrated schema.
       */
      clearBusinessTables: () => {
        for (const table of [
          "review_attempts",
          "reviews",
          "approvals",
          "gate_results",
          "plans",
          "dispatch_commands",
          "run_leases",
          "runs",
          "task_dependencies",
          "tasks",
          "requirements",
          "agent_instances",
          "projects",
          "events",
        ]) {
          stmt(`DELETE FROM ${table}`).run();
        }
      },
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
      /** Read a dispatch command row as JSON (test/fencing diagnostics only). */
      getDispatchCommand: (id) => {
        const row = stmt("SELECT * FROM dispatch_commands WHERE id = ?").get(id);
        return row ? commandJson(row) : null;
      },
      /** Review attempt audit rows for one Task (test diagnostics only). */
      listReviewAttempts: (taskId) => {
        requireId(taskId, "task.id");
        return stmt(
          `SELECT a.* FROM review_attempts a JOIN reviews r ON r.id = a.review_id
            WHERE r.task_id = ? ORDER BY a.attempt ASC, a.id ASC`,
        )
          .all(taskId)
          .map((row) => ({
            id: row.id,
            reviewId: row.review_id,
            attempt: Number(row.attempt),
            status: row.status,
          }));
      },
      /**
       * Migration-only writer: sets a task's status exactly as recorded in the
       * legacy file (e.g. a package that was already DONE) without pretending it
       * walked the 搂5.2 chain. It is NOT part of the public Store contract and
       * only `importStateJson` (same package) may call it; Backend/Web must use
       * patchTask, which always enforces the state machine.
       */
      setTaskStatus: (id, status) => {
        validateTaskStatus(status);
        return transaction(() => {
          requireTaskRow(id);
          stmt("UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?").run(
            status,
            nowIso(),
            id,
          );
          return taskJson(requireTaskRow(id));
        });
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

