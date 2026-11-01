# @atk/scheduler-core（M3）

纯函数调度算法：DAG 环检测、稳定排序、Agent 匹配、写域冲突、确定性派发计划。

- 契约来源：[docs/architecture/m3-contracts.md](../../docs/architecture/m3-contracts.md) §1 与 §0 不变量（ADR-003、规范 §8.2）
- 约束：**零依赖、零时钟、零网络、零文件**；`now` 必须由调用方注入
- 消费方：`apps/scheduler`（`packages/scheduler-core` 是它的唯一算法依赖）

## 导出

| 函数 | 返回 |
|---|---|
| `detectCycles(tasks)` | `{ ok, cycles: string[][] }`（自依赖也算环；环路径规范化 + 确定性排序） |
| `topologicalOrder(tasks)` | `{ ok:true, order, levels } \| { ok:false, cycles }` |
| `readyCandidates({ tasks })` | `{ candidates, missingDeps: [{taskId, depId}] }` |
| `scoreAndSort(tasks, { now })` | `[{ taskId, priority, waitingMs, score }]` |
| `matchAgents({ task, agents, policies })` | `{ candidates, excluded: [{agentId, reason}] }` |
| `detectConflicts({ task, activeRuns, ownership })` | `{ ok, reasons: [{kind, detail}] }` |
| `planDispatch({ snapshot, policies, now })` | `{ proposals, skipped }` |
| `resolveOwner(ownership, path)` / `normalizePath` / `pathsOverlap` | 写域匹配辅助（最长前缀规则） |
| `assertDeterministic(a, b)` | 确定性断言（测试用） |
| `SKIP_REASONS` / `SKIP_REASON_VALUES` / `PRIORITY_WEIGHT` | 机器可读枚举与权重常量 |

## 排序与权重（首版固定，不做 LLM 权重）

1. `priority` 升序（数值小 = 更紧急）
2. 等待时长 `waitingMs` 降序（更老的任务优先；由注入的 `now` 计算）
3. `taskId` 字典序升序（最终稳定 tie-break）

`score = priority * PRIORITY_WEIGHT - waitingMs`，消费者可用同一公式复算；输入数组顺序不影响输出。

## 环与依赖规则

- 环：直接环、间接环、自依赖都会被 `detectCycles` 报告；有环时 `planDispatch` **整体拒绝**：
  `proposals: []`，且快照里**每个 task** 都得到 `skipped[].reason = "cycle"`。
  绝不“跳过有环的部分、继续派发其余任务”。
- 依赖：一个任务只有在所有 deps 都存在且 `DONE` 时才进入候选集；缺失 dep 视为未完成，
  `readyCandidates` 单独报告 `missingDeps`，`planDispatch` 给出 `deps-incomplete`。

## 跳过原因（机器可读枚举，不接受自由文本）

`cycle` · `deps-incomplete` · `no-idle-agent` · `capability-mismatch` · `write-scope-conflict` · `capacity`

## 写域冲突

- 任务/运行上的 `files` 是声明式写域（文件或目录前缀）。路径先规范化（`\`→`/`、折叠 `.`/`..`）。
- 无 `ownership` 时：候选文件与 active Run 文件重合（同一文件或目录包含）即冲突。
- 传入 `ownership`（`{rules:[{prefix, role}]}`，由调用方提供，本包**不** import `lib/**`）时，
  按**最长前缀**把文件映射到 ownership 规则；同一写域（同一 rule prefix）内的不同文件也视为冲突
  （更保守：Backend 会重新校验，本层多跳过不会造成错误派发）。

## planDispatch 行为摘要

```js
planDispatch({ snapshot, policies, now })
// snapshot: { version, generatedAt, projects, tasks, agents, runs, leases }（m3-contracts §2）
// policies: { maxConcurrentPerProject, maxPerAgent, projectId?, workspacePolicy?, ownership? }
```

1. 有环 → 整体拒绝（见上）。
2. 候选 = `status === "READY"` 且 deps 全 `DONE` 且在 `policies.projectId`（若指定）范围内。
3. 按固定权重排序后逐条检查：项目容量 → Agent 匹配（IDLE / Role / Function）→ Agent 容量 →
   写域冲突；每个失败任务得到枚举 reason。
4. 通过的候选生成 proposal，并立刻占用容量与写域，因此同一计划内不会出现两个冲突任务。
5. `workspacePolicy` 优先级：项目 policy → `policies.workspacePolicy` → `{ kind: "none" }`。

## 测试

```bash
node --test packages/scheduler-core/test/*.test.mjs
node scripts/test-workspace.mjs
node scripts/check-boundaries.mjs
node scripts/test.mjs
```
