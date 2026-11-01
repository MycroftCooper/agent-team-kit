-- Schema v1 for @atk/database (M1).
--
-- Applied exactly once by src/sqlite.mjs and recorded in `schema_migrations`.
-- The runner already guarantees "apply once"; every statement is still written
-- with IF NOT EXISTS so that a database whose bookkeeping row was lost is
-- repaired instead of crashing (idempotency is a hard requirement).
--
-- Conventions (contracts §1):
--   * business tables carry `id TEXT PRIMARY KEY`, `created_at TEXT NOT NULL`;
--   * entities that take part in optimistic concurrency carry `version INTEGER
--     NOT NULL DEFAULT 0` and are updated with `WHERE id = ? AND version = ?`;
--   * `events` is append-only with `seq INTEGER PRIMARY KEY AUTOINCREMENT`;
--   * timestamps are ISO-8601 strings (UTC, `toISOString()`); SQLite has no
--     native date type and comparing ISO strings is order-preserving.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  repo_path      TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 0,
  -- Migration/import metadata. Never part of the public Project JSON; it keeps
  -- legacy `state.json` fields (source, batch, counts) recoverable by export.
  legacy_json    TEXT,
  settings_json  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  acceptance  TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  function_required TEXT NOT NULL,
  role_required     TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 2,
  status            TEXT NOT NULL DEFAULT 'READY',
  acceptance        TEXT,
  plan_id           TEXT,
  parent_id         TEXT,
  version           INTEGER NOT NULL DEFAULT 0,
  -- Original legacy object for imported tasks (NULL for tasks created via the
  -- API). `exportStateJson` uses it to round-trip the pre-migration file.
  legacy_json       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id                TEXT PRIMARY KEY,
  role              TEXT NOT NULL,
  description       TEXT,
  capabilities_json TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_instances (
  id                TEXT PRIMARY KEY,
  role              TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'OFFLINE',
  task              TEXT,
  detail            TEXT,
  since             TEXT,
  legacy_json       TEXT,
  version           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,
  function   TEXT NOT NULL,
  status     TEXT NOT NULL,
  attempt    INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  ended_at   TEXT,
  error_json TEXT,
  version    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_leases (
  run_id       TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  owner_id     TEXT NOT NULL,
  generation   INTEGER NOT NULL DEFAULT 0,
  claimed_until TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatch_commands (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  run_id          TEXT,
  agent_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  idempotency_key TEXT NOT NULL UNIQUE,
  owner_id        TEXT,
  generation      INTEGER NOT NULL DEFAULT 0,
  claimed_until   TEXT,
  payload_json    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id TEXT,
  status         TEXT NOT NULL DEFAULT 'PROPOSED',
  content_json   TEXT,
  version        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT,
  status        TEXT NOT NULL,
  verdict       TEXT,
  manifest_hash TEXT,
  commit_sha    TEXT,
  findings_json TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1,
  version       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One row per review attempt (ADR-005: a review is bound to a frozen candidate
-- version; re-freezing invalidates the old attempt instead of overwriting it).
CREATE TABLE IF NOT EXISTS review_attempts (
  id            TEXT PRIMARY KEY,
  review_id     TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  run_id        TEXT,
  attempt       INTEGER NOT NULL,
  status        TEXT NOT NULL,
  verdict       TEXT,
  manifest_hash TEXT,
  findings_json TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  task_id     TEXT,
  scope       TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  actor       TEXT NOT NULL,
  status      TEXT NOT NULL,
  at          TEXT,
  legacy_json TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_results (
  id           TEXT PRIMARY KEY,
  task_id      TEXT,
  run_id       TEXT,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL,
  report_path  TEXT,
  report_sha256 TEXT,
  details_json TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  project_id     TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  type           TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  happened_at    TEXT NOT NULL
);

-- Required indexes (contracts §1 + dispatch/SSE access paths).
CREATE INDEX IF NOT EXISTS idx_tasks_project_status_priority
  ON tasks(project_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_role_function
  ON tasks(role_required, function_required);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_dep
  ON task_dependencies(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_events_project_seq
  ON events(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_aggregate
  ON events(aggregate_type, aggregate_id, seq);
CREATE INDEX IF NOT EXISTS idx_dispatch_commands_status_claimed
  ON dispatch_commands(status, claimed_until);
CREATE INDEX IF NOT EXISTS idx_dispatch_commands_task
  ON dispatch_commands(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_task
  ON runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status
  ON runs(status);
CREATE INDEX IF NOT EXISTS idx_reviews_status
  ON reviews(status);
CREATE INDEX IF NOT EXISTS idx_review_attempts_review
  ON review_attempts(review_id, attempt);
CREATE INDEX IF NOT EXISTS idx_approvals_task
  ON approvals(task_id, status);
CREATE INDEX IF NOT EXISTS idx_gate_results_task
  ON gate_results(task_id, name);
CREATE INDEX IF NOT EXISTS idx_requirements_project
  ON requirements(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_project
  ON plans(project_id, status);
