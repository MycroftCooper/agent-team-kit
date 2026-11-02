# M6.3 二次审查验收报告——最终签字版

- 审查者：`qa-reviewer`；未改产品代码、未 commit。
- 审查对象：`fix/m6.2-runtime-execution` 当前工作区（HEAD `bef7d00`；QA 测试/报告为未提交改动）。
- 交付：`test/qa-m63-launcher-chain.test.mjs`、本报告，以及旧 QA 套件的 M6.3 fixture/契约迁移。
- 结论：**M6.3 QA 通过，可标记完成/可签字。**（边界见 §8；签名基于当前工作区）

## 1. 当前真实数字

```text
node --test test/qa-m63-launcher-chain.test.mjs
ℹ tests 8 | pass 8 | fail 0 | skipped 0

node scripts/test.mjs            → 536 tests / 536 pass / 0 fail / 0 skip
node scripts/test-workspace.mjs  → 768 tests / 768 pass / 0 fail / 0 skip
node scripts/check-boundaries.mjs→ PASS (10 packages, 10 edges, 0 cycles)
m1 16/16 | m2 4/4 | m3 6/6 | m4 9/9 | m5 4/4 | m6 12/12
```

| 套件 | tests | pass | fail | skip |
|---|---|---|---|---|
| QA-M63 真实 Launcher 链路 | 8 | 8 | 0 | 0 |

## 2. 真实 Launcher 链路（QA-M63.1/02）

真实 `apps/launcher/cli.mjs start`（随机端口 + 临时 data + 临时 git 仓库），只 seed 两个 READY 任务和 agent 输入，**不 patch 状态、不注入心跳/结果**。

- 三角色 Backend/Scheduler/Host 同时启动、health 200。
- Host 先 `register` 自己的 agent，再 heartbeat；`agentAvailability` 变 ok；Scheduler 自动 claim FE/BE；产生 2 个 Run。
- 每个 Run 有独立 `run.workspace.path`；真实 `git worktree list --porcelain` 同时包含两条 worktree。
- Host 收到冻结 spec；`run.workspace == spec.workspace`；runtime cwd = persisted run.workspace；prompt 含 title/description/files。
- 两个 Run 最终 COMPLETED；每 Run 有 `run.log` + 至少两次 `run.updated`；command 终态落库；base checkout 未被写入。

**红→绿证据**：第一版实现前同一用例在 30s 内 tasks 仍 READY、runs=[]、agents `no-heartbeat`；M6.3 P0-1 修复（Host register→heartbeat）后转绿。该红证据已回执 Lead，不是测试 seed 问题。

## 3. 6 条故障注入（全部真实执行，无 skip）

| # | 场景 | 实测 |
|---|---|---|
| 63.3 | Host↔Backend 断网 | result 持续 `ECONNREFUSED` 时 Outbox 保留、completed=0；恢复后同一 idempotencyKey 重试成功 |
| 63.4 | Backend 超时/5xx | 5xx ACK 不被当作成功；completed 仅在 persisted:true 后 +1 |
| 63.5 | Host 真实 SIGKILL | 运行 WP3 `restart-recovery.test.mjs` 真实子进程 SIGKILL；2/2 pass：worktree/未提交文件保留、recovered interrupted、同一 Run 不启动两次、缺 worktree→RECOVERY_REQUIRED |
| 63.6 | ACK 丢失但已持久化 | 仅 1 次 result POST；reconcile 带 matching command/result 后 Outbox 清空、completed=1 |
| 63.7 | 租约过期旧 Host | 新 holder generation+1；旧 generation 的 batch 报 STALE_GENERATION 零写入；只有新 holder 事件落库 |
| 63.8 | Launcher stop 失败 | `killImpl` 抛 EPERM 时 stop 不静默成功：保留失败 survivor 或 state，供人工处理 |

## 4. 旧 QA 套件 M6.3 迁移（根因 40 红 → 0）

### 4.1 迁移前实测

- m2 QA：9/25 pass，**16 fail**（单 token/旧 `/internal` 语义、Host 无 spec、host token 错误）
- m3 QA：22/25 pass，**3 fail**（单 token、Host 无 spec）
- m5 QA：22/24 pass，**2 fail**（launcher 手工 seed IDLE agent，与 Host register 冲突）
- QA-03 authz：6/11，**5 fail**（per-role token、AGENT review reviewerRunId）
- QA-01：7/9，**2 fail**（integration 使用 user-action 角色，新语义无该 token 绑定）
- QA-02：8/15，**7 fail**（Host token/spec/none-workspace/reconcile command）
- QA-05：4/8，**4 fail**（Host 无 agents/host token、reviewerRunId、none workspace）
- 合计本机 **39 红**；与 Lead 报 40 的 1 条差异按统计口径记录。迁移前全仓 legacy 为 518/536。

### 4.2 迁移内容（fixture/契约同步点，未删对抗断言）

- **per-role tokens**：解析 `internal tokens: scheduler=… runtime-host=…`；scheduler/claims 用 scheduler token，Host/events/result 用 runtime-host token；role header 仅作 assertion；缺失 header 不再当作 elevation。
- **Host spec**：m2 seed 通过 `freezeTaskSpec` 绑定 frozen spec；Host fixture 提供 agent 列表并显式 `allowNoneWorkspace`（仅 mock），真实 worktree 不允许 none。
- **Review**：`createReview(AGENT)` 必须 `reviewerRunId` 且 reviewer Run `function==="REVIEWER"`；提交用 reviewer Run。
- **F10/register**：m5 launcher fixture 不再手工 seed IDLE agent/heartbeat，由真实 Host register 自己的 agents；m3 测试仍可 seed 心跳作为纯 fixture。
- **Integration**：内部 integration 使用 scheduler token/role（user-action 不是独立 token 绑定）。
- **Host 对账**：fake client 的 Outbox/reconcile fixture 提供 matching command/generation/result；只迁移证据形状，不降低断言强度。
- **错误码**：保留 `WORKSPACE_REQUIRED`、`REVIEW_RUN_NOT_REVIEWER` 等新契约断言。

迁移后：**m1-m6 QA / QA-M63 / 全仓 legacy 536 全绿**，没有产品回归需要上报。

## 5. 变异测试（隔离树 HEAD `bef7d00` + 仅 QA overlay）

每处先确认基线绿，变异后恢复并校验 SHA-256 与原始相等。

| 变异 | 原 sha256 | 变异 sha256 | 结果 |
|---|---|---|---|
| M1 heartbeat gating 关闭：`agentAvailability` 无条件 available | `ac60839f…` | `009f8b3e…` | scheduler heartbeat-gating **2/2 红** |
| M2 Outbox 对账关闭：跳过 reconcile | `18ae5840…` | `c9a3d4db…` | QA-02.6 **红**（丢 ACK 被盲目重发） |
| M3 workBranch 唯一性：所有 claim 路径固定 `shared` | `d47f7739…` | `f15ad2c2…` | QA-M63.2 **红**（两 Run 不再独立 worktree） |

三处均真实变红，恢复后原 sha256 一致。

## 6. 缺陷闭环

- **P0-1（M6.3 前置 BLOCKER）**：Host 旧 heartbeat 形状与新 endpoint 不匹配 → `no-heartbeat` → 不派发。已由 `58d5430` 修复（register→heartbeat→claim）；QA-M63 红→绿已复验。
- **per-role tokens（P0-2）**：`cddd2f8` 修复；旧 QA 迁移后全绿。
- 本轮未发现新的 open BLOCKER/MAJOR。

## 7. 门禁清单（全部通过）

1. 真实 Launcher 拉起 Backend+Scheduler+Host；health/进程/PID 正常。✅
2. 两任务自动派发；每 Run 独立 worktree；真实 git worktree list 验证。✅
3. 冻结 spec 到 Runtime；cwd 取 persisted workspace；prompt 完整。✅
4. 每 Run 事件/日志/完成回执落库；最终 COMPLETED。✅
5. 6 条故障注入全部真实执行（断网/5xx/SIGKILL/ACK 丢失/租约/fence/stop 失败）。✅
6. 全量 legacy/workspace/boundaries/m1-m6 smoke 全绿；3 处 M6.3 变异真红。✅

## 8. 边界声明

1. 签名基于当前工作区（HEAD `bef7d00` + 未提交 QA 测试/报告）；QA 未 commit；若最终提交内容变化需重跑。
2. Runtime 是 MockRuntime；真实 DSH Adapter 仍不可用，不使用真实 P4/交易凭据。
3. QA-M63.5 的 SIGKILL 由 WP3 真实子进程测试执行，本套件调用并断言其通过（单一事实源）。
4. Git worktree 使用 `os.tmpdir()` 临时仓库，测试后清理；不触碰生产仓库。
5. Node < 22.5 时 QA 文件整体 SKIP，不当作 PASS。

**最终结论：M6.3 可标记完成，QA 可签字。**
