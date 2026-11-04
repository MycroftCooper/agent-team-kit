# Changelog

## 2.0.0-alpha.1

Breaking rebuild around the standalone web workspace and external pull agents.

- Removed the legacy JSON workflow/CLI and migration projections, software board
  plugin, runtime host/adapters, separate scheduler process and worktree lifecycle.
- Added multi-project registration, versioned PM plans, human approval, role/team
  identities, direct-project file leases, durable receipts and optional review.
- Added human tasks, VERIFIED dependency progression and final plan acceptance
  with candidate drift checks. Unknown writers retain quarantined file locks.
- Rebuilt the bilingual Linear-style UI with ordinary SSE-driven invalidation,
  paginated tasks/logs, output snapshots and operations controls.
- Added independent packaging, HTTP/CLI agent protocol, backup/restore, browser
  workflow tests, protocol fault checks and a seeded performance harness.
- New data lives under AgentTeamKit/Next. Previous data is never auto-imported,
  upgraded, reset, pruned or deleted.
