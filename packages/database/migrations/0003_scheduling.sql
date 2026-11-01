-- Schema v3: scheduling inputs (M3 / ATK-301, ATK-303).
--
-- The Scheduler snapshot (docs/architecture/m3-contracts.md §2) needs two pieces
-- of data M1/M2 did not store:
--   * a per-project scheduling policy (`projects.policy_json`, default NULL → {}),
--   * the write scope of a task and of the run it produced (`files_json`), so
--     claimTask can reject a candidate whose files intersect an active run's.
--
-- Additive ALTER TABLE ADD COLUMN keeps existing rows/foreign keys; the runner
-- records this file in `schema_migrations` and does not run it twice.
-- `health().schemaVersion` therefore becomes 3.

ALTER TABLE projects ADD COLUMN policy_json TEXT;
ALTER TABLE tasks ADD COLUMN files_json TEXT;
ALTER TABLE runs ADD COLUMN files_json TEXT;
