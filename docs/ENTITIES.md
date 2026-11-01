# Entities and Functions

agent-team-kit coordinates **five entities** and **three Functions**. The `atk`
CLI is the scheduler: it dispatches tickets, records who produced a frozen
snapshot, and refuses a review that would let an Agent Instance check its own
code. This page is the model the rest of the toolkit enforces; the file-level
contracts are in [INTERNALS.md](INTERNALS.md).

## The five entities

| Entity | Duty (职责) | Example | Lives in |
|---|---|---|---|
| **Project** | Project and its strategy configuration (项目及策略配置) | `P4Deck` | `agent-flow.config.json` |
| **Role** | Professional role and permission template (专业角色和权限模板) | `FE`, `BE`, `QA` | `config.roles` + `ownership.json` + `roles/<ROLE>.md` |
| **Agent Instance** | A concrete runtime instance and its capabilities (具体运行实例及能力) | `agent-fe-02` | `runtime.json` → `agents[]` |
| **Task** | Work target, dependencies and acceptance criteria (工作目标、依赖、验收标准) | `SHELVED-017` | `state.json` → `packages[]`, `subitems[]`, `batch.slices[]` |
| **Run** | One task execution record (一次任务执行记录) | `run-20261102-001` | the frozen manifest, the `qa-approval.json`, the apply receipt |

A **Role** is a template: configured id, path prefixes in `ownership.json`, and a
card. It has no memory and no runtime state.

The permission layer adds two more subjects around the three Agent Functions:
`HUMAN` (the user) and `SYSTEM` (the trusted deterministic execution layer, not an
AI Function). The subject model, the operation matrix and the deny-by-default
decision rules live in [PERMISSIONS.md](PERMISSIONS.md); the entities below say
*who* performs work, the permission page says *what each subject may do*.

An **Agent Instance** is the concrete worker: an id such as `agent-fe-02`, the
Role it acts under, and the Functions it is allowed to perform. `atk init` writes
one instance per Role (`agent-<role>-01`); add more entries to `runtime.json`
when one Role is staffed by several instances.

A **Task** is what the board tracks. A batch **slice** is the review/apply unit;
a **package** (or sub-item) is the ticket-level work unit.

A **Run** is materialized by receipts, never by chat: the producing Run is the
manifest (`atk batch manifest --agent <id>`), the reviewing Run is the
`qa-approval.json`, and the integration Run is the apply receipt. Each carries
the `run` / `reviewer` identity block described below.

## The three Functions

| Function | 中文 | Main duty (主要责任) |
|---|---|---|
| `ORCHESTRATOR` | 组织者 | Plans, splits, coordinates and decides (规划、拆解、协调、决策) |
| `WORKER` | 执行者 | Implements, tests, writes docs and does the concrete task (编码、测试、文档、具体任务) |
| `REVIEWER` | 检查者 | Reviews independently, verifies and gives the verdict (独立审查、验证、给出结论) |

Two fields express the collaboration contract:

- **`Agent.capabilities`** — which Functions this Agent Instance supports
  (`runtime.json`). Used by the scheduler before it hands out a ticket.
- **`Run.function`** — which Function this Run actually performed (the
  manifest records `WORKER`; the QA approval records `REVIEWER`).

A Role declares the Functions it may perform in `agent-flow.config.json`:

```jsonc
"functions": {
  "roles": {
    "LEAD": ["ORCHESTRATOR"],
    "FE": ["WORKER"],
    "BE": ["WORKER"],
    "QA": ["REVIEWER"]
  },
  "enforceNoSelfReview": true
}
```

Missing Roles fall back to `LEAD=ORCHESTRATOR`, `QA=REVIEWER`, everything else
`WORKER`, so an existing config keeps working unchanged.

## Hard rule: no self-review

> **No Agent Instance may review code it produced.** The scheduler must enforce
> this; a role card is not enough.

The rule has two sides and the scheduler checks both:

1. **Dispatch** — `atk state task <ID> --for <REVIEWER role>` refuses unless the
   caller names the reviewer instance with `--agent <id>`. It then refuses when
   - the role also owns the task (a Role may not review its own work), or
   - a frozen manifest for that task already records the same `run.agent`
     (`atk` scans `<evidenceDir>` for it).
2. **Review** — `atk batch verify` / `atk batch apply --qa <approval>` fail when
   any of these identity checks fail:

| Check | Refuses when |
|---|---|
| `producer-identity` | the manifest has no `run.agent` (frozen without `--agent`) |
| `reviewer-identity` | `qa-approval.json` has no `reviewer.agent` |
| `producer-function` | the manifest's run is not a `WORKER` run |
| `reviewer-function` | the approval's run is not a `REVIEWER` run |
| `no-self-review` | `reviewer.agent === manifest.run.agent` |
| `producer-registered` / `reviewer-registered` | the instance is absent from `runtime.json` |
| `producer-capability` / `reviewer-capability` | the instance does not declare that Function |
| `producer-role-match` / `reviewer-role-match` | the instance's Role differs from the declared run Role |
| `reviewer-role-capability` | the reviewer's Role is not allowed to perform `REVIEWER` |

`atk evidence` also refuses to derive `qaPassed` from a receipt whose reviewer is
the manifest's producer, and it refuses any receipt that is not a valid signed
`kind: "qa-approval"` (legacy `passed: true` receipts included, unless the
project explicitly opts in with `batch.legacyReceipts` / `--legacy-receipts`),
so a hand-copied receipt cannot bypass the gate. The smoke alarm is the exit code:
a refused check exits `1` (`batch verify` / `batch apply`), while a usage or
configuration error exits `2`.

The escape hatch is `"functions": { "enforceNoSelfReview": false }`. It exists
only for a project that has not adopted Agent Instance identities yet; it turns
every identity check off and is not recommended. It does **not** turn a
self-reported receipt into a QA fact: the signed structure (or the explicit
legacy-receipts switch) is still required.

## Identity records

The manifest records the producing Run:

```jsonc
// <artifactDir>/<batch>-manifest.json
"run": {
  "id": "run-20261102-001",   // or: run-<batchId>-<timestamp>
  "agent": "agent-fe-02",
  "role": "FE",
  "function": "WORKER",
  "startedAt": "2026-11-02T10:00:00+08:00",
  "contributors": ["agent-fe-03"]   // optional: other instances that helped
}
```

The QA approval records the reviewing Run as a **signed receipt**: a bare
`passed: true` is not a QA fact (M0; see [WORKFLOW.md](WORKFLOW.md) §5).

```jsonc
// qa-approval.json
{
  "schemaVersion": 1,
  "kind": "qa-approval",
  "manifestSha256": "...",
  "verdict": "PASS",
  "reviewer": {
    "run": "run-qa-01",
    "agent": "agent-qa-01",
    "role": "QA",
    "function": "REVIEWER"
  },
  "targetRunId": "run-20261102-001",   // the producing WORKER run (manifest.run.id)
  "gates": [
    { "name": "quick", "status": "PASS", "reportSha256": "..." }
  ],
  "originalApplied": false
}
```

`targetRunId`, `policyVersion` and `commitSha` are optional but are checked for
equality when both the manifest and the receipt carry them. Legacy receipts
that only self-report `passed: true` / `noninteractiveQA: "passed"` are refused
by default; `"batch": { "legacyReceipts": true }` or `--legacy-receipts` is the
explicit, temporary escape hatch.

The Agent Instances live in `runtime.json` (schema version 3):

```jsonc
{
  "schemaVersion": 3,
  "agents": [
    { "id": "agent-fe-02", "role": "FE", "capabilities": ["WORKER"], "status": "working", "task": "SHELVED-017", "detail": "", "since": "..." }
  ],
  "events": []
}
```

## End-to-end

```
LEAD (ORCHESTRATOR)  --atk task <ID> --for FE --agent agent-fe-02-->  WORKER run
                     --atk batch manifest --agent agent-fe-02-->     manifest.run
QA (REVIEWER)        --atk batch verify --manifest <f> --qa <f>-->    identity checks
                     writes qa-approval.json with reviewer.agent != producer.agent
LEAD                 --atk batch apply --qa <f> --apply --confirm-dev-closed-->
                     --atk evidence-->                                qaPassed / applied
```

The model does not replace the existing gates: a Run still has to pass the
frozen manifest, the QA approval bound to that hash, the apply confirmation and
the human acceptance. It adds one question the gates did not ask before:
**who is reviewing, and did that instance write this code?**

## Migration

A project scaffolded before this model keeps loading (Roles get default
Functions; old `runtime.json` schema version 2 files are accepted with warnings).
To enforce the rule:

1. add `functions` to `agent-flow.config.json` (or rely on the defaults);
2. give every Agent Instance an `id` and `capabilities` in `runtime.json`;
3. freeze with `atk batch manifest --agent <id>`;
4. have QA write a signed `qa-approval.json` with `kind: "qa-approval"`,
   `verdict: "PASS"`, the `manifestSha256`, a `reviewer` block and (in
   controlled integration) the declared `gates`;
5. run `atk batch verify --manifest <f> --qa <f>` and treat any failing check as
   a stop, not a warning.

Old receipts created before this model only carry `passed: true`. They are
refused by default: re-issue them as signed receipts, or set
`"batch": { "legacyReceipts": true }` (or pass `--legacy-receipts`) as a
temporary migration switch. The switch is meant to be removed once every receipt
has been re-issued; it does not bypass the signed-structure checks for any
receipt that declares `kind: "qa-approval"`.
