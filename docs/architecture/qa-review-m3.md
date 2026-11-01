# M3 独立 QA 复核报告（QA-004）

- 文档类型：独立复核报告（Reviewer / QA Function，身份隔离）
- 审查对象：分支 `m0/baseline-and-p0`，**冻结 commit `25559b232f5c3be08b21d9eb50e728b1021953b6`**（HEAD）
  - M3 提交：`bc8b2b0` scheduler-core / `b116bb6` database（0003 + snapshot/claimTask）/ `23fa52a` backend M3 端点 / `0824f8b` apps/scheduler + m3-smoke / `550b552` M3 文档 / `3c8a1ed` 边界
- 审查者：`qa-reviewer`（REVIEWER/QA）。M3 代码由 Lead、`worker-runtime-spike`、`worker-database`、`worker-backend` 编写，审查者未参与，只做独立验证与对抗测试。
- 环境：Windows 11，Node v24.16.0；仓库 `E:\CodeProject\agent-team-kit`。
- 审查期间 Lead 的 `127.0.0.1:1421` 服务没有被停止/修改；QA 全部使用临时库 + 随机端口。
- **冻结树口径**：`git archive 25559b2` 解包到 `E:\CodeProject\atk-qa-m3-frozen`，并把每个包的 `node_modules/@atk/*`（包括 `apps/web` 的 `@atk`）重新指向解包树。这一点是必要的：审查期间工作区出现了未提交的 **M4 WIP**（`m4-contracts.md`、`SELF_REVIEW_FORBIDDEN` 等），若不做隔离，`test-workspace` 会读到主仓库的 M4 契约而显示 428/433 假失败。M3 的所有结论以隔离的冻结树为准，修复状态另标。
- 审查者交付：`test/m3-qa-adversarial.test.mjs`（25 条）、本报告。未改产品代码/他人测试，未执行改变 git 状态的命令，未 commit。

> **结论：M3 在冻结 SHA 上不能标记完成（1 个 BLOCKER 未修）；BLOCKER 修复后可以。** 冻结版本有 **1 BLOCKER + 6 MINOR**（无 MAJOR）。BLOCKER 是 Scheduler 进程入口 `cli.mjs` 直接 import 失败（M3 声称的“独立 Scheduler 进程”从未被执行过）；另发现 Host CLI 有同类缺陷。Lead 已在审查期间修复两处 CLI、新增进程级测试并把 m3-smoke 扩到 6 项；同时采纳了“幂等跨重启”“写域路径拼写”两条 MINOR 的修复单。截至本报告：`test/m3-qa-adversarial.test.mjs` 在当前工作区 **25 条 / 24 pass / 1 fail**（只剩 QA4-02 跨重启幂等；A2/F1 已在审查期间被修复），冻结树上 **25 条 / 21 pass / 4 fail**（A2、B6、D1 CLI、F1 四条，均为当时的真实缺口）。**QA PASS ≠ 生产可用**，边界见 §8。

---

## 1. 执行清单（真实命令 / 退出码 / 关键输出）

### 1.1 冻结树 `25559b2`（隔离解包）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `node scripts/test.mjs` | 0 | **375 tests / 375 pass / 0 fail / 0 skipped / 0 todo** |
| 2 | `node scripts/test-workspace.mjs` | 0 | 42 文件 / **433 tests / 433 pass / 0 fail** |
| 3 | `node scripts/check-boundaries.mjs` | 0 | **PASS**：8 package(s) / 6 edge(s) / 0 cycle(s) |
| 4 | `node scripts/m1-smoke.mjs` | 0 | **16/16**（M1 无回归） |
| 5 | `node scripts/m2-smoke.mjs` | 0 | **4/4**（M2 无回归） |
| 6 | `node scripts/m3-smoke.mjs --verbose` | 0 | **5/5**；但见 §2 的门禁自审（合成环、Host 步骤未被断言） |
| 7 | `node --test test/m3-qa-adversarial.test.mjs`（在冻结树） | 1 | **25 tests / 21 pass / 4 fail**：A2 环报告不全、B6 幂等不跨重启、D1 Scheduler CLI 起不来、F1 missingDeps 形状；其余 21 条绿 |
| 8 | 变异测试（隔离树，见 §5） | — | 基线 66/66 绿；**3/3 变异被产品测试抓到** |
| 9 | 两个真实 Scheduler CLI 进程（冻结树） | — | 无法执行：两进程都在 import 阶段 `ERR_MODULE_NOT_FOUND`（QA4-01） |
| 10 | 真实 DB 环（隔离临时库） | 0 | 手工插入反向依赖后：`planDispatch proposals=0`、scheduler round 0 次 claim、`runs=0`、任务状态不变（说明合成快照并非在掩盖后端 bug） |

### 1.2 当前工作区（post-freeze 修复 + M4 WIP；不作为 M3 结论）

| 命令 | 结果 |
|---|---|
| `node --test test/m3-qa-adversarial.test.mjs` | **25 tests / 24 pass / 1 fail**（只剩 B6 跨重启幂等；A2/F1 在审查期间已修） |
| `node scripts/test.mjs`（含本报告 25 条） | **400 tests / 399 pass / 1 fail**（即 B6） |
| `node scripts/m3-smoke.mjs` | **6/6**（新增第 6 条：spawn 真实 Scheduler CLI 进程） |
| `node apps/scheduler/cli.mjs --help` / `node apps/runtime-host/cli.mjs --help` | 均是 exit 0、打印 Usage（BLOCKER 已修） |
| 两个真实 CLI 进程并发（同一后端） | 两个进程 exit 0；3 个任务、3 个 Run、3 个 command，**每任务恰好 1 个 Run**（第二次 round 的重复 proposal 被幂等 claim 吸收，没有重复派发） |
| 写域路径变体（当前工作区） | `./src/...`、反斜杠已与 `src/...` 冲突；**目录前缀 `src` 仍被放行**（QA4-03 未完全关闭） |
| `m3-status.md` | 仍写 `350/350`、`423/423`、`m2-smoke 3/3`、独立 QA 待补、m3-smoke 5/5（QA4-07 文档过期） |
| `test-workspace.mjs`（当前工作区） | 432/433：失败是未提交 M4 WIP 新增 `SELF_REVIEW_FORBIDDEN` 尚无 i18n 文案，**不是 M3 冻结树的 433/433** |

---

## 2. `m3-smoke` 门禁自审（把它当被测物）

**结构上不会再“服务已死仍继续”**：checks 循环在 `try` 内、`finally` 只负责停 backend；每条 check 的 fetch/socket 失败会被该 check 捕获为 FAIL。**这一条 PASS。**

冻结版 5 条 check 的门禁强度如下（结论：**部分自证，需要独立复核补位**）：

1. **“环整体拒绝”用的是合成快照，不碰数据库/后端**（`m3-smoke.mjs:207-236`，注释已解释理由：真环会让整个计划拒绝，饿死后续检查）。这是**有意的设计取舍，不是伪造**：`planDispatch` 是纯函数，环规则确实在 planner；QA 用**真 SQLite + 真 scheduler** 复算（临时库插入反向依赖）：`proposals=[]`、scheduler 0 proposals、`runs=0`、所有任务保持 READY —— planner 行为正确。但门禁本身**不能证明**“含环 DAG 下后端零 claim”是端到端事实，只能证明 planner 输出。因此判 **MINOR（门禁覆盖不足，不是产品缺陷）**，并在本报告 F2 用真实 DB 补上。
2. **“单租约”检查不是空转**：它先让 scheduler 领一个新 probe task，然后循环 claim **所有**可领 command；断言每个 Run 恰好 1 条 live lease、同一 Run 不被领两次、所有 command 都被租走后额外 claim 返回 null。输出 “2 claim(s), 1 live lease per run, extra claim null”。**这一条真实有效**（它的标题“a second claim gets nothing”略夸张，但断言的是正确的不变量）。
3. **“重启不重复”构造的是新 Scheduler 实例**（无内存状态，只读快照），不是真正的进程重启；它证明“无状态 + 快照可重建”，但没有覆盖 SIGINT/新进程/两个进程并发。QA 用 D1（CLI 进程）、D2（两实例并发）、D3（重启 + stop 不取消）补位，均通过。
4. **“验收后继续”里的 Host 步骤是装饰性的**：check1 已将 M3-A 置为 CLAIMED；check5 的 `host.tick()` 没有断言 Run 状态/命令状态，随后无论 Host 是否真正完成都能把 Task 手工推到 DONE（冻结版用 PATCH 链，post-freeze 版改走 M4 approval）。QA 的 F4 实测：Run 通过内部 API COMPLETED/命令 DONE 后，Task **仍停在 CLAIMED**（M3 无自动验收，m3-status §5.1 已诚实记录）；因此“验收后继续”的语义应读作“人工把 Task 推到 DONE 后继续”，而不是“Host 跑完后继续”。判 **MINOR（门禁叙事过强，已用 F4 补证；回执已注明无自动验收）**。
5. **不覆盖 claim 的失败类/幂等/容量/写域**（由包测试覆盖）；门禁只验调度主链。可接受，但应写清边界（m3-contracts §5 已写）。

Post-freeze 修复：Lead 新增第 6 条 check“真实 Scheduler CLI 进程启动并完成一轮”（直接针对 QA4-01 的教训）；check5 改走 M4 人工验收（approvals），不再用 PATCH 直接 DONE。**当前 6/6 真实通过。**

---

## 3. A–F 结论表（期望 · 实际 · 判定）

判定：**PASS** = 契约满足；**FAIL** = 冻结版本违反（修复状态另注）；**OBSERVATION** = 记录项。

### A. 调度算法（scheduler-core，纯函数）

| 项 | 期望 | 实际（冻结） | 判定 |
|---|---|---|---|
| A1 直接/自依赖/间接/多环 | 全部拒绝、`proposals: []`、所有 task `skipped.reason="cycle"` | 一致（4 种形态全过） | PASS |
| A2 报告每条环（契约 §1 “报告每条环”） | 共享节点图 A→{B,C}、B/C→D、D→A 应报 A-B-D 与 A-C-D | 冻结：只报 A-B-D，漏 A-C-D（QA4-04）；审查期间已修为“枚举 SCC 内全部简单环”，当前用例转绿 | **冻结 MINOR FAIL → 已修 PASS** |
| A3 拓扑序合法性、输入乱序不变 | 每个 dep 在前；乱序结果相同 | 一致（含 levels） | PASS |
| A4 确定性（同快照两次 / tasks·agents·runs 乱序） | 字节级相同 | 一致 | PASS |
| A5 100 task / 20 agent | 快、确定、proposal 有界 | 一致（毫秒级、同序、proposals=10） | PASS |
| A6 skip 原因 | deps/capacity/no-idle/write-scope 可区分 | 一致（分别构造四类场景） | PASS |
| A7 缺失 dep | 不进入候选、报 `deps-incomplete` | 一致 | PASS |

### B. claimTask 原子性 / 幂等 / 失败零写入

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| B1 成功 claim | 1 Run（STARTING）+ 命令 PENDING + Task CLAIMED v+1 + 2 事件（task.updated/run.created）+ snapshot.version +2 | 一致 | PASS |
| B2 两真实进程同时 claim | 1 winner / 1 `TASK_VERSION_CONFLICT`；1 Run | 一致（子进程 barrier） | PASS |
| B3 同 idempotencyKey 重放 | 同 run/command，零写入；同 key 换 task → VALIDATION_ERROR | 一致（store 层） | PASS |
| B4 五类失败零写入 | 版本/依赖/agent/容量/写域失败 → 对应错误码且 fingerprint（version/tasks/runs/events/commands）完全不变 | 一致（逐类断言） | PASS |
| B5 HTTP claim | 成功/同进程重放/依赖拒绝，拒绝时零写入 | 一致 | PASS |
| B6 **跨 Backend 重启的幂等重放** | 同 key 仍返回原 `{run,command,task}`（契约 §5 无进程限定） | **重启后 409 TASK_VERSION_CONFLICT**：route 的 `claimIdempotency` 是进程内 Map，且在 store 持久幂等分支之前做了 READY/version 预检（QA4-02） | **MINOR FAIL（已派单）** |
| B7 五类失败错误码 | TASK_VERSION_CONFLICT / TASK_DEPENDENCY_BLOCKED / CAPABILITY_UNAVAILABLE(reason) | 一致 | PASS |

### C. 单租约与容量

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| C1 同 Run 单 live lease | 两个 host 只有 1 个拿到 lease；DB 恰好 1 条 live lease | 一致 | PASS |
| C2 容量 | 超 maxPerAgent / maxConcurrentPerProject 拒绝（`CAPABILITY_UNAVAILABLE` + reason capacity） | 一致（store + backend 双检） | PASS |
| C3 租约过期 | 过期 command 可重领、attempts+1、generation+1 | 一致（M2 语义沿用） | PASS |
| C4 两 Scheduler 并发 | 不重复派发（原子 claim 兜底） | 库实例并发：每任务 1 Run/1 command；真实 CLI 两进程（修复后）：同样 3 task/3 run/3 command | PASS |

### D. Scheduler 进程

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| D1 进程入口可运行 | `node apps/scheduler/cli.mjs --help` exit 0；`--once` 可用 | **冻结：`ERR_MODULE_NOT_FOUND`（import `./client.mjs`、`./index.mjs`，实际在 `src/`）→ exit 1**（QA4-01） | **BLOCKER FAIL（已修）** |
| D2 两实例同时跑 | 不重复派发 | 一致（库级并发；修复后真实两 CLI 进程也验证：每任务 1 Run） | PASS（修复后） |
| D3 重启 / 优雅停止 | 新实例只领新 READY；stop 不取消已派发 Run | 一致 | PASS |
| D4 快照失败退避 | 不退出、1000→2000→4000ms | 一致（runOnce 返回 ok:false + backoffMs） | PASS |
| D5 缺 token | CLI exit 2 且提示 | 冻结无法验证（import 先失败）；修复后 CLI 测试覆盖 exit 2 | PASS（修复后） |
| D6 CLI 真实进程 | 真实后端 + token，`--once` 完成一轮 | 修复后（含 m3-smoke 第 6 条）通过 | PASS（修复后） |

### E. 迁移与数据

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| E1 v2→v3 原地升级 | schemaVersion 3、数据保留、0003 列存在 | 一致（当前工作区因 M4 有 0004 时为 ≥3） | PASS |
| E2 0003 幂等 / 记账行丢失自愈 | 重复 open 幂等；丢 `schema_migrations` v3 后不崩、修复记录、数据保留 | 一致（自愈 WARN：column(s) already exist；schema 仍 ≥3） | PASS |
| E3 snapshot.version 单调 | 失败不涨、成功 +2 | 一致（实测 before/afterFailure/afterSuccess） | PASS |

### F. 文档、门禁与隐私

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| F1 m3-contracts §5 与代码一致 | readyCandidates `{candidates, missingDeps:[{taskId, missing:string[]}]}` | 冻结：代码返回 `{taskId, depId}`（QA4-05）；审查期间已改为契约形状，当前用例转绿；其余 §5 形状一致 | **冻结 MINOR FAIL → 已修 PASS** |
| F2 m3-status 已知限制诚实 | 无自动验收/单实例/无预算/workspace 未接入 | 限制本身写得诚实（§5.1-5.7）；但数字过期：350/350、423/423、m2 3/3、m3 5/5、“独立 QA 待补”（QA4-07） | **部分 MINOR** |
| F3 隐私 | 新文件无令牌/本机绝对路径 | 0 命中 | PASS |
| F4 m3-smoke 自身 | 断言真实事实 | 见 §2：环=合成快照（MINOR 覆盖不足）；check5 Host 未断言（MINOR）；post-freeze 新增 CLI check | **部分 MINOR** |

---

## 4. 缺陷清单

> 状态为审查结束时的状态；“已修”指审查期间 Lead 已落盘（未由 QA commit），“已派单”指 Lead 采纳但工作区尚未完成。

### QA4-01（BLOCKER，已修）Scheduler 进程入口无法启动；Host CLI 同类缺陷

- 位置：`apps/scheduler/cli.mjs:13-14` 静态 import `./client.mjs` / `./index.mjs`，实际文件在 `src/`；`apps/runtime-host/cli.mjs` 同类（`./client.mjs` / `./host.mjs`）。
- 复现（冻结隔离树）：`node apps/scheduler/cli.mjs --help` 与 `--once` 都 exit 1，`ERR_MODULE_NOT_FOUND`；`--help` 也失败（静态 import 先于 main）。Host 同理。
- 影响：M3 契约 §3/ATK-305 声称的“独立 Scheduler 进程（轮询/退避/心跳/SIGINT）”从未被执行；m3-smoke 直接 import `src/index.mjs`，7 个 scheduler 测试也 import 库，所以 5/5 与包测试全绿掩盖了它。部署/启动（M5 `atk start`）会直接失败。
- 修复验证（post-freeze 工作区）：两 CLI import 改到 `./src/...`；`--help` exit 0、缺 token exit 2、`--once` 走真实后端成功；m3-smoke 新增第 6 条“真实 Scheduler CLI 进程”；`apps/scheduler/test/cli.test.mjs`、`apps/runtime-host/test/cli.test.mjs` 为进程级回归。QA 用真实后端起两个 CLI 进程并发：3 任务/3 Run/3 command，每任务 1 Run。
- 归属：Lead（scheduler/host CLI）+ worker-runtime-spike（Host）。

### QA4-02（MINOR，已派单）`idempotencyKey` 重放不能跨 Backend 重启

- 位置：`apps/backend/src/routes-internal.mjs` 的 `claimIdempotency` 是进程内 Map，且 replay 判断发生在 `store.claimTask`（持久幂等分支）之前；重启后 route 先做 READY/version 预检 → 失败。
- 复现：HTTP claim 成功（200）→ 同 key 同进程重放 200 同 run/command → kill Backend 再起（同库）→ 同请求 **409 TASK_VERSION_CONFLICT**（`details.currentVersion=1, status=CLAIMED`）。
- 依据：m3-contracts §5 “同 idempotencyKey 重放返回既有 `{run,command,task}`”，没有进程限定。
- 影响：安全性不变（Task 已 CLAIMED，不会重复派发），但契约级幂等承诺在有 Backend 重启/网络重试的客户端上不成立。修复方向（Lead 已派单）：先尝试 store 持久幂等，再走 route 预检；或把缓存持久化。
- 归属：worker-backend。

### QA4-03（MINOR，部分修复）写域检查在 Backend/Store 只做精确字符串比较，路径拼写/目录前缀可绕过

- 位置：`packages/database/src/model.mjs` 的 `filesIntersection`（精确 Set 交集）；`routes-internal.mjs` 的 `assertWriteScope` 也是 `candidateFiles.filter(file => files.includes(file))`。scheduler-core 则用 `normalizePath` + `pathsOverlap`（目录包含），比后端更严格。
- 复现（冻结隔离库，active run files=`["src/win\\path.js"]`，claim 新任务）：
  - `["src/win/path.js"]` → **ALLOWED**（未规范化）
  - `["./src/win/path.js"]` → **ALLOWED**
  - `["src"]` → **ALLOWED**（目录 scope 应包含该文件）
  - 同字符串 `["src/win\\path.js"]` → 正确拒绝。
- 当前工作区状态：Lead 已让 store 统一 normalize，`./` 与反斜杠两种变体已拒绝；**目录前缀 `src` 仍被放行**，因此未完全与 scheduler-core 对齐。
- 依据：m3-contracts §2 step 6 “files 与 activeRuns 的 files 有交集 → 拒绝”；§5 写域说明以最长前缀/路径 scope 语义描述。Scheduler 会跳过这些冲突，所以正常链路安全；但后端是最后防线，直接调用内部 claim 的客户端可造成两个并发 Run 写同一文件。
- 归属：worker-database / worker-backend。

### QA4-04（MINOR，已修）`detectCycles` 曾漏报部分简单环

- 位置：`packages/scheduler-core/src/index.mjs` `detectCycles`（DFS 只用 back-edge 当前栈生成环，不枚举 SCC 内所有简单环）。
- 复现：任务 A deps [B,C]；B deps [D]；C deps [D]；D deps [A]。实际存在 A-B-D 与 A-C-D 两个环；`detectCycles` 只返回 `[["A","B","D"]]`。
- 依据：m3-contracts §1 `detectCycles` “强连通：报告每条环”。安全性不受影响（`cycles.length>0` 仍整体拒绝、proposals=[]），但“每条环”诊断不完整；若消费方按 cycles 列表修复图，会漏。
- 归属：worker-runtime-spike。

### QA4-05（MINOR，已修）`readyCandidates` 的 `missingDeps` 形状曾与契约 §5 不一致

- 契约 §5：`{ candidates: Task[], missingDeps: [{taskId, missing: string[]}] }`；代码：`missingDeps: [{taskId, depId}]`。
- 影响：文档/实现不一致（调用方目前只有 `planDispatch`，未使用 `readyCandidates`，所以是契约债务）。建议二选一统一：改代码为 `missing` 数组，或改契约文字。
- 归属：worker-runtime-spike / Lead（契约）。

### QA4-06（MINOR，部分修复）`m3-smoke` 的门禁自证面

- 环拒绝：合成快照（不碰 DB/后端）——见 §2；QA 已用真实 DB 补证（正确）。门禁/契约应明确“环规则由 planner 单测 + QA 真实 DB 覆盖”，不要声称端到端零 claim。
- check5：`host.tick()` 的 Run 完成/命令状态从未断言，Task 早在 check1 就是 CLAIMED，因此 Host 完全坏掉该 check 仍绿；post-freeze 已改为 M4 approval 路径并保留诚实说明，但“真实 Host 全链路”仍不是 check5 证明的东西。
- 不覆盖：两 Scheduler 并发、CLI 进程（post-freeze 已补 CLI check，并发仍由 QA 覆盖）、claim 失败类（包测试覆盖）。
- 归属：Lead。

### QA4-07（MINOR，未修）`m3-status.md` 数字与状态过期

- §1 仍写 `test.mjs 350/350`、`test-workspace 423/423`、`m2-smoke 3/3`、`m3-smoke 5/5`；“独立 QA 待补/M2 复核进行中”也未更新。
- 冻结实际：`375/375`、`433/433`（42 文件）、`m2-smoke 4/4`、`m3-smoke 5/5`；post-freeze 门禁 6/6。建议在标记 M3 完成时同步 §1/§5/§6。
- 归属：Lead。

### OBSERVATION

1. **Backend 的 7 步校验在 route 层和 store 层各做一遍**：route 层是 read-then-act（`getTask/listTasks/listRuns` 后再 `store.claimTask`），但最终写入永远在 store 单事务内重检——竞态安全，只是重复代码；边界图/维护成本需注意。
2. **没有 `store.claimTask` 时 Backend 返回 500 拒绝**（绝不拼多次调用造伪事务）——符合契约 §5，属正确设计。
3. **`claimTask` 的 `function`/`role` 入参被忽略**：backend 先 `resolveClaimAgent(requestedFunction/requestedRole)` 并传入 store，但 store 只用 task 的 `functionRequired/roleRequired` 重新校验；安全（以 DB 为准），但接口表面有误导。
4. **`planDispatch` 对“已有 active Run 的 READY task”静默丢弃**（无 skipped 条目）：与后端 fencing 一致，但调度诊断里该任务凭空消失；建议加进入 skipped 的机器可读原因或文档说明。
5. **Scheduler 循环不捕获 `planDispatch` 抛错**：若 `MAX_PER_AGENT` 等环境变量是非法值（CLI 用 `Number()` 直接转），`positiveIntegerOrInfinity` 抛 TypeError → `runOnce` 拒绝 → start 循环 unhandled rejection（进程崩溃/退出 1），而不是“配置错误 exit 2”。属运维健壮性，建议 CLI 启动时校验。
6. **m3-smoke 用第二个 SQLite 连接直接 seed**（backend 运行时双写者）——测试专用，可接受。
7. **写域 `files` 可选**：未声明即不判冲突（m3-status §5.7 已记录，M4 起应强制）。
8. **两个 Scheduler 的同一 proposal 会共享确定性 idempotencyKey**：后端 cache/store 让第二个调度器得到同一 `{run,command}`（200），因此两个 Scheduler 都统计为 claimed；DB 无重复（安全），但“claimed 计数”会被高估；M4 若做预算/计量需注意。

---

## 5. 变异测试（`git archive 25559b2` 隔离树，工作区未动）

方法：解包到 `E:\CodeProject\atk-qa-m3-mut`，`@atk/*` 指向解包树；基线 `claim-task/dispatch/graph` 三个测试文件 **66/66 绿**；逐个注入变异、跑对应测试、恢复。

| 变异 | 目标测试 | 结果 |
|---|---|---|
| **M1 `claimTask` 跳过依赖检查** | `packages/database/test/claim-task.test.mjs` | **CAUGHT**：5 tests / 4 pass / 1 fail（`claimTask rejects each of the 7 checks and leaves the DB byte-for-byte unchanged`） |
| **M2 `planDispatch` 在含环快照里仍返回非环任务的 proposal** | `packages/scheduler-core/test/dispatch.test.mjs` + `graph.test.mjs` | **CAUGHT**：61 tests / 59 pass / 2 fail（`planDispatch rejects the whole plan when any cycle exists`、`… rejects a 100-task snapshot that contains one cycle`） |
| **M3 `claimTask` 去掉持久幂等重放分支** | `packages/database/test/claim-task.test.mjs` | **CAUGHT**：5 tests / 4 pass / 1 fail（`claimTask replays the same idempotencyKey without creating a second run`） |

结论：M3 产品测试对“依赖检查、环整体拒绝、持久幂等”真的会失败，3/3 被抓。QA 套件在同一冻结树上的 25 条另有 4 条红（见 §1.1），额外覆盖了产品测试没有的产品入口（CLI）、环报告完整性、missingDeps 形状、跨重启幂等。

---

## 6. 契约 vs 代码（m3-contracts §5 + 实现定稿事实）

| 契约项 | 代码/测试验证 | 结论 |
|---|---|---|
| `planDispatch` 纯函数、`now` 注入、确定性 | A3/A4/A5 乱序 + 字节相同；变异 M2 被抓 | 一致 |
| 环整体拒绝、每个 task cycle | A1 + 真实 DB F2；m3-smoke 合成快照（覆盖不足见 QA4-06） | 一致（报告每条环例外 QA4-04） |
| `readyCandidates` 形状 | 代码 `{taskId, depId}` vs 契约 `{taskId, missing[]}` | **不一致（QA4-05）** |
| `matchAgents` 形状 | `{candidates, excluded}` | 一致 |
| `scoreAndSort` 权重 | priority↑ → waitingMs↓ → id；`score = priority*1e12 - waitingMs` | 一致 |
| 快照 `version=MAX(events.seq)` | 失败 0、成功 +2（E3） | 一致 |
| claim 7 步单事务、失败回滚 | B4 fingerprint 逐类一致；变异 M1/M3 被抓 | 一致 |
| 失败错误码/details | B4/B7 实测：version→TASK_VERSION_CONFLICT；dep→TASK_DEPENDENCY_BLOCKED；agent/capacity/write-scope→CAPABILITY_UNAVAILABLE+reason | 一致 |
| claim 幂等（同 key） | 同进程 200 同 run/command（B3/B5）；跨 Backend 重启 409（B6，QA4-02） | 部分不一致 |
| 写域冲突 | 精确字符串一致时拒绝；规范化/目录 scope 有洞（QA4-03） | 部分不一致 |
| Scheduler 无状态、重启重建 | D3/D4 + 两实例/两进程 D2/C4 | 一致 |
| Scheduler 进程/心跳/优雅停止 | 冻结 CLI 不可运行（QA4-01）；修复后 CLI 进程可用，stop 不取消 Run（D3） | 修复后一致 |
| 路由不写业务状态、只提建议 | Scheduler 只调 snapshot/claim/heartbeat；测试/m3-smoke 真实链路 | 一致 |

---

## 7. 结论：M3 能否标记完成

**冻结 SHA `25559b2` 不能标记完成**（存在 1 个 BLOCKER：Scheduler 进程入口不可运行，且 Host CLI 同类缺陷）。修复后：

- 已修复（审查期间）：QA4-01（BLOCKER，两处 CLI + 进程级测试 + m3-smoke 第 6 条）；QA4-03 的规范化部分（`./`、反斜杠）。
- 审查期间已修：QA4-04（环枚举改为 SCC 内全部简单环）、QA4-05（missingDeps 改为 `{taskId, missing[]}`）。
- 报告时仍未关闭：QA4-02（跨重启幂等，唯一红用例）、QA4-03 的目录前缀部分、QA4-07（m3-status 数字）；QA4-06 为门禁/文档说明项（post-freeze 已加 CLI check 并保留诚实说明）。
- 建议 M3 完成的条件：上述剩余 3 条 MINOR 修复/明确接受后，把 `test/m3-qa-adversarial.test.mjs` 纳入 CI（当前工作区 25 条中 24 绿，唯一红是 QA4-02），并复跑 `test.mjs`（当前 400：399 pass/1 fail）、`test-workspace`（隔离冻结 433/433）、`m1/m2/m3-smoke`（16/16、4/4、6/6）。**不要用当前 M4 WIP 的 432/433 作为 M3 回归证据**（那是 M4 未提交的 i18n 缺口）。
- 已达成（独立验证）：调度确定性/依赖顺序/环整体拒绝/100×20 规模；claimTask 单事务原子性、两进程单 winner、五类失败零写入；单 Run 单 live lease、容量双检；Scheduler 无状态重启/两实例/两 CLI 进程不重复派发；v2→v3 迁移与 0003 自愈、snapshot.version 单调；真实 DB 环零 claim。
- 无 MAJOR；1 BLOCKER（已修）+ 6 MINOR（3 未关闭/3 部分或文档）。

---

## 8. “QA PASS ≠ 生产可用”边界

即使 M3 标记完成，本结论**不构成生产可用性背书**：

1. **真实 DSH/Magpie 仍不可用**：能力全 false 的 stub，RT-P07/P08 未验证；M0 结论不变。
2. **无预算/限流/暂停/取消策略**（规范 §8 的一部分），也没有优先级抢占、DAG 重规划。
3. **Scheduler 单实例、无选主**：多实例靠 Backend 原子 claim 兜底，正确但不经济；没有 leader 选举/租约。
4. **workspace 未接入 Host**：claim 后不会自动建 worktree（M4/M5）。
5. **无自动验收**：Run 完成不会推进 Task；M3 依赖人工走合法链（M4 approval 才闭环）。
6. **JSON 仍是旧 CLI 的事实源**：SQLite 是执行侧事实源，ADR-006 切换仍未做。
7. **单用户本机安全模型**：内部 token 走进程环境；API 仍是 loopback 信任模型。
8. **测试缺口**：m3-smoke 的环是 planner 级验证（QA 已补真实 DB）、check5 不证明 Host 全链路；两 Scheduler 并发只由 QA 覆盖。

---

## 附录 A：对抗套件清单（`test/m3-qa-adversarial.test.mjs`，25 条）

| 组 | 用例（摘要） | 冻结树 | 当前工作区 |
|---|---|---|---|
| A（6） | 四种环整体拒绝；**每条环报告**；拓扑序/乱序；确定性；100×20；四类 skip 原因 | 5 绿 + A2 红 | 5 绿 + A2 红 |
| B（6） | 成功 claim；两进程 claim；store 幂等；五类失败零写入；HTTP 成功/重放/拒绝；**跨重启幂等** | 5 绿 + B6 红 | 5 绿 + B6 红 |
| C（2） | 单 live lease；容量（agent/project） | 2 绿 | 2 绿 |
| D（4） | **CLI 可运行**；两实例并发；重启/停止；退避 | D1 红 + 3 绿 | 4 绿 |
| E（3） | v2→v3；0003 自愈；version 单调 | 3 绿 | 3 绿 |
| F（4） | **missingDeps 契约形状**；真实 DB 环零 claim；m3-smoke 净绿+隐私；人工验收边界 | 3 绿 + F1 红 | 3 绿 + F1 红 |

Node < 22.5（无 `node:sqlite`）时整个文件打印 SKIPPED 且不注册测试，legacy 20/22 CI 的 375 基线不受影响。

## 附录 B：复跑命令

```bash
# 冻结树 25559b2（隔离解包 + 包内 @atk/* 指向解包树；不要用当前 M4 WIP 工作区）
node scripts/test.mjs                 # 375/375
node scripts/test-workspace.mjs       # 433/433（42 文件）
node scripts/check-boundaries.mjs     # PASS 8 packages / 6 edges / 0 cycles
node scripts/m1-smoke.mjs             # 16/16
node scripts/m2-smoke.mjs             # 4/4
node scripts/m3-smoke.mjs             # 5/5（冻结）；当前修复后 6/6
node --test test/m3-qa-adversarial.test.mjs  # 冻结 21/25（4 红）；当前 24/25（1 红：B6）

# 变异（隔离树）
# M1 去掉 claimTask 依赖检查 → claim-task.test.mjs 红
# M2 planDispatch 环时返回 proposal → dispatch/graph test 红
# M3 去掉 claimTask 幂等重放 → claim-task.test.mjs 红
```
