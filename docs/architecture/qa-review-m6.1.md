# M6.1 独立验收报告（QA-01/02/03）——最终签字版

- 审查者：`qa-reviewer`；未改产品代码、未 commit。
- 审查对象：`fix/m6.1-runtime-reliability` **当前工作区**（HEAD `0834367` + Lead 未提交的 M6.1 实现；QA 不写 git 状态）。
- 交付：`test/qa-m61-state-machine.test.mjs`、`test/qa-m61-runtime-faults.test.mjs`、`test/qa-m61-authz.test.mjs`、本报告。
- 签字含义：本报告发布时的工作区通过下列门禁；若产品/测试在签字后变化，需要重跑。

## 1. 结论

**M6.1 QA 通过，可签字。**

- 三个 M6.1 QA 套件：**34 tests / 34 pass / 0 fail / 0 skip**。
- 既有 QA 全量（m1-m6）：**145 / 145**。
- 全仓 legacy 套件：**509 / 509**；workspace 套件：**657 / 657**。
- 4 处变异全部真红，证明关键对抗断言不是“空转”。
- 唯一产品缺陷 QA-M61-01（Windows 盘符绝对路径）已修复并由 QA-03.5b 复验；Lead 已说明 scheduler-core 的同类实现属于 **M6.2 F13 统一范围**，本轮记为已知差异，不据此判 M6.1 不合格。
- 36 条既有 QA 红全部是 **fixture/契约同步迁移**，不是产品缺陷；没有删除对抗断言。

## 2. 当前真实数字

```text
# M6.1 独立 QA
node --test test/qa-m61-*.test.mjs
ℹ tests 34 | pass 34 | fail 0 | skipped 0

# 既有 QA（m1-m6）
node --test test/m*-qa-adversarial.test.mjs
ℹ tests 145 | pass 145 | fail 0 | skipped 0

# 全仓
node scripts/test.mjs            → 509 tests / 509 pass / 0 fail / 0 skip
node scripts/test-workspace.mjs  → 657 tests / 657 pass / 0 fail / 0 skip
```

| 套件 | tests | pass | fail | skip |
|---|---|---|---|---|
| `qa-m61-authz`（QA-03） | 11 | 11 | 0 | 0 |
| `qa-m61-state-machine`（QA-01） | 9 | 9 | 0 | 0 |
| `qa-m61-runtime-faults`（QA-02） | 14 | 14 | 0 | 0 |
| m1 QA | 25 | 25 | 0 | 0 |
| m2 QA | 25 | 25 | 0 | 0 |
| m3 QA | 25 | 25 | 0 | 0 |
| m4 QA | 23 | 23 | 0 | 0 |
| m5 QA | 24 | 24 | 0 | 0 |
| m6 QA | 23 | 23 | 0 | 0 |

所有进程测试使用临时 SQLite + 真实 HTTP / 真实 Host；未触碰 1421。

## 3. 缺陷复验（QA-M61-01，MINOR）

**修复确认：**
- `packages/contracts/src/paths.mjs` 新增 `^[A-Za-z]:` 拒绝；`C:\abs` 与 `C:/abs` 均抛 TypeError。
- database 通过 import contracts 自动继承；QA-03.5b 现在断言 contracts + database 双层拒绝并通过。
- scheduler-core 仍有自己一份 path 实现，盘符绝对路径仍被接受；Lead 明确这是 **M6.2 F13 统一项**，记为“已知差异，M6.2 关闭”，不影响 M6.1 签字。

**契约统一：**
- `applyRuntimeEventBatch` 失败以**抛 StoreError**为准（契约文档已改）。QA-01.5 / QA-02.1 / QA-02.1b / QA-02.3 已改为 `assert.rejects`（分别断言 VALIDATION_ERROR/StoreError 或 STALE_GENERATION），并继续断言零写入。不再按旧 `{ok:false,problem}` 返回形状断言。

## 4. 既有 QA fixture 迁移（红→绿）

### 4.1 迁移前实测

| 套件 | 迁移前 | 红的原因 |
|---|---|---|
| m2 QA | 13/25 pass，**12 fail** | raw `/internal/v1/*` 未带 `x-atk-internal-role`，被角色门 403 |
| m4 QA | 4/23 pass，**19 fail** | fixture 用 `store.patchTask` 造 CLAIMED/RUNNING/REVIEWING，被 F01 store 守卫拒绝；A1-A3 是 F06 契约同步点 |
| m5 QA | 24/24 pass | 无需迁移（Lead 提到的 m2/m5 中 m5 已绿） |
| m6 QA | 19/23 pass，**4 fail** | A5/B1 fixture + D1/D2 固定 `schemaVersion===5` |
| m3 QA | 24/25 pass，**1 fail** | F4 fixture 用 `patchTask` 造执行态 |
| 小计（m2/m4/m5/m6） | 60/95 pass，**35 fail** | — |

Lead 报 37 红；本机实测 m2/m4/m5/m6 为 35 红，加 m3 F4 为 36 红，差 1 条未复现（可能统计口径/另一个未点名套件）。当前全仓 509/509 已绿。

### 4.2 迁移内容（只动 fixture 与契约同步点）

- **m2 QA**：在测试内写 `roleFor(method, route)` 小 helper（scheduler/runtime-host 按端点映射，不 import backend 内部文件），给 `env.internal` 请求加 role header。未改任何权限断言。
- **m4 QA**：fixture 状态推进改为 `store[INTERNAL].setTaskStatus`：
  - `makeTask`/`toAwaiting`、C1/C2 的 AWAITING、D2/D3 的执行态、E2 的 AWAITING；
  - E1 的 “store 不能再开 DONE 入口” 仍保留 `patchTask(DONE)` 断言，不放宽。
- **m3 QA F4**：同上的 fixture 迁移（RUNNING/REVIEWING/AWAITING），断言不变。
- **m6 QA**：
  - B1 的 CLAIMED fixture 改为 `store[INTERNAL].setTaskStatus`；
  - D1/D2 的 schemaVersion 不再写死 5，改为从 `packages/database/migrations/*.sql` 前缀计算 `LATEST_SCHEMA`（当前 6）；D2 删除/重放最新版本行。
- **DONE reason**：当前 F01 统一返回 `execution-state-guard`；既有 C5/E1 只断言 409 + 状态不变，迁移后自然通过，没有放宽或改成弱断言。
- **m4 A1-A3（F06 契约同步，单独说明）**：旧断言是“浏览器 body.actor 等于作者 → 403 SELF_REVIEW_FORBIDDEN”。M6.1 F06 明确浏览器 session 恒为 HUMAN、body.actor 不是 principal；若继续要求 403 就是保留旧契约。已改为**更强的对抗断言**：body.actor 精确/空白/大小写变体提交后 200，但 DB `reviews.reviewer="HUMAN"` 且 `reviewer_agent_id` 为 NULL，body.actor 不进入事件。没有删除“不能冒充 reviewer”的对抗意图。

## 5. 9 条 skip 全部转正（0 skip）

| 原 skip | 转正后的实测 |
|---|---|
| QA-03.7 AGENT assignment / reviewerAgentId | 真实 HTTP create review（AGENT+reviewerAgentId）→ 201；浏览器提交→403 `review-requires-runtime-host`；runtime-host + reviewer Run 提交→200，DB reviewer=agent-2；另加 03.7b 作者自审创建→`SELF_REVIEW_FORBIDDEN` 且零写入 |
| QA-03.8 human approval principal | 真实 decide；事件 `approval.recorded` 含 `principal:"HUMAN"`、`operation`、`targetHash`、`targetVersion`；body.actor="agent-evil" 不进入事件；task DONE |
| QA-03.9 integration role | 缺 role→`internal-role-required`；runtime-host→`internal-role-forbidden`；user-action 错 hash→`APPROVAL_STALE` 零写入；正确 hash→200，task AWAITING，integrations=1 |
| QA-01.6 COMPLETED Run 前置 | 无 COMPLETED Run→409 `completed-run-required` 零写入；有→201，同事务 REVIEWING+PENDING |
| QA-01.7 PASS→INTEGRATING | PATCH INTEGRATING→409 `execution-state-guard`；submit PASS→INTEGRATING |
| QA-01.8 无 integration 记录 | PATCH AWAITING→409；user-action integration→200 AWAITING |
| QA-01.9 DONE 唯一入口 | PATCH DONE→409；错 targetHash→409 `APPROVAL_STALE` 状态不变；正确 hash→DONE，事件 principal HUMAN |
| QA-02.12 真实 HTTP Outbox→reconcile | 真实 `createInternalClient` + local internal API：首次 result 响应被丢，reconcile 后 Outbox 清空、completed=1、只 post 1 次、同 idempotencyKey |
| QA-02.13 服务端 batch 拒绝 | 真实 HTTP event batch 失败→400/422，Run/events fingerprint 不变 |

## 6. 变异测试（隔离工作区副本 `atk-qa-m61-final`）

基线：QA-01.1/01.3 2 pass；QA-03.8 1 pass。

| 变异 | 目标 | 结果 |
|---|---|---|
| M1 删除 F01 后端谓词 + store 执行态边守卫 | QA-01.1 / QA-01.3 | **CAUGHT：2/2 红** |
| M2 删除 submit 的 “internal 不可提交 HUMAN assignment” 拒绝 | QA-03.2 | **CAUGHT：1/1 红** |
| M3 把 store `transaction()` 改成直接执行 | QA-02.1b（写阶段失败回滚） | **CAUGHT：1/1 红** |
| M4 把 approval 事件 `principal:"HUMAN"` 篡改为 AGENT | QA-03.8 | **CAUGHT：1/1 红** |

## 7. M6.1 门禁清单（全部通过）

1. **F06 assignment**：真实 HTTP 创建 AGENT review；session 提交→403 `review-requires-runtime-host`；runtime-host+正确 reviewer Run→200；作者自审→`SELF_REVIEW_FORBIDDEN` 零写入；body.actor 被忽略。✅
2. **F06 human approval**：事件 `principal:"HUMAN"`、`operation:"approval.decide"`、`targetHash`、`targetVersion`；伪造 body.actor 不生效；错 hash→`APPROVAL_STALE` 状态不变。✅
3. **F01 可信触发源**：无 COMPLETED Run 创建 review→409 零写入；有→同事务 REVIEWING+PENDING；PASS→INTEGRATING；无 integration→AWAITING 409 零写入；有 integration→AWAITING；DONE 仅 approval。✅
4. **F02 真实 HTTP Outbox**：丢响应→reconcile→Outbox 清空不盲目重发；同 idempotencyKey；completed 只在 ACK 后 +1。✅
5. **F03/F07/F08/F09**：批次写阶段失败整批回滚；100 同毫秒 eventId 去重；错误 generation 零写入；FENCING/FENCING_REQUIRED；corrupt recovery→RECOVERY_REQUIRED。✅
6. **F13 Windows 路径**：contracts/database 拒绝盘符绝对路径；POSIX `../`/绝对路径/`src` vs `src/a.ts` 一致；scheduler-core 差异记为 M6.2。✅（M6.1 范围内）

## 8. 边界声明

1. **签名基于当前工作区**（HEAD `0834367` + 未提交 M6.1 实现）；QA 未 commit。若 Lead 最终提交内容与本次验收不同，需要重跑。
2. 真实 DSH 不可用；Agent/Runtime 路径仍用 MockRuntime（M6.1 范围如此）。
3. 无浏览器 E2E；Web 不在 QA-01/02/03 范围。
4. Windows 子进程 env 验证是真实 launcher spawn 边界的 env 对象，不是内核级隔离；已按此强度表述，不夸大。
5. Node < 22.5 无 `node:sqlite` 时 QA 套件整体 SKIP，不当作 pass。
6. scheduler-core 的盘符路径接受是已知差异，**M6.2 F13 统一时关闭**；本轮不据此判 M6.1 不合格。
