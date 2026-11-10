import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { requireThat } from "../../contracts/src/index.mjs";
const TABLES = [
  "projects",
  "roles",
  "teams",
  "agents",
  "tasks",
  "plans",
  "runs",
  "locks",
  "acceptances",
  "materializations",
  "automations",
  "automation_runs",
  "automation_trigger_states",
];
export function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db;
  let transactionDepth = 0;
  function open() {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      const probe = new DatabaseSync(file, { readOnly: true });
      try {
        const tables = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        requireThat(
          tables.length === 0 || tables.some((t) => t.name === "app_meta"),
          "LEGACY_DATABASE",
          "This application does not import or upgrade the previous database",
          409,
        );
        if (tables.some((t) => t.name === "app_meta"))
          requireThat(
            probe.prepare("SELECT value FROM app_meta WHERE key='format'").get()
              ?.value === "atk-next-1",
            "DATABASE_VERSION",
            "Unsupported database format",
            409,
          );
      } finally {
        probe.close();
      }
    }
    db = new DatabaseSync(file);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const prior = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    requireThat(
      prior.length === 0 || prior.some((r) => r.name === "app_meta"),
      "LEGACY_DATABASE",
      "This application does not import or upgrade the previous database",
      409,
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    const format = db
      .prepare("SELECT value FROM app_meta WHERE key='format'")
      .get();
    requireThat(
      !format || format.value === "atk-next-1",
      "DATABASE_VERSION",
      "Unsupported database format",
      409,
    );
    db.prepare(
      "INSERT OR IGNORE INTO app_meta VALUES ('format','atk-next-1')",
    ).run();
    for (const table of TABLES)
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY,project_id TEXT,parent_id TEXT,status TEXT,agent_id TEXT,stage TEXT,priority INTEGER NOT NULL DEFAULT 2,created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project_id,status,created_at,id); CREATE INDEX IF NOT EXISTS idx_${table}_queue ON ${table}(status,priority,created_at,id); CREATE INDEX IF NOT EXISTS idx_${table}_parent ON ${table}(parent_id); CREATE INDEX IF NOT EXISTS idx_${table}_agent ON ${table}(agent_id,status);`,
      );
    db.exec(
      "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,project_id TEXT,entity_id TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id,seq); CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id,seq);",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(json_extract(data,'$.planId')); CREATE INDEX IF NOT EXISTS idx_runs_plan ON runs(json_extract(data,'$.planId'));",
    );
  }
  try {
    open();
  } catch (error) {
    try {
      db?.close();
    } catch {}
    throw error;
  }
  const api = {
    file,
    get db() {
      return db;
    },
    get(table, id) {
      requireThat(TABLES.includes(table), "STORE_TABLE", "invalid table", 500);
      const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
      return row ? JSON.parse(row.data) : null;
    },
    put(table, row) {
      requireThat(TABLES.includes(table), "STORE_TABLE", "invalid table", 500);
      const prior = api.get(table, row.id);
      const next = { ...row, version: (prior?.version ?? 0) + 1 };
      db.prepare(
        `INSERT INTO ${table}(id,project_id,parent_id,status,agent_id,stage,priority,created_at,version,data) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,parent_id=excluded.parent_id,status=excluded.status,agent_id=excluded.agent_id,stage=excluded.stage,priority=excluded.priority,version=excluded.version,data=excluded.data`,
      ).run(
        next.id,
        next.projectId ?? null,
        next.parentId ?? next.sourceTaskId ?? next.runId ?? null,
        next.status ?? null,
        next.agentId ?? null,
        next.stage ?? null,
        next.priority ?? 2,
        next.createdAt,
        next.version,
        JSON.stringify(next),
      );
      return next;
    },
    list(
      table,
      {
        projectId,
        status,
        parentId,
        agentId,
        stage,
        planId,
        statuses,
        kind,
        excludeKind,
        owner,
        search,
        hideChildren,
        deadline,
        tag,
        sort,
        direction,
        newest = false,
        limit = 100,
        offset = 0,
      } = {},
    ) {
      requireThat(TABLES.includes(table), "STORE_TABLE", "invalid table", 500);
      const filters = [],
        params = [];
      for (const [col, val] of [
        ["project_id", projectId],
        ["status", status],
        ["parent_id", parentId],
        ["agent_id", agentId],
        ["stage", stage],
        ["json_extract(data,'$.planId')", planId],
        ["json_extract(data,'$.kind')", kind],
      ])
        if (val !== undefined && val !== null) {
          filters.push(`${col}=?`);
          params.push(val);
        }
      if (statuses?.length) {
        filters.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
      if (excludeKind) {
        filters.push("json_extract(data,'$.kind') IS NOT ?");
        params.push(excludeKind);
      }
      if (owner === "REQUEST") {
        filters.push("json_extract(data,'$.kind')='REQUEST'");
      } else if (owner) {
        filters.push("json_extract(data,'$.executorType')=?");
        params.push(owner);
      }
      if (search) {
        filters.push("instr(lower(coalesce(json_extract(data,'$.title'),'') || ' ' || coalesce(json_extract(data,'$.description'),'')),lower(?))>0");
        params.push(search);
      }
      if (hideChildren) filters.push("parent_id IS NULL");
      const due = "json_extract(data,'$.dueDate')";
      if (deadline?.missing) filters.push(`${due} IS NULL`);
      if (deadline?.openOnly) filters.push("status NOT IN ('VERIFIED','DONE','CANCELLED')");
      for (const [comparison, value] of [
        [">=", deadline?.from], ["<=", deadline?.through], ["<", deadline?.before],
      ]) {
        if (value) {
          filters.push(`${due}${comparison}?`);
          params.push(value);
        }
      }
      if (tag) {
        filters.push("EXISTS (SELECT 1 FROM json_each(data,'$.tags') AS tag WHERE tag.value=?)");
        params.push(tag);
      }
      const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
      const total = Number(
        db.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get(...params)
          .n,
      );
      const taskSort = {
        priority: "priority",
        created: "created_at",
        updated: "json_extract(data,'$.updatedAt')",
        due,
        title: "json_extract(data,'$.title') COLLATE NOCASE",
      };
      const order = table === "tasks" && Object.hasOwn(taskSort, sort)
        ? `${taskSort[sort]} ${direction === "desc" ? "DESC" : "ASC"}${sort === "due" ? " NULLS LAST" : ""},created_at,id`
        : newest
          ? table === "runs" && parentId
            ? "json_extract(data,'$.generation') DESC,id DESC"
            : "created_at DESC,rowid DESC"
          : "priority,created_at,id";
      const items = db
        .prepare(
          `SELECT data FROM ${table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset)
        .map((r) => JSON.parse(r.data));
      return {
        items,
        total,
        nextCursor:
          offset + items.length < total ? offset + items.length : null,
      };
    },
    all(table, filters = {}) {
      return api.list(table, { ...filters, limit: 1_000_000 }).items;
    },
    childProgress(parentId, planId) {
      return db.prepare(
        `SELECT count(*) AS total, count(*) FILTER (WHERE status IN ('VERIFIED','DONE')) AS verified
         FROM tasks WHERE parent_id=? AND json_extract(data,'$.planId')=? AND status!='CANCELLED'`,
      ).get(parentId, planId);
    },
    taskTags(projectId) {
      return db.prepare(
        `SELECT DISTINCT tag.value FROM tasks CROSS JOIN json_each(tasks.data,'$.tags') AS tag
         WHERE tasks.project_id=? AND tag.type='text' ORDER BY tag.value COLLATE NOCASE,tag.value`,
      ).all(projectId).map(({ value }) => value);
    },
    activeRuns() {
      return db
        .prepare(
          "SELECT data FROM runs WHERE status IN ('RUNNING','STOP_REQUESTED','QUARANTINED')",
        )
        .all()
        .map((r) => JSON.parse(r.data));
    },
    remove(table, id) {
      requireThat(TABLES.includes(table), "STORE_TABLE", "invalid table", 500);
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    },
    tx(fn) {
      if (transactionDepth) return fn();
      db.exec("BEGIN IMMEDIATE");
      transactionDepth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        transactionDepth--;
      }
    },
    emit(event) {
      const r = db
        .prepare(
          "INSERT OR IGNORE INTO events(event_id,type,project_id,entity_id,data,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          event.eventId,
          event.type,
          event.projectId ?? null,
          event.entityId ?? null,
          JSON.stringify(event.data ?? {}),
          event.createdAt,
        );
      return Number(r.lastInsertRowid);
    },
    event(id) {
      const r = db
        .prepare("SELECT seq,data FROM events WHERE event_id=?")
        .get(id);
      return r ? { seq: Number(r.seq), ...JSON.parse(r.data) } : null;
    },
    events({ after = 0, limit = 100, projectId, entityId, newest = false } = {}) {
      let q = "seq>?",
        args = [after];
      if (projectId) {
        q += " AND project_id=?";
        args.push(projectId);
      }
      if (entityId) {
        q += " AND entity_id=?";
        args.push(entityId);
      }
      return db
        .prepare(`SELECT * FROM events WHERE ${q} ORDER BY seq ${newest ? "DESC" : "ASC"} LIMIT ?`)
        .all(...args, limit)
        .map((r) => ({
          seq: Number(r.seq),
          eventId: r.event_id,
          type: r.type,
          projectId: r.project_id,
          entityId: r.entity_id,
          data: JSON.parse(r.data),
          createdAt: r.created_at,
        }));
    },
    latestSeq() {
      return Number(
        db.prepare("SELECT coalesce(max(seq),0) AS n FROM events").get().n,
      );
    },
    close() {
      db.close();
    },
    reopen() {
      open();
    },
    checkpoint() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    snapshot(target) {
      db.prepare("VACUUM INTO ?").run(target);
    },
  };
  return api;
}
