# Refactor ledger: R0–R6

## Baseline

Implementation started from `ea8f110281255f18c2d632bc65692ecd34be7e42` on
`fix/m6.1-runtime-reliability`, with 28 modified tracked files and two new tests.
Before editing, a path-preserving source ZIP, binary patch, baseline metadata and
Git history bundle were captured under `artifacts/refactor-baseline-20261105/`.
The implementation branch is `codex/refactor-web-pull-agents`. Baseline archives
are local recovery material and are deliberately excluded from publication.

## Disposition

| Previous subsystem                                                            | Result                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| Software board plugin and copies                                              | Removed from tracked production sources                   |
| Legacy file workflow CLI, JSON authority, Phase C, old migration/import paths | Removed                                                   |
| Old templates, presets, self-hosting state, workflow skills                   | Removed; replaced by web configuration and protocol guide |
| Runtime host, runtime SDK, model stub/mock, separate scheduler process        | Removed                                                   |
| Git worktrees, run branches, integration and prune                            | Removed; no automatic source-tree operations              |
| DAG sorting, path overlap, SQLite transactions, loopback/CSRF, idempotency    | Retained as tested principles and focused new modules     |
| Backend business routes, schema, state/permission rules, launcher             | Rebuilt for external pull agents                          |
| Web                                                                           | Rebuilt as bilingual Linear-style project workspace       |
| Tests, CI, release packaging and docs                                         | Rebuilt against the new acceptance scenarios              |

## Phase evidence

| Phase | Implemented behavior                                                          | Verification                                                            |
| ----- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| R0    | Independent module boundaries, no legacy entries, empty new store             | Boundary check, old-DB refusal, package smoke                           |
| R1    | Non-Git multi-project registration, artifacts, relocation and retries         | Operations tests, browser registration, package smoke                   |
| R2    | Roles/teams/identities, DRAFT, fixed planning stage, versioned human approval | Workflow/policy tests, real browser plan approval                       |
| R3    | Atomic claims, full file scopes, quarantined leases, durable snapshots        | Concurrent HTTP clients, lock tests, restart and stale generation tests |
| R4    | Optional review, human tasks, VERIFIED dependencies, final acceptance         | Workflow tests and browser execution/review/human/acceptance chain      |
| R5    | Full web pages, ordinary-event invalidation, bounded timelines                | Browser E2E and screenshots at 1440px/1280px                            |
| R6    | Independent npm package, backups, protocol fault tests and seeded load        | Package smoke, operations tests and performance report                  |

See [validation](VALIDATION.md) for actual results and their limits. Protocol
clients simulate external participants without pretending to be AI model runs.
No hosted model integration or legacy-data migration is a prerequisite for use.
