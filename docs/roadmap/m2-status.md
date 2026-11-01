# M2 / v0.5 交付回执与 M3 准入结论

- 文档类型：里程碑交付回执（规范 §14 M2、§16.2、§19）
- 日期：2026-11-02
- 分支：`m0/baseline-and-p0`
- 执行者：Lead(ARCH) + `worker-runtime-spike`（runtime-sdk）+ `worker-database`（Run/租约/命令）+ `worker-backend`（内部 API）
- 关联：[m2-contracts.md](../architecture/m2-contracts.md)、[ADR-010](../architecture/adr/ADR-010-runtime-host-boundary.md)、[ADR-003](../architecture/adr/ADR-003-dispatch-reliability.md)、[m1-status.md](m1-status.md)

> **状态：M2 完成（MockRuntime 路径），M3 可以开始。真实 DSH 适配器仍不可用**——它只有"能力全 false"的占位，误用会以 `CAPABILITY_UNAVAILABLE` 明确拒绝，不会静默假装在跑。独立 QA 复核待下一轮补（本轮已有 `m2-smoke` 端到端门禁 + 各包测试）。

---

## 1. 强制交付回执（规范 §16.2）

```text
Task: ATK-201/202/204/205/206 (M2 / v0.5)
Source: branch m0/baseline-and-p0（M2 提交见 §6）
Changed: 新增 packages/runtime-sdk、packages/workspace、apps/runtime-host；
         packages/database 加 0002 迁移与 Run/租约/命令仓储；
         apps/backend 加 /internal/v1/*、内部凭据、事件生产者；
         contracts 加 STALE_GENERATION、run.log；scripts/m2-smoke.mjs
Build: node --check 全绿 | 无框架依赖；runtime-host 仅依赖 @atk/runtime-sdk
Tests: node scripts/test.mjs             -> 350 / 350 pass / exit 0
       node scripts/test-workspace.mjs   -> 321 / 321 pass / exit 0（33 文件）
       node scripts/check-boundaries.mjs -> PASS（6 packages / 5 edges / 0 cycles）
       node scripts/m1-smoke.mjs         -> 16 / 16（M1 无回归）
       node scripts/m2-smoke.mjs         -> 3 / 3（见 §3）
Contracts: internal API 形状、Run 状态机、租约语义（见 §2）；STALE_GENERATION(409)、run.log
Security: 内部凭据与浏览器双向隔离；Host 不写 DB；generation fencing 实测 409 且零写入
Evidence: 本文件 + m2-contracts + 各包 test/ + scripts/m2-smoke.mjs
Blockers: 无（MockRuntime 路径）；真实 DSH 仍待 RT-P07/P08 证据
Next: M3 Scheduler（DAG/优先级/Agent 匹配/租约与预算）
```

---

## 2. M2 关键设计裁决（已写进代码与契约）

| # | 裁决 | 理由 |
|---|---|---|
| 1 | `run.created` 只由 `createRun` 写；**`run.updated` 只由 `updateRunStatus` 写**（与状态变更同事务）；`appendRunEvent` 只承载 `run.log` | 早期实现两边都写，导致一次 `session.started` 产生**两条** `run.updated`。单一写入方消除了重复，也消除了"事件说 RUNNING、状态还 STARTING"的窗口 |
| 2 | `updateRunStatus(id, {status, generation?})`：给了 generation 就必须在**同一事务**里校验租约，不符 `STALE_GENERATION` 且零写入 | 纯状态批次没有 log 事件时，fencing 不能靠"先 reconcile 再写"（read-then-act 会并发穿透） |
| 3 | **释放租约 = 置为过期，不删行**；`reconcile` 完成后返回**已过期 lease（generation 保留）** 而不是 null | 删行会让 generation 从 1 重来，旧 Host 可能重新匹配 → fencing 失效 |
| 4 | Host 领到 `attempts > 1` 的命令**绝不重启会话**，直接上报 `session.ended(interrupted)` 并把命令置 FAILED | 上一个 Host 可能已启动会话但观测不到；"二次启动"比"保守中断"危险得多 |
| 5 | 同一 Run 同时只允许一个 live lease；claim 先重试过期命令、再取新命令 | ADR-003 的硬不变量 |
| 6 | 真实 DSH 适配器只以 `createDshRuntimeStub()` 形式存在（七项能力全 false、`probe()` false、`start()` 抛 `CAPABILITY_UNAVAILABLE`） | M0 的 Spike 已证明 RT-P07/P08 未验证；不允许"假装可用" |
| 7 | Runtime SDK 零运行时依赖（只声明 `@atk/contracts` 为允许依赖，src 不 import） | 接口即契约；不为了边界图多画一条边引入无意义耦合 |

---

## 3. M2 门禁（`node scripts/m2-smoke.mjs`，真实链路）

```text
PASS  a dispatch command is claimed, the session runs and the run COMPLETES
      COMPLETED, 2 run.updated (RUNNING -> COMPLETED), 1 run.log
PASS  a dead host's command is reclaimed as INTERRUPTED and never restarted
      INTERRUPTED, 0 sessions started by the recovery host
PASS  an outdated generation is refused and leaves the run untouched
      409 STALE_GENERATION, run unchanged (STARTING v0)
3/3 checks passed
```

该脚本用**真实 SQLite + 真实 HTTP 内部 API + 真实 SQLite 事务**，只有 Agent 会话是 MockRuntime。三条断言分别对应规范 §14 M2 门禁的"一个任务全链路完成""重启不误报完成""无法恢复时安全阻断"。

---

## 4. 关键实测证据（摘录）

- **claim 原子性**：`worker_threads` 两个真实 SQLite 连接 + 共享 barrier 同时 claim → 恰好 1 winner / 1 null，DB 租约与 winner 一致。
- **单事件不变量**：一次 `session.started` → `run.updated` 恰好 1 条；旧 generation 的 `updateRunStatus` → `STALE_GENERATION`，状态/version/事件数全不变。
- **SSE 真生产者**：连上 `/api/v1/events/stream` → 调内部 events 路由 → 客户端收到 `run.updated`（seq 2）与 `run.log`（seq 3），M1 的"只有心跳"问题解决。
- **双向凭据隔离**：内部 token 打 `/api/v1/*` → 403 `token-missing`；浏览器 token 打 `/internal/*` → 403 `internal-token-missing`；内部 token 只打印一次到 stdout，不落盘、不进日志、不进任何 HTTP 响应。
- **worktree 安全**：脏工作区默认拒绝删除（必须 `force+confirmClean`）；仓库内路径拒绝；分支不可复用。

---

## 5. 已知限制（M2 结束时）

1. **没有 Scheduler**：命令靠手工/脚本入队，没有 DAG、优先级、Agent 匹配与预算（M3）。
2. **真实 DSH 不可用**：RT-P07（真实 Magpie 路由）、RT-P08（多 Agent 并行）、受限执行、会话级模型选择仍未验证。
3. **单 Host 串行**：M2 的 Host 一次只驱动一个会话；并行执行是 M3 的事。
4. **workspace 与 Run 尚未自动绑定**：`createWorktree` 已实现并有安全测试，但 Host 还没在 claim 后自动建 worktree（留给 M3，因为需要 Scheduler 决定 base ref）。
5. **独立 QA 未做**：M2 目前只有 Lead 的端到端门禁与各包测试；独立复核留到下一轮，结论可能补充缺陷。
6. **JSON 仍是旧 CLI 的事实源**：SQLite 是 Web/执行侧的事实源，ADR-006 的停机切换仍未执行。

---

## 6. 提交

| commit | 内容 |
|---|---|
| `6f7321f` | M2 契约 + ADR-010 + packages/workspace + contracts 扩展 |
| `23bdd5d` | 迁移代数断言改为"已迁移" |
| `6a50c28` | 迁移记账断言改为按文件数推导 |
| （本次） | runtime-sdk / database M2 / backend 内部 API / runtime-host / m2-smoke |

回滚：删除 `apps/runtime-host` + `packages/runtime-*` 即回到 M1 形态（手工派发、无自动执行）；数据库删除即回到 JSON 单事实源。

---

## 7. M3 准入

**允许开始 M3**，但必须先定三件事：

| 事项 | 说明 |
|---|---|
| Scheduler 决策输入/输出 | `DispatchProposal(taskId, agentId, expectedTaskVersion, workspacePolicy)`，只经 Backend 事务落地 |
| Host 拉起方式 | Backend 启动时生成内部 token 并以子进程拉起 Host，还是 Launcher 统一管理（M5 的 `atk start` 最终形态） |
| worktree 生命周期 | Scheduler 决定 base ref 与冲突域；Host 在 claim 后建、完成/中断后按策略清理 |

M3 门禁（规范）：Mock 100 Task / 20 Agent 无双重有效租约；真实 2 Agent 不互相覆盖；Backend/Scheduler/Runtime 任一中断时状态可辨识并安全恢复。
