# M6.2 独立验收报告（QA-04 / QA-05）——最终签字版

- 审查者：`qa-reviewer`；未改产品代码、未 commit。
- 审查对象：`fix/m6.2-runtime-execution` 当前工作区（HEAD `e1469a9`；QA 测试与报告为未提交改动）。
- 交付：`test/qa-m62-consistency.test.mjs`（QA-04）、`test/qa-m62-integration.test.mjs`（QA-05）、本报告。
- 结论：**M6.2 QA 通过，可标记完成/可签字。**（边界见 §7；签名基于当前工作区，若产品/测试再变需重跑）

## 1. 结论与真实数字

```text
node --test test/qa-m62-consistency.test.mjs test/qa-m62-integration.test.mjs
ℹ tests 14 | pass 14 | fail 0 | skipped 0

node scripts/test.mjs            → 528 tests / 528 pass / 0 fail / 0 skip
node scripts/test-workspace.mjs  → 717 tests / 717 pass / 0 fail / 0 skip
node scripts/check-boundaries.mjs→ PASS (9 packages, 7 edges, 0 cycles)
m1-smoke 16/16 | m2 4/4 | m3 6/6 | m4 9/9 | m5 4/4 | m6 12/12
```

| 套件 | tests | pass | fail | skip |
|---|---|---|---|---|
| QA-04 `qa-m62-consistency` | 6 | 6 | 0 | 0 |
| QA-05 `qa-m62-integration` | 8 | 8 | 0 | 0 |

两个原 skip（05.7/05.8）已按实现转正，见 §4，均为实际执行而非“写成 pass”。

## 2. QA-04：SQLite / Memory 共同契约

全部在两份**真实 store** 上各跑一遍；不 import `apps/backend/test/fake-store.mjs`。

| # | 覆盖 | 结果 |
|---|---|---|
| 04.1 | claim + 同 key 幂等重放 + 冻结 spec/workspace；双 store 的 spec 内容/`specHash` 相等 | PASS |
| 04.2 | heartbeat/availability：无心跳、新鲜、过期、capacity=0；绝不 IDLE-alone | PASS |
| 04.3 | Review → PASS → INTEGRATING → integration → AWAITING → approval → DONE，事件 principal 一致 | PASS |
| 04.4 | event batch 原子性、去重、坏批次 StoreError 零写入；双 store eventId 投影一致 | PASS |
| 04.5 | reconcile / renew / 错误 owner 的 STALE_GENERATION fence 一致 | PASS |
| 04.6 | SQLite 注入事务中途失败：Task/event 无部分写入 | PASS |

### 缺陷闭环：QA-M62-01（MAJOR，已修并复验）

- 发现：同一 claim 输入，SQLite 先 CAS 到 CLAIMED 再冻结 spec → `taskVersion=1`；Memory 先冻结 → `taskVersion=0`，`specHash` 不同。
- 影响：同一 Run 的冻结 spec 随 store 实现变化，破坏 F05 的“执行中改任务不改变当前 Run”和双 store 等价。
- 修复：WP2 commit `142df70`（claim 前冻结，以 claim 前版本为准）。
- 复验：独立 probe 与 QA-04.1 均显示双 store `specTaskVersion=0`、`specHash` 相等。**CLOSED。**

## 3. QA-05：真实执行链路集成

真实 HTTP Backend + 真实 SQLite + 真实 Scheduler/Client + 真实 Host/Client + 真实 git worktree；Runtime 为 MockRuntime。未使用生产 P4/交易凭据。

| # | 场景 | 结果 |
|---|---|---|
| 05.1 | 含 FE/BE 子任务的需求，真实 Scheduler `runOnce` 自动领取 → 2 个 CLAIMED/2 个独立 Run | PASS |
| 05.2 | claim 带 worktree workspace/baseCommit/targetBranch；Host 获冻结 spec；runtime cwd = run.workspace.path；prompt 含 title/description/files；worktree 分支正确、base 仓库不被写；run COMPLETED、command DONE、事件含 taskVersion/specHash | PASS |
| 05.3 | 两 Run 独立 worktree/独立 cwd/互不可见未提交文件，均注册 | PASS |
| 05.4 | 独立 QA 以 AGENT assignment + reviewer runId 提交；PASS → INTEGRATING → integration → AWAITING；不自动 DONE；Human Approval 后才 DONE | PASS |
| 05.5 | CHANGES_REQUESTED → REJECTED → rework READY（attempt 2）→ Scheduler 重新领取、新 Run | PASS |
| 05.5b | Runtime 故意失败 → Run FAILED、command 终态、result 不假报成功 | PASS |
| 05.7 | 真实子进程 SIGKILL 后：worktree + 未提交文件保留；新 Host `recover()` 报 interrupted（lease-expired/backend-sweep）；缺 worktree → RECOVERY_REQUIRED 不重建；同一 Run 再 claim `starts=0` | PASS（见 §4） |
| 05.8 | Scheduler `workspacePolicy` 完整 → claim.workspace=worktree；不完整 → 400 `workspace-policy-incomplete` + `missing`，Task 保持 READY/零 Run；Mock/`none` → kind none | PASS（见 §4） |

链路断言：任务/回执由 Scheduler/Backend/Host 传递，无需手工复制；失败有确定终态；不使用真实凭据；跨进程重启恢复已覆盖。

## 4. 两个 skip 的转正依据（真实执行）

### QA-05.7（WP3，commit `e1469a9` 起）

- 测试实际运行 `apps/runtime-host/test/restart-recovery.test.mjs`（该套件会 `spawn` 真实 Host 子进程、写 worktree、`SIGKILL` 后重启恢复）；同时断言该测试源仍包含 `SIGKILL` 与 `RECOVERY_REQUIRED`，防止未来被人为弱化。
- 断言：子进程测试 **2/2 pass**、exit 0；因此 05.7 不再是“只引用 WP3 报告”，而是每次 QA 全量都会真实执行。

### QA-05.8（WP1，commit `0791773`）

- 完整 policy：Scheduler 的 `workspacePolicy={kind:"worktree",root,baseCommit,targetBranch}` 经 `runOnce` → claim → 真实 Run `workspace.kind=worktree`，路径在 root 下、baseCommit 匹配、`run.workspace == spec.workspace`，Task CLAIMED。
- 不完整 policy：`{kind:"worktree",targetBranch}` → 400 `VALIDATION_ERROR`、`details.reason="workspace-policy-incomplete"`、`details.missing` 至少含 `baseCommit`；Task 保持 READY、零 Run（不静默退化 none）。
- Mock/`none`：`workspacePolicy:{kind:"none"}` → Run workspace kind none。
- 该测试已实际跑过；不是 skip。

## 5. Legacy fixture 迁移（F10 / F05）

- **F10**：m3 `makeAgent` 补 `recordHeartbeat`（typeof 保护）、纯 planner `agentRow` 补 `lastHeartbeatAt/capacity`；m5 `sandbox.seed` 补 `recordHeartbeat`。仅 fixture，断言未动；m3 **25/25**、m5 **24/24**。
- **F05**：QA-02 fake claim 构造合法 `TaskExecutionSpec`（schemaVersion 1、kind none、workspace 记录），保留 F02/F07 ack/fencing 断言；加 Memory store parity 用例；QA-02 **15/15**。未发现产品回归，也未改弱断言。
- scratch：仓库根无 `kept.txt` 等遗留；m5 的 `keep.txt` 位于 `os.tmpdir()` 临时目录，不属于工作树污染。

## 6. M6.2 变异测试（隔离树：HEAD `e1469a9` + 仅 QA 测试 overlay）

基线（每个目标）：QA-04.1、QA-05.3、scheduler heartbeat-gating、QA-05.8 均绿。每处变异后恢复并校验 SHA-256 与原始文件一致。

| 变异 | 原始 sha256 | 变异 sha256 | 结果 | 恢复校验 |
|---|---|---|---|---|
| M1 claim 冻结顺序：sqlite `freezeTaskSpec` 用 claim 后版本 | `f6ffa2c6…47b6a` | `dc50c15d…03f1` | **QA-04.1 红**（双 store spec 不等） | restored = original |
| M2 worktree 唯一性：`resolveClaimWorkspace` 忽略 runId，路径固定 `shared` | `58babfc5…1ec6` | `65d64b23…bfb7d` | **QA-05.3 红**（两 Run 同一路径） | restored = original |
| M3 heartbeat gating：`agentAvailability` 无条件 available | `5274bc99…eccb` | `7928c111…87be` | **scheduler heartbeat-gating 2/2 红** | restored = original |
| M4 WP1 桥禁用：`workspaceFromPolicy` 直接返回 undefined | `d9c6be1f…32ae` | `f9779be7…1468` | **QA-05.8 红**（完整 policy 退化为 none） | restored = original |

（完整哈希见执行日志；四处在恢复后均与原始 SHA-256 相等。）

## 7. 边界声明

1. 签名基于当前工作区（HEAD `e1469a9` + 未提交 QA 测试/报告）；QA 未 commit。若最终提交内容不同，需要重跑。
2. Runtime 是 MockRuntime；没有真实 DSH Adapter、浏览器 E2E、真实 P4/交易环境或生产凭据。
3. git worktree 使用 `os.tmpdir()` 临时仓库/工作树，结束后清理；不触碰生产仓库。
4. Node < 22.5 时 QA 文件整体 SKIP，不当作 PASS。
5. `QA-05.7` 的“真实 SIGKILL”由 WP3 `restart-recovery.test.mjs` 执行；本 QA 套件负责调用它并断言其通过，不重复实现第二套杀子进程逻辑；这是刻意的单一事实源选择，报告如实说明。
6. m1-m6 smoke 与 528/717 全量均在最终工作区跑过；检查项与 pass 数见 §1。

**最终结论：M6.2 可标记完成 / QA 可签字。**
