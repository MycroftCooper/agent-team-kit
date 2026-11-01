# 架构（中文摘要）

> 英文原文：[ARCHITECTURE.md](ARCHITECTURE.md)。

agent-team-kit 是一个**带角色合同与证据门禁的状态机**，外加一个只读看板。四层：

```
                 +---------------------------------------+
 人  ----------> |  看板（Markdown / HTML / SSE / DSH）  |  只读视图
                 +---------------------------------------+
                                  ^ 派生
                 +---------------------------------------+
                 |  证据门禁（回执 / manifest / 批准）    |  什么算完成
                 +---------------------------------------+
                                  ^ 产出
                 +---------------------------------------+
 agent ---------> |  角色合同（ownership.json + 角色卡）  |  谁能写哪里
                 +---------------------------------------+
                                  ^ 协调
                 +---------------------------------------+
                 |  状态机（state.json + atk CLI）        |  有什么、在哪个阶段
                 +---------------------------------------+
```

1. **状态机**：`state.json` 是唯一真值（批次 / 切片 / 工作包 / 子项）。查询用
   `atk state check|board|queue|task`；派生用 `atk evidence`；冻结与应用用
   `atk batch`；归档用 `atk state archive`（前置 `humanAccepted`）。CLI 从不问模型
   "现在什么状态"。
2. **角色合同**：`roles` 定义角色，`ownership.json` 用路径前缀分配写域（最长前缀
   优先，同一路径两个角色是配置错误），`roles/<ROLE>.md` 写清写域、禁做、任务循环、
   6 行回执、命令、轮次预算与证据阶梯。`atk ownership check --role` 把"单写者"
   从约定变成可执行检查。
3. **证据门禁**：候选快照 → `manifestSha256` → QA 的 `qa-approval.json` 绑定 →
   `atk batch verify` → apply 回执 → `atk evidence` 派生 → 人工验收。缺回执就
   不推进，不补写事实。
4. **看板**：`atk state board`（Markdown）、`atk board`（静态 HTML）、
   `atk serve`（文件监听 + SSE）、DSH 插件（同源只读路由）。三者都直接读
   `state.json`，看板永远不是输入；唯一可写回的是人工勾选人类待办。

## 实体与 Function

四层之上是一套协作模型：**Project / Role / Agent Instance / Task / Run**，以及
`ORCHESTRATOR` / `WORKER` / `REVIEWER` 三个 Function。Role 声明可承担的 Function，
Agent Instance（`runtime.json`）声明 `id` 与 `capabilities`，Run 由回执物化。

调度器 （`atk`）强制执行硬规则：**同一个 Agent Instance 不允许审查自己产出的代码。**
审查派单必须带 `--agent`；manifest 记录产出 Run；`qa-approval.json` 记录审查者；
`atk batch verify/apply` 拒绝自审；`atk evidence` 不会把可证明的自审批准计入
`qaPassed`。详见 [ENTITIES.zh-CN.md](ENTITIES.zh-CN.md)。

同一调度器还执行**权限层**：用户、三个 Agent Function 与受控 `SYSTEM` 主体，对每项操作
按默认拒绝矩阵判定；`atk permit check` 按
`RBAC ∧ Scope ∧ Ownership ∧ State ∧ Policy ∧ Approval` 求值，返回机器可识别原因码，
并把决策追加到审计文件。矩阵与强制点见 [PERMISSIONS.zh-CN.md](PERMISSIONS.zh-CN.md)。

## 模块地图

| 层 | 模块 |
|---|---|
| CLI / 上下文 | `bin/atk.mjs`、`lib/dispatch.mjs`、`lib/context.mjs` |
| 配置 / 标签 | `lib/config.mjs`、`lib/labels.mjs`、`lib/util.mjs` |
| 实体 / Function | `lib/functions.mjs`（分类、运行时实例、职责分离检查） |
| 权限 | `lib/permission-registry.mjs`（矩阵）、`lib/permissions.mjs`（判定流程、审计、`atk permit`） |
| 状态机 | `lib/state.mjs`、`lib/human-todos.mjs`、`lib/evidence.mjs` |
| 批次 / 门禁 | `lib/batch.mjs`、`lib/gate.mjs`、`lib/select-tests.mjs`、`lib/baseline.mjs`、`lib/ownership.mjs` |
| 看板 / 插件 | `lib/board.mjs`、`lib/plugin.mjs`、`plugins/dsh-agent-board/` |
| 脚手架 | `lib/init.mjs`、`presets/`、`templates/flow/` |

## 设计约束

- 零第三方依赖，Node >= 20.11，ESM。
- 不硬编码项目知识：路径来自配置，角色来自配置，标签来自 `lib/labels.mjs`。
- 输出确定：集合排序，`--json` 只输出 JSON，人类输出从简。
- 退出码：`0` 成功、`1` 检查/门禁失败或安全拒绝、`2` 用法错误、`3` 并发/漂移拒绝。

精确的模块与数据契约见 [INTERNALS.md](INTERNALS.md)。
