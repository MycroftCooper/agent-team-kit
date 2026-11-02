# @atk/scheduler-core（M3）

纯函数调度算法：DAG 环检测、稳定排序、Agent 匹配、写域冲突、确定性派发计划。

- 契约来源：[docs/architecture/m3-contracts.md](../../docs/architecture/m3-contracts.md) §1 与 §0 不变量（ADR-003、规范 §8.2）
- 约束：**纯函数**；唯一依赖 `@atk/contracts`（共享仓库路径规则，M6.2 F13）；零时钟、零网络、零文件；`now` 必须由调用方注入
- M6.2 F10：`status === "IDLE"` **不等于**可派发，还要求最近心跳在 TTL 内且 capacity > 0
- 消费方：`apps/scheduler`（`packages/scheduler-core` 是它的唯一算法依赖）

## 导出

| 函数 | 返回 |
|---|---|
| `detectCycles(tasks)` | `{ ok, cycles: string[][], truncated }`（每个 SCC 内枚举**所有简单环**；自依赖也算环；环从最小 id 起始 + 确定性排序；超过上限时 `truncated: true`） |
| `topologicalOrder(tasks)` | `{ ok:true, order, levels } \| { ok:false, cycles }` |
| `readyCandidates({ tasks })` | `{ candidates, missingDeps: [{taskId, missing: string[]}] }` |
| `scoreAndSort(tasks, { now })` | `[{ taskId, priority, waitingMs, score }]` |
| `matchAgents({ task, agents, policies, now })` | `{ candidates, excluded: [{agentId, reason}] }`（`now` 必填；IDLE/Role/Function 之外还校验心跳与容量） |
| `agentAvailability(agent, { now, ttlMs? })` | `{ available, reason }`；reason ∈ `ok` / `no-heartbeat` / `stale-heartbeat` / `no-capacity` |
| `detectConflicts({ task, activeRuns, ownership })` | `{ ok, reasons: [{kind, detail}] }` |
| `planDispatch({ snapshot, policies, now })` | `{ proposals, skipped }`；有不可用 IDLE agent 时附加 `unavailableAgents` + `heartbeatTtlMs` |
| `resolveOwner(ownership, path)` / `normalizePath` / `pathsOverlap` | 写域匹配辅助（`normalizePath`/`pathsOverlap` 就是 `@atk/contracts` 的同一实现） |
| `assertDeterministic(a, b)` | 确定性断言（测试用） |
| `SKIP_REASONS` / `SKIP_REASON_VALUES` / `PRIORITY_WEIGHT` / `DEFAULT_HEARTBEAT_TTL_MS` / `AGENT_AVAILABILITY_REASONS` | 机器可读枚举与常量 |

## 排序与权重（首版固定，不做 LLM 权重）

1. `priority` 升序（数值小 = 更紧急）
2. 等待时长 `waitingMs` 降序（更老的任务优先；由注入的 `now` 计算）
3. `taskId` 字典序升序（最终稳定 tie-break）

`score = priority * PRIORITY_WEIGHT - waitingMs`，消费者可用同一公式复算；输入数组顺序不影响输出。

## 环与依赖规则

- 环：直接环、间接环、自依赖都会被 `detectCycles` 报告；**同一 SCC 内的每条简单环都单独报告**
  （例如 `A→B→D→A` 与 `A→C→D→A` 是两条，而不是只报一条）。有环时 `planDispatch` **整体拒绝**：
  `proposals: []`，且快照里**每个 task** 都得到 `skipped[].reason = "cycle"`。
  绝不“跳过有环的部分、继续派发其余任务”。
- 枚举上限：每个 SCC 最多 `CYCLE_LIMITS.perScc`（100）条、总计 `CYCLE_LIMITS.total`（1000）条，
  另设 `CYCLE_LIMITS.visitBudget`（250,000 次 DFS 边检查）防止“指数级简单路径但环很少”的病态图；
  达到任一上限时返回已找到的环并置 `truncated: true`，绝不静默少报。
- 依赖：一个任务只有在所有 deps 都存在且 `DONE` 时才进入候选集；缺失 dep 视为未完成，
  `readyCandidates` 按 `missingDeps: [{taskId, missing: [depId...]}]` 单独报告，`planDispatch` 给出 `deps-incomplete`。

## 跳过原因（机器可读枚举，不接受自由文本）

`cycle` · `deps-incomplete` · `no-idle-agent` · `capability-mismatch` · `write-scope-conflict` · `capacity`

## 写域冲突

- 任务/运行上的 `files` 是声明式写域（文件或目录前缀）。路径规范化**复用 `@atk/contracts`**
  （`normalizeRepoPath` / `pathsOverlap`，M6.2 F13）：`\`→`/`、折叠 `.`/`..`、trim、合并重复斜杠；
  **盘符绝对路径（`C:\abs` / `C:/abs`）、UNC、`..` 越界和空串一律拒绝**（与 database/backend 同一实现，
  调度器不再接受"看着像项目内路径"的绝对路径）。被拒绝的路径不会成为写域，也不会与任何路径冲突。
- 无 `ownership` 时：候选文件与 active Run 文件重合（同一文件或目录包含）即冲突。
- 传入 `ownership`（`{rules:[{prefix, role}]}`，由调用方提供，本包**不** import `lib/**`）时，
  按**最长前缀**把文件映射到 ownership 规则；同一写域（同一 rule prefix）内的不同文件也视为冲突
  （更保守：Backend 会重新校验，本层多跳过不会造成错误派发）。

## 心跳门控（M6.2 F10）

- `IDLE` 只是必要条件。派发前还要求 `agentAvailability({now, ttlMs})` 为 `ok`：
  `lastHeartbeatAt + ttlMs >= now` 且 `capacity > 0`；TTL 默认 `DEFAULT_HEARTBEAT_TTL_MS`（30s），
  可用 `policies.heartbeatTtlMs` 覆盖，但**没有关闭开关**。
- 心跳缺失 → `no-heartbeat`；过期（含不可解析的时间）→ `stale-heartbeat`；容量 0 → `no-capacity`。
- 这些拒绝会写进调度结果（`planDispatch().unavailableAgents` + `heartbeatTtlMs`，`apps/scheduler`
  的 round summary 同样透出），任务侧得到 `skipped[].reason = "no-idle-agent"`，绝不静默跳过。
- Host 恢复心跳后，下一轮即可正常派发；scheduler 仍是单实例、无选主。

## planDispatch 行为摘要

```js
planDispatch({ snapshot, policies, now })
// snapshot: { version, generatedAt, projects, tasks, agents, runs, leases }（m3-contracts §2）
// policies: { maxConcurrentPerProject, maxPerAgent, projectId?, workspacePolicy?, ownership?, heartbeatTtlMs? }
```

1. 有环 → 整体拒绝（见上）。
2. 候选 = `status === "READY"` 且 deps 全 `DONE` 且在 `policies.projectId`（若指定）范围内。
3. 按固定权重排序后逐条检查：项目容量 → Agent 匹配（IDLE / Role / Function / 心跳 / 容量）→ Agent 容量 →
   写域冲突；每个失败任务得到枚举 reason。
4. 通过的候选生成 proposal，并立刻占用容量与写域，因此同一计划内不会出现两个冲突任务。
5. `workspacePolicy` 优先级：项目 policy → `policies.workspacePolicy` → `{ kind: "none" }`。
6. 若本轮有 IDLE agent 被心跳/容量拒绝，结果附加 `unavailableAgents: [{agentId, reason}]` 与
   `heartbeatTtlMs`（全部可用时不出现该字段，保持历史形状）。

## 测试

```bash
node --test packages/scheduler-core/test/*.test.mjs
node scripts/test-workspace.mjs
node scripts/check-boundaries.mjs
node scripts/test.mjs
```
