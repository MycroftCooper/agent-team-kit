# M3 契约：Scheduler Core / 调度快照 / 原子领取 / Scheduler 进程

- 状态：M3 实施契约
- 关联：规范 §8、§7.2、§14（M3）；ADR-003（持久化命令 + 幂等认领 + 对账）、ADR-010
- 纪律：任何形状变更先 message Lead。

---

## 0. M3 范围与硬不变量

**做**：`packages/scheduler-core`（纯函数算法）、Backend `scheduling/snapshot` + `tasks/:id/claim`、`apps/scheduler`（独立进程）、`scripts/m3-smoke.mjs`。

**不做**：LLM 参与调度决策（规范 §8.2 明确禁止）；真实 DSH 适配器；M4 的 QA 闭环。

**硬不变量**：
1. Scheduler **只提出建议**，不落地业务状态；一切写入经 Backend 事务（规范 §8.1）。
2. Scheduler **无状态**：重启从 Backend 快照重建，内存里不保存队列真值。
3. **任何时刻一个 Run 最多一个有效租约**；一个 Task 最多一个活跃 Run。
4. 依赖未完成的任务**绝不**进入候选集；有环的 DAG 整体拒绝并报告（不静默跳过）。
5. 排序确定性：固定权重 + 稳定排序，同一快照输入必得同一 proposal 序列。

---

## 1. `packages/scheduler-core`（纯函数，零依赖）

```js
detectCycles(tasks) // -> { ok: boolean, cycles: string[][] }        // 强连通：报告每条环
topologicalOrder(tasks) // -> { ok, order: string[], levels: string[][] } | { ok:false, cycles }
readyCandidates({ tasks }) // -> Task[]   // status READY 且所有 deps 均 DONE
scoreAndSort(tasks, { now }) // -> [{ taskId, score, priority, waitingMs }]  // 确定性
matchAgents({ task, agents, policies }) // -> Agent[]  // Function/Role/capability/status=IDLE
detectConflicts({ task, activeRuns, ownership }) // -> { ok, reasons: [{kind, detail}] }
planDispatch({ snapshot, policies, now }) // -> {
  proposals: [{ taskId, agentId, expectedTaskVersion, workspacePolicy, reason }],
  skipped: [{ taskId, reason }]           // 依赖未完成/能力不匹配/冲突/预算/无空闲 Agent
}
```
- **零网络、零文件、零时钟**（`now` 必须注入），便于确定性测试。
- 权重首版固定：`priority` 升序（小=高）→ 等待时长降序 → taskId 字典序（稳定）。
- `detectConflicts` 的写域判断复用 `ownership` 规则形状（`{rules:[{prefix, role}]}`），**不** import `lib/**`（包边界）——由调用方把规则传进来。

---

## 2. Backend 内部端点（新增）

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/internal/v1/scheduling/snapshot` | 一致快照 `{ version, generatedAt, projects:[{id,policy}], tasks:[...], agents:[...], runs:[...], leases:[...] }`；`version` 单调递增（每次成功 claim 后 +1），Scheduler 用它判断快照是否过期 |
| POST | `/internal/v1/tasks/:id/claim` | 原子领取：`{ agentId, expectedTaskVersion, function?, role?, workspacePolicy?, idempotencyKey }` → 200 `{ run, command, task }`；失败码见下 |

**claim 的原子校验（Backend 单事务，任一步失败全部回滚）**：
1. Task 存在且 `status === "READY"`；Task.version === `expectedTaskVersion`（否则 `TASK_VERSION_CONFLICT`）；
2. 所有依赖 Task 均 `DONE`（否则 `TASK_DEPENDENCY_BLOCKED`）；
3. Agent 存在、`status ∈ {IDLE}`、具备所需 Function/Role（否则 `CAPABILITY_UNAVAILABLE`）；
4. 该 Task 无活跃 Run（否则 `TASK_VERSION_CONFLICT` 或 `CAPABILITY_UNAVAILABLE`，用前者带 details）；
5. 容量：同 project 活跃 Run 数 < `policies.maxConcurrentPerProject`、同 agent < `maxPerAgent`（否则 `CAPABILITY_UNAVAILABLE` + reason `capacity`）；
6. 写域冲突：候选 task 的 `files` 与 activeRuns 的 files 有交集 → 拒绝（`CAPABILITY_UNAVAILABLE` + reason `write-scope-conflict`）；
7. CAS 更新 Task → CREATED Run（STARTING）→ 建租约？**不建**：租约由 Host claim 建立（M2 语义）→ 写 `dispatch_commands`（idempotencyKey）→ 追加 `task.updated`/`run.created` 事件。

---

## 3. `apps/scheduler`（独立进程）

```text
loop:  snapshot -> planDispatch -> 逐条 POST claim -> 记录结果 -> sleep(pollMs)
       （事件订阅只是兜底；轮询是主路径，M3 允许）
```
- 环境变量：`ATK_BACKEND_URL`、`ATK_INTERNAL_TOKEN`、`SCHEDULER_OWNER`（默认 `scheduler-<pid>`）、`SCHEDULER_POLL_MS`（默认 1000）、`MAX_CONCURRENT_PER_PROJECT`、`MAX_PER_AGENT`。
- **无状态**：启动时不做任何内存恢复；每次循环重新取快照。
- 失败处理：claim 409/403 → 记录并按下一轮重试（带退避）；快照拉取失败 → 退避重试，不退出。
- 心跳：每 10s `POST /internal/v1/scheduler/heartbeat`（Backend 只需收下并记录）。
- 优雅停止：SIGINT → 停止循环 → 退出 0，**不**取消已派发的 Run（那是 Host 的事）。

---

## 4. M3 门禁（`node scripts/m3-smoke.mjs`）

必须同时满足：
1. **确定性**：同一快照两次 `planDispatch` 输出字节级相同（`scheduler-core` 单测覆盖）。
2. **无环拒绝**：含环 DAG → 整个 plan 拒绝、`skipped` 里给出 `cycle` 原因、**零** claim 发生。
3. **依赖顺序**：A→B 依赖下，B 绝不在 A 完成前被派发（真实 DB + Backend）。
4. **无双重有效租约**：N 个 Host 并发领取同一批任务后，`run_leases` 中任一时刻每个 Run 至多一条有效租约；每 Task 至多一个活跃 Run。
5. **重启恢复**：Scheduler 在中途被杀 → 重启后从快照继续，不重复派发已完成的 Task，也不丢 READY Task。
6. **中断可辨识**：中途杀一个 Host → 对应 Run 不是 `COMPLETED`（`INTERRUPTED`），且不会二次启动。

---

## 5. 已实现状态与最终形状（M3 收尾）

实现与 §1 的两处返回形状差异已定稿（保留实现，因为调用方只有 `planDispatch`，且它们携带了契约要求的"为什么被跳过"信息）：

| 函数 | 实际形状 |
|---|---|
| `readyCandidates({ tasks })` | `{ candidates: Task[], missingDeps: [{taskId, missing: string[]}] }` |
| `matchAgents({ task, agents, policies })` | `{ candidates: Agent[], excluded: [{agentId, reason}] }` |
| `detectCycles` / `topologicalOrder` / `scoreAndSort` / `detectConflicts` / `planDispatch` | 与 §1 一致 |

**其余定稿事实**

| 项 | 结论 |
|---|---|
| 排序权重 | `priority` 升序 → `waitingMs` 降序 → `taskId` 字典序；`score = priority*1e12 - waitingMs`；`now` 必须注入 |
| 环的处理 | `planDispatch` **整体拒绝**：`proposals: []`，快照里**每个** task 都带 `skipped.reason="cycle"`（100 task 含 1 环 → 100 条 cycle） |
| 写域 | Task/Run 可选 `files: string[]`；Run 在 claim 时从 Task 快照（之后 Task 变化不影响 Run）；空 `files` = 未声明 = 不判冲突；传 `ownership` 时按最长前缀映射，比精确交集更保守（多跳过不会错派） |
| 容量 | `policies` 随 claim 从 Scheduler 传入；`project.policy_json` 只作为快照数据源，不在 store 内合并，避免双源 |
| 快照 version | `MAX(events.seq)`；每次成功 claim 追加 `run.created` + `task.updated` 两条事件 ⇒ 严格单调（实测 `[0,2,4]`）；失败不增长 |
| 迁移 | `0003_scheduling.sql`：`projects.policy_json` / `tasks.files_json` / `runs.files_json`，schemaVersion 2→3，v1→v3 原地升级有测试 |
| claim 语义 | 单事务 7 步；失败分支错误码与 details 见 §2；同 `idempotencyKey` 重放返回既有 `{run,command,task}`（不新建、不写事件）；同 key 换 taskId → `VALIDATION_ERROR` |
| 无原子 claim 时 | Store 缺 `claimTask` → Backend 返回 500 并拒绝，**绝不**拼多次调用造出伪事务 |

**M3 门禁实测（`node scripts/m3-smoke.mjs`，5/5）**

```text
PASS  only the dependency root is dispatched; its dependents are reported blocked
PASS  a cycle is refused wholesale: no claim is made for cycle members
PASS  a run holds exactly one live lease; a second claim gets nothing
PASS  a restarted scheduler does not dispatch an already claimed task twice
PASS  after the root is accepted, the next task is dispatched
```
