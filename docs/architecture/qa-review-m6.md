# M6 独立 QA 复核报告（QA-007）

- 文档类型：独立复核报告（Reviewer / QA Function，身份隔离）
- 审查对象：**M6 冻结 `0abdee1`**（`bf8e443` 事件过滤/v5/replace/readiness、`4a9c80b` backend events/export-import/health、`e509ed9` fail-closed 修复 + m6-smoke + m6-status、`0abdee1` switch 测试适配）。HEAD `3f4183d` 的 Phase C（旧 CLI 只读视图）**不在 M6 范围内**，仅作“切换期分叉风险”旁证。
- 审查者：`qa-reviewer`（REVIEWER/QA），未参与 M6 实现。
- 环境：Windows 11，Node v24.16.0。
- 冻结树口径：审查期间工作区干净（HEAD 3f4183d）；为避免 Phase C 的代码影响，所有 M6 数字都来自 `git archive 0abdee1` 隔离树 `E:\CodeProject\atk-qa-m6-frozen`（包内 `@atk/*` 均指向解包树）。
- 未动 1421；全部临时库/随机端口；未改产品代码/他人测试，未 commit。
- 交付：`test/m6-qa-adversarial.test.mjs`（19 条）、本报告。

> **结论：M6 在冻结 SHA 上不能标记完成，v1.0 不宜宣发。** 门禁 7/7 全绿，但独立复核发现 **3 个 MAJOR + 4 个 MINOR**：replace 的 fail-closed 仍漏掉 requirements/大小写/嵌套/agents（清库后 PASS）；有活跃 RUNNING Run 时 CLI 切换不拒绝（switchReadiness 只是健康字段）；真实 HTTP 事件分页会丢/跳事件（Web 时间线的唯一数据源）。另有导出/导入状态漂移、store 参数校验不一致、契约 API 缺失、m6-smoke 覆盖缺口。**v1.0 可用 ≠ 生产可用**，边界见 §7。

---

## 1. 执行清单（冻结树 `0abdee1`）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `node scripts/test.mjs` | 0 | **447 tests / 447 pass / 0 fail / 0 skipped** |
| 2 | `node scripts/test-workspace.mjs` | 0 | 59 文件 / **601 tests / 601 pass** |
| 3 | `node scripts/check-boundaries.mjs` | 0 | **PASS：9 package(s) / 6 edge(s) / 0 cycle(s)** |
| 4 | `node scripts/m1-smoke.mjs` | 0 | **16/16** |
| 5 | `node scripts/m2-smoke.mjs` | 0 | **4/4** |
| 6 | `node scripts/m3-smoke.mjs` | 0 | **6/6** |
| 7 | `node scripts/m4-smoke.mjs` | 0 | **9/9** |
| 8 | `node scripts/m5-smoke.mjs` | 0 | **4/4** |
| 9 | `node scripts/m6-smoke.mjs` | 0 | **7/7, 0 skipped**（门禁自审见 §2） |
| 10 | `node --test test/m6-qa-adversarial.test.mjs` | 1 | **19 tests / 14 pass / 5 fail**：A2 requirements、A3 大小写/嵌套、B1 CLAIMED→RUNNING、B3 活跃 Run 切换、C2 HTTP 分页 |
| 11 | 变异测试（隔离树 `atk-qa-m6-mut`，见 §5） | — | **3/3 被 QA 测试抓到** |
| 12 | 真实链路探针（临时库） | — | replace 变体/回滚/切换/事件/升级/backup 全部实测 |

---

## 2. `m6-smoke` 门禁自审（把门禁当被测物）

m6-smoke 7 条 check，FAIL→exit1、缺 backend→exit2；我逐条复核：

| # | 门禁点 | 实际做法 | 自审结论 |
|---|---|---|---|
| 1 | events filter/page | 用 store 直接查 **105** 条事件；`listEvents` 数组 + `.items`；`listEventsPage` 分页 40/40/25；limit 0 拒绝 | **契约 §3.1 要求“真实库 >1000 事件”**，实际只 105；不测 HTTP（真实客户端路径）、不测组合过滤/正好 limit/空结果；`limit` 上限 1000 由 store cap，未验证 |
| 2 | readiness | 直接调 `verifySwitchReadiness`：idle→active-run→idle | 只验证“函数报告”，**不验证 CLI 是否拒绝切换**（见 §4 QA7-02） |
| 3 | export→import | export→空库 merge import→counts 比较 projects/tasks/agents | 不比较 events/runs/requirements/deps/status/title；`>=` 风险（本处用 ===）；不验证 export 文档结构 |
| 4 | **failing replace** | 构造 `batch.tasks:[{DUP},{DUP}]` → 期望拒绝 | **payload 在“写前校验”阶段就被拒（IMPORT_WRITE_FAILED），根本没到 clear/写入事务**，因此证明不了回滚路径；只比较 tasks/events，projects/agents/migrations 未进 fingerprint。m6-status 自己承认“旧测试只覆盖写入前校验失败”，但门禁本身仍未改。 |
| 5 | successful replace | replace 后 schemaVersion===5、migrationWarnings===[] | 不验证导入内容（任务/事件/顺序/依赖） |
| 6 | backup/tamper/restore | 真 backup；篡改 manifest sha；restore 拒绝且 target 不存在；恢复后 counts 精确（projects/tasks/events/agents） | **真实**，是本轮最扎实的一条 |
| 7 | v1→v5 | 只断言 `schemaVersion===5` 与 project 行保留 | **不验证行为等价**（tasks/events 是否保留、旧事件按 aggregateId 是否可查、v4→v5）——见 §3 D 组：我独立验证了行为，门禁没有 |

**结论**：check6 真实；check1/2/3/4/5/7 都是“部分断言”。尤其 check4 的坏 payload 不进写入阶段、check7 只对版本号，属于典型“看起来通过其实没验证”。**7/7 绿与 3 个 MAJOR 同时存在，正是门禁覆盖不足**。

---

## 3. A–F 结论表（期望 · 实际 · 判定）

判定：**PASS** = 冻结满足；**FAIL** = 违反契约（缺陷）；**OBSERVATION** = 记录项。

### A. replace fail-closed（5 条：3 PASS、2 FAIL）

| 项 | 期望 | 实际（冻结 `0abdee1`） | 判定 |
|---|---|---|---|
| A1 `batch.tasks` / 顶层 `tasks` / 非数组 | 拒绝且零写入 | SKIPPED `IMPORT_WRITE_FAILED` / `INVALID_RECORD`，全量 fingerprint（13 表 + migrations）不变 | PASS |
| A2 **`requirements` 变体** | 视为未知集合，拒绝且零写入 | **PASS**，清除 tasks/agents/events，requirements 写入 1 条（数据丢失） | **FAIL / MAJOR** |
| A3 **`batch.requirements` / `Tasks`（大写）/ `batch.Tasks` / 顶层 `agents` / 嵌套未知集合** | 拒绝且零写入 | **全部 PASS 并清库**（tasks 1→0、agents 1→0、events 1→0） | **FAIL / MAJOR** |
| A4 空数组（`tasks:[]`、`batch.tasks:[]`） | 无害，可继续 | PASS，清库后导入空集（预期） | PASS |
| A5 写入中途失败（独立注入第 2 个 `createTask` 抛错） | 单事务回滚、账本不变、reopen 不重跑 | SKIPPED `IMPORT_WRITE_FAILED`；**13 表 + schema_migrations 全量 deepEqual 前后一致**；reopen schema5、无 migrationWarnings | PASS |

### B. 切换安全 / 导出导入（3 条：1 PASS、2 FAIL）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| B1 export→replace 内容精确一致 | 任务 id/状态/依赖/项目/agent 一致 | 任务 id/依赖/项目/agent 一致，但 **CLAIMED 导出为 `in-progress`，再导入变 RUNNING**（legacy 词汇有损） | **FAIL / MINOR（QA7-04）** |
| B2 merge 幂等 | 两次导入不重复 | 全量 fingerprint 第二次不变 | PASS |
| B3 有活跃 RUNNING Run/命令时 CLI 切换 | 拒绝 | `verifySwitchReadiness()` 已返回 `{ok:false,blockers:["active-run"]}`，但 `import --mode replace --force` **exit 0**；runs 1→0、dispatch_commands 1→0、events 3→0 | **FAIL / MAJOR** |

### C. 事件过滤/分页（3 条：2 PASS、1 FAIL）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| C1 组合过滤、空结果、正好 limit、memory/sqlite 一致 | 一致 | 全部一致（seq 升序、空结果 `hasMore:false` 无 next、memory==sqlite） | PASS |
| C2 **HTTP 分页完整性** | `hasMore/nextAfterSeq` 必须与返回 items 一致、无重无漏 | 4 条事件 `limit=2`：items=[1,2] 但 nextAfterSeq=**3**（续页从 4 开始 → **seq 3 丢失**）；3 条事件 `limit=2`：items=[1,2]、hasMore=false（**seq 3 永久丢失**）；默认 100/105 同样跳 seq101 | **FAIL / MAJOR** |
| C3 1000 上限/非法参数 | store cap 1000；HTTP >1000/0/非法 400 | store 5000→1000 且 hasMore；HTTP 全部 400 `VALIDATION_ERROR`（具体错误字段）；memory 同一套校验 | PASS |

（补充：store 层 `aggregateId` 不做 ID 校验，`"bad id!"` 可查并返回空；HTTP 才 400——QA7-05 MINOR。）

### D. 升级（2 条，全 PASS）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| D1 v1→v5、v4→v5 数据保留 + 行为等价 | schema5、项目/任务/事件保留、旧事件按 aggregateId 可查、索引存在、账本 1..5 | 全部一致（v1/v4 两种真实旧库；`listEvents({aggregateId})` 返回旧事件） | PASS |
| D2 v5 记账行丢失自愈 | reopen 不重跑、schema5、索引在 | 一致 | PASS |

### E. backup/restore 交叉（4 条，全 PASS）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| E1 tamper 快照 | 拒绝且不改/不建 target | exit1，target 保持 `KEEP`（--force 也不动） | PASS |
| E2 restore 后精确 counts + health | counts 全等、health 200 且 counts 同 | 一致（真实 backend 起在恢复库上） | PASS |
| E3 manifest schemaVersion 过高 | 拒绝 | exit1，错误含 schemaVersion/newer | PASS |
| E4 **live WAL 一致性** | WAL 未 checkpoint 的写入必须进快照 | 保持 store 打开时 backup→restore，counts 全等（直接复制 .db 会红，见变异 M3） | PASS |

### F. 文档 / CLI / 隐私（2 条，全 PASS）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| F1 契约 surface/CLI/退出码 | export/import/backup/restore、mode、非 PASS exit1 | 一致；非 PASS import 实测 exit1 且 report SKIPPED | PASS |
| F2 隐私 | 新源码/文档无 token、无本机路径 | 0 命中 | PASS |

---

## 4. 缺陷清单

### QA7-01（MAJOR）replace 的 fail-closed 仍漏掉 requirements/大小写/嵌套/agents，清库后 PASS

- 位置：`packages/database/src/import-export.mjs` 477-498：只检查 `batch.tasks`、顶层 `state.tasks`；其它“未认识的非空集合”不校验。`replace` 走 `internal.transaction(clearBusinessTables + writeAll)`，未知集合被忽略即 PASS。
- 复现（真实 SQLite，初始库 tasks/agents/events 各 1 + 迁移账本 1..5）：`importStateJson(store,{stateJson:{requirements:[...]},mode:"replace",force:true})` → `status:"PASS"`，tasks/agents/events 归零；`batch.requirements`、`Tasks`（大写）、`batch.Tasks`、顶层 `agents`、`batch.nested.tasks` 同样 PASS 清库。测试 A2/A3。
- 规范依据：m6-contracts §0.1（replace 任一步失败整体回滚、原数据仍在）、§0.2；m6-status §3 的“fail-closed 不认识的集合”声明。这个缺陷与它自己描述并“修复”的 `batch.tasks` 缺陷同源，只是覆盖面不足。
- 归属：worker-database（importer）/ Lead。
- 建议：对 legacy state 允许的键做白名单，任何未知的、非空的“集合形状”（数组/对象数组）在 clear 前 fail-closed，至少覆盖 requirements/agents/runs/events/tasks 的大小写与嵌套变体，并在错误里给出完整 key 路径。

### QA7-02（MAJOR）有活跃 RUNNING Run/命令时，CLI 切换不拒绝（switchReadiness 未被执行）

- 位置：`apps/backend/cli.mjs` `importCommand`（0abdee1 只做 non-empty/force 检查）；`verifySwitchReadiness` 仅在 health 字段与独立函数中暴露。
- 复现：claimTask → Run RUNNING（runs=1、command=1、events=3）；`verifySwitchReadiness()` 返回 `ok:false, blockers:["active-run"]`；`import --mode replace --force` → exit 0，runs/commands/events 全部清空。测试 B3。
- 规范依据：m6-contracts §0.3“存在活跃 Run/租约时 switchReadiness.ok=false，禁止切换”；ADR-006 阶段 3；ops 文档也写“切换只允许停机时进行”。
- 归属：worker-backend / Lead。
- 建议：`import --mode replace` 在写入前调用 `verifySwitchReadiness`；`ok=false` 时 exit 1 并输出 blockers（如要强制，必须显式危险开关 + 文档）；m6-smoke 增加“active-run → CLI 拒绝”的 check。

### QA7-03（MAJOR）`GET /api/v1/events` 分页丢/跳事件

- 位置：`apps/backend/src/server.mjs` events.list 832-866：`fetchLimit = limit+1` 调 `store.listEvents`，store 返回基于 fetchLimit 的 `hasMore/nextAfterSeq`；route 再 `slice(0,limit)`，但直接沿用 store 的 `hasMore/nextAfterSeq`。
- 复现：4 条事件 `?limit=2` → items [1,2]、`nextAfterSeq:3`（客户端 afterSeq=3 从 4 开始，3 丢失）；3 条事件 `?limit=2` → items [1,2]、`hasMore:false`（3 永久丢失）；默认 100/105 同理跳 seq101。测试 C2。
- 规范依据：m6-contracts §2（events 分页）、§3.1“分页 afterSeq 续页无重无漏”；Web `#/runs` 时间线唯一的 HTTP 事件源。
- 归属：worker-backend / worker-web。
- 建议：route 不要二次 slice；要么直接使用 store 返回的 `{items,hasMore,nextAfterSeq}`（一次分页完成），要么用 `limit+1` 的原始行自行判定 `hasMore = raw.length > limit`、`nextAfterSeq = items.at(-1).seq`；m6-smoke 加真实 HTTP 边界用例（3/4/100/1000）。

### QA7-04（MINOR）export→replace 的状态有损：CLAIMED 变成 RUNNING

- 位置：`import-export.mjs` `STATUS_TO_STAGE`（CLAIMED→`in-progress`）与 `PACKAGE_STAGE_TO_STATUS`（`in-progress`→RUNNING）。
- 复现：任务 CLAIMED → export → replace import → 任务 RUNNING（测试 B1）。
- 依据：m6-status ATK-604“export→import→export 语义等价”；m6-contracts §0.4 可读 JSON 用于跨版本/审计。归属：worker-database。
- 建议：legacy stage 增加可逆映射（如 `claimed` 复用/新增 stage），或在文档明确“CLAIMED 与 RUNNING 在 legacy JSON 中不可区分”作为限制。

### QA7-05（MINOR）store 层事件过滤参数校验与 HTTP 不一致

- `listEventsPage({aggregateId:"bad id!"})` 不报 VALIDATION_ERROR，返回空；HTTP 层才用 ID_RE 拒绝。m6-contracts §1 要求非法参数 `VALIDATION_ERROR`。归属：worker-database。

### QA7-06（MINOR）`store.verifySwitchReadiness()` 在 sqlite/memory store 上不存在（契约 §1 列了该方法）

- 只有 `@atk/database` 导出的函数；backend `serve` 用 `Object.defineProperty` 临时挂到 store（cli.mjs 522-528），直接调用 store 的调用方（脚本/未来 CLI）会 `TypeError`。m6-smoke 直接 import 函数，因此门禁发现不了。归属：worker-database。
- 建议：把 `verifySwitchReadiness` 真正挂到 store 接口（sqlite/memory），backend 去掉 shim。

### QA7-07（MINOR）m6-smoke 覆盖缺口（7/7 与 3 MAJOR 并存）

- check1 只 105 事件（契约要求 >1000）、不测 HTTP；check2 只测函数不测 CLI；check3 只比 3 个 counts；**check4 的坏 payload 在写前校验就被拒，不覆盖 clear 后回滚**；check5 只查版本/账本；check7 只查 schemaVersion/project，不查任务/事件行为与 v4→v5。
- 归属：Lead / worker-runtime-spike。建议逐条对齐 m6-contracts §3 的语义，尤其 check4 用“独立注入写入中途异常”的指纹测试、check7 增加“旧事件按 aggregateId 查询”。

### OBSERVATION

| # | 内容 |
|---|---|
| QA7-08 | Phase C（HEAD `3f4183d`）的“backend 运行时拒绝 import replace”保护真实存在且有效：我在 HEAD 上用随机端口验证 `--port` 与 `ATK_PORT` 都被拒绝（exit 1，报 “database switch must run while the backend is stopped”）。但它不在 M6 冻结 `0abdee1` 内，且检测把“health 探测失败”视为“未运行”，属于 best-effort 而非锁。 |
| QA7-09 | export/import 的 JSON 只含 legacy state/runtime，不包含 runs/events/leases；replace 会重置执行历史（import manifest `runs:0` 是真实声明）。m6-status 的“已知限制”未列出这一点。 |
| QA7-10 | requirements 只从 `batch.id` 派生（export 不输出 requirements 数组），所以 A2 的 requirements 数据来自人工编辑/未来版本；但 fail-closed 的承诺应覆盖它。 |
| QA7-11 | `listEvents` 数组带不可枚举 `items/hasMore/nextAfterSeq` 的向后兼容实现正确（`Array.isArray` 为 true），本轮未发现回归。 |

---

## 5. 变异测试（隔离树 `atk-qa-m6-mut`，0abdee1）

基线：冻结树 19 条（14 绿 / 5 已知红）；逐个注入、跑 target、恢复。

| 变异 | 目标测试 | 结果 |
|---|---|---|
| **M1 删掉 replace 的 fail-closed 校验块** | A1（batch.tasks/top-level tasks） | **CAUGHT**：1/1 红（原本 SKIPPED，变异后 PASS 清库） |
| **M2 import 非 PASS 仍 exit 0** | F1（非 PASS 必须 exit1） | **CAUGHT**：1/1 红 |
| **M3 backup 退化为直接复制 .db** | E4（live WAL 一致性） | **CAUGHT**：1/1 红（WAL 未 checkpoint 的事务丢失，counts 不等） |

补充：M3 在“静止库”的 E1/E2 不会红（main 已 checkpoint），必须用 E4 这种 live-WAL 用例才能证明；这也说明 m6-smoke 的 backup check 是静止库备份，覆盖不到 WAL 一致性。

---

## 6. 文档与契约一致性

| 契约项 | 验证 | 结论 |
|---|---|---|
| §0.1 replace 单事务、失败整体回滚 | 独立注入中段失败：全量 fingerprint 不变、reopen 正常 | 一致（A5） |
| §0.2 不清 schema_migrations | 失败/成功 replace 后账本 1..5；reopen 不重跑 | 一致 |
| §0.3 活跃 Run/租约禁止切换 | store readiness 正确，**CLI 不执行** | **不一致（QA7-02）** |
| §0.4 两条恢复路径语义不同 | backup 二进制精确/export 可读 JSON；文档基本一致 | 一致（但 runs/events 不在 JSON，见 QA7-09） |
| §0.5 listEvents 数组兼容 | `Array.isArray`、items/hasMore/nextAfterSeq 均验证 | 一致 |
| §1 store API（filter/limit/import/readiness） | filter/limit/import 一致；**store.verifySwitchReadiness 缺失**；aggregateId 校验弱 | 部分不一致（QA7-05/06） |
| §2 Backend events/export/import/health | export/import/健康字段一致；events 分页实现错误 | **分页不一致（QA7-03）** |
| §3 m6-smoke 6 项 | 实际 7 条但覆盖语义不足 | 不一致（QA7-07） |
| v1→v5 就地升级 | v1/v4 真实旧库数据+事件+行为 | 一致（门禁只查版本，我补了行为） |

另外：m6-status 写“独立 QA（QA-007）待做”是诚实的；但它的“已知限制”没有列出 fail-closed 覆盖面、HTTP 分页、活跃 Run 切换、JSON 不含 runs/events，因此 v1.0 宣发前必须补文档或修代码。

---

## 7. 结论：M6 能否标记完成 / v1.0 边界

- **冻结 `0abdee1`：不能标记完成。** 门禁 7/7、447/447、601/601、boundaries 9/6/0、m1..m5 全绿，但独立复核有 **3 个 MAJOR**：
  1. fail-closed 漏 requirements/大小写/嵌套/agents → 清库 + PASS（数据丢失、假绿）；
  2. 活跃 RUNNING Run 时 CLI 切换不拒绝（contract §0.3 被绕过，Run/命令/事件丢失）；
  3. HTTP 事件分页丢/跳事件（Web 时间线核心路径）。
  另有 4 个 MINOR（状态映射有损、store 校验/API 缺失、门禁覆盖不足）。**3 个 MAJOR 都足以阻止 v1.0 宣发**；建议按 BLOCKER 级别排期修复（尤其 1、3）。
- 收口清单：
  1. QA7-01：未知集合白名单 fail-closed（requirements/agents/runs/events/tasks 的大小写与嵌套），错误带 key 路径；补测试。
  2. QA7-02：import replace 前调用 `verifySwitchReadiness`，blockers 非空 exit 1。
  3. QA7-03：修 events route 的 hasMore/nextAfterSeq（不要二次 slice 混用 fetchLimit 元数据），加真实 HTTP 分页测试。
  4. QA7-04/05/06：状态可逆映射/文档；store aggregateId 校验；store 挂 `verifySwitchReadiness`。
  5. QA7-07：m6-smoke 加 HTTP 分页、active-run CLI、>1000 事件、mid-write 回滚指纹、v1/v4 行为断言。
  6. 重新冻结后复跑全部门禁 + 本 QA 套件。
- **v1.0 可用 ≠ 生产可用**：
  1. 真实 DSH 不可用；所有多 Agent 演示是 MockRuntime。
  2. 无安装包/签名/自动更新；Windows 单机。
  3. 无浏览器 E2E（Web 时间线只到单测；而本轮 HTTP 分页 MAJOR 正说明“单测绿≠接口正确”）。
  4. 旧 CLI 仍以 JSON 为事实源；Phase C 的只读切换在 HEAD 是独立提交，不在 M6 范围，且检测是 best-effort。
  5. 无多用户/远程；日志无轮转；JSON export/import 不含 runs/events/leases，切换会重置执行历史。
  6. Node < 22.5 时 QA 套件整体 SKIP；本轮未做跨平台验证。

---

## 附录 A：对抗套件（19 条）与冻结结果

| 组 | 用例 | 冻结 |
|---|---|---|
| A（5） | batch.tasks/top tasks/非数组拒绝；空数组；mid-write 回滚；**requirements**；**大小写/嵌套/agents** | 3 绿 / **2 红**（A2/A3） |
| B（3） | export→replace 精确内容；merge 幂等；**active RUNNING Run 拒绝切换** | 2 绿 / **1 红**（B3） |
| C（3） | store 组合过滤/边界/memory 一致；**HTTP 分页完整性**；1000 cap/非法 400 | 2 绿 / **1 红**（C2） |
| D（2） | v1/v4→v5 数据+行为；v5 账本自愈 | 2 绿 |
| E（4） | tamper；restore 精确 counts+health；高版本拒绝；live WAL 一致性 | 4 绿 |
| F（2） | CLI surface/非 PASS exit1；隐私 | 2 绿 |

## 附录 B：复跑命令（冻结树 0abdee1）

```bash
# 隔离解包 0abdee1 后（包内 @atk/* 指向解包树；不要混入 HEAD Phase C）
node scripts/test.mjs             # 447/447
node scripts/test-workspace.mjs   # 601/601（59 文件）
node scripts/check-boundaries.mjs # PASS 9/6/0
node scripts/m1-smoke.mjs         # 16/16
node scripts/m2-smoke.mjs         # 4/4
node scripts/m3-smoke.mjs         # 6/6
node scripts/m4-smoke.mjs         # 9/9
node scripts/m5-smoke.mjs         # 4/4
node scripts/m6-smoke.mjs         # 7/7
node --test test/m6-qa-adversarial.test.mjs   # 19 tests：14 pass / 5 fail（本轮 5 个缺陷/缺口）

# 变异（atk-qa-m6-mut）
# M1 删 fail-closed          -> A1 红
# M2 import 非 PASS exit 0   -> F1 红
# M3 backup 直接复制 .db     -> E4 红（live WAL）
```

---

## 8. 复验（HEAD `97605cd`，QA-007 修复后）

- 复验日期：2026-11-02；对象 `97605cd`（修复提交 `7a630b4` / `003066d` / `97605cd`），工作区干净。
- 复验未改产品代码；`test/m6-qa-adversarial.test.mjs` 追加了 4 条复验用例（A6/B4/B5/C4），报告追加本节。

### 8.1 数字（HEAD 97605cd）

| 检查 | 结果 |
|---|---|
| `node scripts/test.mjs` | 追加复验用例前 **471/471**（0 fail / 0 skipped）；追加 A6/B4/B5/C4 后 **475 tests / 474 pass / 1 fail**（A6 残余形状缺口） |
| `node scripts/test-workspace.mjs` | **604/604**（59 文件） |
| `node scripts/check-boundaries.mjs` | **PASS：9 package / 6 edge / 0 cycle** |
| `m3 / m4 / m5 / m6-smoke` | **6/6、9/9、4/4、9/9**（m6-smoke 新增 2 条真实 HTTP 分页） |
| 本 QA 套件（23 条：原 19 + A6/B4/B5/C4） | **22 pass / 1 fail**（A6 残余形状缺口） |

### 8.2 三个原 MAJOR 的复验

| 原缺陷 | 复验结论 | 证据 |
|---|---|---|
| QA7-01 未知集合 fail-closed | **数组路径已修；对象路径仍有残余 MAJOR（QA7-01r，见 §8.3）** | 未知**数组**（含 10 层深、数字键、`__proto__`、`constructor`、`batch.nested`）→ SKIPPED `IMPORT_WRITE_FAILED`，零写入；但未知**非空对象（无数组）**仍 PASS 并清库 |
| QA7-02 活跃 Run 切换 | **已修** | 有 RUNNING Run/命令时 import replace → exit1，**数据库 main/wal/journal sha256 与 counts 完全不变**；`--force-switch` → exit0、stderr 有 `warning: --force-switch discards in-flight Runs/leases`、stdout `"forced": true` + `"switchForced": true`；backend 在线 + `--force-switch` → exit1 且是 online 拒绝（“backend is stopped”），**在线检查先于 readiness/force** |
| QA7-03 HTTP 事件分页 | **已修** | 1001 条/limit=1000：items=1000、hasMore=true、nextAfterSeq=1000，第二页 seq1001 且 hasMore=false 无 next；正好 1000 条：hasMore=false 无 next；3 条/limit=2 第二页 seq3；4 条/limit=2 两页 [1,2]/[3,4]；`afterSeq` 指向最后一条/空结果：`{items:[],hasMore:false}` 且**无 nextAfterSeq 键** |
| QA7-04 CLAIMED→RUNNING | **已修** | B1 用例转绿，export→replace 保持 CLAIMED |
| QA7-05 store `aggregateId` 校验 | **未修（MINOR）** | `store.listEventsPage({aggregateId:"bad id!"})` 仍不抛错（`code:null`）；仅 HTTP 层 400 |
| QA7-06 `store.verifySwitchReadiness` | **未修（MINOR）** | sqlite store 上 `typeof store.verifySwitchReadiness === "undefined"`；仍只有 `@atk/database` 导出函数 + backend serve 的临时 shim |

### 8.3 残余 MAJOR（QA7-01r）：未知**非空对象**仍被静默丢弃

- 提交 `97605cd` 的说明与 Lead 口径是“Unknown non-empty arrays **and objects** are now both refused at any depth”；实际 `scanUnsupportedCollections` 对未知键只做 `firstNestedArray()`：对象里没有**非空数组**就直接放行（`import-export.mjs` 498-547）。
- 复现（真实 SQLite，初始 tasks/agents/events 各 1；`mode:"replace", force:true`）以下全部 **`status:"PASS"`、零错误、旧库被清空（tasks/agents/events=0）**：
  - `{ metadata: { a: 1, b: "x" } }`
  - `{ metadata: {10 层嵌套，叶子是字符串} }`
  - `{ "0": { a: 1 } }`（数字键对象）
  - `JSON.parse('{"__proto__":{"a":1}}')`、`JSON.parse('{"constructor":{"a":1}}')`
  - `batch.metadata` / `project.metadata` / `counts.metadata` 对象
  - 空对象 `{metadata:{}}` 放行是合理的（无数据）；以上是**非空**对象。
- 已拒绝的对照：同样结构只要叶子是**非空数组**（如 `metadata.level…arr:[1]`、`"0":[1]`、`__proto__.arr:[1]`、`constructor.arr:[1]`）→ SKIPPED + 零写入。
- 影响：与 QA7-01 同类——调用方把新集合/扩展数据以对象形式放进 state，replace 清空旧库后 PASS，数据被丢弃；也与提交说明/Lead 的“unknown objects refused”直接矛盾。
- 定级：**MAJOR（残余）**。归属：worker-database / Lead。
- 建议：对未知键的对象值也 fail-closed（至少“非空对象”拒绝，空对象可放行）；或把 `firstNestedArray` 替换为“未知子树中任何非空数组或非空对象 → 拒绝”，并在错误里保留 dotted path。`batch.slices` 记录内部的未知字段目前会被 `legacy.item` 原样保存（已验证 `meta:{a:1,arr:[1,2]}` 保留），若白名单设计要允许这种“记录内扩展”，需在文档中显式区分“记录内部扩展”与“集合/顶层扩展”。

### 8.4 `m6-smoke` 9/9 自审与 QA7-07 剩余项

新增的两条 HTTP 分页 check（3/4/105 条 + 非法参数 400）是真实且有效的，复验通过。仍然缺：

| # | 缺口 | 现状 |
|---|---|---|
| 1 | **>1000 事件** | check1 仍只 seed 105；契约 §3.1 要求 >1000；limit=1000 的 `hasMore/nextAfterSeq` 边界未被门禁覆盖 |
| 2 | **写入中途失败回滚指纹** | check4 的坏 payload 仍是 `batch.tasks`（写前校验阶段），**不进 clear/写入事务**；因此门禁无法发现“事务回滚被破坏” |
| 3 | **v1/v4→v5 行为** | check7 仍只断言 `schemaVersion===5` + project 行；没有 tasks/events 保留、旧事件按 aggregateId 查询、v4→v5 |
| 4 | 未知**对象**形状 | §8.3 的残余缺口没有任何门禁用例 |

**最小可执行清单（每行一句话 + 期望断言，可直接进 m6-smoke）：**

1. **>1000 事件**：`seedOnlyEvents(file, 1005, "M6-MANY")` 后
   - `store.listEventsPage({aggregateId:"M6-MANY", limit:1000})` → `items.length===1000 && hasMore===true && nextAfterSeq===1000`；用 `afterSeq:1000` 再查 → `items.length===5 && hasMore===false`；
   - HTTP `GET /api/v1/events?aggregateId=M6-MANY&limit=1000` → 同样 1000/true/1000，第二页 5 条，全量 seq 无重无漏。
2. **写入中途失败回滚**：用 in-process `importStateJson`（临时 DB，`openStore` 后把 `store.createTask` 包成“第 2 次调用抛错”，`mode:"replace"`）→
   - `report.status==="SKIPPED"` 且 problems 含 `IMPORT_WRITE_FAILED`；
   - 13 张业务表 counts + `schema_migrations` 版本集合在调用前后 **deepEqual**；
   - reopen `migrate:true` → `schemaVersion===5`、`migrationWarnings()===[]`。
3. **v1/v4→v5 行为**：用 raw SQL 建 v1 与 v4 两个库（0001/0001-0004 + 账本行 + project/task/event），`openStore({migrate:true})` 后分别断言
   - `health().schemaVersion===5`；`listTasks()` 含旧任务；`listEvents({aggregateId:"V-T"})` 返回旧事件；`idx_events_type_seq` 存在；账本 1..5。
4. **（修 §8.3 后）未知对象形状**：`importStateJson(mode:"replace", stateJson:{metadata:{a:1}})` → `status==="SKIPPED"` + 全量 fingerprint 不变。

**哪些已由对抗套件覆盖、哪些必须进门禁**：
- 已由 QA 套件覆盖：A1/A2/A3/A6（形状）、A5（写入中途回滚指纹）、B1-B5（内容/幂等/活跃 Run/force-switch/在线顺序）、C1-C4（过滤/分页/HTTP 边界）、D1-D2（v1/v4 行为、账本自愈）、E1-E4（backup/tamper/live WAL）、F1-F2。
- **必须单独进 m6-smoke**：上表 1、2、3（门禁要能独立防回归，不能依赖 QA 套件）；4 在 §8.3 修复后加入。
- QA7-05/06（store 参数校验/store 方法）建议作为 MINOR 顺带修，不阻塞门禁清单。

### 8.5 复验结论（直接回答）

**M6 当前仍不可标记完成。** 原 3 个 MAJOR 中，**QA7-02、QA7-03 已修并复验通过，QA7-01 只修了数组/集合路径**：未知**非空对象**（metadata、10 层嵌套、数字键、`__proto__`、`constructor`、batch/project/counts 下的对象）仍会 `PASS` 并清空旧库（§8.3 QA7-01r MAJOR），与修复提交自己的“unknown objects refused”说明矛盾。另有 QA7-05/06 两个 MINOR 未修。**修掉 QA7-01r（未知非空对象 fail-closed）并补上 §8.4 的 3 条门禁后，M6 才可以标记完成。**

“v1.0 可用 ≠ 生产可用”的边界与 §7 相同：Mock DSH、无安装包/自动更新、无浏览器 E2E、旧 CLI 仍 JSON 事实源、JSON export/import 不含 runs/events/leases、单机 Windows、Node<22.5 时套件整体 SKIP。

---

## 9. 最终复验（HEAD `a0671ce`，QA-007 签字）

- 日期：2026-11-02；对象 `a0671ce`（修复 `7a630b4`/`003066d`/`97605cd` + 本轮 `a0671ce`）。工作树干净；未改产品代码。
- 本轮只读验证 + 一条隔离变异（证明门禁有效），未 commit 产品代码；报告的 §8 结论已被本轮取代。

### 9.1 数字（HEAD a0671ce）

| 检查 | 结果 |
|---|---|
| `node scripts/test.mjs` | **475/475**（0 fail / 0 skipped） |
| `node scripts/test-workspace.mjs` | **604/604**（59 文件） |
| `node scripts/check-boundaries.mjs` | **PASS：9 package / 6 edge / 0 cycle** |
| `packages/database`（`test/*.test.mjs`） | **114/114** |
| `apps/backend`（`test/*.test.mjs`） | **135/135** |
| `m3 / m4 / m5 / m6-smoke` | **6/6、9/9、4/4、12/12** |
| `test/m6-qa-adversarial.test.mjs` | **23/23**（含上轮追加的 A6/B4/B5/C4） |
| `test/phase-c-readonly.test.mjs`（Phase C 回归） | **5/5**（写入口拒绝 + JSON 字节不变 + 只读命令 + stale lock + 非 ASCII） |

### 9.2 未知对象 fail-closed 复验（QA7-01r）

按 Lead 指定的 8 种变体 + 未见过的组合逐项实测（真实 SQLite，初始库 tasks/agents/events 各 1；`mode:"replace"`）：

| 形状 | 结果 |
|---|---|
| `metadata` 对象 / 10 层纯对象 / 数字键对象 / `__proto__` 对象 / `constructor` 对象 / `batch.metadata` / `project.metadata` / `counts.metadata`（8 种） | **全部 SKIPPED `IMPORT_WRITE_FAILED`，`dbUnchanged`** |
| `metadata: [{ a: { arr: [1] } }]`（数组→对象→数组，非受信容器） | SKIPPED，零写入 |
| `metadata: { list: [{ deep: { arr: [1] } }] }` | SKIPPED，路径 `metadata.list` |
| `counts.metadata.deep`（纯对象与数组叶子两种） | SKIPPED，路径 `counts.metadata...` |
| 未知对象含空数组 `{arr:[]}` / 嵌套空对象 `{a:{}}` | SKIPPED（非空对象即拒绝；空对象 `{}` 本身放行） |
| `Object.create(null)` 作为**根** state（合法 legacy 字段） | PASS（正常导入，无原型对象可工作） |
| `Object.create(null)` 作为**未知 metadata** 值 | SKIPPED，零写入 |
| **`batch.slices[i]` 内嵌未知非空对象**（`meta:{a:1,arr:[1,2]}`、`deep:{x:{y:1}}`、`__proto__`/`constructor` 对象） | **PASS（应放行）**；`legacy.item` 原样保留这些记录级扩展，不丢数据 |

结论：QA7-01r 已关闭；“未知非空对象拒绝、受信记录内扩展保留”的边界现在符合预期。

### 9.3 QA7-05 / 06 复验

| 项 | 结果 |
|---|---|
| store 层 `aggregateId` 非法 | sqlite 与 memory 都抛 `VALIDATION_ERROR`，`details.field==="aggregateId"`（`"bad id!"` 已拒绝） |
| `store.verifySwitchReadiness()` | sqlite 与 memory 上均为 function；空闲库返回 `{ok:true, schemaVersion:5, counts:{...}, blockers:[]}` |

### 9.4 m6-smoke 12/12 自审（新增 3 条是否真抓缺陷）

1. **>1000 事件**：check10 `seedOnlyEvents(1005)` → store `listEventsPage(limit=1000)` 断言 items=1000/hasMore=true/nextAfterSeq=1000，第二页 5 条、hasMore=false、无 next；HTTP 同一断言，并拼接两页校验 **seq 1..1005 恰好各一次**。真实、有效。
2. **写入中途失败回滚**：check11 用 Proxy 包住 `createTask`，第 2 次调用抛错；断言 `status==="SKIPPED"`、`IMPORT_WRITE_FAILED`、`createTaskCalls>=2`、**15 张表 counts + schema_migrations 版本集合前后 deepEqual**、reopen schema5/warnings=[]。
   - 是否证明“进了事务”：`createTaskCalls>=2` 证明已进入 `writeAll()`（replace 的 clear→writeAll 在 `INTERNAL.transaction` 内）；失败后全量 fingerprint 与失败前一致，证明 clear 与部分写入被回滚。
   - **我做了隔离变异验证**：把 `INTERNAL.transaction` 改成 `(work) => work()`（去掉事务）后跑真实 `m6-smoke` → **check11 FAIL，11/12**；恢复后 12/12。说明该 check 确实能抓住“回滚被破坏”，不是自证。
   - 非阻塞硬化建议：target 目前是空库，check11 没有**直接观测** `clearBusinessTables` 被调用；若要更强的实现无关性，可 seed 目标库旧行或 Proxy 计数 `clearBusinessTables`。当前证据（调用次数+代码顺序+变异）已足以签字。
3. **v1/v4→v5 行为**：check12 对 v1、v4 两个真实旧库分别断言 schema5、旧任务 V-T 及其状态、旧事件按 aggregateId 可查、`idx_events_type_seq` 存在、账本 [1,2,3,4,5]、warnings=[]。真实、有效。
- 原 check4（写前校验）保留；check11 已补上真正的事务中途回滚，两者互补。
- 原先 QA7-07 的三条缺口已全部落进门禁；复验后无需再补门禁级项。

### 9.5 Phase C 回归

`test/phase-c-readonly.test.mjs` **5/5**：所有写入口仍以 `READ_ONLY_MODE` 拒绝、旧 JSON 字节不变、只读命令（board/status/doctor/verify/export）正常、stale lock 只诊断不强绕、非 ASCII/BOM 场景通过。M6 修复未改变 Phase C 的只读语义；HEAD `3f4183d` 的只读切换无回归。

### 9.6 最终结论

**M6 可以标记完成。** QA-007 原 3 个 MAJOR（换版失效/活跃 Run 切换/HTTP 分页）与残余 QA7-01r 均已关闭；QA7-04/05/06 已修并复验；m6-smoke 12/12，新增三道门禁经代码审查与一次“去掉事务”变异验证能抓住对应缺陷；root 475/475、workspace 604/604、database 114/114、backend 135/135、boundaries 9/6/0、m3..m6 全绿。无 BLOCKER，无 MAJOR，无必须再补的门禁级缺口。

**v1.0 可用 ≠ 生产可用**（边界不变）：
1. 真实 DSH 不可用，所有多 Agent 演示是 MockRuntime；
2. 无安装包/签名/自动更新；仅 Windows 本机；
3. 无 CI 级浏览器 E2E（Web 时间线只到单测 + 真实 HTTP 接口测试）；
4. 旧 CLI 仍以 JSON 为事实源，Phase C 只是“只读视图”，不是完全切换；
5. JSON export/import 不含 runs/events/leases，replace 切换会重置执行历史（已在 m6-status 文档化）；
6. 无多用户/远程；日志无轮转；Node < 22.5 时 QA 套件整体 SKIP。
