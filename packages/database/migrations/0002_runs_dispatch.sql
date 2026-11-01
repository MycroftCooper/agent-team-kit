-- Schema v2: runtime execution facts (M2 / ATK-202, ATK-204).
--
-- M1 created `runs`, `run_leases` and `dispatch_commands` but nothing wrote them.
-- M2 turns them into the execution source of truth, so the columns the contract
-- (docs/architecture/m2-contracts.md §2/§3, ADR-003) needs are added here.
--
-- Additive only: ALTER TABLE ADD COLUMN keeps existing rows and foreign keys.
-- The migration runner records this file in `schema_migrations` and never runs it
-- twice for a normal open; `health().schemaVersion` therefore becomes 2.

-- Run: the role the run executes under, the isolated workspace it was given, and
-- the process exit code reported by the runtime host.
ALTER TABLE runs ADD COLUMN role TEXT;
ALTER TABLE runs ADD COLUMN workspace_id TEXT;
ALTER TABLE runs ADD COLUMN exit_code INTEGER;

-- Lease: the heartbeat timestamp is separate from the expiry so reconciliation
-- can tell "never heartbeated" from "heartbeat 3s ago". expiresAt/claimedUntil
-- stays in the existing `claimed_until` column (same value as the command lease).
ALTER TABLE run_leases ADD COLUMN last_heartbeat_at TEXT;

-- Dispatch command: the command kind, the attempt counter (incremented on every
-- claim, including re-claims of expired commands) and the persisted result so an
-- idempotent retry of `/dispatch/:id/result` can return the original outcome.
ALTER TABLE dispatch_commands ADD COLUMN command_type TEXT NOT NULL DEFAULT 'RUN_TASK';
ALTER TABLE dispatch_commands ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dispatch_commands ADD COLUMN result_json TEXT;
ALTER TABLE dispatch_commands ADD COLUMN completed_at TEXT;

-- Claim scan: oldest PENDING command, or a CLAIMED command whose lease expired.
CREATE INDEX IF NOT EXISTS idx_dispatch_commands_claim
  ON dispatch_commands(status, claimed_until, created_at);
