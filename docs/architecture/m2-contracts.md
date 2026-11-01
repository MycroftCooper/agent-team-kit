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
