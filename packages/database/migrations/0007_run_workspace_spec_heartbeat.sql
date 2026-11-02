-- M6.2 F04/F05/F10: Run workspace binding, frozen TaskExecutionSpec, agent heartbeat.
ALTER TABLE runs ADD COLUMN workspace_path TEXT;
ALTER TABLE runs ADD COLUMN base_commit TEXT;
ALTER TABLE runs ADD COLUMN target_branch TEXT;
ALTER TABLE runs ADD COLUMN workspace_kind TEXT;

CREATE TABLE IF NOT EXISTS run_specs (
  run_id       TEXT,
  task_id      TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  spec_json    TEXT NOT NULL,
  spec_hash    TEXT NOT NULL,
  frozen_at    TEXT NOT NULL
);
-- run_id is an audit reference: NULL until a real Run binds the freeze. SQLite
-- treats NULLs as distinct under UNIQUE, so unbound freezes may accumulate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_specs_run ON run_specs(run_id);
CREATE INDEX IF NOT EXISTS idx_run_specs_task ON run_specs(task_id);

ALTER TABLE agent_instances ADD COLUMN host_id TEXT;
ALTER TABLE agent_instances ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE agent_instances ADD COLUMN capacity INTEGER;
