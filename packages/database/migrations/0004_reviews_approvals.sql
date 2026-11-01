-- M4: make reviews / review_attempts / approvals (created in M1, never written)
-- usable by the Review -> rework -> acceptance loop (m4-contracts §1, ADR-005).
--
-- reviews gets the reviewer identity, the evidence block and the submission
-- timestamp; review_attempts mirrors the evidence for audit; approvals record
-- when a human decided; tasks can carry the candidate hash that an approval
-- must match (the "Task has targetHash" rule in decideApproval).
ALTER TABLE reviews ADD COLUMN reviewer TEXT;
ALTER TABLE reviews ADD COLUMN evidence_json TEXT;
ALTER TABLE reviews ADD COLUMN submitted_at TEXT;
ALTER TABLE review_attempts ADD COLUMN evidence_json TEXT;
ALTER TABLE approvals ADD COLUMN decided_at TEXT;
ALTER TABLE approvals ADD COLUMN decision TEXT;
ALTER TABLE approvals ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN target_hash TEXT;
