# Permissions

The toolkit has one permission registry, one decision pipeline and one
append-only audit trail. The registry is **code-owned** (`lib/permission-registry.mjs`)
and versioned with the toolkit: a project cannot relax it from configuration.
The single source of truth for the matrix is `atk permit matrix` (add `--json`
for machines).

## Subjects

| Subject | 主体 | Duty (职责) | Kind |
|---|---|---|---|
| `HUMAN` | 用户 | Final decision, authorization and acceptance (最终决策、授权、验收) | human |
| `ORCHESTRATOR` | 组织者 | Plans, splits, coordinates and decides (规划、拆解、调度、协调) | Agent Function |
| `WORKER` | 执行者 | Implements, modifies, tests and fixes (编码、修改、测试、修复) | Agent Function |
| `REVIEWER` | 检查者 | Independent review, verification and verdict (独立审查、验证、提供结论) | Agent Function |
| `SYSTEM` | 系统服务 | Deterministic state transitions and safety gates (确定性状态迁移和安全门禁) | trusted execution layer |

**`SYSTEM` is not an AI Agent Function.** It is the trusted deterministic layer
(the CLI, gates, state transitions). It may execute predefined actions but it
cannot create its own approval; high-risk actions still need a real human
authorization.

## Decision formula

```
Permit = RBAC ∧ Scope ∧ Ownership ∧ State ∧ Policy ∧ Approval
```

Not every operation needs a Task, Run or human Approval: each operation is
evaluated only against the constraints that apply to it. **A missing required
attribute denies.** Anything not in the registry is denied (deny-by-default).

## Decision order

1. Is the operation in the permission registry? Otherwise
   `OPERATION_NOT_REGISTERED`.
2. Does the subject resolve to `HUMAN`, an Agent Function or `SYSTEM`?
   Otherwise `SUBJECT_UNKNOWN`.
3. Base permission of the subject Function: the matrix cell.
   `N` → `ROLE_DENIED`.
4. Allowed range of the professional Role (`functions.roles` and
   `config.roles`). An Agent Function outside its Role's range → `ROLE_DENIED`.
5. Target project/task ownership relation → `TASK_NOT_FOUND` /
   `OWNERSHIP_DENIED`.
6. Write scope and execution environment → `WRITE_SCOPE_VIOLATION` /
   `WORKSPACE_NOT_ISOLATED`.
7. Task state, budget and security policy → `STATE_CONSTRAINT_FAILED` /
   `BUDGET_EXCEEDED` / `POLICY_DENIED`.
8. Human authorization → `APPROVAL_REQUIRED`.
9. Record the decision event (append-only).

A matrix cell is `A` = allowed, `C` = conditional (the cell's conditions must
all hold), `N` = denied. A conditional cell is not a default pass.

## Reason codes

| Code | Meaning |
|---|---|
| `ALLOWED` | The operation is allowed. |
| `OPERATION_NOT_REGISTERED` | Not in the registry; deny-by-default. |
| `SUBJECT_UNKNOWN` | Unknown subject or Agent Instance. |
| `ROLE_DENIED` | The matrix or the Role's Function range denies it. |
| `ATTRIBUTE_MISSING` | A required context attribute was not supplied. |
| `TASK_NOT_FOUND` | The referenced task does not exist in `state.json`. |
| `OWNERSHIP_DENIED` | The task/project belongs to another Role or instance. |
| `WRITE_SCOPE_VIOLATION` | A file is outside the subject Role's write scope. |
| `WORKSPACE_NOT_ISOLATED` | The candidate workspace is inside the original tree. |
| `SELF_REVIEW_DENIED` | The reviewer is an author/contributor of the candidate. |
| `REVIEW_EVIDENCE_INVALID` | The QA approval does not bind the frozen manifest. |
| `GATE_NOT_GREEN` | The latest quick/local gate report is not green. |
| `STATE_CONSTRAINT_FAILED` | The task/run state forbids the operation. |
| `BUDGET_EXCEEDED` | The task budget is exhausted. |
| `POLICY_DENIED` | Project environment/security policy denies it. |
| `APPROVAL_REQUIRED` | A human authorization or confirmation is required. |
| `RUN_SCOPE_DENIED` | The Run belongs to another Agent Instance. |
| `AUDIT_WRITE_FAILED` | The decision could not be appended to the audit. |

## Key additional constraints

| Permission | Required conditions |
|---|---|
| Modify product code | `Function=WORKER`, the task is claimed, the files are inside the task's authorized write scope |
| Submit QA result | `Function=REVIEWER`, no author/contributor relation between this review and the Run, bound to a valid Commit/Manifest |
| Execute integration | every automated gate green, independent QA passed, the target branch did not drift |
| Start an Agent | dispatch authorization, available Runtime, concurrency quota, project environment policy satisfied |
| Continue an over-budget task | the user explicitly raised or approved the budget |
| Change the project security policy | the user confirms and the change is recorded; an Agent may never relax it by itself |
| Connect to production P4 / live trading | default deny for automatic Agents; a separate controlled manual process is required |
| Final acceptance | only the user, and only for the specified version or candidate |

## Hard constraints

- **An Orchestrator cannot self-authorize.** It may propose role and resource
  changes, but it cannot obtain higher privileges, remove a quality gate or
  approve its own work.
- **A Worker cannot modify another Worker's candidate.** Collaboration goes
  through interface contracts, git changes and the dispatcher, not by editing a
  peer's workspace.
- **A Reviewer cannot approve work it helped produce.** The check is the whole
  candidate's author/contributor relation, not just a `runId` difference. QA may
  run tests and write independent test cases, but must not modify the candidate
  under review.
- **`SYSTEM` is not a superuser Agent.** It executes predefined actions and
  records decisions; it never invents approvals.

## Where it is enforced

| Command | Operation | Behaviour |
|---|---|---|
| `atk state task <ID> --for <ROLE> [--agent <id>]` | `task.claim` | Claiming is conditional on an eligible task; review dispatches additionally need a reviewer identity (no self-review). |
| `atk batch manifest --agent <id>` | `qa.manifest.freeze` | A conditional WORKER/ORCHESTRATOR action; a REVIEWER instance is denied by the matrix. |
| `atk batch verify --manifest <f> --qa <f>` | `qa.result.submit` | Adds the permission decision to the verify checks; a self-authored review is `SELF_REVIEW_DENIED`. |
| `atk batch apply --apply --confirm-dev-closed` | `integration.merge.development` | A real write requires QA evidence bound to the manifest, no drift, and a green quick/local gate report when those gates are configured. The dry-run plan stays available. |
| `atk state archive <ID> --note "why"` | `integration.archive` | Conditional on `humanAccepted`; the Orchestrator records the archive. |

Everything not wired into an existing command can be queried before acting:

```bash
atk permit matrix                                  # full subject x operation table
atk permit explain qa.result.submit                # cells, conditions, reason codes
atk permit check code.modify --agent agent-fe-01 --task FE-01 --files src/ui/a.ts
atk permit audit --tail 20                         # append-only decision trail
```

`atk permit check` exits `0` when allowed, `1` when denied (the reason code is
printed) and `2` on a usage/configuration error.

## Audit

Every decision is appended to `<artifactDir>/permission-audit.jsonl` (default
`artifacts/agent-flow/permission-audit.jsonl`). The file is append-only: no
command rewrites or deletes an existing event (`audit.modify` is denied for every
subject). Each line carries the operation, subject, role, instance, matrix cell,
decision, reason code, task and project.

## Changing the registry

The registry lives in `lib/permission-registry.mjs`; each operation has a
five-character `actions` row in subject order
(`HUMAN`, `ORCHESTRATOR`, `WORKER`, `REVIEWER`, `SYSTEM`) plus the conditions for
its conditional cells. Add or change an operation there, then update
`test/permissions.test.mjs` and this page. There is intentionally no per-project
override: the matrix is a security boundary, not a preference.
