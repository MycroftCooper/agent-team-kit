# M4 独立 QA 复核报告（QA-005）

- 文档类型：独立复核报告（Reviewer / QA Function，身份隔离）
- 审查对象：分支 `m0/baseline-and-p0`，**冻结 commit `36c9b555f58ad003f558df40da1c11b5a4e8f022`**
  - M4 提交：`36c9b55` contracts 枚举/错误码 + database 0004 + Review/Approval 仓储 + backend 7 端点 + web 工作台 + m4-smoke；同批 `1172bb4`（M3 CLI 修复）、`5096ffc`（环枚举/missingDeps）、`45e36ca`（QA-004 测试与报告）
- 审查者：`qa-reviewer`（REVIEWER/QA）。M4 代码由 Lead、`worker-database`、`worker-backend`、`worker-web`、`worker-runtime-spike` 编写，审查者未参与。
- 环境：Windows 11，Node v24.16.0；仓库 `E:\CodeProject\agent-team-kit`。
- **冻结树口径**：审查期间工作区出现了未提交的 **M5 WIP**（`m5-contracts.md`、`docs/operations/`、web/cli 改动、check-boundaries 改动），因此所有 M4 数字都来自 `git archive 36c9b55` 解包到 `E:\CodeProject\atk-qa-m4-frozen`（各包 `node_modules/@atk/*` 含 `apps/web` 均指向解包树）。当前工作区的修复只用于“修复状态”验证，不作为 M4 结论。
- 审查期间 Lead 的 `127.0.0.1:1421` 服务未被停止/修改；QA 全部使用临时库 + 随机端口。
- 审查者交付：`test/m4-qa-adversarial.test.mjs`（23 条）、本报告。未改产品代码/他人测试，未执行改变 git 状态的命令，未 commit。

> **结论：M4 在冻结 SHA 上不能直接标记完成（2 个 MAJOR：自审可被空白/大小写绕过；验收 hash 绑定在生产链路上退化为“回显”）。** 无 BLOCKER；另有 4 个 MINOR。审查期间 Lead 已在工作区落盘修复（自审 actor 规范化、PASS 写入 `target_hash`、createApproval 绑定真实候选 hash、证据计数上限、attempt 去重、store 层 DONE 拒绝、m4-smoke 扩到 9 条），QA 在**当前工作区**复跑：M4 对抗套件 **23/23 绿**、m4-smoke **9/9**。把这些修复提交/冻结后 M4 可以标记完成。**QA PASS ≠ 生产可用**，边界见 §8。

---

## 1. 执行清单（真实命令 / 退出码 / 关键输出）

### 1.1 冻结树 `36c9b55`（隔离解包）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `node scripts/test.mjs` | 0 | **400 tests / 400 pass / 0 fail / 0 skipped / 0 todo** |
| 2 | `node scripts/test-workspace.mjs` | 0 | 50 文件 / **511 tests / 511 pass / 0 fail** |
| 3 | `node scripts/check-boundaries.mjs` | 0 | **PASS**：8 package(s) / 6 edge(s) / 0 cycle(s) |
| 4 | `node scripts/m1-smoke.mjs` | 0 | **16/16** |
| 5 | `node scripts/m2-smoke.mjs` | 0 | **4/4** |
| 6 | `node scripts/m3-smoke.mjs` | 0 | **6/6** |
| 7 | `node scripts/m4-smoke.mjs` | 0 | **8/8, 0 skipped, 0 failed**（门禁自审见 §2） |
| 8 | `node --test test/m4-qa-adversarial.test.mjs`（冻结树） | 1 | **23 tests / 18 pass / 5 fail**：A3 自审空白/大小写绕过、B3 1e15 证据计数被接受、C2 AWAITING 任务没有 target_hash、D2 review_attempts attempt 重复、E1 store 层可直推 DONE |
| 9 | 变异测试（隔离树，见 §5） | — | 基线 29/29 绿；**3/3 变异被产品测试抓到** |
| 10 | 真实链路 hash 探针（端口临时库） | 0 | 见 QA5-02：AWAITING 任务 `target_hash=NULL`，任意 64-hex approval 回显即 DONE；raw 写入 task hash 后旧 approval → 409 |

### 1.2 当前工作区（审查期间修复 + M5 WIP；仅作修复状态）

| 命令 | 结果 |
|---|---|
| `node --test test/m4-qa-adversarial.test.mjs` | **23 tests / 23 pass / 0 fail**（五条冻结缺口均已转绿） |
| `node scripts/m4-smoke.mjs` | **9/9, 0 skipped, 0 failed**（check4 改为“PASS 写入 target_hash”绑定、check6 改为真实 Scheduler CLI + Host CLI、新增 check9 换版失效） |
| `node scripts/test.mjs`（含本报告 23 条） | 423 tests / 421 pass / **2 fail**——失败的是**上一轮 M3 QA 套件的 F3/F4**，被未提交的 M5 WIP 改变（m3-smoke/Task 自动推进），**不是 M4 冻结树的问题**；M4 冻结树 `test.mjs` 400/400 |
| `node scripts/test-workspace.mjs`（当前 WIP） | 518 tests / 1 fail（M5 WIP 的导航测试；冻结树 511/511） |

---

## 2. `m4-smoke` 门禁自审

**结构**：check harness 把 PASS/FAIL/SKIP 分开；`SkipCheck` 只在依赖未实现时触发，且**任何 SKIP 或 FAIL 都使 exit ≠ 0**（`process.exitCode = passed === results.length ? 0 : 1`），不存在“跳过还绿”。checks 在 try 内执行、finally 只停 backend。这一条 PASS。

**逐条核实（冻结版 8 条）**：

| # | 检查 | 自审结论 |
|---|---|---|
| 1 | 自审 403 | **真实**：HTTP 执行 + DB 断言 review PENDING、task REVIEWING。但只测精确 actor（见 QA5-01 空白/大小写绕过未被门禁覆盖）。 |
| 2 | 缺证据 400 | **真实**：无 hash 与 1/2 两个变体，DB review/task 不变。 |
| 3 | 合法 PASS | **真实**：DB review=PASS/PASS、task=INTEGRATING。 |
| 4 | 验收 hash 绑定 | **冻结版是“回显级”验证**：fixture task 的 `target_hash` 为 NULL，只比较 approval.target_hash 与请求 targetHash；没有断言 Task 当前 hash，也没有“换版后旧 approval 失效”场景 → 不能证明 §0.3 的换版即失效（QA5-02/QA5-06）。post-freeze 已改：PASS 写入 target_hash、createApproval 绑定、新增 check9 换版失效；当前 9/9。 |
| 5 | PATCH DONE 409 | **注意**：如果守卫缺失、PATCH 返回 200，该 check 抛的是 **SkipCheck（SKIP 而不是 FAIL）**——整体仍 exit 1（不会假绿），但回归会被标成“跳过”，信号弱。 |
| 6 | 返工环 + 新 Run | 冻结版：**新 Run 确实是新 id/attempt 2**，DB 断言真实；但 Scheduler/Host 是**同进程库实例**，不是新进程。post-freeze 改为 `scheduler/cli.mjs --once` + `runtime-host/cli.mjs --once` 两个真实进程（当前 check6 详情可见新的 Run/Command id）。 |
| 7 | SSE | **真实**：真 SSE 连接、事件 id 递增，并与 DB 事件数交叉断言。 |
| 8 | 人工 REJECTED | **真实查库**：`approvals.status=REJECTED`、`approvals.target_hash`、`task=READY`、`approval.recorded` 事件的 `payload.decision=REJECTED` 都由只读 SQLite 读取断言，不是只看 HTTP。 |

**结论**：m4-smoke 的 1/2/3/7/8 是真实断言；4/6 在冻结版存在“演示级”弱点（4 最严重，与 QA5-02 同根）；5 的回归信号是 SKIP 而非 FAIL。post-freeze 已针对 4/6 修正并新增 check9；但 check5 的 SKIP 机制仍在（建议把“守卫缺失”判 FAIL）。

---

## 3. A–H 结论表（期望 · 实际 · 判定）

判定：**PASS** = 冻结满足；**FAIL** = 冻结违反（注释修复状态）；**OBSERVATION** = 记录项。

### A. 自审门禁

| 项 | 期望 | 实际（冻结） | 判定 |
|---|---|---|---|
| A1 actor = Run.agentId | 403 `SELF_REVIEW_FORBIDDEN`，Review/Task/事件零写入 | 一致 | PASS |
| A2 未给 runId 时 = 最近 Run 的 agent（代理判定） | 403 | 一致（`latestProducerAgentId`，优先非终态 Run） | PASS |
| A3 空白/大小写变体 | 仍应拒绝 | **`" agent-dev-1"`、`"agent-dev-1 "`、`"AGENT-DEV-1"` 全部 200 PASS，review=PASS、task=INTEGRATING**（QA5-01） | **MAJOR FAIL → 当前已修** |
| A4 自审零写入 | review PENDING、task REVIEWING、无 review.updated | 一致 | PASS |
| A5 省略 actor（默认 HUMAN） | 按 server 注释是浏览器默认；**但意味着“按声明而非认证”** | 200、reviewer=HUMAN（QA5-07） | OBSERVATION |
| A6 Run 不属于该 Task | VALIDATION_ERROR | 一致 | PASS |

### B. 证据门禁

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| B1 无 manifestHash / passed<total / total=0 / 非整数 / evidence 非对象 / passed 负数 | 400 `EVIDENCE_MISSING` + 零写入 | 一致（矩阵逐项） | PASS |
| B2 PASS 不要求 findings；CHANGES_REQUESTED 必须 findings；BLOCKED 可无 | 一致 | 一致（CHANGES 缺 findings → VALIDATION_ERROR，review 仍 PENDING） | PASS |
| B3 伪造成极大值（passed=total=1e15） | 不应被当作真实全绿 | **冻结接受为 PASS**（QA5-03）；当前已改为 out-of-range 拒绝 | **MINOR FAIL → 已修** |
| B4 证据字符串/数组/负数 | 拒绝且零写入 | 一致 | PASS |

### C. 人工验收与 hash 绑定

| 项 | 期望 | 实际（冻结） | 判定 |
|---|---|---|---|
| C1 错 targetHash | 409 `APPROVAL_STALE`、approval PENDING、task 不动、零事件 | 一致（用匹配 approval 的 hash 创建，再以另一 hash decide） | PASS |
| C2 AWAITING 任务携带“当前目标 hash” | 任务必须有 target_hash 供三方比较 | **生产代码从不写 `tasks.target_hash`**：任务恒为 NULL；PASS Review 的 manifestHash/commit 与 Approval targetHash 无关联（QA5-02） | **MAJOR FAIL → 当前已修** |
| C3 Task target_hash 已存在时 | 与 approval/请求不一致 → 409；一致 → DONE | 一致（raw 写 task hash 后旧 approval 409；匹配后 DONE） | PASS（路径存在） |
| C4 已裁决 approval 再 decide / REJECTED 分支 | 409、task 不动/READY | 一致（再次 decide → VERSION_CONFLICT；REJECTED → task READY） | PASS |
| C5 PATCH DONE（AWAITING 与 REJECTED） | 409 `human-approval-required`，task 不动 | 一致（Backend 层） | PASS |

### D. 返工环

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| D1 CHANGES_REQUESTED → Task REJECTED → rework READY | 一致，旧 review 保持 verdict，新 review 下一 attempt，task.updated(reason=rework) | 一致 | PASS |
| D2 attempt 递增/唯一 | 每轮 attempt 唯一 | **rework 在旧 review 插 attempt=2 的 PENDING row，随后 createReview 的新 review 也 attempt=2 → 同 Task 两条 attempt=2（孤兒 + 正式）**（QA5-04） | **MINOR FAIL → 当前已修** |
| D3 maxAttempts 边界 | maxAttempts=1 首轮 rework 即 BLOCKED；默认 3 第三轮超限 → BLOCKED + REWORK_LIMIT_REACHED | 一致（attempt 2/2>1、4>3，task BLOCKED，事件 reason=rework-limit） | PASS |
| D4 并发 rework（同 review） | 恰 1 成功、1 失败；1 条 rework 事件 | 一致（两真实进程 barrier） | PASS |
| D5 返工后调度新 Run | 由 Scheduler 重新派发且是新 Run | 一致（m4-smoke check6 冻结版库里实例/新 Run id；当前真实 CLI 进程） | PASS |

### E. DONE 唯一入口

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| E1 PATCH DONE | 409，task 不动 | 一致（AWAITING 与 REJECTED 都 409） | PASS |
| E2 store 层 | 内部也不应有第二入口 | **冻结：`store.patchTask(AWAITING_ACCEPTANCE → DONE)` 成功**（QA5-05）；当前已拒绝 | **MINOR FAIL → 已修** |
| E3 无 approval 不能 DONE | 一致 | 一致 | PASS |
| E4 事件审计链 | review.requested → review.updated → approval.recorded（创建+裁决）→ task.updated（返工/BLOCKED） | 一致（DB 事件与 payload 断言） | PASS |

### F. 迁移与并发

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| F1 v3→v4 原地升级保留数据 | schemaVersion 4、0004 列存在、数据保留 | 一致（隔离临时库手工 v3 升级） | PASS |
| F2 0004 记账行丢失自愈 | 不崩、数据保留、schema≥4 | 一致 | PASS |
| F3 同 review 并发 submit（CAS） | 恰 1 成功、1 conflict；1 条 review.updated | 一致（两真实进程） | PASS |

### G/H. 文档、Web、隐私

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| G1 m4-contracts §2 端点表 | 7 端点与 server 路由一致 | 一致（reviews list/create/submit/rework + approvals list/create/decide） | PASS |
| G2 web 双语词典 | en/zh-CN key 一致、错误码全覆盖、APPROVAL_STALE 文案含“重新验收” | 一致：**292/292 keys**（任务描述写 293，实测 292，两边一致且硬编码键检查通过；差异是计数口径，不判缺陷） | PASS |
| G3 隐私 | 新文件无 token/本机用户名/绝对路径 | M4 新增源码/文档/m4-smoke 0 命中 | PASS |
| H1 错误码映射 | 16 个 contract 错误码全部有本地化 message key | 一致（含 SELF_REVIEW_FORBIDDEN/EVIDENCE_MISSING/APPROVAL_STALE/REWORK_LIMIT_REACHED） | PASS |
| H2 写失败不吞错 | UI 显示服务端 code | 现有 web 单测（useWriteAction/workbench/errors）覆盖；QA 静态核对 errors.ts 的 `describeError` 映射；无浏览器 E2E | PASS（单测层）/ OBSERVATION（无 E2E） |

---

## 4. 缺陷清单

> 状态为审查结束时：冻结版本的真实缺陷 + 工作区修复状态（修复由 Lead/worker 落盘，未由 QA commit）。

### QA5-01（MAJOR，冻结 FAIL，当前已修）自审门禁可被空白/大小写变体绕过

- 位置：`apps/backend/src/server.mjs` `requireNonEmptyString`/`actorFrom`（不 trim，返回原串；省略 actor 默认 HUMAN）；`packages/database/src/model.mjs` `validateToken`（只校验 trim 非空、返回原串）；`sqlite.mjs` `submitReview` 用精确 `Set.has` 比较 reviewer 与作者。
- 复现（冻结树，真实 HTTP+DB；每个变体独立 task）：submit actor=`" agent-dev-1"` / `"agent-dev-1 "` / `"AGENT-DEV-1"` → **200**，review=PASS、reviewer 记录为带空格/大写字符串、task=INTEGRATING；精确 `"agent-dev-1"` → 403。省略 actor → reviewer=HUMAN、200（按 server 注释是浏览器默认）。
- 影响：M4 的核心不变量“Agent 不能批准自己”只要在 actor 上加一个空格/改大小写就失效；之后人工验收默认可继续到 DONE。
- 修复验证（当前工作区）：server 已拒绝空白/大小写 actor（新 backend 测试 “self-review cannot be bypassed with whitespace/case actor variants”），QA 的 A3 已转绿。
- 归属：worker-backend / worker-database。

### QA5-02（MAJOR，冻结 FAIL，当前已修）验收 hash 绑定在生产链路上退化为“调用方回显”

- 位置：`packages/database/migrations/0004_reviews_approvals.sql` 建了 `tasks.target_hash`，但 production 代码**没有任何写入方**；`TASK_PATCH_KEYS`/`PATCHABLE_TASK_FIELDS` 不含 targetHash；`decideApproval` 的“Task 当前 hash”比较只在非空时执行。
- 复现（冻结树）：PASS review 的 manifestHash=M、commit 任意；Task 进入 AWAITING_ACCEPTANCE 时 `target_hash=NULL`；`POST /approvals {targetHash: 64×a}` → 201；`POST /decide {targetHash: 64×a}` → 200、Task **DONE**。整个链路没有任何东西证明 64×a 对应被 PASS 的候选；旧 approval 也不会因换版失效（没有可比较的 Task hash）。代码路径本身正确：raw 写入 `target_hash=64×b` 后，旧 approval decide → 409 `APPROVAL_STALE`。
- 影响：M4 §0.3“换版即失效”在端到端层面不成立；m4-smoke check4 用 `target_hash=NULL` 的 fixture 只验证了 approval↔请求回显，属于“看起来通过其实没验证”。
- 修复验证（当前工作区）：PASS Review 写入 `target_hash`；createApproval 绑定该真实候选 hash；m4-smoke check4 改为“PASS 写入的 hash”，新增 check9“新 PASS 改 hash → 旧 approval + 旧 hash 409”；backend 测试新增 “createApproval binds the Task's real candidate hash (no arbitrary targetHash)”。QA 的 C2 已转绿。
- 归属：worker-database / worker-backend / Lead（契约）。

### QA5-03（MINOR，冻结 FAIL，当前已修）证据计数无上限（1e15 被接受为“全绿”）

- 位置：`model.mjs` PASS 证据校验只要求 `passed===total>0`（冻结）。
- 复现：`passed=total=1e15` → review PASS。
- 修复：当前工作区 `assertPassEvidence` 增加 out-of-range 拒绝；QA B3 转绿。
- 归属：worker-database。

### QA5-04（MINOR，冻结 FAIL，当前已修）review_attempts 出现重复 attempt 编号

- 冻结：review1（attempt1）CHANGES → rework 在 review1 插入 attempt2 的 PENDING row；createReview 的新 review 也以 attempt2 插入 → 同 Task 两条 attempt=2（其中一条是永不使用的孤儿）。
- 依据：contract “attempt+1”/“同一 Task 的 attempt 达到 maxAttempts”应能标识轮次。
- 修复：当前工作区 D2 已绿（列值唯一）。
- 归属：worker-database。

### QA5-05（MINOR，冻结 FAIL，当前已修）store 层允许 `AWAITING_ACCEPTANCE → DONE`

- 冻结：`store.patchTask` 直接成功（Backend PATCH 的 409 守卫是唯一 public 门）；内部调用/未来路由可绕过“DONE 唯一入口”。
- 修复：当前 store 拒绝该 patch，QA E1 转绿。建议同时明确“DONE 单入口在 Backend+Store 双层”的契约措辞。
- 归属：worker-database。

### QA5-06（MINOR，冻结部分，当前大部分修复）m4-smoke 的演示级弱点

- check4 冻结版只验证 hash 回显（见 QA5-02）；check6 冻结版用库实例而非新进程；check5 把“守卫缺失导致 PATCH 200”判成 SKIP 而非 FAIL。
- 当前：check4/6 已改（真实 PASS 写入 hash、真实 scheduler/host CLI 进程），新增 check9；check5 的 SKIP 机制仍在。
- 归属：Lead / worker-runtime-spike。

### QA5-07（OBSERVATION）actor 是“客户端声明”，不是认证身份

- 省略 actor 默认 HUMAN；approval 的 actor 在 server 固定为 HUMAN；任何能拿到浏览器 token 的调用方都可以自报 HUMAN/任意 agent id（空格修复只解决“同一 id 的拼写绕过”，不解决身份伪造）。
- M4 的“Agent 不能批准自己”成立前提是“Agent 没有浏览器 token、只有内部 token”；建议把该威胁模型写进 m4-contracts/ADR（M5 若做身份模型再收紧）。approval 决策同理。

### QA5-08（OBSERVATION）契约与状态回执对“人工验收拒绝”的迁移不一致

- `m4-contracts.md` §1 写 `AWAITING_ACCEPTANCE → REJECTED`（并称 REJECTED→继续返工），而 `m4-status.md` 裁决 3 与代码是 `AWAITING_ACCEPTANCE → READY`。代码/门禁按后者，文档需同步（MINOR 文档）。

### QA5-09（OBSERVATION）其余记录项

- 证据 `findings` 只对 CHANGES_REQUESTED 必填（符合契约）；Approve/Reject 的对象是 `targetHash` 字符串，人工验收始终是“人信任人”，系统无法自动证明该 hash 对应真实产物（M5/M6 可接 manifest 校验）。
- 迁移/import 的 `setTaskStatus` 仍可写 DONE（M0 遗留路径，非 public API）；建议在 M5 明确“仅迁移使用”。
- `m4-smoke` 的 fixture 用 `store.patchTask` 走状态链（测试专用），不是产品写路径，可接受。

---

## 5. 变异测试（`git archive 36c9b55` 隔离树，工作区未动）

方法：解包到 `E:\CodeProject\atk-qa-m4-mut`（`@atk/*` 指向解包树）；基线 `packages/database/test/reviews.test.mjs` + `approvals.test.mjs` + `apps/backend/test/review.test.mjs` **29/29 绿**；逐个注入变异、跑对应测试、恢复。

| 变异 | 目标测试 | 结果 |
|---|---|---|
| **M1 `submitReview` 去掉自审检查** | `packages/database/test/reviews.test.mjs` | **CAUGHT**：9 tests / 8 pass / 1 fail（`self-review, CAS conflicts and invalid verdicts write nothing`） |
| **M2 Backend PATCH DONE 放行** | `apps/backend/test/review.test.mjs` | **CAUGHT**：16 tests / 15 pass / 1 fail（`decide APPROVED with the correct hash is the only DONE entrance`，该用例覆盖直接 PATCH） |
| **M3 `decideApproval` 的 approval/task hash 校验失效** | `packages/database/test/approvals.test.mjs` | **CAUGHT**：4 tests / 3 pass / 1 fail（`a changed target is APPROVAL_STALE and keeps the Task awaiting`） |

补充观察：只删 **server 层**的 hash 比较不会让产品测试变红——因为 `apps/backend/test/review.test.mjs` 用 fake-store，fake-store 自己也会比较（真实 store 也会兜底）。这属于“冗余防线的测试盲区”，不是产品可观察缺陷；M3 变异选择权威的 `decideApproval` 层验证，3/3 被抓。

---

## 6. 契约 vs 代码（m4-contracts §0/§1/§2）

| 契约项 | 代码/测试验证 | 结论 |
|---|---|---|
| §0.1 Agent 不能自审 | 精确 actor ✓；空白/大小写 ✗（冻结，当前已修）；actor 无认证（OBSERVATION） | 冻结部分不一致 |
| §0.2 PASS 必须有 manifestHash + 全绿测试 | 矩阵一致；计数无上限（冻结，当前已修） | 冻结部分不一致 |
| §0.3 Approval 绑定 targetHash、换版即失效 | 代码比较存在；Task hash 无写入方 → 退化回显（冻结，当前已修） | 冻结不一致 |
| §0.4 返工上限 | 默认 3/maxAttempts=1、REWORK_LIMIT_REACHED + BLOCKED 一致；attempt 记录重复（冻结，当前已修） | 一致（修复后） |
| §0.5 人工验收是 DONE 唯一入口 | Backend PATCH 守卫✓；store 层（冻结可绕过，当前已修） | 修复后一致 |
| §0.6 事件复用既有类型 | review.requested/updated、task.updated、approval.recorded 一致 | 一致 |
| §1 Store 方法/状态迁移 | createReview/submit/rework/createApproval/decideApproval 与契约一致；人类 REJECTED→READY 与 §1 文字不一致（见 QA5-08） | 大部分一致 |
| §2 7 端点 + 4 错误码 | 路由与错误码一致；CSRF/Origin 沿用 M1 | 一致 |
| §3 Web 工作台 | #/reviews 组件、双语词典 292/292、错误映射 16/16；无浏览器 E2E（已知限制） | 一致（单测层） |

---

## 7. 结论：M4 能否标记完成

- **冻结 SHA `36c9b55`：不能直接标记完成**。2 个 MAJOR（QA5-01 自审空白/大小写绕过；QA5-02 验收 hash 退化为回显）会直接破坏 M4 的两个核心承诺；4 个 MINOR（证据上限、attempt 重复、store DONE、门禁演示级）次之。无 BLOCKER。
- **修复后可以**：审查期间工作区已落盘全部修复，QA 复跑：M4 对抗套件 23/23、m4-smoke 9/9、冻结树原有 test 400/400、workspace 511/511、boundaries PASS、m1/m2/m3 smoke 16/4/6。把这些修复（连同 m4-smoke 的 check4/6/9 改动）提交并重新冻结后，M4 可标记完成。
- 收口清单：
  1. 提交工作区修复并打新冻结 SHA；复跑 §1.1 全部命令 + `test.mjs`（M4 文件加入后应为 423/423；当前 421/423 的 2 个失败是 **M5 WIP 下的 M3 QA F3/F4**，需在 M4 收口前与 M5 改动分开处理）。
  2. 把 m4-smoke check5 的“守卫缺失”从 SKIP 改为 FAIL（或至少让 SKIP 明确列出依赖缺失原因）。
  3. 更新 m4-contracts §1 的“人类拒绝 → REJECTED”文字与 m4-status 裁决 3/代码对齐（QA5-08）；更新 m4-status 的“独立 QA 待做”与本报告数字。
  4. 在 m4-contracts/ADR 写明 actor 为客户端声明、Agent 无浏览器 token 的威胁模型（QA5-07），否则“Agent 不能批准自己”只能算“按声明拒绝”。
- 已达成（独立验证）：精确自审 403 + 零写入；未给 runId 的最近 Run 代理判定；PASS 证据矩阵；拒绝/再次裁决/换版（在 Task hash 存在时）；DONE 的 PATCH 双路径拒绝；返工环/上限/并发 rework 单赢家/CAS 并发 submit；v3→v4 迁移与 0004 自愈；事件链；7 端点与 16 错误码映射；双语 292/292。

---

## 8. “QA PASS ≠ 生产可用”边界

1. **真实 DSH/Magpie 仍不可用**（能力全 false 的 stub）；M4 的“执行”仍是 MockRuntime。
2. **无浏览器 E2E**：Web 工作台只到单测/静态核对层，没有 Playwright 级真浏览器验证。
3. **Scheduler 单实例、无预算/限流**；workspace 未接入 Host；JSON 仍是旧 CLI 事实源（ADR-006 停机切换未做）。
4. **actor 无认证**：M4 的自审/验收都依赖客户端声明的 actor；本地单用户模型下 Agent 若能拿到浏览器 token（同用户可读 token 文件），可绕过“不能自审/不能自批”的声明层语义（见 QA5-07）。
5. **人工验收本身是信任动作**：targetHash 是调用方提供的字符串，系统（M4）不校验其与真实产物/构建的对应关系；M5/M6 需要把 manifest/产物 hash 接入。
6. **返工/验收的自动化只到 M4 范围**：没有自动验收、没有 Review 工作流的真实 Agent 审查（M5 起）。
7. **迁移/import 的 legacy setTaskStatus** 仍可写 DONE（非 public API，仅迁移路径）。

---

## 附录 A：对抗套件清单（`test/m4-qa-adversarial.test.mjs`，23 条）

| 组 | 用例（摘要） | 冻结树 | 当前工作区 |
|---|---|---|---|
| A（4） | 精确自审 403 + 零写入；无 runId 代理判定；**空白/大小写变体**；省略 actor 默认 HUMAN（记录项） | 3 绿 + A3 红 | 4 绿 |
| B（3） | EVIDENCE_MISSING 矩阵零写入；findings 规则；**1e15 计数** | 2 绿 + B3 红 | 3 绿 |
| C（5） | 错 hash 409；**AWAITING 任务 target_hash**；task hash 正确时的 stale/匹配；再次 decide/REJECTED 分支；PATCH DONE 双路径 409 | 4 绿 + C2 红 | 5 绿 |
| D（4） | CHANGES→REJECTED→READY + 事件；**attempt 唯一**；maxAttempts=1/3 边界；并发 rework 单赢家 | 3 绿 + D2 红 | 4 绿 |
| E（2） | **store 不得有第二 DONE 入口**；事件审计链 | 1 绿 + E1 红 | 2 绿 |
| F（2） | v3→v4 迁移 + 0004 自愈；并发 submit CAS | 2 绿 | 2 绿 |
| G（3） | 7 端点表 + 隐私；词典 292/292 + 16 错误码 + APPROVAL_STALE 文案；m4-smoke 全 PASS（≥8） | 3 绿 | 3 绿（当前 gate 9/9） |

Node < 22.5（无 `node:sqlite`）时整个文件打印 SKIPPED 且不注册测试；冻结树 `test.mjs` 的 400 基线不受影响。

## 附录 B：复跑命令

```bash
# 冻结树 36c9b55（隔离解包 + 包内 @atk/* 指向解包树；不要用当前 M5 WIP）
node scripts/test.mjs                    # 400/400
node scripts/test-workspace.mjs          # 511/511（50 文件）
node scripts/check-boundaries.mjs        # PASS 8/6/0
node scripts/m1-smoke.mjs                # 16/16
node scripts/m2-smoke.mjs                # 4/4
node scripts/m3-smoke.mjs                # 6/6
node scripts/m4-smoke.mjs                # 8/8（冻结）；当前修复后 9/9
node --test test/m4-qa-adversarial.test.mjs  # 冻结 18/23；当前 23/23

# 变异（隔离树）
# M1 submitReview 去掉自审 → reviews.test.mjs 红
# M2 PATCH DONE 放行 → apps/backend/test/review.test.mjs 红
# M3 decideApproval hash 校验失效 → approvals.test.mjs 红
```
