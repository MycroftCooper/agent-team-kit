# 实体权限（中文摘要）

> 英文原文：[PERMISSIONS.md](PERMISSIONS.md)。矩阵的唯一真源是
> `atk permit matrix`（机器可读用 `--json`）。

权限注册表由代码内置（`lib/permission-registry.mjs`）随工具包版本发布，项目**不能**
通过配置放宽；未登记的操作一律拒绝（deny-by-default）。

## 主体

| 标识 | 主体 | 职责 | 性质 |
|---|---|---|---|
| `HUMAN` | 用户 | 最终决策、授权、验收 | 人 |
| `ORCHESTRATOR` | 组织者 | 规划、拆解、调度、协调 | AI Agent Function |
| `WORKER` | 执行者 | 编码、修改、测试、修复 | AI Agent Function |
| `REVIEWER` | 检查者 | 独立审查、验证、提供结论 | AI Agent Function |
| `SYSTEM` | 系统服务 | 确定性状态迁移和安全门禁 | 可信执行层 |

**`SYSTEM` 不是 AI Agent Function**：它是受控的确定性代码，可以执行预定义动作、记录
决策，但不能自行创造审批；高风险动作仍需要真实人工授权。

## 判定公式与顺序

```
Permit = RBAC ∧ Scope ∧ Ownership ∧ State ∧ Policy ∧ Approval
```

并非所有操作都需要 Task / Run / 人工 Approval；每项操作只评估适用的约束，**缺少必需
属性时默认拒绝**。

1. 操作是否在注册表 → `OPERATION_NOT_REGISTERED`
2. 主体能否解析（HUMAN / 三个 Function / SYSTEM）→ `SUBJECT_UNKNOWN`
3. Function 基础权限（矩阵单元格）；`N` → `ROLE_DENIED`
4. 专业 Role 的允许范围（`functions.roles`）→ `ROLE_DENIED`
5. 项目/任务归属 → `TASK_NOT_FOUND` / `OWNERSHIP_DENIED`
6. 写域与执行环境 → `WRITE_SCOPE_VIOLATION` / `WORKSPACE_NOT_ISOLATED`
7. 任务状态、预算与安全策略 → `STATE_CONSTRAINT_FAILED` / `BUDGET_EXCEEDED` / `POLICY_DENIED`
8. 人工授权 → `APPROVAL_REQUIRED`
9. 追加审计事件

单元格 `A` = 允许，`C` = 条件允许（必须满足该格条件），`N` = 拒绝。`C` 不是默认放行。

## 关键附加约束

| 权限 | 必须满足的条件 |
|---|---|
| 修改产品代码 | Function=WORKER，任务已领取，文件在当前任务授权写域内 |
| 提交 QA 结果 | Function=REVIEWER，审查者与被审候选无作者/贡献关系，绑定有效 Commit/Manifest |
| 执行集成 | 自动化 Gate 全绿、独立 QA 通过、目标分支无漂移 |
| 启动 Agent | 调度授权、可用 Runtime、并发额度、项目环境策略满足 |
| 继续超预算任务 | 用户明确提高或批准预算 |
| 修改项目安全策略 | 用户确认并记录变更，Agent 不得自行放宽 |
| 连接生产 P4 / 实盘交易 | 默认禁止自动 Agent，必须走单独受控人工流程 |
| 最终验收 | 仅用户可操作，且只能针对指定版本或候选结果 |

## 硬约束

- **组织者不能自我授权**：可提议角色与资源调整，但不能自行提权、解除质量门禁或批准自己的工作。
- **执行者不能修改其他执行者的候选**：协作通过接口契约、Git 变更和调度器进行。
- **检查者不能审批自己参与编写的成果**：检查整个候选的作者/贡献者关系，而不只是 runId；
  QA 可以跑测试、写独立用例，但不能在审查过程中修改被审候选代码。
- **SYSTEM ≠ 超级用户 Agent**：只执行预定义动作与记录决策，不自行创造审批。

## 强制位置

| 命令 | 操作 | 行为 |
|---|---|---|
| `atk state task` | `task.claim` | 领取任务按任务资格判定；审查派单额外要求审查实例身份（禁自审） |
| `atk batch manifest --agent` | `qa.manifest.freeze` | 条件允许的 WORKER/ORCHESTRATOR 动作；REVIEWER 实例被矩阵拒绝 |
| `atk batch verify --qa` | `qa.result.submit` | 权限判定进入 verify 检查项；自审返回 `SELF_REVIEW_DENIED` |
| `atk batch apply --apply --confirm-dev-closed` | `integration.merge.development` | 真实写入必须有绑定 manifest 的 QA 证据、无漂移；配置了 quick/local 门禁时还要求绿报告 |
| `atk state archive` | `integration.archive` | 条件为 `humanAccepted`，由组织者记录归档 |

其余操作可先用 CLI 查询：

```bash
atk permit matrix                          # 完整主体 × 操作矩阵
atk permit explain qa.result.submit        # 单元格、条件、原因码
atk permit check code.modify --agent agent-fe-01 --task FE-01 --files src/ui/a.ts
atk permit audit --tail 20                 # 只追加的决策审计
```

退出码：`0` 允许，`1` 拒绝（打印原因码），`2` 用法/配置错误。

## 审计与修改

每个决策追加到 `<artifactDir>/permission-audit.jsonl`；文件只追加，任何命令都不会重写或
删除既有事件（`audit.modify` 对所有主体都是 `N`）。要增删操作，改
`lib/permission-registry.mjs` 并同步 `test/permissions.test.mjs` 与本页；不存在项目级
覆盖开关——矩阵是安全边界，不是偏好设置。
