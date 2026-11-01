# M2 独立 QA 复核报告（QA-003）

- 文档类型：独立复核报告（Reviewer / QA Function，身份隔离）
- 审查对象：分支 `m0/baseline-and-p0`，**冻结 commit `fed5ee868bfd6a8fb4442c417e6d47e830318a28`**
  - M2 提交：`4158ea4` runtime-sdk / `281a03b` database（Run/租约/命令）/ `b828694` backend 内部 API / `87766eb` runtime-host + m2-smoke / `fed5ee8` M2 文档
- 审查者：`qa-reviewer`（REVIEWER/QA）。M2 产品代码由 Lead、`worker-runtime-spike`、`worker-database`、`worker-backend` 编写，审查者未参与，只做独立验证与对抗测试。
- 环境：Windows 11，Node v24.16.0，pnpm 11.6.0；主仓库 `E:\CodeProject\agent-team-kit`。
- 关键时序说明：审查期间 Lead 在 `127.0.0.1:1421` 上运行 M2 demo 服务，**没有被停止或修改**；QA 全部使用临时库 + 随机端口（另有一次 14215 手工联调）。审查进行到一半时，BLOCKER 上报后 Lead 追加了 `b8fc426`（修 QA3-01），随后工作区又出现未提交的 M2 修复与 M3 WIP 改动。为保持“冻结 SHA”口径，**主结论全部基于 `git archive fed5ee8` 解包出的隔离树**（`@atk/*` 链接指向解包树，不是主仓库）；修复状态另用 `b8fc426` 与当前工作区验证，均单独标注。
- 审查者交付：`test/m2-qa-adversarial.test.mjs`（25 条）、本报告。未修改任何产品代码/他人测试，未执行改变 git 状态的命令，未 commit。

> **结论：M2 可以标记完成。** 冻结版本有 **1 个 BLOCKER + 2 个 MAJOR + 5 个 MINOR**；BLOCKER 已由 `b8fc426` 修复，2 个 MAJOR 与 5 个 MINOR 已由后续（审查结束时的）工作区修复全部关闭。当前工作区：`test.mjs 375/375`、`test-workspace 433/433`、`m1-smoke 16/16`、`m2-smoke 4/4`、QA 对抗套件 **25/25**、边界 PASS。**但“QA PASS ≠ 生产可用”**：真实 DSH 适配器仍不可用、无 Scheduler、JSON 仍是旧 CLI 事实源、Host 单会话串行、无浏览器 E2E（见 §8）。

---

## 1. 执行清单（真实命令 / 退出码 / 关键输出）

### 1.1 冻结树 `fed5ee8`（隔离解包，`E:\CodeProject\atk-qa-frozen-fed5ee8`）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `node scripts/test.mjs` | 0 | **350 tests / 350 pass / 0 fail / 0 skipped / 0 todo**（M1 未退化；加入本报告 25 条后见 §1.2） |
| 2 | `node scripts/test-workspace.mjs` | 0 | 33 文件 / **321 tests / 321 pass / 0 fail** |
| 3 | `node scripts/check-boundaries.mjs` | 0 | **PASS**：6 package(s) / 5 edge(s) / 0 cycle(s) |
| 4 | `node scripts/m1-smoke.mjs` | 0 | **16/16 checks passed**（M1 无回归） |
| 5 | `node scripts/m2-smoke.mjs --verbose` | 0 | **3/3 checks passed**——但 stderr 同时有 `[host] result: 400 VALIDATION_ERROR invalid ownerId`、`[host] interrupt-result: 400 …`、`[host] events: 400 … illegal run transition`。**这是假绿，见 QA3-01** |
| 6 | `cmd /c "pnpm --filter @atk/web build"`（主检出，M2 未改 web 源码） | 0 | `tsc --noEmit && vite build`；dist `index.html 445 B`、`index-39V7qS6z.css 15,529 B`、`index-CidX81qC.js 285,841 B`（gzip 0.28 / 3.27 / 85.94 kB） |
| 7 | 真实服务（端口 **14215**，临时库 + `--web-dist apps/web/dist`） | 0 | health 200（schemaVersion 3，因当前树有 M3 的 0003）/session token 43 + csrf 43/一次完整 MockRuntime Run → `COMPLETED`、`dispatch command DONE`、`host.stats.errors=0`；internal reconcile/heartbeat/sweep 全 200，reconcile 返回已过期 lease（generation 保留）；SSE 收到 `run.updated` + `run.log` 且**不含内部 token** |
| 8 | `node --test test/m2-qa-adversarial.test.mjs`（在隔离的冻结树上，当时文件还带 5 个 `todo` 标记） | 1 | **25 tests / 16 pass / 4 fail / 5 todo-fail**——4 个绿测试是回归守卫（B6 命令 DONE、D1/D2 崩溃回收、F2 门禁自审），5 个 todo 是当时未修的缺口。修复落盘后这 5 条已转成普通 test；若在冻结树上跑**转正后**的同一文件，结果为 **16 pass / 9 fail**（即当时所有缺口都会直接红，不再有 todo 静默） |
| 9 | 变异测试（隔离树，见 §5） | — | 基线 35/35 绿；**3/3 变异被产品测试 + QA 套件抓到** |
| 10 | 迁移：手工造 v1 库 → v2；同库 openStore 两次 | 0 | v1 数据保留、`schemaVersion 2`、`schema_migrations` 2 行；重复 open 幂等。裸重跑 0002 会 `duplicate column name`（见 QA3-06） |

> 注：在**非 ASCII 路径**（例如 `%TEMP%` 带中文用户名）解包时，`test.mjs` 曾出现 348/350——根因是先前的 `test/config.test.mjs` 用 `new URL(import.meta.url).pathname`（未解码），与产品无关，QA3-07 已修。

### 1.2 当前工作区（`b8fc426` + 审查结束时未提交的修复）

| 命令 | 结果 |
|---|---|
| `node scripts/test.mjs` | **375 tests / 375 pass / 0 fail / 0 skipped / 0 todo**（350 基线 + 本报告 25 条） |
| `node scripts/test-workspace.mjs` | **433 / 433 pass**（42 文件；比冻结多出的是 M3 WIP 的新包/新测试，不属于 M2 判定） |
| `node scripts/check-boundaries.mjs` | **PASS**：8 package(s) / 6 edge(s) / 0 cycle(s)（含 M3 scheduler） |
| `node scripts/m1-smoke.mjs` | **16/16** |
| `node scripts/m2-smoke.mjs` | **4/4**（新增第 4 条：事件已落库、result 未发出的孤儿命令被 sweep 成 DONE） |
| `node --test test/m2-qa-adversarial.test.mjs` | **25/25 pass，0 fail，0 todo** |
| `cmd /c "pnpm --filter @atk/web build"` | exit 0（同上 dist 体积） |

---

## 2. `m2-smoke` 自身审查（把它当被测物）

**结构上不会再“服务已死仍继续”**：checks 循环在 `try` 内（`m2-smoke.mjs:319-320`），`finally` 只负责停 backend；每条 check 的 `fetch`/socket 失败会被该 check 捕获为 FAIL。**这一条判 PASS。**

冻结版仍有三处“看起来通过、实际没验证”的面：

1. **只断言 Run、不断言 dispatch command**：3 条 check 分别看 Run 状态/事件数/409，没有一条看命令是否 `DONE/FAILED`；Host 的 `result` 400 被 `safe()` 吞掉（只 `stats.errors++`），所以 QA3-01 的 BLOCKER 在 3/3 下完全隐形。
2. **Host 的吞错不可见**：即使 `--verbose` 只把错误打到 stderr，门禁退出码仍为 0；没有 `stats.errors === 0` 断言。
3. **契约 §5 声称“门禁必须覆盖 6 项”**，实际只有 3 条 check；`startFails`、`neverEnds`、reconcile 都不在门禁里（QA3-08）。

**“死 Host 回收”不是假通过（QA 独立复核）**：冻结门禁把 lease 设为 1200 ms、`await sleep(LEASE_MS + 600)` 后才让 recovery host 领取；recovery 命中“过期命令”，`attempts` 从 1→2，`recoveryRuntime._sessionCount === 0`（观察的是 mock 的会话计数，不是只看 Run 状态），Run 被标 `INTERRUPTED`。QA 用独立 SQLite 探针复算：命令 attempts=2、0 次启动、Run INTERRUPTED；所以这条 check 的**语义是真实的**，只是没断言命令终态。

**修复后（当前工作区 4/4）**门禁新增/加强了 5 类断言：`host.stats.errors === 0`、命令 `DONE`、命令 `FAILED` + `result_json` 含 `reclaimed-after-lost-lease`、无残留 `PENDING/CLAIMED`、孤儿命令被 sweep 成 `DONE` 且 `derivedFrom:"run-terminal"`；并且 `_sessionCount` 在 dead/recovery 两侧都断言。**这正是 QA3-01 要求的“门禁必须断言最终业务事实”。**

仍属门禁边界（OBSERVATION，不判缺陷）：门禁用第二个 SQLite 连接直接 seed 命令（测试期双写者，可接受）；只跑 MockRuntime；Host 的 `recover()` 持久化路径由 host 包测试覆盖，门禁不模拟真实进程崩溃重启。

---

## 3. A–F 结论表（期望 · 实际 · 判定）

判定：**PASS** = 契约满足；**FAIL** = 冻结版本违反（已修复处注明）；**OBSERVATION** = 记录项。

### A. 内部凭据与鉴权（ADR-008 §5 / ADR-010 §2 / m2-contracts §2）

| 项 | 期望 | 实际（冻结） | 判定 |
|---|---|---|---|
| A1 无/空/错 `x-atk-internal` | 403 `NOT_AUTHORIZED`，`details.reason=internal-token-missing/invalid` | 一致 | PASS |
| A1b 浏览器 token 打 `/internal/*` | 拒绝（不得接受会话 token） | 403 `internal-token-missing` | PASS |
| A1c 内部 token 打 `/api/v1/*` | 拒绝（不得接受内部凭据） | 403 `token-missing` | PASS |
| A2 内部 token 出现在响应体/响应头/错误 details/SSE 帧 | 0 | 全 0（health/session/claim/404/bad-token/SSE） | PASS |
| A3 内部 token 落盘 | 0 | 临时 LOCALAPPDATA 全目录扫描 0 命中；stdout 只出现 1 次（子进程 env 交接） | PASS |
| A4 坏 Host 打内部面 | 403 `host-not-loopback` / `host-missing` | 一致（`localhost.evil.example`、无 Host HTTP/1.0） | PASS |
| A5 旧内部请求重放 | 过期 generation → 409；终态命令重复 result 幂等返回原结果 | 一致（D4/D5、C1、B5） | PASS |

### B. claim 与租约并发（ADR-003 / m2-contracts §3/§6）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| B1 两真实进程同时 claim | 恰 1 winner，1 null；winner owner 与存库一致 | 一致（子进程 barrier 并发） | PASS |
| B2 live lease 不可被第二个 claim 抢 | null | 一致 | PASS |
| B3 过期边界（±1 ms） | 过期前 1 s 不可领、过期后 1 ms 可领，attempts+1、generation+1 | 一致（直接改 `claimed_until` 精确边界） | PASS |
| B4 同一 Run 两条 PENDING 命令 | live lease 期间第二条不可领；租约过期后**先重试过期命令**（ruling 6），新命令仍 PENDING | 一致 | PASS |
| B5 attempts / idempotencyKey | 同 key 只有一条命令；重领 attempts+1、generation 单调 | 一致（attempts 1→2，gen 1→2） | PASS |
| B6 完整 Host 会话关闭命令 | 命令 `DONE`、`host.stats.errors=0` | **冻结 FAIL：命令永远 CLAIMED**（QA3-01）；`b8fc426` 起 PASS | 冻结 FAIL → 已修 PASS |

### C. fencing / 事件 / 状态机（m2-contracts §2/§6）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| C1 旧 generation 的 events/result/renew | 409 `STALE_GENERATION`，零写入（Run version/事件数不变） | 一致 | PASS |
| C2 租约过期（未 reclaim）→ `updateRunStatus` | 409 `STALE_GENERATION`（ruling 2/8） | **冻结：成功写 COMPLETED**（MAJOR，QA3-02）；工作区已修 | 冻结 FAIL → 已修 PASS |
| C3 租约过期 → `completeDispatchCommand` | 409 | **冻结：成功写 DONE**（QA3-02）；工作区已修 | 冻结 FAIL → 已修 PASS |
| C4 `events: []` 纯 fence，旧 generation | 409（ruling 3/10） | **冻结：200**（routes 在空批次时根本不调 store，MINOR，QA3-03）；工作区已修 | 冻结 FAIL → 已修 PASS |
| C5 >8 KiB output | `run.log` 文本 ≤8192 B，`truncated:true`，`bytes:9000` | 一致 | PASS |
| C6 未知类型/畸形 payload | 400，零写入 | 一致（Run 仍 STARTING、version 0、无事件） | PASS |
| C7 重复批次/单写者 | 重放 skipped；一次状态迁移恰好 1 条 `run.updated`（RUNNING+COMPLETED 共 2 条），`run.log` 1 条 | 一致（ruling 1） | PASS |
| C8 完成后的 reconcile | 返回**已过期 lease（非 null）**，generation 保留 | 一致（ruling 4） | PASS |

### D. Host 崩溃时序

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| D1 start 之前崩溃（命令 CLAIMED 无会话） | 回收 attempts>1：Run `INTERRUPTED`、命令 `FAILED` + `reclaimed-after-lost-lease`、0 次启动 | 冻结：Run 正确但**命令 CLAIMED**（result 400 吞错）；`b8fc426` 起命令 FAILED，一致 | 冻结部分 FAIL → 已修 PASS |
| D2 `session.started` 之后、result 之前崩溃 | 同上，绝不二次启动 | 同上；`recoveryRuntime._sessionCount === 0` | 已修 PASS |
| D3 Run 已 COMPLETED、result 未发出就崩溃 | 命令必须进入终态（不得永久 CLAIMED） | **冻结/`b8fc426`：命令永久 CLAIMED**（claim 只扫非终态 Run，且 Host 从不 reconcile，MAJOR，QA3-05）；工作区以 `sweepDispatchCommands` + claim 前 sweep 修成 `DONE`（`derivedFrom:"run-terminal"`） | 冻结 FAIL → 已修 PASS |
| D4 新 holder 已 reclaim 后旧 holder 复活 | 旧 generation 的 events/result/renew 全部 409，Run/命令不被覆盖 | 一致 | PASS |
| D5 Host 重启后先 reconcile（ADR-010 决策 7 / §5.4） | 启动先 reconcile 持久化在途记录，再领取新命令 | 冻结：完全未调用 reconcile；工作区新增 `host.recover()`（`stateFile` 持久化 in-flight 记录，CLI 启动时先跑），配合 sweep | 冻结 FAIL（已修） |

### E. 迁移与数据

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| E1 M1 v1 库原地升级 v2 保留数据 | 任务/项目保留、schemaVersion≥2、列存在 | 一致（本项目 v1 数据保留；当前树因 0003 schemaVersion 3） | PASS |
| E2 迁移幂等 | 同库重复 open 幂等 | 一致（openStore 两次 schema 不变、无重复迁移行）。裸重跑 0002 会 `duplicate column name`（runner 自愈已在工作区补，见 QA3-06） | PASS（runner 层） |
| E3 reconcile 对已完成 Run | 过期 lease（非 null）且 generation 保留 | 一致 | PASS |

### F. 文档、门禁与隐私

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| F1 §6 七条裁决与代码一致 | 1 单写者、2 generation+租约、3 空批次纯 fence、4 释放=过期、5 attempts>1 不重启、6 单 live lease/先重试过期、7 SDK 零依赖 + DSH stub 全 false | 1/4/5/6/7 冻结即一致；2/3 冻结不一致（QA3-02/03，已修）；工作区另加裁决 8–14，与实现一致 | 冻结部分 FAIL → 已修 PASS |
| F2 `m2-smoke` 作为门禁的诚实性 | 必须断言命令终态 + 无吞错 | 冻结 3/3 假绿（QA3-01）；`b8fc426` 起 4/4，含 DONE/FAILED/reason/无残留/`stats.errors=0`/sweep 断言 | 冻结 FAIL → 已修 PASS |
| F3 密钥/本机用户名/绝对路径 | 0 命中 | M2 源码/文档/脚本 0 命中；内部 token 不落盘 | PASS |

---

## 4. 缺陷清单

> 编号沿用上报顺序；状态为审查结束时的状态（BLOCKER 已在 `b8fc426` 提交，其余在审查结束时的工作区修复；均未由 QA commit）。

### QA3-01（BLOCKER，已修 `b8fc426`）Host 的 `result` 请求缺 `ownerId`，命令生命周期完全不可达，门禁假绿

- 位置：`apps/runtime-host/src/client.mjs` 的 `result(...)` 只发 `{generation,status,result}`；`apps/backend/src/routes-internal.mjs` 的 `dispatch.result` 强制 `requireId(body.ownerId)`。
- 复现（冻结树）：`node scripts/m2-smoke.mjs --verbose` → 3/3 PASS，但 stderr 有 4 条 `[host] … 400 VALIDATION_ERROR invalid ownerId` / `illegal run transition`；随后 SQLite 里 happy 命令仍 `CLAIMED`（独立探针确认）。直接 HTTP：无 `ownerId` → 400；带 `ownerId` → 200。
- 影响：m2-contracts §2/§5.3/§6.5 全部不可达，命令永不 DONE/FAILED，recovery 每个 lease 周期反复 interrupt；门禁只断言 Run 所以全绿。
- 修复验证：`b8fc426` 后 m2-smoke 3/3 无 `[host]` 错误，D1/D2 命令 FAILED + reason，startFails Run FAILED；QA 用例 B6/F2 是长期回归守卫。
- 归属：Lead（scripts/m2-smoke.mjs）+ worker-runtime-spike（client/host）。

### QA3-02（MAJOR，已修）租约“过期”不 fence：旧 Host 在过期后、reclaim 前仍能写终态/关命令

- 位置：`packages/database/src/sqlite.mjs` 的 `updateRunStatus`/`completeDispatchCommand` 只比较 generation/owner，不检查 `claimed_until > now`（`appendRunEvent`/`renewRunLease` 都检查）。
- 复现（冻结与 `b8fc426` 均复现，隔离库）：claim(gen1, lease 1000 ms) → sleep 1300 ms（无人 reclaim）→ `updateRunStatus(RUNNING→COMPLETED, generation:1)` **成功**；`completeDispatchCommand(DONE, gen1)` **成功**。
- 依据：m2-contracts §6 裁决 2“给了 generation 就在同一事务校验租约”、ADR-010 决策 3“过期上报一律 409”、ADR-003“租约过期即失效”。
- 影响：lease TTL 窗口（默认 30 s）内慢 Host/网络分区可把 Run 收成 COMPLETED，recovery 的 INTERRUPTED 随后变成 illegal transition。
- 修复验证：工作区已加 `claimed_until <= now` → `STALE_GENERATION`（`reason:"lease-expired"`），QA 用例 C2/C3 由红转绿；契约补充裁决 8。
- 归属：worker-database。

### QA3-03（MINOR，已修）`events: []` 纯 fence 不校验 generation

- 位置：`apps/backend/src/routes-internal.mjs` 的 events 路由在无事件可写时跳过 store 调用，直接 200。
- 复现：claim → renew（gen2）→ `POST /runs/:id/events {generation:1, events:[]}` → **200**（期望 409）；真实 stale 写是 409。
- 依据：m2-contracts §6 裁决 3（空批次是合法纯 fence）与 §2（events 409）。
- 修复验证：工作区改为空批次也走 store fence，C4 由红转绿；契约补充裁决 10。
- 归属：worker-backend。

### QA3-04（MINOR，已修）409 `details` 形状与契约不一致

- 位置：`routes-internal.mjs` 的 `staleError` 输出 `{runId, expectedGeneration, receivedGeneration}`（result 路由为 `{commandId, …}`）；契约 §6.2 要求 `{runId, generation, currentGeneration, reason}`（store 内部错误本来就是后者）。
- 复现：renew 后用旧 generation 写事件 → 409，details 键为 `expectedGeneration/receivedGeneration`。
- 修复验证：工作区统一映射为契约形状，F1 由红转绿；契约补充裁决 11。
- 归属：worker-backend。

### QA3-05（MAJOR，已修）Host 恢复路径从未调用 `reconcile`；“Run 已终态、result 未发”窗口把命令永久卡在 CLAIMED

- 位置：`apps/runtime-host/src/host.mjs`/`cli.mjs`（冻结版无任何 `reconcile` 调用；client 有方法但无人用）。claim 扫描限定 `r.status IN (QUEUED,STARTING,RUNNING)`，因此 Run 终态后其 CLAIMED 命令既不会被 reclaim、也不会被关闭。
- 复现（冻结与 `b8fc426`，隔离库）：claim → 发 `session.started`+`session.ended(completed)`（Run COMPLETED）→ 进程崩溃（不发 result）→ sleep 过期 → recovery host tick → Run 保持 COMPLETED、**命令一直 CLAIMED（attempts=1，result=null）**，没有任何恢复路径。
- 依据：m2-contracts §5.4、ADR-010 决策 7（重启必须先 reconcile）、§5.3 命令生命周期。
- 修复验证：工作区新增 `sweepDispatchCommands`（Backend 每次 claim 前 sweep，并暴露 `POST /internal/v1/dispatch/sweep`）把“Run 终态 → 命令 DONE/FAILED（`derivedFrom:"run-terminal"`）”落库；Host 新增 `recover()`（`stateFile` 记录 in-flight，CLI 启动先 reconcile）。D3 由红转绿，m2-smoke 第 4 条 check 覆盖该窗口；契约补充裁决 9/13。
- 归属：worker-database（sweep）+ worker-runtime-spike（recover）+ Lead（门禁）。

### QA3-06（MINOR，已修）0002 裸重跑不幂等；迁移 runner 现按“duplicate column = 已应用”自愈

- 位置：`packages/database/migrations/0002_runs_dispatch.sql` 是裸 `ALTER TABLE ADD COLUMN`；迁移 runner 只靠 `schema_migrations` 记账，记账行丢失/手工重跑时报 `duplicate column name: role`（0001 是 `IF NOT EXISTS`，能自愈）。
- 复现：openStore 两次幂等（PASS）；手工对已迁移库再执行 0002 → SQLite 报 duplicate column。
- 修复验证：工作区 runner 容忍 duplicate column（记 WARN 后继续），契约补充裁决 12；对抗用例 E1 覆盖“v1→v2 + 重复 open”。
- 归属：worker-database。

### QA3-07（MINOR，已修）测试不可移植：`test/config.test.mjs` 用 `new URL(import.meta.url).pathname`

- 现象：仓库位于非 ASCII 路径（例如 `%TEMP%` 带中文用户名）时，`presets/generic.json`、`agent-flow.config.schema.json` 的路径被百分号编码，2 个测试 ENOENT 假失败；ASCII 主仓库 350/350。
- 修复验证：工作区已改为 `fileURLToPath(import.meta.url)`（97/143 行），非 ASCII 也可跑。
- 归属：Lead（根测试）。

### QA3-08（MINOR，已修）契约 §5 声称 m2-smoke“必须覆盖 6 项”，冻结门禁只有 3 条 check

- 现象：§5 列 1–6（含 startFails/neverEnds/reconcile），冻结 m2-smoke 只有 happy / 死 Host / fencing 三条；文档与门禁不一致。
- 修复验证：门禁扩为 4 条（新增孤儿命令窗口，并强化命令终态断言），契约 §7 增加“§5 覆盖说明（诚实版）”：明确 startFails/neverEnds 由 host 包测试覆盖、reconcile 由 recover/sweep 覆盖。
- 归属：Lead。

### OBSERVATION

1. **后端 internal 单测使用 fake-store**：对 `packages/database/src/sqlite.mjs` 的变异（去掉 `updateRunStatus` 的 generation/租约 fence、让 `run.updated` 双写）不会让 `apps/backend/test/internal.test.mjs` 变红（18/18 仍绿）；只有 database 包测试 + 本 QA 套件能抓到。建议 backend 加一条真实 SQLite 的集成用例，或明确 fake-store 的覆盖边界。
2. **Host 的 in-flight 状态文件**：`%LOCALAPPDATA%\AgentTeamKit\runtime\host-<ownerId>.json`，内容为 runId/commandId/ownerId/generation/at，不含 token；属新增持久化面，M2 只做恢复用，清理策略留 M3。
3. **m2-smoke 用第二个 SQLite 连接直接 seed 命令**（测试期双写者）——仅测试用，可接受；ADR-002 的单写者约束针对生产进程。
4. **`run.updated` 的进程内 dedupe**：去重表在 Backend 内存；Backend 重启后重放的旧批次会因 Run 终态而得到 400（而非 skipped）。M2 契约只承诺“同一进程重试”，M3 需要持久化 dedupe 或允许幂等终态重放。
5. **1421 服务**：QA 未连接/未修改；仅在 14215 临时库做联调。`m1-smoke`/`serve` 使用临时 `LOCALAPPDATA`（M1 QA2-03 修复已生效），不再覆盖共享 token 文件。

---

## 5. 变异测试（`git archive fed5ee8` + 隔离 `@atk` 链接，工作区未动）

方法：解包到 `E:\CodeProject\atk-qa-mut`，把每个包的 `node_modules/@atk/*` 重新指向解包树（避免解析到主仓库）；基线产品测试 35/35 绿后逐个注入变异、跑对应测试、恢复文件。

| 变异 | 目标测试 | 结果 |
|---|---|---|
| **M1 去掉 `updateRunStatus` 的 generation/租约 fence** | `packages/database/test/dispatch-lease.test.mjs` + `run-lifecycle.test.mjs` | **CAUGHT**：15 tests / 14 pass / 1 fail（`updateRunStatus honours optional generation fencing`）；QA 套件 C2 也红 |
| **M2 把 `claimDispatchCommand` 改成非事务** | `packages/database/test/claim-atomicity.test.mjs` | **CAUGHT**：2 tests / 1 pass / 1 fail（`two concurrent claimers: exactly one wins the same command`） |
| **M3 让 `updateRunStatus` 双写 `run.updated`** | `packages/database/test/run-lifecycle.test.mjs` | **CAUGHT**：6 tests / 4 pass / 2 fail（`updateRunStatus walks the legal transitions…`、`…generation fencing`）；QA 套件 C7 也红 |

结论：M2 的产品测试对鉴权、claim 原子性、Run 状态机/事件单写、租约 generation、SSE、迁移幂等**真的会失败**；3/3 变异被抓。QA 套件额外覆盖了“过期租约 fence”“Run 终态→命令终态”“空批次纯 fence”“details 形状”“门禁诚实性”等产品单测的空白面。

---

## 6. 契约裁决与代码一致性（§6 七条 + §7 补充）

| 裁决 | 代码/测试验证 | 结论 |
|---|---|---|
| 1 `run.created` 只由 createRun；`run.updated` 只由 updateRunStatus；appendRunEvent 只承载 run.log | C7：一次 started→ended 恰好 2 条 run.updated、1 条 run.log；M3 变异（双写）被抓 | 一致 |
| 2 updateRunStatus 带 generation 时同事务校验租约 | C1（stale gen 409 零写入）+ C2（过期租约 409，修复后） | 冻结不一致 → 已修 |
| 3 appendRunEvent 校验 generation/租约；`events: []` 是纯 fence | C4（修复后 409/200 正确） | 冻结不一致 → 已修 |
| 4 释放=过期不删行；reconcile 返回过期 lease 且保留 generation | C8（lease 非 null、generation 保留、已过期） | 一致 |
| 5 attempts>1 绝不重启；命令 FAILED + `reclaimed-after-lost-lease` | D1/D2（0 会话、命令 FAILED、reason、attempts=2） | 一致（`b8fc426` 起） |
| 6 单 Run 单一 live lease；claim 先重试过期命令 | B2/B4（live 不可抢；过期命令优先于新 PENDING） | 一致 |
| 7 SDK 零运行时依赖（只声明 @atk/contracts，src 不 import）；DSH stub 全 false + CAPABILITY_UNAVAILABLE | package.json 仅此依赖；src 只 import 本地 `./index.mjs`；host 测试/QA 复核 stub 行为 | 一致 |
| 8 租约过期即失效（updateRunStatus/complete 双校验） | C2/C3 | 已修一致 |
| 9 命令终态可从 Run 终态推导（sweep） | D3 + m2-smoke 第 4 条 + QA 独立 SQLite 复核 | 已修一致 |
| 10 空批次纯 fence 也必须校验 generation | C4 | 已修一致 |
| 11 409 details 统一形状 | F1 | 已修一致 |
| 12 迁移 runner 容忍 duplicate column | E1 + 手工重跑 | 已修一致 |
| 13 Host 重启先 reconcile 持久化在途记录 | `host.recover()` + CLI 启动先跑 + host 包测试（QA 未独立做进程崩溃重启 E2E，属代码/包测试验证） | 已修一致 |
| 14 门禁断言最终业务事实（命令终态/无残留/stats.errors=0） | F2 自审 + 当前 4/4 | 已修一致 |

---

## 7. 结论：M2 能否标记完成

**可以标记完成（MockRuntime 路径）**，但必须把当前工作区的修复提交后再写“M2 完成”：

- 已达成（独立验证）：内部凭据双向隔离（响应/头/SSE/落盘 0 泄漏，bad Host 403，stdout 只 1 次）；claim 原子性与租约边界（两进程恰 1 winner、±1 ms、attempts/generation 单调）；Run 状态机与 `run.updated` 单写者（2 条，无重复）；8 KiB 截断、畸形事件零写入、批次去重；SSE 真生产者；崩溃窗口 D1/D2 安全中断、D3 孤儿命令 sweep、旧 holder fencing；M1 v1→v2 原地升级与重复 open 幂等。
- 全部缺陷已关闭：QA3-01（BLOCKER，`b8fc426`）、QA3-02（MAJOR）、QA3-05（MAJOR）、QA3-03/04/06/07/08（MINOR）均已修复并经本套件/门禁验证；审查结束时无未关闭的 BLOCKER/MAJOR/MINOR。
- 仍需做的事（非 QA 缺陷）：把工作区的 M2 修复与 M3 WIP **分开提交**，提交后复跑 `test.mjs`/`test-workspace.mjs`/`m1-smoke`/`m2-smoke`；更新 `docs/roadmap/m2-status.md`（当前仍写“独立 QA 待补”、门禁 3/3）为本报告数字；`test/m2-qa-adversarial.test.mjs` 与 `docs/architecture/qa-review-m2.md` 由 Lead 决定提交时机（本报告未 commit）。
- 注意事项：当前工作区的 25 条 QA 测试已全部是普通 test（无 todo），未来回归会直接红，不会静默通过。

---

## 8. “QA PASS ≠ 生产可用”边界

即便 M2 标记完成，本结论**不构成生产可用性背书**：

1. **真实 DSH/Magpie 仍不可用**：只有能力全 false 的 stub（`CAPABILITY_UNAVAILABLE`），RT-P07/P08（真实路由、多 Agent 并行）未验证；M0 的“不可用”结论不变。
2. **没有 Scheduler**：命令靠手工/脚本入队；DAG、优先级、Agent 匹配、预算、worktree 自动绑定都是 M3。
3. **JSON 仍是旧 CLI 的事实源**：SQLite 是 Web/执行侧事实源，ADR-006 的停机切换未做；双事实源的边界仍需在 M3 前收敛。
4. **Host 单会话串行**：一次只驱动一个会话；并行执行与多 Host 协作未做。
5. **无浏览器 E2E**：SSE/UI 的实时性只在 HTTP + 单测层验证，没有 Playwright/真实浏览器。
6. **安全边界是“本机单用户”**：无 TLS、无多用户/角色认证；内部 token 通过进程环境交接，同用户进程可读。
7. **恢复语义依赖新增的持久化 state 文件与 sweep**：M2 只覆盖“进程崩溃后保守中断/从 Run 终态推导命令终态”，不是通用调度级恢复（M3）。

---

## 附录 A：对抗套件清单（`test/m2-qa-adversarial.test.mjs`，25 条，全绿）

| 组 | 用例（摘要） | 结果 |
|---|---|---|
| A（4） | 内部凭据四向隔离/坏 Host/令牌不泄漏（响应·头·文件·stdout·源码）/SSE 无 token | 4/4 |
| B（6） | 两进程 claim、live lease、±1 ms 边界、同 Run 双命令、idempotencyKey、完整 Host 会话关闭命令（DONE、0 错误） | 6/6 |
| C（8） | stale gen 零写入、过期租约 fence（update/result）、空批次纯 fence、8 KiB 截断、畸形事件零写、去重/单 write r、reconcile 过期 lease | 8/8 |
| D（4） | D1 崩溃前、D2 started 后、D3 终态孤儿命令 sweep、D4 旧 holder fencing | 4/4 |
| E（1） | v1→v2 原地升级、数据保留、重复 open 幂等、0002 列存在 | 1/1 |
| F（2） | 409 details 契约形状、m2-smoke 门禁自审（N/N、无 FAIL、命令终态、无吞错） | 2/2 |

Node < 22.5（无 `node:sqlite`）时整个文件打印 SKIPPED 且不注册测试，legacy 20/22 CI 的 350 基线不受影响。

## 附录 B：复跑命令

```bash
# 主仓库（当前工作区，含修复）
node scripts/test.mjs                  # 375/375
node scripts/test-workspace.mjs        # 433/433
node scripts/check-boundaries.mjs      # PASS 8 packages / 6 edges / 0 cycles
node scripts/m1-smoke.mjs              # 16/16
node scripts/m2-smoke.mjs              # 4/4
node --test test/m2-qa-adversarial.test.mjs   # 25/25

# 冻结版本复核（不污染工作区）
git archive fed5ee8 | tar -x -C <temp>  # 再把各包 node_modules/@atk/* 指向解包树
node scripts/test.mjs                  # 350/350（ASCII 路径）
node scripts/test-workspace.mjs        # 321/321（33 文件）
node scripts/m1-smoke.mjs              # 16/16
node scripts/m2-smoke.mjs --verbose    # 3/3 但 stderr 有 [host] 400（QA3-01）
```
