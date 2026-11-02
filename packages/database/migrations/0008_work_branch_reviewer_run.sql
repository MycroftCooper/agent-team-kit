-- M6.3 P0-3/P0-4/P1-5/P1-8: work branch vs integration target, command
-- event identity, reviewer Run binding and persisted legacy flag.
ALTER TABLE runs ADD COLUMN project_id TEXT;
ALTER TABLE runs ADD COLUMN work_branch TEXT NOT NULL DEFAULT '';
UPDATE runs SET project_id = (SELECT project_id FROM tasks WHERE tasks.id = runs.task_id)
  WHERE project_id IS NULL;
UPDATE runs SET work_branch = 'atk/run/' || id WHERE work_branch = '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_project_work_branch ON runs(project_id, work_branch);

ALTER TABLE dispatch_commands ADD COLUMN event_id TEXT;
ALTER TABLE reviews ADD COLUMN reviewer_run_id TEXT;

ALTER TABLE events ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
UPDATE events SET legacy = 1 WHERE event_id IS NULL;
