# 实体与 Function

`agent-team-kit` 用 **5 个实体**和 **3 个 Function** 描述协作；`atk` CLI 是调度器，
它派单、记录谁产出了冻结快照，并拒绝让同一个 Agent Instance 审查自己产出的代码。
完整模型见 [ENTITIES.md](ENTITIES.md)（英文），文件级契约见
[INTERNALS.md](INTERNALS.md)。

## 五个实体

| 实体 | 职责 | 示例 | 落在哪里 |
|---|---|---|---|
| **Project** | 项目及策略配置 | `P4Deck` | `agent-flow.config.json` |
| **Role** | 专业角色和权限模板 | `FE`、`BE`、`QA` | `config.roles` + `ownership.json` + `roles/<ROLE>.md` |
| **Agent Instance** | 具体运行实例及能力 | `agent-fe-02` | `runtime.json` → `agents[]` |
| **Task** | 工作目标、依赖、验收标准 | `SHELVED-017` | `state.json` → `packages[]` / `subitems[]` / `batch.slices[]` |
| **Run** | 一次任务执行记录 | `run-20261102-001` | 冻结 manifest、`qa-approval.json`、apply 回执 |

- **Role 只是模板**：配置里的 id、`ownership.json` 的路径前缀、角色卡；它没有运行状态。
- **权限层在三个 Agent Function 之外还有两个主体**：`HUMAN`（用户）与 `SYSTEM`
  （受控的确定性执行层，不是 AI Function）。主体模型、操作矩阵与默认拒绝规则见
  [PERMISSIONS.zh-CN.md](PERMISSIONS.zh-CN.md)。
- **Agent Instance 才是执行者**：`id` + 所属 Role + `capabilities`（能承担哪些 Function）。
  `atk init` 为每个 Role 生成一个实例（`agent-<role>-01`）；同一 Role 多人时向
  `runtime.json` 增加实例即可。
- **Run 由回执物化**：产出方是 `atk batch manifest --agent <id>` 写下的 manifest，
  审查方是 `qa-approval.json`，集成方是 apply 回执。它们各自携带身份块。

## 三个 Function

| Function | 中文 | 主要责任 |
|---|---|---|
| `ORCHESTRATOR` | 组织者 | 规划、拆解、协调、决策 |
| `WORKER` | 执行者 | 编码、测试、文档、具体任务 |
| `REVIEWER` | 检查者 | 独立审查、验证、给出结论 |

两个字段表达协作职责：

- **`Agent.capabilities`**：该实例支持哪些 Function（`runtime.json`）。
- **`Run.function`**：本次执行实际承担的 Function（manifest 记 `WORKER`，
  QA 批准记 `REVIEWER`）。

Role 能执行哪些 Function 由配置声明：

```jsonc
"functions": {
  "roles": { "LEAD": ["ORCHESTRATOR"], "FE": ["WORKER"], "BE": ["WORKER"], "QA": ["REVIEWER"] },
  "enforceNoSelfReview": true
}
```

未声明的 Role 按 `LEAD=ORCHESTRATOR`、`QA=REVIEWER`、其余 `WORKER` 兜底，旧配置无需修改即可加载。

## 硬规则：不允许审查自己的代码

> **任何 Agent Instance 不得审查自己产出的代码。** 由调度器强制检查，不能只写在角色卡里。

1. **派单**：`atk state task <ID> --for QA` 必须带 `--agent <id>`；若该 Role 拥有该任务，
   或 `<evidenceDir>` 里的 manifest 已记录同一 `run.agent`，直接拒绝（exit 1）。
2. **审查**：`atk batch verify` / `atk batch apply --qa <approval>` 会在以下任一检查失败时拒绝：
   `producer-identity`、`reviewer-identity`、`producer-function`、`reviewer-function`、
   `no-self-review`、`producer-registered`、`reviewer-registered`、`producer-capability`、
   `reviewer-capability`、`producer-role-match`、`reviewer-role-match`、`reviewer-role-capability`。
3. **证据**：`atk evidence` 不会把"审查者就是产出者"的批准计入 `qaPassed`，也不会把
   非结构化回执（含只自报 `passed: true` 的旧式回执）计入，手抄回执无法绕过。

退出码：`1` = 检查被拒绝（`batch verify` / `batch apply`）；`2` = 用法或配置错误。
逃生开关 `functions.enforceNoSelfReview: false` 仅用于尚未采用实例身份的旧项目，不推荐；
它关闭身份检查，但**不会**把自报回执变成 QA 事实——结构化结构或显式
`batch.legacyReceipts` 仍然必需。

## 身份块

```jsonc
// manifest
"run": { "id": "run-20261102-001", "agent": "agent-fe-02", "role": "FE",
         "function": "WORKER", "startedAt": "...",
         "contributors": ["agent-fe-03"] /* 可选：共同产出的其他实例 */ }

// qa-approval.json（结构化签名回执；裸 passed:true 不是 QA 事实）
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
  "targetRunId": "run-20261102-001",      // 产出方 WORKER 的 run id（manifest.run.id）
  "gates": [
    { "name": "quick", "status": "PASS", "reportSha256": "..." }
  ],
  "originalApplied": false
}

// runtime.json（schemaVersion 3）
{ "schemaVersion": 3,
  "agents": [{ "id": "agent-fe-02", "role": "FE", "capabilities": ["WORKER"],
               "status": "working", "task": "SHELVED-017", "detail": "", "since": "..." }] }
```

`targetRunId`、`policyVersion`、`commitSha` 可选，但 manifest 与回执都携带时会校验一致。
只自报 `passed: true` / `noninteractiveQA: "passed"` 的旧式回执默认被拒；
`"batch": { "legacyReceipts": true }` 或 `--legacy-receipts` 是显式的临时逃生门。

## 完整链路

```
LEAD(ORCHESTRATOR) --atk task <ID> --for FE --agent agent-fe-02--> WORKER Run
                   --atk batch manifest --agent agent-fe-02-->     manifest.run
QA(REVIEWER)       --atk batch verify --manifest <f> --qa <f>-->    身份检查
                   写 qa-approval.json，reviewer.agent ≠ producer.agent
LEAD               --atk batch apply --qa <f> --apply --confirm-dev-closed-->
                   --atk evidence-->                                qaPassed / applied
```

实体模型不替代原有门禁：冻结 manifest、绑定 hash 的 QA 批准、apply 确认、人类验收仍然生效。
它只多问一个问题：**谁在审查，这个实例是否写过这段代码？**

## 迁移

1. 在 `agent-flow.config.json` 增加 `functions`（或直接依赖默认值）；
2. 给 `runtime.json` 每个 Agent Instance 补 `id` 与 `capabilities`；
3. 冻结时带 `--agent <id>`；
4. QA 写结构化签名回执：`kind: "qa-approval"`、`verdict: "PASS"`、`manifestSha256`、
   `reviewer` 身份块，受控集成还要声明 `gates`；
5. 用 `atk batch verify --manifest <f> --qa <f>` 复核，任何检查失败都按停止处理。

旧式只有 `passed: true` 的回执默认被拒：重新签发结构化回执，或临时设置
`"batch": { "legacyReceipts": true }`（或 `--legacy-receipts`）。该开关只用于迁移期，
回执重签完成后应移除；它不会绕过声明 `kind: "qa-approval"` 回执的结构校验。
