// Permission registry: the subject model and the operation matrix.
//
// Subjects: HUMAN, the three AI Agent Functions (ORCHESTRATOR / WORKER /
// REVIEWER) and SYSTEM (the trusted deterministic execution layer, explicitly
// NOT an AI Function). The matrix is deny-by-default: an operation that is not
// listed here is never allowed.
//
// Row format: `actions` is a five-character string in subject order
//   [HUMAN, ORCHESTRATOR, WORKER, REVIEWER, SYSTEM]
// with `A` = allowed, `C` = conditional (the conditions below must hold),
// `N` = denied. `conditions` maps a subject to the checks a conditional cell
// must satisfy; `default` applies to every conditional subject without an
// override.
//
// The matrix is code-owned and versioned with the toolkit: a project may not
// relax it from configuration. See docs/PERMISSIONS.md.

export const PERMISSION_MATRIX_VERSION = 1;

export const PERMISSION_SUBJECTS = [
  { id: "HUMAN", zh: "用户", en: "User", kind: "human" },
  { id: "ORCHESTRATOR", zh: "组织者", en: "Orchestrator", kind: "agent" },
  { id: "WORKER", zh: "执行者", en: "Worker", kind: "agent" },
  { id: "REVIEWER", zh: "检查者", en: "Reviewer", kind: "agent" },
  { id: "SYSTEM", zh: "系统服务", en: "System service", kind: "system" },
];

export const SUBJECT_IDS = PERMISSION_SUBJECTS.map((subject) => subject.id);
export const AGENT_SUBJECTS = PERMISSION_SUBJECTS.filter((subject) => subject.kind === "agent").map((subject) => subject.id);

export const ACTION_ALLOW = "A";
export const ACTION_CONDITIONAL = "C";
export const ACTION_DENY = "N";

/** Machine-readable refusal reasons the scheduler can branch on. */
export const REASON = {
  ALLOWED: "ALLOWED",
  OPERATION_NOT_REGISTERED: "OPERATION_NOT_REGISTERED",
  SUBJECT_UNKNOWN: "SUBJECT_UNKNOWN",
  ROLE_DENIED: "ROLE_DENIED",
  ATTRIBUTE_MISSING: "ATTRIBUTE_MISSING",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  OWNERSHIP_DENIED: "OWNERSHIP_DENIED",
  WRITE_SCOPE_VIOLATION: "WRITE_SCOPE_VIOLATION",
  WORKSPACE_NOT_ISOLATED: "WORKSPACE_NOT_ISOLATED",
  SELF_REVIEW_DENIED: "SELF_REVIEW_DENIED",
  REVIEW_EVIDENCE_INVALID: "REVIEW_EVIDENCE_INVALID",
  GATE_NOT_GREEN: "GATE_NOT_GREEN",
  STATE_CONSTRAINT_FAILED: "STATE_CONSTRAINT_FAILED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  POLICY_DENIED: "POLICY_DENIED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  RUN_SCOPE_DENIED: "RUN_SCOPE_DENIED",
  AUDIT_WRITE_FAILED: "AUDIT_WRITE_FAILED",
};

/** Short descriptions of the shared condition predicates (used by `permit explain`). */
export const CONDITION_LABELS = {
  "human-approval": "a human explicitly approved this operation",
  "explicit-confirmation": "the human confirmed this specific action",
  "recorded-change": "the change is recorded in the project policy/audit record",
  "task-context": "a task/run context is present and the subject participates in it",
  "task-eligible": "the task exists, is not archived, and matches the subject's role",
  "task-self": "the task belongs to the subject's own role",
  "task-claimed": "the task is claimed by a registered Agent Instance of that role",
  "self-task-edit": "the subject edits only its own assigned task",
  "write-scope": "every changed file is inside the subject role's write scope",
  "workspace-isolated": "the candidate workspace is isolated from the original tree",
  "independent-author": "the reviewer is not an author/contributor of the candidate",
  "review-evidence": "a valid QA approval binds the frozen manifest",
  "gate-green": "the configured quick/local gate report is green",
  "no-drift": "the original tree has not drifted from the frozen manifest",
  "qa-passed": "an independent QA run passed for this manifest",
  "budget-allowed": "the task remains inside its round/budget allowance",
  "dispatch-authorized": "the dispatcher is allowed to start this agent session",
  "runtime-available": "an Agent Runtime slot is available",
  "concurrency-quota": "the project concurrency quota allows another Agent",
  "policy-ok": "the project environment/security policy allows it",
  "run-self": "the Run belongs to the acting Agent Instance",
  "run-other": "the Run belongs to another Agent Instance",
  "human-accepted": "the human accepted the applied result",
  "controlled-process": "a separate, controlled human process authorizes it",
  "protected-branch": "the protected-branch policy allows the write",
};

/** Validate one five-character action row. */
function normalizeActions(id, actions) {
  if (typeof actions !== "string" || !/^[ACN]{5}$/.test(actions)) {
    throw new Error(`permission registry: ${id} actions must be a five-character A/C/N string`);
  }
  return actions;
}

function operation(id, zh, en, actions, conditions = {}) {
  return { id, zh, en, actions: normalizeActions(id, actions), conditions };
}

const PROJECT = [
  operation("project.view", "查看项目和配置", "View projects and configuration", "AAAAA"),
  operation("project.create", "创建、删除项目", "Create or delete a project", "ANNNC", {
    default: ["human-approval"],
  }),
  operation("project.settings", "修改项目基础设置", "Change project settings", "ACNNC", {
    default: ["human-approval"],
  }),
  operation("project.runtime.edit", "修改 Agent Runtime / Magpie 路由", "Change Agent Runtime / Magpie routing", "ANNNN"),
  operation("project.roles.edit", "配置 Agent 角色与写域", "Configure Agent roles and write scopes", "ACNNC", {
    default: ["human-approval"],
  }),
  operation("project.limits.edit", "调整最大并发数、任务预算", "Adjust concurrency limits and task budgets", "ACNNC", {
    default: ["human-approval"],
  }),
  operation("project.security.edit", "修改安全策略与门禁规则", "Change security policy and gate rules", "ANNNC", {
    default: ["human-approval", "recorded-change"],
  }),
  operation("secret.read", "读取密钥及敏感凭据", "Read secrets and sensitive credentials", "CNNNC", {
    default: ["human-approval"],
  }),
];

const TASKS = [
  operation("task.requirement.create", "创建需求 / Epic", "Create a requirement / Epic", "AACCC", {
    default: ["task-context"],
    SYSTEM: ["human-approval"],
  }),
  operation("task.split", "拆分需求为子任务", "Split a requirement into subtasks", "AACNC", {
    default: ["task-context"],
    SYSTEM: ["human-approval"],
  }),
  operation("task.scope.edit", "修改任务范围与验收条件", "Change task scope and acceptance criteria", "ACNNC", {
    default: ["task-context"],
    SYSTEM: ["human-approval"],
  }),
  operation("task.priority.edit", "设置优先级与依赖", "Set priority and dependencies", "AANNC", {
    default: ["human-approval"],
  }),
  operation("task.worker.create", "创建 / 指派 Worker 任务", "Create or assign a WORKER task", "AANNC", {
    default: ["human-approval"],
  }),
  operation("task.review.create", "创建 / 指派 Review 任务", "Create or assign a REVIEWER task", "AANCC", {
    default: ["task-context"],
    SYSTEM: ["human-approval"],
  }),
  operation("task.claim", "领取符合条件的任务", "Claim an eligible task", "CCCCA", {
    default: ["task-eligible"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("task.self.edit", "修改自身任务内容", "Edit the subject's own task", "ACCNC", {
    default: ["task-self"],
    SYSTEM: ["human-approval"],
  }),
  operation("task.other.edit", "修改其他 Agent 的任务", "Edit another Agent's task", "ACNNC", {
    default: ["task-context"],
    SYSTEM: ["human-approval"],
  }),
  operation("task.split.request", "请求任务拆分 / 阻塞处理", "Request a task split or blocker handling", "AAAAC", {
    default: ["human-approval"],
  }),
  operation("task.move", "跨项目移动任务", "Move a task across projects", "ACNNC", {
    default: ["task-context"],
    SYSTEM: ["human-approval"],
  }),
  operation("task.cancel", "取消、暂停、恢复任务", "Cancel, pause or resume a task", "ACCCA", {
    default: ["task-context"],
  }),
];

const AGENTS = [
  operation("agent.view", "查看 Agent 状态与日志", "View Agent status and logs", "AACCA", {
    default: ["task-context"],
  }),
  operation("agent.start", "启动 Agent 会话", "Start an Agent session", "ACNNA", {
    default: ["dispatch-authorized", "runtime-available", "concurrency-quota", "policy-ok"],
  }),
  operation("agent.self.stop", "停止自己的 Run", "Stop the subject's own Run", "ACCCA", {
    default: ["run-self"],
  }),
  operation("agent.other.stop", "停止其他 Agent Run", "Stop another Agent's Run", "ACNNA", {
    default: ["run-other"],
  }),
  operation("agent.terminate.all", "强制终止所有 Agent", "Force-terminate every Agent", "ANNNA"),
  operation("agent.retry", "重试失败任务", "Retry a failed task", "ACNNA", {
    default: ["task-context"],
  }),
  operation("agent.model.edit", "修改 Agent 的模型 / Runtime", "Change an Agent's model / Runtime", "ANNNC", {
    default: ["human-approval", "recorded-change"],
  }),
  operation("agent.command", "向其他 Agent 发送工作指令", "Send a work instruction to another Agent", "AACCC", {
    default: ["task-context"],
    SYSTEM: ["human-approval"],
  }),
  operation("agent.role.switch", "切换 Agent Function / Role", "Switch an Agent's Function / Role", "ACNNC", {
    default: ["human-approval"],
    SYSTEM: ["human-approval", "recorded-change"],
  }),
  operation("agent.auto.assign", "自动分配空闲 Agent", "Automatically assign an idle Agent", "CCNNA", {
    default: ["dispatch-authorized", "concurrency-quota"],
    HUMAN: ["explicit-confirmation"],
  }),
];

const CODE = [
  operation("code.read", "读取授权范围内的项目代码", "Read project code inside the authorized scope", "AAAAC", {
    default: ["policy-ok"],
  }),
  operation("code.worktree.create", "创建独立 Worktree", "Create an isolated worktree", "CCCNA", {
    default: ["task-context", "workspace-isolated"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("code.modify", "修改产品代码", "Modify product code", "CNCNN", {
    default: ["task-claimed", "write-scope"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("code.contract.modify", "修改共享接口契约", "Modify a shared interface contract", "ACCNC", {
    default: ["task-context", "write-scope"],
    SYSTEM: ["human-approval"],
  }),
  operation("code.tests.modify", "修改测试代码", "Modify test code", "CNCCN", {
    default: ["write-scope"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("code.outside.scope.modify", "修改角色写域之外的文件", "Modify files outside the role write scope", "CNNNN", {
    HUMAN: ["explicit-confirmation"],
  }),
  operation("code.other.workspace.modify", "修改运行中其他 Agent 的工作区", "Modify another running Agent's workspace", "NNNNN"),
  operation("code.commit", "创建本地 Commit", "Create a local commit", "CNCNC", {
    default: ["task-context", "write-scope"],
    HUMAN: ["explicit-confirmation"],
    SYSTEM: ["policy-ok"],
  }),
  operation("code.pr.create", "创建 PR / 候选集成请求", "Create a PR / candidate integration request", "CCCNC", {
    default: ["task-context"],
    HUMAN: ["explicit-confirmation"],
    SYSTEM: ["policy-ok"],
  }),
  operation("code.protected.branch.modify", "直接修改受保护分支", "Write to a protected branch directly", "NNNNC", {
    default: ["human-approval", "protected-branch"],
  }),
  operation("code.worktree.remove", "删除 Worktree / 清理资源", "Remove a worktree / clean resources", "CCNNA", {
    default: ["task-context"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("code.conflict.resolve", "解决合并冲突", "Resolve merge conflicts", "CCCNC", {
    default: ["task-context"],
    HUMAN: ["explicit-confirmation"],
    SYSTEM: ["policy-ok"],
  }),
];

const QA = [
  operation("qa.compile.run", "运行编译、Lint、单元测试", "Run compile / lint / unit tests", "ACAAA", {
    default: ["task-context"],
  }),
  operation("qa.e2e.run", "运行集成 / E2E 测试", "Run integration / E2E tests", "ACCAA", {
    default: ["task-context"],
  }),
  operation("qa.logs.view", "查看测试日志和构建产物", "View test logs and build artifacts", "AAAAA"),
  operation("qa.receipt.create", "生成执行回执", "Write an execution receipt", "CCAAA", {
    default: ["task-context"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("qa.manifest.freeze", "生成 Manifest / 冻结候选", "Freeze the candidate manifest", "CCCNA", {
    default: ["workspace-isolated"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("qa.review.other", "审查其他 Agent 的变更", "Review another Agent's change", "ANNAC", {
    default: ["policy-ok"],
  }),
  operation("qa.review.self", "审查自己的变更", "Review the subject's own change", "CNNNN", {
    HUMAN: ["explicit-confirmation"],
  }),
  operation("qa.result.submit", "提交 QA PASS / FAIL", "Submit a QA PASS / FAIL", "CNNCC", {
    default: ["review-evidence"],
    HUMAN: ["explicit-confirmation"],
    REVIEWER: ["independent-author", "review-evidence"],
    SYSTEM: ["review-evidence"],
  }),
  operation("qa.candidate.modify", "修改已冻结候选", "Modify a frozen candidate", "NNNNN"),
  operation("qa.invalidate", "因代码变更使旧 QA 失效", "Invalidate old QA evidence after a code change", "CNNNA", {
    HUMAN: ["explicit-confirmation"],
  }),
  operation("qa.gate.confirm", "确认自动化 Gate 结果", "Confirm automated gate results", "CNNNA", {
    HUMAN: ["explicit-confirmation"],
  }),
  operation("qa.rework.request", "要求开发 Agent 返工", "Ask a developer Agent to rework", "AANCC", {
    default: ["review-evidence"],
    SYSTEM: ["policy-ok"],
  }),
  operation("qa.evidence.forge", "覆盖或伪造测试 / QA 证据", "Overwrite or forge test / QA evidence", "NNNNN"),
];

const INTEGRATION = [
  operation("integration.request", "请求集成", "Request integration", "AACCC", {
    default: ["task-context"],
    SYSTEM: ["policy-ok"],
  }),
  operation("integration.precheck", "执行集成前最终校验", "Run the final pre-integration check", "CNNNA", {
    HUMAN: ["explicit-confirmation"],
  }),
  operation("integration.merge.development", "合并至开发集成分支", "Merge into the development integration branch", "CNNNC", {
    default: ["gate-green", "qa-passed", "no-drift"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("integration.merge.protected", "合并至受保护主分支", "Merge into the protected main branch", "CNNNC", {
    default: ["gate-green", "qa-passed", "no-drift", "human-approval"],
    HUMAN: ["explicit-confirmation", "human-approval"],
  }),
  operation("release.push", "推送远程代码", "Push code to the remote", "CNNNC", {
    default: ["gate-green", "human-approval"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("release.publish", "发布正式版本", "Publish a release", "CNNNC", {
    default: ["gate-green", "human-approval", "recorded-change"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("production.p4.connect", "连接真实 P4 生产环境", "Connect to the production P4 environment", "CNNNN", {
    HUMAN: ["human-approval", "controlled-process"],
  }),
  operation("production.trade.access", "访问实盘交易服务", "Access a live trading service", "CNNNN", {
    HUMAN: ["human-approval", "controlled-process"],
  }),
  operation("integration.accept", "标记人工验收通过", "Mark human acceptance", "ANNNN"),
  operation("integration.archive", "归档已完成人工验收的任务", "Archive a human-accepted task", "ACNNC", {
    default: ["human-accepted"],
  }),
  operation("integration.rollback", "回滚已集成变更", "Roll back an integrated change", "CCNNC", {
    default: ["task-context"],
    HUMAN: ["explicit-confirmation"],
    SYSTEM: ["policy-ok"],
  }),
];

const AUDIT = [
  operation("audit.cost.view", "查看项目运行成本", "View project running cost", "AACCA", {
    default: ["task-context"],
  }),
  operation("audit.log.read", "读取自身执行日志", "Read the subject's own execution log", "AAAAA"),
  operation("audit.append", "追加审计事件", "Append an audit event", "CCCCA", {
    default: ["task-context"],
  }),
  operation("audit.modify", "修改既有审计事件", "Modify an existing audit event", "NNNNN"),
  operation("audit.budget.edit", "调整 Token / 费用上限", "Change the token / cost ceiling", "ACNNC", {
    default: ["human-approval", "recorded-change"],
  }),
  operation("audit.budget.continue", "超过预算后继续执行", "Continue after exceeding the budget", "CNNNC", {
    default: ["human-approval"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("audit.incident.handle", "处理异常与阻塞", "Handle an incident or blocker", "AACCA", {
    default: ["task-context"],
  }),
  operation("audit.alert.close", "关闭安全报警", "Close a security alert", "CNNNC", {
    default: ["human-approval"],
    HUMAN: ["explicit-confirmation"],
  }),
  operation("audit.report.export", "导出执行 / 测试报告", "Export an execution / test report", "AACCA", {
    default: ["task-context"],
  }),
];

export const PERMISSION_GROUPS = [
  { id: "project", zh: "项目与配置管理", en: "Projects and configuration", operations: PROJECT },
  { id: "tasks", zh: "需求、任务与调度", en: "Requirements, tasks and scheduling", operations: TASKS },
  { id: "agents", zh: "Agent 生命周期与控制", en: "Agent lifecycle and control", operations: AGENTS },
  { id: "code", zh: "代码与工作区", en: "Code and workspaces", operations: CODE },
  { id: "qa", zh: "测试、QA 与证据", en: "Testing, QA and evidence", operations: QA },
  { id: "integration", zh: "集成、发布与人工验收", en: "Integration, release and acceptance", operations: INTEGRATION },
  { id: "audit", zh: "审计、成本与异常", en: "Audit, cost and incidents", operations: AUDIT },
];

const OPERATION_INDEX = new Map();
for (const group of PERMISSION_GROUPS) {
  for (const item of group.operations) {
    if (OPERATION_INDEX.has(item.id)) throw new Error(`permission registry: duplicate operation ${item.id}`);
    OPERATION_INDEX.set(item.id, { ...item, group: group.id, groupLabel: group.en, groupLabelZh: group.zh });
  }
}

export const PERMISSION_OPERATIONS = [...OPERATION_INDEX.values()];

/** Look up an operation by id. */
export function getOperation(id) {
  return OPERATION_INDEX.get(String(id ?? "").trim());
}

/** Matrix cell for one subject (A/C/N), or undefined for an unknown subject. */
export function actionFor(operation, subject) {
  const index = SUBJECT_IDS.indexOf(String(subject ?? "").toUpperCase());
  if (index === -1) return undefined;
  return operation.actions[index];
}

/** Conditions a conditional cell must satisfy (subject override wins over `default`). */
export function conditionsFor(operation, subject) {
  const key = String(subject ?? "").toUpperCase();
  const table = operation.conditions ?? {};
  return [...(table[key] ?? table.default ?? [])];
}

/** Subject metadata by id. */
export function subjectInfo(id) {
  return PERMISSION_SUBJECTS.find((subject) => subject.id === String(id ?? "").toUpperCase());
}

/** Matrix statistics used by tests and `atk permit matrix --json`. */
export function permissionStats() {
  const counts = { operations: PERMISSION_OPERATIONS.length, groups: PERMISSION_GROUPS.length, cells: {} };
  for (const operation of PERMISSION_OPERATIONS) {
    for (const subject of SUBJECT_IDS) {
      const action = actionFor(operation, subject);
      counts.cells[action] = (counts.cells[action] ?? 0) + 1;
    }
  }
  return counts;
}
