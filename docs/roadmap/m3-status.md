# M3 / v0.6 交付回执与 M4 准入结论

- 文档类型：里程碑交付回执（规范 §14 M3、§16.2、§19）
- 日期：2026-11-02
- 分支：`m0/baseline-and-p0`
- 执行者：Lead(ARCH) + `worker-runtime-spike`（scheduler-core）+ `worker-database`（快照/claim）+ `worker-backend`（内部端点）
- 关联：[m3-contracts.md](../architecture/m3-contracts.md)、[ADR-003](../architecture/adr/ADR-003-dispatch-reliability.md)、[ADR-010](../architecture/adr/ADR-010-runtime-host-boundary.md)、[m2-status.md](m2-status.md)

> **状态：M3 完成（确定性调度 + 原子领取）。Scheduler 能按 DAG 派发、拒绝环、无状态重启、同一 Run 单租约。M4（QA 闭环与返工）可以开始。** 独立 QA 尚未复核 M3；M2 的独立复核仍在进行中（已发现并修复 1 个 BLOCKER，见 §7）。

---

## 1. 强制交付回执（规范 §16.2）

```text
Task: ATK-301/302/303/304/305/306 (M3 / v0.6)
Source: branch m0/baseline-and-p0（M3 提交见 §6）
Changed: 新增 packages/scheduler-core、apps/scheduler、scripts/m3-smoke.mjs；
         packages/database 加 0003 迁移 + schedulingSnapshot/claimTask；
         apps/backend 加 scheduling/snapshot、tasks/:id/claim、scheduler/heartbeat
Build: 无构建步骤；scheduler-core 零依赖零 import（纯函数）
Tests: node scripts/test.mjs             -> 400 / 400 pass（含 QA-004 对抗 25 条）
       node scripts/test-workspace.mjs   -> 507 / 507 pass（隔离冻结树为 433/433）
       node scripts/check-boundaries.mjs -> PASS（8 packages / 6 edges / 0 cycles）
       node scripts/m1-smoke.mjs         -> 16 / 16（M1 无回归）
       node scripts/m2-smoke.mjs         -> 4 / 4（M2 无回归）
       node scripts/m3-smoke.mjs         -> 6 / 6（见 §3）
Contracts: scheduler-core 返回形状、快照 version=MAX(events.seq)、task.files/run.files、
           claim 7 步错误码（见 m3-contracts §2/§5）
Security: Scheduler 只提建议、不写业务状态；claim 必须走 store 单事务；内部凭据隔离沿用 M2
Evidence: 本文件 + m3-contracts + 各包 test/ + scripts/m3-smoke.mjs
Blockers: 无（M3 范围内）；独立 QA 待补
Next: M4 —— 独立 Review、返工环、人工验收、审查工作台
```

---

## 2. 交付内容

| 条目 | 交付物 | 验证 |
|---|---|---|
| ATK-301 | `packages/scheduler-core`：环检测、拓扑序、ready 候选、确定性排序、Agent 匹配、写域冲突、容量、`planDispatch` | 67 测试（含 100 task / 20 agent 压测与输入乱序确定性） |
| ATK-302 | 匹配与冲突：Function/Role/capability/IDLE；`files` 交集 + ownership 最长前缀 | 同上 |
| ATK-303 | Backend `scheduling/snapshot` + `tasks/:id/claim` + `scheduler/heartbeat` | 91 backend 测试（scheduler 18） |
| ATK-304 | 租约/generation 沿用 M2；claim 单事务、幂等键重放、真并发只 1 winner | database 77 测试 |
| ATK-305 | Scheduler 进程：无状态轮询、退避、心跳、优雅停止（不取消已派发 Run） | 7 测试 |
| ATK-306 | `m3-smoke`：依赖顺序/环拒绝/单租约/重启不重复/验收后继续派发 | 5/5 |

---

## 3. M3 门禁实测

```text
PASS  only the dependency root is dispatched; its dependents are reported blocked
      claimed M3-A; M3-B stays READY
PASS  a cycle is refused wholesale: no claim is made for cycle members
      M3-X/M3-Y skipped as cycle; 0 proposals for the whole snapshot
PASS  a run holds exactly one live lease; a second claim gets nothing
      2 claim(s), 1 live lease per run, extra claim null, probe runs cancelled
PASS  a restarted scheduler does not dispatch an already claimed task twice
      no duplicate claim; 0 active run(s) unchanged
PASS  after the root is accepted, the next task is dispatched
      M3-A accepted by legal transitions; claimed M3-B
PASS  the scheduler CLI process starts and completes a round
      CLI exit 0, round ok (0 proposal(s), 1 skipped)
6/6 checks passed
```

> 冻结时门禁是 5/5。QA-004 的 BLOCKER（`apps/scheduler/cli.mjs` 与 `apps/runtime-host/cli.mjs` 的 import 路径写错，两个进程入口都起不来，而库级测试与门禁全绿）修复后新增第 6 条——**spawn 真实 Scheduler CLI 进程**。见 §9。

要点：门禁用**真实 Backend + 真实 SQLite + 真实 Scheduler + 真实 Host**，只有 Agent 会话是 MockRuntime；"接受"用公开 API 走 Task 状态机的合法链（`RUNNING→REVIEWING→INTEGRATING→AWAITING_ACCEPTANCE→DONE`），因为 **M3 不做自动验收**。

---

## 4. 关键实测证据

- **环整体拒绝**：快照里存在环时 `proposals: []`，且每个 task 都带 `skipped.reason="cycle"`（不是只跳过环成员）。
- **确定性**：同一快照两次 `planDispatch` 的 JSON 字节相等；tasks/agents/runs 输入数组打乱后结果仍相等；100 task / 20 agent 压测同样成立。
- **claim 原子性**：`worker_threads` 两个真实 SQLite 连接 + barrier 同时 claim 同一 Task → 恰好 1 winner / 1 `TASK_VERSION_CONFLICT`，库内仅 1 个 Run、2 条事件。
- **失败零写入**：7 步失败分支逐个断言 fingerprint（version/tasks/runs/agents/events）前后完全一致。
- **幂等**：同 `idempotencyKey` 重放返回同一 `{run,command}`，runs 数与事件数均不增长。
- **version 单调**：`MAX(events.seq)`，实测 `[0,2,4]`（每次 claim 追加两条事件）。

---

## 5. 已知限制（M3 结束时）

1. **没有自动验收**：Run 完成后 Task 不会自动前进；人工/CLI 走合法状态链（M4 的 Review/Approval 才闭环）。
2. **Scheduler 单实例**：没有选主；多 Scheduler 会同时提议，靠 Backend 原子 claim 兜底（正确但不经济）。
3. **无预算/限流**：规范 §8 的 token 预算与暂停/恢复/取消策略未实现。
4. **workspace 未接入 Host**：`createWorktree` 已实现，但 claim 后自动建 worktree 留给 M4/M5（需要 base ref 策略）。
5. **真实 DSH 仍不可用**：能力全 false 占位。
6. **M3 未做独立 QA**；M2 的独立复核进行中。

> 该条已被 QA-004 取代，见 §9。

---

## 9. 独立 QA（QA-004）结论与缺陷闭环

审查对象：M3 冻结提交 `bc8b2b0`..`550b552`（隔离 `git archive` + 每包 `@atk/*` 指向解包树）。报告：[qa-review-m3.md](../architecture/qa-review-m3.md)，套件：`test/m3-qa-adversarial.test.mjs`（25 条）。

**冻结 SHA 的结论：不能标记完成（1 BLOCKER）**；修复后可以。当前状态：**1 BLOCKER + 6 MINOR 中 4 条已关闭，2 条（QA4-02/03）在修，1 条文档（QA4-07）已更新**。

| 缺陷 | 严重度 | 状态 |
|---|---|---|
| QA4-01 两个 CLI 入口（scheduler / runtime-host）import 路径写错（`./client.mjs` 应为 `./src/client.mjs`），`--help` 都起不来，而库测试与门禁全绿 | BLOCKER | 已修；新增两个进程级 `cli.test.mjs` 与 m3-smoke 第 6 条真实 CLI check |
| QA4-02 `idempotencyKey` 重放不跨 Backend 重启（route 进程内 Map 先于 store 持久幂等预检） | MINOR | 修中（改为先尝试 store.claimTask） |
| QA4-03 写域精确字符串比较，`./`、反斜杠、**目录前缀** 可绕过 | MINOR | 规范化已修；目录前缀（segment-aware overlap）修中 |
| QA4-04 `detectCycles` 漏报共享节点的简单环 | MINOR | 已修（枚举 SCC 内全部简单环，有上限与确定性） |
| QA4-05 `readyCandidates.missingDeps` 形状不符契约 §5 | MINOR | 已修（`{taskId, missing[]}`） |
| QA4-06 m3-smoke 的自证面：环拒绝用合成快照、check5 的 Host 步骤未被断言、不覆盖双 Scheduler 并发 | MINOR（诚实性） | 已补：真实 CLI 进程 check；check5 改走 M4 人工验收；双进程并发由 QA 独立实测（3 task/3 run/3 command，无重复派发） |
| QA4-07 `m3-status` 数字过期 | MINOR（文档） | 已更新（§1/§3） |

**变异测试（冻结隔离树，基线 66/66）**：3/3 被抓——跳过 claimTask 依赖检查、环时仍返回非环 proposals、去掉 claimTask 持久幂等重放。

**QA 的观察项（不判缺陷）**：route 7 步预检与 store 事务重检重复（安全）；store 缺 `claimTask` 时 500 拒绝（正确）；`claimTask` 的 `function/role` 入参被忽略（以 DB 为准）；`planDispatch` 对已有活跃 Run 的 READY task 静默丢弃（无 skipped 原因）；Scheduler 循环不捕获 `planDispatch` 抛错（非法 `MAX_PER_AGENT` 会崩溃而非 exit 2）；双 Scheduler 计量会高估 claimed（DB 不重复）。

**教训（与 M2 的 QA3-01 同类）**：**库级测试全绿不等于产品入口可运行**。从此 M2/M3 门禁都必须包含"真实进程"检查，而不只是 import 库。

**边界（QA PASS ≠ 生产可用）**：真实 DSH 不可用、无预算/限流、Scheduler 单实例无选主、workspace 未接入 Host、无自动验收、JSON 仍是旧 CLI 事实源。
7. **写域 `files` 是可选的**：未声明即不判冲突；M4 起应强制声明。

---

## 6. 提交

| commit | 内容 |
|---|---|
| `bc8b2b0` | packages/scheduler-core（纯函数 DAG/排序/匹配/冲突/planDispatch） |
| `b116bb6` | packages/database：0003 迁移 + schedulingSnapshot + claimTask |
| `23fa52a` | apps/backend：snapshot + atomic claim + scheduler heartbeat |
| `0824f8b` | apps/scheduler + scripts/m3-smoke.mjs |
| 本提交 | m3-contracts §5 + 本回执 + CHANGELOG |

回滚：删除 `apps/scheduler` + `packages/scheduler-core` 即回到 M2 形态（手工入队、无自动派发）。

---

## 7. 与 M2 复核的交叉

M2 的独立复核在执行中发现一个 **BLOCKER**（`apps/runtime-host` 的 result 请求缺 `ownerId` → 400 被 `safe()` 吞掉 → dispatch command 永不 DONE/FAILED，而 `m2-smoke` 只断言 Run 状态所以仍是 3/3 绿）。已在 M3 期间修复并强化门禁：

- host client 现在发送 `ownerId` 与契约要求的 `exitCode/summary/error`；
- 启动失败会先上报 `session.ended(failed)` 再关命令，Run 不会卡在 STARTING；
- `stop()` 不再对已结束会话调用 `runtime.stop`（避免非法 `COMPLETED→CANCELLED`）；
- **门禁新增**：dispatch command 必须是 DONE（崩溃路径必须是 FAILED + reason）、不允许残留 PENDING/CLAIMED、`host.stats.errors === 0`——被吞的 400 现在会让门禁变红。

教训已写进流程：**端到端门禁必须断言"最终业务事实"（命令最终状态），而不只是过程状态（Run 状态）**。

---

## 8. M4 准入

**允许开始 M4**，需要先定：

| 事项 | 说明 |
|---|---|
| Review/Approval 实体写入路径 | `reviews` / `approvals` 表已有（M1 建），M4 补 Store 方法与 API |
| 返工环 | `REVIEWING → RUNNING` 等返工边需要 Run/session 上下文，M4 与 ReviewAttempt 一起设计 |
| 人工验收 | `Approval` 绑定 targetHash，换版即失效（M0 已定契约） |
| 审查工作台 | Web 的"审查与验收"从占位变真页面（仍双语） |
| 写域强制 | M4 起 claim 要求 `files` 声明，否则拒绝或标记 |

M4 门禁（规范）：伪回执/自审/失效 Hash/缺测试均无法进入"已通过集成"或"人工验收"；返工不超过上限；人工验收后才 `DONE`。
