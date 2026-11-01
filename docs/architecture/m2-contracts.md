# M2 契约：Runtime SDK / 内部 API / Run 生命周期 / 工作区

- 状态：M2 实施契约（三个 Worker 共同依据）
- 关联：规范 §8、§9、§7.2；ADR-003（持久化命令 + 幂等认领 + 对账）、ADR-004（Runtime 边界）、ADR-008（内部凭据）、ADR-010
- 纪律：任何形状变更先 message Lead；不允许各包自造字段。

---

## 0. M2 范围与硬边界

**做**：`packages/runtime-sdk`（接口 + MockRuntime）、Run 生命周期与事件生产者、Backend 内部 API、`apps/runtime-host`（领命令 → 起会话 → 回传事件 → 对账）、`packages/workspace`（git worktree）。

**不做（M2 明确不做）**：真机 DSH 适配器标"可用"（RT-P07/P08 未验证 → 只允许 experimental 且能力全 false）、Scheduler 决策（M3）、多 Agent 并行调度、Worktree 自动合并。

**硬不变量**：
1. Runtime Host **不写数据库**，只经 `/internal/v1/*`。
2. 任何"启动结果未知"必须先对账，禁止盲目二次启动。
3. Run 状态由 Backend 事务推进；Host 只是报告事实。
4. 内部凭据与浏览器会话完全分离（ADR-008 §5）。

---

## 1. `packages/runtime-sdk`

```ts
export interface RuntimeCapabilities {
  canStart: boolean; canSend: boolean; canObserveStructuredEvents: boolean;
  canStop: boolean; canReconnect: boolean; canSpecifySessionModel: boolean;
  canRunRestricted: boolean;
}
export interface RuntimeHealth { ok: boolean; kind: string; version?: string; detail?: string; capabilities: RuntimeCapabilities; }
export interface StartRunInput {
  runId: string; taskId: string; prompt: string;
  cwd: string;                 // 会话工作目录（worktree 或项目根）
  model?: string;              // 仅在 canSpecifySessionModel 时使用
  env?: Record<string, string>;
  timeoutMs?: number;
}
export interface RuntimeSessionHandle { sessionId: string; nativeSessionId?: string; startedAt: string; capabilities: RuntimeCapabilities; }

export type RuntimeEvent =
  | { type: "session.started"; sessionId: string; at: string }
  | { type: "output"; sessionId: string; stream: "stdout" | "stderr"; text: string; at: string }
  | { type: "state"; sessionId: string; state: "running" | "idle" | "waiting_input"; at: string }
  | { type: "session.ended"; sessionId: string; at: string; reason: "completed" | "failed" | "cancelled" | "interrupted"; exitCode: number | null }
  | { type: "log"; sessionId: string; level: "info" | "warn" | "error"; message: string; at: string };

export interface AgentRuntime {
  readonly kind: string;
  probe(): Promise<RuntimeHealth>;
  capabilities(): Promise<RuntimeCapabilities>;
  start(input: StartRunInput): Promise<RuntimeSessionHandle>;
  send(sessionId: string, prompt: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  reconnect(sessionId: string): Promise<RuntimeSessionHandle | null>;
  subscribe(sessionId: string, sink: (event: RuntimeEvent) => void): Promise<() => void>;
}
```

**MockRuntime 要求**：确定性、可脚本化、无网络无子进程：
- 场景 DSL：`{ steps: [{ emit: RuntimeEvent }, { delayMs }, { end: reason, exitCode }] }`；`start()` 返回稳定 `sessionId`；
- 可注入故障：`startFails`、`crashAfterMs`、`ignoreStop`、`neverEnds`、`slowStartMs`；
- `capabilities()` 可配置；默认全 `true`（用于测试），**但 DSH 适配器的默认必须是全 `false`**；
- 事件顺序可断言；`subscribe` 返回 unsubscribe；`stop()` 触发 `session.ended(cancelled)`（除非 `ignoreStop`）。

---

## 2. Backend 内部 API（`/internal/v1`，不对浏览器开放）

**鉴权**：`x-atk-internal: <token>`。token 由 Backend 启动时生成并通过环境变量 `ATK_INTERNAL_TOKEN` 传给子进程；**不接受** `x-atk-token` 浏览器会话；缺/错 → 403 `NOT_AUTHORIZED`，`details.reason = "internal-token-missing" | "internal-token-invalid"`。仍校验 `Host` 为 loopback。

| Method | Endpoint | 用途 |
|---|---|---|
| GET | `/internal/v1/dispatch/claim?owner=<id>&leaseMs=<n>` | 原子领取一条 `PENDING` 命令 → `CLAIMED`，返回 `{ command, run, task, lease: { ownerId, generation, claimedUntil } }`；无活 → `204` |
| POST | `/internal/v1/dispatch/:id/result` | 幂等写结果 `{ status: "DONE"|"FAILED", exitCode?, summary?, error? }`；generation 不符 → 409 `STALE_GENERATION` |
| POST | `/internal/v1/runs/:id/renew` | `{ ownerId, generation, leaseMs }` → 续租 + `generation+1`；不匹配 → 409 |
| POST | `/internal/v1/runs/:id/events` | 批量上报 `{ generation, events: RuntimeEvent[] }`；generation 必须等于当前租约；写入 Run 事件与 SSE |
| POST | `/internal/v1/runtime/heartbeat` | `{ ownerId, status: "IDLE"|"BUSY", capabilities, sessions: string[] }` |
| GET | `/internal/v1/runs/:id/reconcile` | 对账：返回该 Run 的权威状态与已知 session；Host 重启后先查这里 |

**事件映射**：Runtime Host 上报的 `RuntimeEvent` → Backend 追加 `events`（`run.updated` / `run.log`），并推进 Run 状态：
`session.started` → `RUNNING`；`state` 不改变 Run 状态；`session.ended(completed)` → `COMPLETED`；`(failed)` → `FAILED`；`(cancelled)` → `CANCELLED`；`(interrupted)` → `INTERRUPTED`。
每次状态变化都追加一条事件（这解决了 M1 的"UI 实时没有业务事件"问题）。

**Run 状态机**：`QUEUED → STARTING → RUNNING → COMPLETED | FAILED | CANCELLED | INTERRUPTED`，`STARTING` 只能到 `RUNNING|FAILED|INTERRUPTED`；终态不可再迁出。

---

## 3. 数据层新增（`packages/database`）

表已存在（M1 建好），M2 补仓储方法与语义：
- `dispatch_commands`：`id, runId, commandType, payloadJson, status(PENDING|CLAIMED|DONE|FAILED|EXPIRED), idempotencyKey, ownerId, generation, claimedUntil, attempts, createdAt`
- `run_leases`：`runId, holderId, generation, expiresAt, lastHeartbeatAt`
- Store 新增（严格照此签名）：
```js
createRun(dto): Run                       // 由任务创建，状态 STARTING（命令已持久化）
getRun(id): Run
updateRunStatus(id, { status, exitCode?, endedAt? }): Run   // 校验状态机
enqueueDispatchCommand({ runId, commandType, payload, idempotencyKey }): DispatchCommand
claimDispatchCommand({ ownerId, leaseMs }): { command, lease } | null   // 事务 + 原子
completeDispatchCommand({ id, ownerId, generation, status, result }): DispatchCommand
renewRunLease({ runId, ownerId, generation, leaseMs }): Lease
appendRunEvent({ runId, generation, events })  // 校验 generation → 写入 events 表
reconcileRun({ runId }): { run, lease, sessions }
```
- 所有 CAS/租约操作在单事务内；`STALE_GENERATION` 用契约新增错误码（Lead 负责加 `packages/contracts`）。
- 状态推进必须追加 `events`（`run.created` / `run.updated`），供 SSE 消费。

---

## 4. `packages/workspace`（Lead 实现，M2 只做最小安全集）

```js
createWorktree({ repoPath, projectId, runId, baseRef }): { id, runId, path, branch, baseCommit }
listWorktrees({ repoPath })
removeWorktree({ repoPath, id, force = false, confirmClean = false })
```
- 路径：`%LOCALAPPDATA%\AgentTeamKit\worktrees\<projectId>\<runId>`（仓库外）。
- 创建前校验：`repoPath` 是 git 仓库、`baseRef` 可解析、目标路径不存在、`runId` 已登记。
- 删除前检查：未提交变更 / 未跟踪文件 / 活跃进程 → **默认拒绝**；`force` 需同时 `confirmClean` 并写审计。
- 不使用 shell 拼接；`git` 用 argv 数组，`cwd` 固定。

---

## 5. M2 验收（门禁，MockRuntime 真跑）

```bash
node scripts/test-workspace.mjs                  # 全部包测试
node scripts/m2-smoke.mjs                        # Lead 写的端到端门禁
```
`m2-smoke` 必须覆盖：
1. 建任务 → 建 Run + dispatch command（QUEUED/STARTING）→ Host 领命令（CLAIMED，有 lease/generation）；
2. Host 用 MockRuntime 起会话 → `session.started` → Run `RUNNING` → 事件落库且 SSE 收到 `run.updated`；
3. `session.ended(completed)` → Run `COMPLETED`，dispatch command `DONE`；
4. **重启对账**：Host 跑到一半被杀 → 新 Host 启动先 `reconcile` → Run 标 `INTERRUPTED`（**不得** `COMPLETED`），且不会二次启动同一 Run；
5. **generation fencing**：旧 Host 用过期 generation 上报 → 409，Backend 状态不被覆盖；
6. 失败路径：`startFails` → Run `FAILED` + 可读错误；`neverEnds` → 超时后 `INTERRUPTED`。

---

## 6. 已实现状态与最终裁决（M2 收尾）

实现与本文档的差异已收敛为下面 7 条裁决，代码、测试与 [m2-status.md](../roadmap/m2-status.md) 以此为准：

| # | 裁决 |
|---|---|
| 1 | `run.created` 只由 `createRun` 写；**`run.updated` 只由 `updateRunStatus` 写**（同事务）；`appendRunEvent` 只承载 `run.log`（收到 `run.updated` 按普通事件写入，不做特殊处理）。早期两边都写会产生**两条** `run.updated` |
| 2 | `updateRunStatus(id, { status, exitCode?, endedAt?, generation? })`：给了 `generation` 就在同一事务校验租约，不符 → `STALE_GENERATION`（409，`details {runId, generation, currentGeneration, reason}`）且零写入；不给则 M1 行为 |
| 3 | `appendRunEvent({ runId, generation, events })`：只校验 generation 与租约存在/未过期；**`events: []` 是合法的纯 fence**；不推进 Run 状态 |
| 4 | **释放租约 = 置为过期，不删行**；`reconcileRun` 对已完成的 Run 返回**已过期 lease（generation 保留）** 而不是 null。删行会让 generation 从 1 重来，旧 Host 可能重新匹配 → fencing 失效 |
| 5 | Host 领到 `attempts > 1` 的命令**绝不重启会话**：上报 `session.ended(interrupted)` 并把命令置 `FAILED`（`result.reason = "reclaimed-after-lost-lease"`） |
| 6 | 同一 Run 同时只允许一个 live lease；claim 先重试过期命令、再取新命令 |
| 7 | Runtime SDK 零运行时依赖（只声明 `@atk/contracts` 为允许依赖，src 不 import）；`createDshRuntimeStub()` 七项能力全 false、`probe()` false、所有操作 reject `CAPABILITY_UNAVAILABLE` |

**内部 API 最终响应形状**

| Endpoint | 响应 |
|---|---|
| `GET /internal/v1/dispatch/claim` | 200 `{ command, run, task, lease: { ownerId, generation, claimedUntil } }` / 204 无活 |
| `POST /internal/v1/dispatch/:id/result` | 200 `{ command, run }`（同 generation 幂等） / 409 `STALE_GENERATION` |
| `POST /internal/v1/runs/:id/renew` | 200 `{ lease }`（generation+1） / 409 |
| `POST /internal/v1/runs/:id/events` | 200 `{ run, appended, skipped }`（`appended` 只含 `run.log`；纯状态批次为 `[]`） / 409 |
| `POST /internal/v1/runtime/heartbeat` | 200 `{ ok, ownerId, status, receivedAt }` |
| `GET /internal/v1/runs/:id/reconcile` | 200 `{ run, lease\|null, sessions: [] }`（M2 `sessions` 恒为空数组） |

**门禁实测（`node scripts/m2-smoke.mjs`）**：3/3 通过——COMPLETED 且 `run.updated` 恰好 2 条（RUNNING→COMPLETED）无重复；死 Host 的命令被回收后 `INTERRUPTED` 且恢复 Host **0 次启动**；过期 generation → `409 STALE_GENERATION` 且 Run 保持 `STARTING v0`。

> 该段为初版门禁记录（3 项）。QA-003 后门禁扩展为 4 项（新增"事件已落库、result 未发出的崩溃窗口"），见 §7。

---

## 7. QA-003 之后的补充裁决

独立复核在 M2 冻结版本上发现 2 个 MAJOR / 5 个 MINOR，下面是修正后的**契约补充**（代码与测试以此为准）：

| # | 裁决 |
|---|---|
| 8 | **租约过期即失效**：`updateRunStatus(..., {generation})` 与 `completeDispatchCommand(...)` 必须在同一事务内同时校验 `generation` **与** `claimed_until > now`；过期 → `STALE_GENERATION`，`details.reason = "lease-expired"`，零写入。原先只比 generation，导致租约过期后、他人 reclaim 前旧 Host 仍能写终态 |
| 9 | **命令终态可从 Run 终态推导**：`sweepDispatchCommands({ now })` 关闭所有 `CLAIMED` 且 Run 已终态的命令（Run `COMPLETED` → 命令 `DONE`；其余终态 → `FAILED`），`result_json = {derivedFrom:"run-terminal", runStatus}`。Backend 在**每次 claim 之前**先 sweep，并暴露 `POST /internal/v1/dispatch/sweep`。这填补"事件已落库、result 未发出"的崩溃窗口——否则命令会永久停在 CLAIMED |
| 10 | **空 `events: []` 是纯 fence，但也必须校验 generation**：合法时 200，stale 时 409。路由不能在"没有事件要写"时跳过 store 调用 |
| 11 | **409 details 形状统一**：`{runId | commandId, generation, currentGeneration, reason}`，`reason ∈ generation-mismatch | lease-missing | lease-expired` |
| 12 | **迁移 runner 容错**：`duplicate column name` 视为"该迁移已应用"（记 WARN 后继续），使 0002/0003 在记账行丢失或手工重跑时自愈，与 0001 的 `IF NOT EXISTS` 风格一致 |
| 13 | **Host 重启必须 reconcile**：Host 在启动后、领取新命令前，先对持久化的在途记录逐个调用 `reconcile`；终态记录清除，未终态记录保留交给 reclaim 路径（`attempts > 1` → `INTERRUPTED`）。**绝不**根据本地记录猜"完成" |
| 14 | **门禁必须断言最终业务事实**：`m2-smoke` 必须断言 dispatch command 的最终状态（`DONE` / `FAILED` + reason）、不允许残留 `PENDING`/`CLAIMED`、且 `host.stats.errors === 0`。只断言 Run 状态会让"被吞掉的 400"看起来是绿的（QA-003 BLOCKER 的根因） |

**§5 覆盖说明（诚实版）**：§5 列出的 6 项中，门禁脚本直接覆盖 1/2/3/4/5；`startFails` 与 `neverEnds` 由 `apps/runtime-host` 的包测试覆盖（不在门禁里重复），`reconcile` 由 Host 的 `recover()` 测试 + Backend 的 sweep 路径覆盖。门禁（4 项）与包测试的分工以此为准，不再声称"门禁覆盖全部 6 项"。
