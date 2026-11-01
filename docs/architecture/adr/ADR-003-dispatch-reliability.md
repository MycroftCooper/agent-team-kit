# ADR-003：调度消息用持久化命令 + 幂等认领 + 对账

- 状态：**Proposed**
- 日期：2026-11-02
- 决策者：ARCH
- 关联：规范 §6.1、§7.2、§8.1、§8.3、§14（ATK-304）；ADR-002

## 背景

调度要跨越三个进程：Scheduler 决策 → Backend 持久化 → Runtime Host 执行。任何一段都可能崩溃在“已决定但未生效”“已启动但结果未知”的中间态。规范 §8.3 明确要求：启动前失败要安全重试并保留原幂等键；启动结果未知必须先对账，不能盲目二次启动。

## 决策

1. **决策与执行分离**：Scheduler 只产出 `DispatchProposal(taskId, agentId, expectedTaskVersion, workspacePolicy)`，不落地业务状态。
2. **Backend 在一个事务内完成原子领取**（规范 §6.1 原文要求）：
   校验 Task=READY → 依赖已完成 → 资源/写域/预算 → CAS 更新版本 → 新建 Run → 建租约 → 写 `dispatch_commands`（带唯一 `idempotency_key`）→ 追加事件。任一步失败全部回滚。
3. **命令是持久化对象**：Runtime Host 通过 `GET/POST /internal/v1/dispatch/claim` 原子领取命令，拿租约（`owner_id` + `generation` + `claimed_until`），执行完幂等写回 `POST /internal/v1/dispatch/:id/result`。
4. **单调 generation 做 fencing**：运行中的每次心跳续租提升 generation；旧进程的上报若 generation 落后一律拒绝，防止“僵尸 Runtime”覆盖新运行。
5. **对账先于重试**：启动结果未知时，Runtime Host 先按 `runId/sessionId` 查询真实会话；无法确认才标记 `INTERRUPTED` 并安全阻断，禁止盲目二次启动。
6. **Scheduler 完全无状态**：内存里不保存队列真值；重启后从 Backend 快照重建。轮询只是漏事件的兜底。
7. 心跳丢失 → `SUSPECT`（观察层状态），隔离旧工作区写入后才允许恢复/重派。

## 理由

- “至少一次投递 + 幂等消费”在本地单机场景足够可靠，且比消息中间件简单得多（规范明确不引入 Redis/RabbitMQ）。
- 把租约与 generation 写在同一个事务里，才能保证“不存在双重有效租约”这一硬验收标准。
- 状态只在 Backend 一处变更，使审计事件与业务状态天然一致。

## 后果

**正面**：崩溃点可枚举、可测试（failure injection 覆盖 claim / 命令持久化 / 已启动未确认 / 结果写回）；M3 的负面测试（20 Agent、100 Task、含循环依赖与断线）有明确断言对象。

**负面 / 代价**：一次派发需要多次内部 HTTP 往返；租约续期与超时参数需要调优；对账逻辑是额外的代码面。

**缓解**：内部 API 全部带 `requestId` 与幂等键；租约超时与心跳间隔配置化；对账表 `runtime_sessions` 保存 `nativeSessionId` 与 `reconnectInfo`。

## 替代方案

| 方案 | 为什么否决 |
|---|---|
| 内存队列（EventEmitter）直连 | 进程崩溃即丢失派发意图；无法证明“不丢任务” |
| Scheduler 直接写数据库 | 违反 ADR-002 单写者；调度决策与事务耦合，回滚困难 |
| 引入消息队列 | 违反本地优先与非目标；运维复杂度远超收益 |

## 兼容与迁移

`dispatch_commands` / `run_leases` 是新增表（规范 §6 已给字段建议）。M1 建表但先只被 Backend 使用；M2 接 Runtime Host；M3 接 Scheduler。

## 回滚

命令表可清空并重建（无业务真值）；租约过期即失效。回滚到 M1 状态时 Scheduler 不启动，派发回到手工 `atk task`。
