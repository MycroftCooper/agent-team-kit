# M0 独立 QA 复核报告（QA-001）

- 文档类型：独立复核报告（Reviewer / QA Function，身份隔离）
- 审查对象：分支 `m0/baseline-and-p0`，冻结 commit **`a4b54b78971ffe3674186cf2faa8db778d86d656`**（6 个提交：`a12fc6f` → `1e7bed0` → `fe83df2` → `0c21aaa` → `3707d02` → `a4b54b7`）
- 审查者：`qa-reviewer`（REVIEWER/QA）。本轮全部产品代码、文档与既有测试由 Lead、worker-ownership、worker-gate、worker-evidence、worker-runtime-spike 编写；审查者未参与任何产品代码编写，也未修改任何产品代码/他人测试。
- 审查环境：Windows 11，Node **v24.16.0**，仓库工作目录 `E:\CodeProject\agent-team-kit`
- 审查时间：2026-11-02
- 审查开始时工作区状态：`git status --porcelain` 为空；HEAD = `a4b54b7`；`package.json` 1839 字节，与 `git show a4b54b7:package.json` 无差异（Lead 告知的 2 分钟误写窗口未留下任何痕迹）。审查期间工作区新增了两个未跟踪文件（本报告 + `test/qa-m0-adversarial.test.mjs`），另发现未跟踪的 `docs/roadmap/m0-status.md`（非冻结 commit 内容，见 §6）。
- 本报告与对抗测试只新增两个文件；除此之外未执行任何改变 git 状态的命令（无 commit/add/checkout/branch/stash），变异测试全部在 `git archive` 解包出的临时目录内进行。

> **结论摘要（最终）：M0 可以标记完成（以修复提交后的新冻结 SHA 为准）。** 首轮在冻结 `a4b54b7` 上发现 2 MAJOR（Q-02 evidence Hash 绑定 fail-open、Q-03 集成路径 gate 报告未要求五值 PASS）+ 2 MINOR（Q-01 `..` 借道、Q-04 静默忽略）。四个缺陷均已修复并由独立复验确认为 **FIXED**；复验轮 `node scripts/test.mjs` = **325/325 pass**、`node scripts/m0-repro.mjs` = **12/12**、本报告对抗套件 **25/25**。修复目前是叠加在 `a4b54b7` 之上的未提交改动——把修复 commit 成新的冻结 SHA、并在该提交上复跑同一组命令后，即可在状态文档中标记 M0 完成。首轮结论保留在 §1–§7（历史），复验细节见 §8。

---

## 1. 执行清单（真实命令 / 退出码 / 关键输出）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `git status --porcelain` + `git rev-parse HEAD` + `git branch --show-current` | 0 | 初始为空；`a4b54b78971ffe3674186cf2faa8db778d86d656`；`m0/baseline-and-p0` |
| 2 | `node scripts/test.mjs`（冻结工作区，未加入本报告测试前） | **0** | `tests 282 / pass 282 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration 12506ms` |
| 3 | `node scripts/m0-repro.mjs` | **0** | **12/12 PASS**：P0-1a/b/c/d/e、P0-2a/b/c/d、P0-3a/b、P0-4a（逐条输出见 §1.1） |
| 4 | `node bin/atk.mjs gate fast --files <本轮 12 个改动文件>` | **0** | `status: PASS`、`ok: true`、`scope.total 12`、steps `ownership/workflow-state/syntax/unit-tests` 全 `passed`、`durationMs 11762`；报告写入 `artifacts/agent-flow/ci-fast-latest.json`（被 .gitignore 忽略） |
| 5 | `node bin/atk.mjs state check` | **0** | `ok: true`，`slices: 1`，`warnings: ["no active work packages"]`（1 条非阻断告警） |
| 6 | `node bin/atk.mjs permit matrix --json` | **0** | 合法 JSON，`schemaVersion 1`、`matrixVersion 1` |
| 7 | `node bin/atk.mjs batch --help` | **2** | 打印 29 行 batch usage（该子命令的 help 按既有设计返回 2，属旧行为，非回归） |
| 8 | `node bin/atk.mjs ownership verify-config` | **0** | `{"ok":true,"rules":15,"problems":[]}` |
| 9 | `node bin/atk.mjs --version` | **0** | `0.2.0` |
| 10 | `node scripts/test.mjs`（加入 `test/qa-m0-adversarial.test.mjs` 后） | **1** | `tests 307 / pass 304 / fail 3 / skipped 0 / todo 0`；3 条失败即本报告 Q-01/Q-02/Q-03 的回归用例（预期红，见 §3/§4） |
| 11 | `git -C . archive --format=tar a4b54b7` + `tar -xf` 到 `%TEMP%`，在解包树上跑 5 个新增测试文件 | 0 | 基线绿；随后 8 个变异体全部被测试抓到（见 §4） |
| 12 | `npm pack --dry-run --json` | 0 | 145 files / unpacked 1,040,195 B；其中 `docs/architecture/**` 53 files / 269,523 B |
| 13 | 运行时 Spike 文档链接校验（Node 脚本解析 89 个相对链接） | 0 | links 89 / missing **0**，与文档“89/89 可解析”一致 |
| 14 | 旧基线（`aec31b6` 解包）复现 `current-state.md` §6 的 P0-1/2/3 | 0 | 全部复现成功（见 §5） |
| 15 | `permit check qa.result.submit` + legacy `passed:true` 回执 | **0** | `allowed: true`、`review-evidence: ok` → 证实 PERMISSIONS 文档声明的“已知限制”真实存在（非已修复） |
| 16 | 隐私/密钥扫描（`docs/**` 递归，含 `spike-evidence/**`） | 0 | 本机用户名 0 命中；真实用户主目录 0 命中（仅脱敏占位符 `C:\Users\<用户名>`）；`sk-`/Bearer 真实密钥 0 命中；mock 请求头为 `<present-fake>` |
| 17 | **复验轮**：`node scripts/test.mjs`（修复工作树） | **0** | **tests 325 / pass 325 / fail 0 / cancelled 0 / skipped 0 / todo 0**（见 §8.2） |
| 18 | **复验轮**：`node scripts/m0-repro.mjs` | **0** | **12/12 PASS**（与首轮一致） |
| 19 | **复验轮**：`node --test test/qa-m0-adversarial.test.mjs` | **0** | **25/25 pass**（A2/C7/C8 由红转绿） |
| 20 | **复验轮**：自举 `gate fast --files <14 个修复/测试/文档文件>` + 旧 CLI | **0** | `status: PASS`、4 步全 `passed`；`state check`/`permit matrix --json`/`ownership verify-config` 均 0；`--version` = 0.2.0 |

依赖与包边界（静态检查 + 自动测试 E2）：根 `package.json` 无 `dependencies`/`devDependencies`；`packages/contracts/package.json` 无依赖、`type: "module"`；`lib/**` 与 `bin/**` 的静态 import 仅 `node:*` 或相对路径，**无一处 import `packages/**`**（反向依赖为 0）。

### 1.1 `node scripts/m0-repro.mjs` 逐条结果（exit 0，12/12）

| 检查 | 结果 |
|---|---|
| P0-1a strict 缺 `--role` | PASS（exit 2） |
| P0-1b strict 未知 role | PASS（exit 2） |
| P0-1c strict 未映射路径 | PASS（exit 1，`status=FAIL`，violations=1） |
| P0-1d strict 域内路径 | PASS（exit 0，`status=PASS`） |
| P0-1e loose 未映射不阻断（旧行为） | PASS（exit 0，`ok:true`） |
| P0-2a 空 fast gate | PASS（exit 2，UNCONFIGURED） |
| P0-2b 空 quick gate | PASS（exit 2，UNCONFIGURED） |
| P0-2c 无适用步骤 | PASS（exit 0，`status=SKIPPED`，输出无 PASS） |
| P0-2d 有步骤且通过 | PASS（exit 0，`status=PASS`） |
| P0-3a verify 无 `--qa` 诊断模式 | PASS（`status=SKIPPED`、`diagnosticOnly`） |
| P0-3b apply 无 QA | PASS（exit 1） |
| P0-4a evidence 拒绝自报 `passed:true` | PASS（`qaApprovals=0`、`rejected=1`、slice 未推进） |

---

## 2. A/B/C/D/E 逐项结论表

判定：**PASS** = 规范要求的行为已满足；**FAIL** = 与规范冲突（实现缺陷）；**OBSERVATION** = 规范未强制/已记录的行为，记录但不判缺陷。

### A. ownership strict 绕过

| 项 | 期望（规范依据） | 实际 | 判定 |
|---|---|---|---|
| A1 绝对路径 | strict 不得把绝对路径归属到项目相对前缀（ATK-002 完整路径清单 + 未映射拒绝） | exit 1、`status:FAIL`、`rule:"unmapped"` | PASS |
| A2 含 `..` 的路径 `src/../lib/x.ts` | 匹配 owner 前必须规范化；不得用 `src/` 前缀替 `lib/` 文件担保 | 首轮：exit **0**、`status:PASS`（被判给 DEV 的 `src/`）；**复验**：exit 1、`status:FAIL`、violation 的 file 为 canonical `lib/x.ts` | **FIXED（Q-01，复验轮转绿）** |
| A3 `AGENT_ROLE=""` | 空串 = 缺 Role → exit 2、`status:ERROR`、不打印 PASS | exit 2、`status:ERROR` | PASS |
| A4 未知 role（含 `ops`/大小写变体） | exit 2（config error），不是 violation | exit 2、`status:ERROR` | PASS |
| A5 未映射 + `--json` | exit 1、`status:FAIL`、`ok:false`、`unmapped` 与 `violations` 一致 | 一致 | PASS |
| A6 空文件清单 | SKIPPED（`ok:false`）+ 明确“不构成通过”，退出 0，绝不 PASS | 非 git 项目下 `--files ","`/空串 → `status:SKIPPED`、`ok:false`，人读输出含“not a pass” | PASS |
| A7 `ignoredPrefixes` 覆盖的路径 | 规范未定义；ignored 语义是“跳过” | 仅 ignored 文件时 `status:PASS`、`checked:1`、`ignored:1`（没有校验任何“有归属”的文件） | OBSERVATION（Q-05） |
| A8 配置 `mode:"strict"` + `--no-strict` | 规范只要求 `--strict` 可升格；代码/`docs/INTERNALS.md`/`docs/CONFIG.md` 一致记录 `--no-strict` 可降级 | 降级为 loose（已有 worker 单测覆盖） | OBSERVATION（Q-07，文档一致，M4 再收紧） |

### B. gate 状态伪通过

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| B1 预置 PASS 报告后跑 FAIL | 报告必须被覆盖为 FAIL | 报告 `status:FAIL`、`ok:false`，exit 1 | PASS |
| B2 `--plan` | 不写报告、不刷新绿色 | 报告字节未变；`planOnly:true`，exit 0 | PASS |
| B3 release 对 `status:PASS` 但 `ok:false` / 缺 `ok` / 大小写 `pass` / 仅 `ok:true` / SKIPPED | 全部拒绝并说明原因 | 全部 exit 1，原因分别为 `inconsistent`/`no status field`/`not PASS`/`SKIPPED`；真 PASS 才 exit 0 | PASS |
| B4 并行步骤一个 failed 一个 error | 绝不能 PASS；status 五值之一、exit ≠ 0 | `status:ERROR`、`ok:false`、exit 2；steps 分别 `failed`(exit 3) / `error`(exitCode null) | PASS（ERROR 优先于 FAIL，规范未规定优先级，合理） |
| B5 步骤命令含 shell 元字符 | 动态 role 不能被 shell 二次解释 | `--role "DEV & exit 7 &"` 未执行 `exit 7`，gate PASS | PASS（Windows cmd 引号安全） |
| B6 集成路径的 gate 报告 | §10.1“只有真实 PASS 满足强制质量条件”；`batch apply` 只应接受显式 PASS 报告 | 首轮：预置 legacy `{ok:true}`（无 status）或 `{status:"FAIL", ok:true}` 报告后 `batch apply --apply` **exit 0 并写入原树**；**复验**：exit 1、`error:"permission-denied"`、`reason:"GATE_NOT_GREEN"`、原树不动；显式 `{status:"PASS",ok:true}` 仍放行 | **FIXED（Q-03，复验轮转绿）** |

### C. QA / 证据绑定伪通过

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| C1 `reviewer.agent` 在 `manifest.run.contributors` 中 | 拒绝（self-review，§10.2） | verify exit 1，`rejected:[self-review]` | PASS |
| C2 `gates` 含 SKIPPED | 拒绝（`gate-not-pass`） | exit 1，`gate-not-pass` | PASS |
| C3 `targetRunId` 缺失但 `manifest.run.id` 存在 | 规范原文“若双方都有该字段则一致”，缺省不构成不一致 | `verify --require-qa` exit 0、`status:PASS` | PASS（规范允许；绑定弱于字面期望，记录） |
| C4 `batch.legacyReceipts:false` + `passed:true` | 拒绝 `legacy-receipt` | verify exit 1，`legacy-receipt` | PASS |
| C5 `manifestSha256` 小写变体 | 视为不同 hash → 拒绝 | verify exit 1，`manifest-sha-mismatch` | PASS |
| C6 `atk evidence` 中 `verdict:"PASS"` 但缺 `kind` | 不得计入 QA 事实；且不得静默 | 首轮：`qaApprovals:0`、state 不推进，但**完全静默**（`rejected` 为空）；**复验**：`qaApprovals:0`、`rejected:[missing-kind]`、state 不推进 | **FIXED（Q-04，复验轮）** |
| C7 `atk evidence` 中 QA 回执的 Hash 绑定不到任何冻结 manifest（含大小写变体/凭空 hash） | 必须拒绝：§1.2 要求校验“目标版本、Hash”；WORKFLOW §5 要求 `manifestSha256` 等于冻结 manifest 的 hash | 首轮：`qaApprovals:1`、`rejected:[]`、slice S1 `qaPassed:true` 且推进到 `awaiting_apply`；**复验**：`qaApprovals:0`、`rejected:[unbound-manifest]`、slice 保持 `in_progress`；大写/小写合法 hash 绑定成功后仍被接受 | **FIXED（Q-02，复验轮转绿）** |
| C8 `--legacy-receipts` 能否绕过 apply 受控门槛 | 显式逃生门可以接受 legacy，但受控集成仍需 gates 声明与独立 reviewer | `apply --legacy-receipts` + 无 gates 的 legacy 回执仍 exit 1（`missing-gates`），reviewerChecks 仍执行 | PASS（未发现“一行开关即绕过”）；记录为 OBSERVATION Q-10 |
| C9 apply 无任何 QA | exit 1、plan `status:FAIL`、原树不动 | 一致 | PASS |

### D. 文档一致性（标准：样例必须与代码真实行为一致）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| D1 `docs/PERMISSIONS.md` / `PERMISSIONS.zh-CN.md` | 必须如实写“review-evidence 仍接受 legacy `passed:true`，权威校验在 batch verify/apply，M4 收紧”，不得写成已修复 | 英文含 “Known limitation (M0, planned for M4)… not a fixed behavior”，中文含“已知限制…不是已修复项”；实跑 `permit check qa.result.submit` + legacy 回执 = `allowed:true`，与文档一致 | PASS |
| D2 `docs/INTERNALS.md` strict 报告样例 | 字段与真实 `--json` 输出一致 | 实跑输出键集合 = 文档 `{status,mode,ok,role,checked,violations,unmapped,ignored}` | PASS |
| D3 `docs/WORKFLOW.md` gate 五值表 | status/退出码与 `GATE_STATUS_EXIT_CODES` 一致；`ok === (status==="PASS")` 不变量；release 只接受显式 PASS 的表述与代码一致 | 逐行核对通过（`PASS 0 / FAIL 1 / SKIPPED 0 / UNCONFIGURED 2 / ERROR 2`） | PASS |
| D4 `docs/WORKFLOW.md` batch verify 诊断样例 | 输出行与真实输出一致 | 实跑逐字匹配：`SKIPPED BATCH-01: diagnostic-only, no qa-approval supplied; QA was not evaluated; 3 structural check(s) ok \| receipt artifacts/evidence/BATCH-01/verify-*.json` | PASS |
| D5 `docs/CONFIG.md` `ownership.mode` 小节 | 默认值、四个 strict 行为、`--strict/--no-strict` 覆盖说明与代码一致 | 一致（schema 同步、默认 loose） | PASS |
| D6 `docs/ENTITIES.md` 身份检查/回执样例 | 检查名与 `lib/functions.mjs` 一致；结构化回执样例与 schema 一致 | 11 个检查名一致；但漏列 `reviewer-role-capability`（`INTERNALS.md` 列全 12 个） | OBSERVATION（文档完整性，MINOR） |
| D7 `docs/architecture/current-state.md` §6 的“修复前”证据 | 必须能在旧基线复现，不能是编造的 | 在 `aec31b6` 解包树上真实复现 P0-1/2/3（见 §5） | PASS |
| D8 `docs/architecture/runtime-spike-dsh-magpie.md` | 报告链接可解析；不把未验证写成通过 | 89/89 相对链接可解析；RT 结论为 PASS/PARTIAL/UNVERIFIED 且生产结论=不可用（本轮未重跑 ACP，仅核对一致性） | PASS |

### E. 安全与隐私

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| E1 本机用户名/真实主目录 | 0 命中 | 本机用户名 0 命中；真实用户主目录 0 命中（只有脱敏规则里的 `<用户名>` 占位符） | PASS |
| E2 密钥/令牌 | 0 命中 | 无 `sk-*` 真实密钥、无长 Bearer；`mock-requests*.sample.ndjson` 的 authorization 为 `<present-fake>` | PASS |
| E3 包边界/依赖 | 无第三方依赖；contracts 零依赖；lib 不反向 import packages | 全部满足（E2 自动测试 + 手工核对） | PASS |
| E4 发布包卫生 | — | `npm pack --dry-run`：145 files / 1.04 MB，其中 `docs/architecture/**` 53 files / 263 KB 会进 tarball | OBSERVATION（Q-09，与 Lead 判断一致，下次发布前处理） |

---

## 3. 缺陷清单

严重度定义：BLOCKER = 阻断 M0 完成/不可解释的安全缺口；MAJOR = 违反明确规范条目、可导致“伪通过/错误事实”；MINOR = 局部偏差或可观测性问题；OBSERVATION = 记录项（文档未定义或已声明）。

### Q-01（MINOR，建议同批修复）ownership strict 未规范化 `..`，前缀匹配可被“借道” —— **状态：FIXED（复验轮）**

- 位置：`lib/ownership.mjs` `normalizePath()` / `resolveOwner()`（`lib/util.mjs` `normalizeRel` 不解析 `..`）
- 复现：
  ```bash
  # 临时项目 flow/ownership.json：rules [{prefix:"src/",role:"DEV"},{prefix:"lib/",role:"LEAD"}]
  node bin/atk.mjs ownership check --strict --role DEV --files "src/../lib/x.ts" --json
  # 实际：exit 0, status PASS, checked 1（被当作 src/ 归属 DEV）；语义上该路径就是 lib/x.ts（LEAD）
  ```
- 期望：路径在归属判断前 canonicalise；无法规范化/越界的路径按 unmapped 处理（strict → exit 1）。
- 规范依据：ATK-002“执行/集成模式强制 Role + 完整路径清单 + 未映射拒绝”；写域检查的核心前提是路径真实。
- 归属建议：worker-ownership / Lead（`lib/ownership.mjs` 或 `lib/util.mjs`），同时补负面用例；`lib/permissions.mjs` 的 `write-scope` 条件走同一 `checkFiles`，修复后一并受益。
- 影响说明：真实 gate 的 `--files` 来自 git 输出，不会产生 `..`；因此被利用需要调用方自己伪造 `--files`，故判 MINOR，但它属于“检查器没有 fail-closed”的同类缺陷。
- **复验（2026-11-02）：FIXED。** `lib/ownership.mjs` 新增 `canonicalPath()`，strict 模式先折叠 `.`/`..`、合并重复 `/`、统一 `\`，再做前缀匹配；前导 `..` 与绝对路径保持不可归属。回归用例 A2 转绿；`test/ownership-strict.test.mjs` 新增 canonicalPath 单测与 5 组路径形状用例；loose 路径改用原 `normalizePath()`（逐字节行为未变，既有 loose 测试全绿）。

### Q-02（MAJOR）`atk evidence` 接受“Hash 未绑定任何冻结 manifest”的结构化 QA 回执并推进状态 —— **状态：FIXED（复验轮）**

- 位置：`lib/evidence.mjs` `deriveEvidence()`：仅当 evidence 目录中存在 `manifestSha256` **完全相等**的 manifest 时才把 manifest 传给 `validateQaApproval`；找不到时 `manifest` 为 `undefined`，Hash/run/self-review 绑定全部被跳过，结构化回执被视为合法。
- 复现（最小化）：
  ```bash
  # 临时项目：flow/state.json 有 slice S1（in_progress, qaPassed:null）；
  # artifacts/evidence/BATCH-01/qa-unbound.json 为完整结构，但 manifestSha256 = "FFFF…"（无对应 manifest），batchId:"S1"
  node bin/atk.mjs evidence --json
  # 实际：exit 0, qaApprovals:1, rejected:[], changes:1
  #       state.json → S1.qaPassed=true, S1.status="awaiting_apply"
  ```
  变体：evidence 目录里有真实 manifest（大写 hash），回执写同一 hash 的**小写**变体 → 同样被计入并推进状态（`qaApprovals:1`）。
- 期望：`kind:"qa-approval"` 且携带非空 `manifestSha256` 的回执，必须能在本次扫描到的 manifest 集合中绑定到同一 Hash（大小写按实现约定的规范形式比较）；绑定不到 → 计入 `rejected`（如 `unbound-approval` / `manifest-not-found`），不产生 `qaPassed` 事实、不推进 slice。
- 规范依据：实现规格 §1.2 风险 4：“`evidence` 按 `passed:true` 等声明识别回执：不把自报字段当作可信批准；**需校验签发流程、Run、目标版本、Hash、实际 Gate 结果**”；ATK-004 第 1 条要求 `manifestSha256` 绑定冻结 manifest；`docs/WORKFLOW.md` §5、`docs/ENTITIES.md` 均承诺“hash 必须等于冻结 manifest 的 hash”。
- 归属建议：worker-evidence / Lead（`lib/evidence.mjs`）。注意 `batch verify/apply` 路径是正确的（它总是拿到真实 manifest），只有 `atk evidence` 这条推导路径 fail-open。
- 影响：状态机被错误推进（可伪造“QA 已通过”事实）；虽然没有直接写产品文件，但会污染 board/queue/acceptance 依据，且与本次 P0-4 修复目标正相反。
- 回归用例：`test/qa-m0-adversarial.test.mjs` → C7（复验轮已转绿）。
- **复验（2026-11-02）：FIXED。** `lib/evidence.mjs` 新增 `shaKeyOf()`（hex 大小写只用于比较）与 fail-closed 绑定：`kind:"qa-approval"` 且 `manifestSha256` 非空、但扫描集内无对应 manifest → `rejected: unbound-manifest`，不产生 qa/applied 事实；绑定成功时用真实 manifest 调 `validateQaApproval`（self-review/run 绑定因此真正执行）。负例“凭空 hash”与正例“大小写变体绑定成功”都由新增测试与本次手跑覆盖；`docs/INTERNALS.md` 已同步绑定规则。

### Q-03（MAJOR）`batch apply` 的集成前置条件仍接受非五值 PASS 的 gate 报告（legacy `ok:true` / 自相矛盾报告） —— **状态：FIXED（复验轮）**

- 位置：`lib/permissions.mjs` `CONDITIONS["gate-green"]`：只检查 `report.ok === true`，未要求 `status === "PASS"` 且 `ok === true` 一致（`lib/release.mjs` 已按 ATK-003 修复，apply 未同步）。
- 复现：
  1. 临时项目配置 `gates.quick.command`，冻结 manifest，写合法结构化 QA 回执（gates 声明 quick PASS）；
  2. 写 `artifacts/agent-flow/ci-fast-latest.json` = `{"schemaVersion":1,"gate":"quick","ok":true}`（或 `{"status":"FAIL","ok":true}`）；
  3. `node bin/atk.mjs batch apply --manifest … --qa … --apply --confirm-dev-closed`
  4. 实际：**exit 0，原树被写入**（`src/app.mjs` 变为 candidate 内容）；期望：exit 1 + `GATE_NOT_GREEN`，原树不动。
- 规范依据：§10.1“Gate 状态五值。只有真实 `PASS` 满足强制质量条件”；ATK-003 的交付门禁语义（release 已实现，apply 是同一“强制质量条件”）；`docs/WORKFLOW.md` §7 明确“a green gate report — a self-declared gate inside the QA receipt is not a gate report”。
- 归属建议：Lead（`lib/permissions.mjs` 是跨域文件，ATK-003/004 交界）。修复方向：`gate-green` 复用 `gateReportVerdict`（`lib/release.mjs` 导出）或等价地要求 `status === "PASS" && ok === true`；同时补 apply 路径回归测试。
- 影响：受控集成本应“只有真实 PASS 才能写原树”，现在 pre-M0 遗留报告（或手工伪造的 ok-only/矛盾报告）即可满足；对升级中的真实项目是迁移期风险。注意它仍需要合法 QA 回执，故不是“零证据合并”。
- 回归用例：`test/qa-m0-adversarial.test.mjs` → C8（复验轮已转绿；断言修订见 §8.5）。
- **复验（2026-11-02）：FIXED。** 唯一实现 `gateReportVerdict` 移到 `lib/gate.mjs`，`lib/release.mjs` re-export，`lib/permissions.mjs` 的 `gate-green` 调用同一函数（BOM 容忍读取）；`test/gate-status.test.mjs` 用同一组 fixture 同时跑 release 与 `evaluatePermission` 并断言结论相等，另有 `assert.equal(release.gateReportVerdict, gate.gateReportVerdict)` 的函数对象同一性断言。`batch apply` 的 permission-denied 分支现在输出机器可读 JSON（`error:"permission-denied"`、`reason`、`detail`）。

### Q-04（MINOR）`atk evidence` 对“像 QA 回执但缺 `kind`”的文件完全静默 —— **状态：FIXED（复验轮）**

- 位置：`lib/evidence.mjs` `classify()` 未归类时不进入 `rejected`。
- 复现：evidence 目录放 `{schemaVersion:1, manifestSha256, verdict:"PASS", reviewer:{run,agent,role,function:"REVIEWER"}, batchId:"S1", gates:[…]}`（无 `kind`）→ `qaApprovals:0`（正确），但 `rejected:[]` 且 stderr 无任何提示。
- 期望：`docs/INTERNALS.md` 写“Every refused receipt is reported in `rejected` — never silently ignored”。一个 QA 形状但缺 `kind` 的回执应至少进入 `rejected`（例如 `unstructured-receipt`），否则写坏格式的 QA 会“安静地不生效”，排查困难。
- 规范依据：ATK-004 第 2 条“静默忽略禁止”（针对 legacy）；INTERNALS 的通用承诺。
- 归属建议：worker-evidence。严重度 MINOR（不产生错误通过，只是可观测性）。
- **复验（2026-11-02）：FIXED。** `looksLikeQaReceipt()` 把含 `verdict`/`reviewer`/`gates` 而无 `kind` 的回执路由到 QA 拒绝路径，`rejected: missing-kind`（legacy 逃生门打开时也拒绝，因为这不是 legacy）；`docs/INTERNALS.md` 已记录。

### Q-05（OBSERVATION）strict 检查在“全部文件都属于 ignoredPrefixes”时仍报 PASS

- 复现：`--files artifacts/x.json`（`ignoredPrefixes: ["artifacts/"]`）→ `status:PASS`、`ok:true`、`checked:1`、`ignored:1`。没有校验任何“有归属”的文件，却与空清单（SKIPPED）语义不同。
- 规范未规定；`ignoredPrefixes` 的既有语义就是跳过。建议：只有在至少校验过一个 owned 文件时才 PASS，否则 SKIPPED（或报告增加 `owned` 计数）。判 OBSERVATION，不阻塞。

### Q-06（OBSERVATION）显式空 `--files` 会回退到 git 变更发现，而不是“空清单 → SKIPPED”

- 复现（git 仓库，存在未跟踪的 `src/untracked.mjs`）：
  ```bash
  node bin/atk.mjs ownership check --strict --role DEV --files "," --json
  # 实际：exit 0, status PASS, checked 1（把 git 未跟踪文件当成了检查对象）
  # 非 git 项目：status SKIPPED（与规范字面一致）
  ```
- 规范依据：ATK-002 第 1 条“空文件清单 → SKIPPED”。`optionList()` 把“提供了但为空”与“未提供”合并，导致 git 回退。
- 影响：不会放松未映射阻断（多检查通常更严），但会让“空清单 SKIPPED”语义不稳定，并可能在 CI 里意外检查无关文件。建议：区分 `args.files !== undefined` 与无该 flag；严重度 OBSERVATION/MINOR，归 worker-ownership。

### Q-07（OBSERVATION，已记录的设计选择）`--no-strict` 可降级配置中的 strict

- `docs/INTERNALS.md` 与 `docs/CONFIG.md` 均明确写出 `--no-strict` 覆盖配置；属已记录行为，不是缺陷。安全建议：M4 收紧时为“配置 strict”提供不可被 CLI 降级的模式（例如 `mode:"strict"` 时忽略 `--no-strict`），避免“配置了 strict 但某条命令脚本仍能降级”的错觉。

### Q-08（OBSERVATION，已知限制，非缺陷）`permit check qa.result.submit` 仍接受 legacy `passed:true`

- 实跑确认（`allowed:true`，`review-evidence: ok`）；PERMISSIONS en/zh 均如实写成“已知限制 + M4 收紧”，未写成已修复 → **文档合格**。权威校验在 `batch verify/apply`（默认拒绝 legacy）。这是任务书明确要求“不要判 BLOCKER”的已知项。

### Q-09（OBSERVATION）`docs/architecture/**`（含审计证据）会进入 npm 发布包

- `npm pack --dry-run --json`：145 files / 1,040,195 B；`docs/architecture/**` 53 files / 269,523 B。与 Lead 的 OBSERVATION 一致；下次正式发布前评估 `files` 排除，或把审计证据迁出发布目录。

### Q-10（OBSERVATION）`apply --legacy-receipts` 未发现“绕过受控集成”的廉价路径

- legacy 回执即使带 `--legacy-receipts`，仍受 `requireGates`（必须声明 gates 且 PASS）与 `reviewerChecks`（生产者/审查者身份、注册、能力）约束；无 gates 时 exit 1（`missing-gates`）。这是显式逃生门的设计行为，记录即可。

### Q-11（OBSERVATION）未跟踪的 `docs/roadmap/m0-status.md` 在 QA 结论前已写“M0 门禁通过”

- 该文件不在冻结 commit 中（审查开始时工作区干净，审查期间出现），其 §3 写“**结论：M0 门禁通过**”、§7 写“允许开始 M1”，并引用当时尚不存在的本报告。首轮复核时与 QA 结论冲突。
- **复验（2026-11-02）：** Q-02/Q-03/Q-01/Q-04 已全部修复并复验通过，因此“M0 门禁通过”的结论现在有独立证据支撑（前提仍是 Lead 把修复提交并在 `m0-status.md` 中写入**新的最终 SHA** 与复验数字 325/325、12/12）。本审查者未修改该文件。

---

## 4. 变异测试结果（证明新增测试“能失败”，而非空断言）

方法：`git archive a4b54b7 | tar -x` 到 `%TEMP%`，在解包树内逐个注入变异、运行对应新增测试文件、再恢复；**未改动工作区**。

- 基线（解包树）：`test/ownership-strict.test.mjs`、`test/gate-status.test.mjs`、`test/evidence-binding.test.mjs`、`test/qa-binding.test.mjs`、`test/release.test.mjs` → exit 0，全部通过。

| 变异 | 目标测试文件 | 结果 | 被抓到的失败用例（示例） |
|---|---|---|---|
| M1 配置 `ownership.mode=strict` 被忽略（`resolveMode` 恒返回 loose） | ownership-strict | **CAUGHT** | `resolveMode defaults…`、`ownership.mode=strict … enforces…` |
| M2 strict 下 unmapped 不再计入 violations | ownership-strict | **CAUGHT** | `checkFiles only treats unmapped…`、`strict check blocks unmapped paths…` |
| M3 `PASS` 退出码从 0 改成 1 | gate-status | **CAUGHT** | `gate fast that really ran…`、`gate quick reports PASS and FAIL…`、`a real PASS gate run is accepted by release…` |
| M4 fast 报告 `ok` 恒为 true | gate-status | **CAUGHT** | 8 条 UNCONFIGURED/SKIPPED/FAIL/ERROR 用例全部转红 |
| M5 `verdict !== "PASS"` 校验被禁用 | evidence-binding | **CAUGHT** | `every structural rejection names the broken condition` |
| M6 `verifyManifest` 恒返回 `status:"PASS"` | qa-binding | **CAUGHT** | 诊断 SKIPPED、缺 QA、legacy、坏 hash、apply dry-run 等 6 条转红 |
| M7 release 接受非 PASS 报告 | gate-status（含 release 用例） | **CAUGHT** | `gateReportVerdict requires status PASS…`、`release rejects every gate report…` |
| M8 contracts 把 `SKIPPED` 当作满足 gate | contracts | **CAUGHT** | 契约测试转红 |

结论：本轮新增的 5 个测试文件（ownership-strict / gate-status / evidence-binding / qa-binding / contracts）的断言都能真实失败，不是 vacuous。**8/8 变异被捕获。**

---

## 5. 旧基线（`aec31b6`）P0 复现核对（`current-state.md` §6 不是编造）

在 `git archive aec31b6` 解包出的旧代码上实跑：

| 文档声明 | 旧基线实测 | 判定 |
|---|---|---|
| P0-1 loose：未映射路径 + 无 role → exit 0、`ok:true`、`unmapped` 仅提示 | `ownership check --files docs/x.md --json` → exit 0，`{"ok":true,"role":null,"checked":1,"violations":[],"unmapped":["docs/x.md"]}` | 与文档逐字一致 |
| P0-2 空 fast gate 静默成功 | `gate fast --files src/a.mjs --json` → exit 0，`No fast gate steps configured (gates.fast.steps is empty). Nothing to run.` | 与文档一致 |
| P0-3 无 QA 的 `batch verify` 打印 PASS | exit 0，`PASS BATCH-01: 3 check(s) passed \| receipt artifacts/evidence/BATCH-01/verify-….json` | 与文档一致 |

---

## 6. 审查范围声明与工作区偏差

- 冻结对象始终是 `a4b54b7`；本轮所有验证都在该工作树（起始 `git status` 干净）与 `git archive a4b54b7` 临时解包树上完成。
- 审查期间新增：`test/qa-m0-adversarial.test.mjs`、`docs/architecture/qa-review-m0.md`（本报告）。除此之外未修改任何产品代码、既有测试、文档或配置，未执行任何 git 写操作。
- 审查期间出现的未跟踪文件 `docs/roadmap/m0-status.md` 不属于冻结 commit（内容见 Q-11）。
- Lead 告知的 `package.json` 误写窗口：复核时文件 1839 字节、JSON 合法、`version 0.2.0`、`files` 12 项，与 `git show a4b54b7:package.json` 完全一致，**未观察到任何残留影响**。
- **复验轮（§8）的审查对象**：工作树中叠加在 `a4b54b7` 之上的未提交修复（HEAD 未变；`lib/{ownership,evidence,gate,permissions,release,batch}.mjs` + 对应既有测试 + `docs/INTERNALS.md`）。审查者仍未修改产品代码，只在复验轮按 Lead 定案修正了 C8 的 1 条过度指定断言（见 §8.5）并更新本报告。

---

## 7. 结论

### 7.1 M0 是否可以标记完成

**首轮结论（冻结 SHA `a4b54b7` 上，历史记录）：不建议标记 M0 完成（有条件通过）。** 复验后结论已更新，见 §8.7：**修复工作树上可以标记 M0 完成，最终以修复提交后的新冻结 SHA 为准。**

- 已真实达成：四类 P0 风险的主路径修复（ownership strict、gate 五值 + release 只接受 PASS、QA 结构化 + 受控集成强制 QA、evidence 拒绝自报回执）全部由 `scripts/m0-repro.mjs` 12/12 与 282 项既有测试锁定；自举 gate PASS；旧 CLI 存活；依赖/包边界/隐私均合格；文档与新行为的一致性整体良好（含已知限制如实记录）。
- 未达成（M0 完成条件）：独立复核新增的 3 条 P0 级负向断言中 **2 条 MAJOR 仍未通过**（Q-02 evidence 的 Hash 绑定 fail-open；Q-03 集成路径 gate 报告未要求五值 PASS）。二者都属于本轮主题“看起来通过其实没验证”，建议在冻结前修复（预估小改动：`lib/evidence.mjs` 绑定缺失时 reject；`lib/permissions.mjs` `gate-green` 复用 `gateReportVerdict`），并把 Q-01 一并修掉（`..` 规范化），然后重跑：

  ```bash
  node scripts/test.mjs            # 首轮期望 307/307，0 fail（首轮当时 304/307；复验轮已 325/325，见 §8.2）
  node scripts/m0-repro.mjs        # 期望 12/12
  ```

  修复后可以标记 M0 完成；若 Lead 选择把 Q-02/Q-03 延后，则必须在状态文档中显式记录为“M0 遗留 MAJOR + 回归用例已红”，并说明 M1 准入的风险承担，而不能写“M0 门禁通过”。
- Q-04（静默忽略）、Q-05/Q-06（语义边界）、Q-09（发布包卫生）为 MINOR/OBSERVATION，可在 M0.1/M1 处理，不阻塞。
- Q-08（permit legacy）为文档已声明的已知限制，非缺陷。

> **复验后（2026-11-02）：** 以上“未达成”的 Q-01/Q-02/Q-03/Q-04 均已修复并复验为 FIXED；修复工作树上 `node scripts/test.mjs` = 325/325、`m0-repro` = 12/12、对抗套件 25/25。完整复验记录见 §8，最终结论见 §8.7。

### 7.2 “QA PASS ≠ 可生产使用”边界声明

即使上述缺陷修复、M0 被标记完成，**本 QA 结论也不构成任何生产可用性背书**：

1. 本报告只覆盖 M0 的 CLI/状态机/证据链加固（ATK-002/003/004），**不覆盖** 2.0 的 Backend/Scheduler/Runtime Host/Web（M1-M6）。
2. Runtime Spike 的结论仍是 **不可用**：RT-P07（真实 Magpie 路由）、RT-P08（多 Agent 并行）、受限执行、会话级模型选择均未验证；MockRuntime 仍是唯一可接受运行时；本次复核未重跑 DSH/ACP，只核对了证据自洽性与脱敏。
3. `atk evidence` 的 `rejected` 字段是 M0 的破坏性字段变更，M1 API 化前必须迁移消费方（`m0-status.md` §7 已记录）。
4. 数据层仍是 JSON 单写者，无多进程事务；SQLite 迁移（ATK-104/105）未开始。
5. 受保护分支合并、打 Tag、生产发布仍需 HUMAN 授权；`batch apply` 只写开发集成分支路径（当前实现直接写原树文件，需按项目流程使用）。

---

## 8. 复验轮（修复后，2026-11-02）

- 背景：首轮复核（§1–§7）在冻结 `a4b54b7` 上报告 Q-01/Q-02/Q-03/Q-04；Lead 组织 worker-ownership / worker-evidence / worker-gate 修复。本轮为独立复验。
- 复验对象：叠加在 `a4b54b7` 之上的**未提交修复**（HEAD 未变）。改动文件：`lib/ownership.mjs`、`lib/evidence.mjs`、`lib/gate.mjs`、`lib/permissions.mjs`、`lib/release.mjs`、`lib/batch.mjs`，对应既有测试（ownership-strict / evidence-binding / evidence / gate-status / permissions / batch），文档 `docs/INTERNALS.md`。审查者仍未修改产品代码；按 Lead 定案只修订了 C8 的 1 条过度指定断言（§8.5）并更新本报告。

### 8.1 修复内容核对（读 diff + 实跑，不只看回执）

- **Q-01 FIXED**：`lib/ownership.mjs` 新增 `canonicalPath()`；strict 模式先折叠 `.`/`..`、合并重复 `/`、统一 `\`，再做前缀匹配；前导 `..` 与绝对路径保持不可归属（仍为 unmapped/violation）。loose 模式继续用原 `normalizePath()`，行为不变。
- **Q-02 FIXED**：`lib/evidence.mjs` 新增 `shaKeyOf()`（hex 大小写只用于比较）与 fail-closed 绑定：QA 回执带非空 `manifestSha256` 但扫描集内无对应 manifest → `rejected: unbound-manifest`，不产生 qa/applied 事实；绑定成功时把真实 manifest 传给 `validateQaApproval`（self-review/run 绑定因此真正执行）。
- **Q-04 FIXED**：`looksLikeQaReceipt()` 把含 `verdict`/`reviewer`/`gates` 但缺 `kind` 的回执路由到 QA 拒绝路径 → `rejected: missing-kind`（legacy 逃生门打开时也拒绝，因为这不是 legacy）。
- **Q-03 FIXED**：唯一实现 `gateReportVerdict` 移到 `lib/gate.mjs`；`lib/release.mjs` re-export；`lib/permissions.mjs` 的 `gate-green` 调用同一函数（BOM 容忍读取）；`lib/batch.mjs` 的 permission-denied 分支输出机器可读 JSON（`{...plan, error:"permission-denied", reason, detail}`）。
- **防漂移断言（抽查：真实存在，非口头声称）**：
  - `test/gate-status.test.mjs:297`：`assert.equal(gateReportVerdict, gateVerdict, …)` —— release re-export 与 `lib/gate.mjs` 实现是**同一函数对象**；
  - `test/gate-status.test.mjs:366` “release and the permission gate-green reach the same verdict on every report” —— 同一组 7 个 fixture（legacy ok-only / FAIL+ok / SKIPPED / UNCONFIGURED / ERROR / PASS+ok:false / PASS+ok:true）同时驱动 `release` 与 `evaluatePermission`，并断言二者结论相等；
  - `test/permissions.test.mjs`：gate-green 单测 + `batch apply` 对每种非显式 PASS 报告都拒绝（并断言 `error:"permission-denied"`/`reason:"GATE_NOT_GREEN"`/原树不动）+ 显式 PASS 仍整合；
  - `test/ownership-strict.test.mjs`：`canonicalPath` 单测 + 5 组路径形状负例；
  - `test/evidence-binding.test.mjs`：`unbound-manifest`、`missing-kind`、大小写绑定、legacy 逃生门仍需绑定等用例。

### 8.2 复跑结果

| 检查 | 结果 |
|---|---|
| `node scripts/test.mjs` | **tests 325 / pass 325 / fail 0 / cancelled 0 / skipped 0 / todo 0，exit 0** |
| `node scripts/m0-repro.mjs` | **12/12 PASS，exit 0** |
| `node --test test/qa-m0-adversarial.test.mjs` | **25/25 pass**（A2/C7/C8 由红转绿） |
| 自举 `gate fast --files <14 个修复/测试/文档文件>` | `status: PASS`、`ok: true`，4 步 `ownership/workflow-state/syntax/unit-tests` 全 `passed`，exit 0 |
| 旧 CLI：`state check` / `permit matrix --json` / `ownership verify-config` / `--version` | 全部 exit 0（`--version` = `0.2.0`） |
| 目标修复用例 | A2、C7、C8 全绿；其余 22 条对抗用例保持绿；8 个变异体仍全部被测试抓到（测试未被削弱） |

### 8.3 过度收紧 / 过度放宽复核（独立手跑，不只看 worker 单测）

| 场景 | 结果 | 判定 |
|---|---|---|
| evidence：结构化回执绑定真实 manifest（大写 hex） | `qaApprovals:1`、`rejected:[]`、slice → `awaiting_apply` | 合法路径未被误伤 |
| evidence：同一 hash 的**小写**变体 | `qaApprovals:1`、绑定成功（`docs/INTERNALS.md` 已记录 hex 大小写不敏感） | 合法路径未被误伤 |
| evidence：凭空 hash / 无对应 manifest | `qaApprovals:0`、`rejected:[unbound-manifest]`、slice 保持 `in_progress` | 修复生效 |
| evidence：缺 `kind` 的 QA 形状回执 | `qaApprovals:0`、`rejected:[missing-kind]`、不推进 | 修复生效且不再静默 |
| apply + legacy `{ok:true}` / `{status:"FAIL",ok:true}` / `{status:"PASS",ok:false}` + 合法 QA | **exit 1**、`error:"permission-denied"`、`reason:"GATE_NOT_GREEN"`、**原树未写** | 修复生效 |
| apply + 显式 `{status:"PASS",ok:true}` 报告 + 合法 QA | **exit 0，原树写入** | 未过度收紧 |
| apply dry-run + 合法 QA + PASS 报告 | exit 0、`dryRun:true`、无 permission-denied 噪声 | 未过度收紧 |
| loose ownership + unmapped 路径 | exit 0、`ok:true`（旧行为保持） | 兼容性保持 |
| strict + `misc/x.txt` / `src/../lib/x.ts` | exit 1、`status:FAIL`；`..` 在 violations 中以 canonical `lib/x.ts` 报告 | 修复生效 |
| release + 真 PASS / legacy ok-only | 0 / 1（reason `no status field`），与 permissions 结论一致 | 防漂移成立 |

**结论：未发现过度收紧或过度放宽；合法路径（结构化回执、显式 PASS 报告、loose ownership、apply dry-run、release）全部保持原语义。**

### 8.4 修复引入的新问题扫描

未发现新的 BLOCKER/MAJOR。记录 2 条非阻断观察：

- **N-01 OBSERVATION**：permission-denied 的 JSON 沿用 verify 的 `status`（此时为 `"PASS"`）+ `error:"permission-denied"`。只读 `status` 的消费方可能把“验证通过但权限拒绝”误读为“整合成功”。集成负责人已把 `error` 定为权威字段（`docs/INTERNALS.md` 新增输出契约）；建议 M1 在 API/类型层明确 `status` 与 `error` 的优先级，或把失败计划的 `status` 置为 `FAIL`。
- **N-02 OBSERVATION（迁移提示）**：evidence 现在要求 evidence 目录内存在 manifest 副本才能推导 QA 事实（fail-closed，符合 Q-02 目标）。旧项目若回执完整但 manifest 副本缺失，会得到 `unbound-manifest`；`docs/INTERNALS.md` 已写绑定规则，建议 M1 迁移说明里重申。
- 格式小问题：`docs/INTERNALS.md` 新增段与 `### 4.6` 之间多 1 个空行（纯格式，忽略）。

### 8.5 C8 断言修订（审查方修正过度指定断言，编号 R-01）

- 修订前：`assert.equal(report?.error, "verify-failed")`。该值不是规范要求；Q-03 的规范要求是 **exit 1 + GATE_NOT_GREEN + 原树不动**，三条均已满足。
- Lead 定案（集成负责人输出契约）：`batch apply` 每条失败路径都输出机器可读 JSON，`error` 取值集合为 `{"verify-failed","permission-denied"}`；非绿 gate 属 permission denial，不是 verify failure（verify 本身已 PASS）。
- 修订后 C8 断言：exit 1（保留）、stderr 含 `GATE_NOT_GREEN`（保留）、`error === "permission-denied"`、`reason === "GATE_NOT_GREEN"`、原树不动（保留）。
- 判定：这是**修正审查方对“实现自选标签”的过度指定**，不是降低规范要求；C8 的 3 条规范性断言保持不变。记录为修订项 R-01，不计入缺陷数。依据：①规范结果集不变；②原标签语义错误（门禁未绿不是 verify 失败）；③集成负责人定义的输出契约。

### 8.6 缺陷 / 观察项状态

| 编号 | 原严重度 | 复验状态 | 证据 |
|---|---|---|---|
| Q-01 | MINOR | **FIXED** | A2 转绿；`test/ownership-strict.test.mjs` canonicalPath/形状用例 |
| Q-02 | MAJOR | **FIXED** | C7 转绿；`test/evidence-binding.test.mjs` unbound/大小写绑定用例 |
| Q-03 | MAJOR | **FIXED** | C8 转绿；release↔permissions 同 fixture 防漂移测试 |
| Q-04 | MINOR | **FIXED** | `missing-kind` 拒绝用例 + C6 保持绿 |
| R-01 | 断言修订 | **ACCEPTED** | §8.5 |
| Q-05/Q-06/Q-07/Q-09 | OBSERVATION | **OPEN（不阻塞）** | 语义边界/发布卫生，M0.1/M1 处理 |
| Q-08 | 已知限制 | **OPEN（按计划 M4 收紧）** | PERMISSIONS en/zh 如实记录 |
| N-01/N-02 | OBSERVATION | **OPEN（非阻塞）** | §8.4 |

### 8.7 复验结论

**M0 可以标记完成**，前提与边界：

1. 本结论验证的是 `a4b54b7 + 修复工作树`。Lead 需把修复 commit 成新的冻结 SHA，并在**该提交上**重跑 `node scripts/test.mjs`（期望 325/325）、`node scripts/m0-repro.mjs`（12/12）、`node --test test/qa-m0-adversarial.test.mjs`（25/25）作为最终冻结证据；把新 SHA 与这三个数字写入 `docs/roadmap/m0-status.md`。
2. 本轮独立复验未发现修复引入的新缺陷；Q-01/Q-02/Q-03/Q-04 全部 FIXED；未发现过度收紧（合法回执、显式 PASS、loose ownership、dry-run、release 均正常）。
3. Q-05/Q-06/Q-07/Q-09/N-01/N-02 为不阻塞的观察项；Q-08 仍是文档已声明的 M4 已知限制。
4. §7.2 的“QA PASS ≠ 可生产使用”边界声明不变：本结论不覆盖 M1-M6，真实 DSH/Magpie 运行时仍不可用（MockRuntime），JSON 单写者与 SQLite 迁移未完成。

---

## 附录 A：复跑命令

```bash
# 1) 全量测试（修复工作树：325 tests，325 pass，0 fail，0 skipped，0 todo）
node scripts/test.mjs

# 2) P0 回归门禁
node scripts/m0-repro.mjs

# 3) 只跑本次审查的对抗性测试（修复后 25/25）
node --test test/qa-m0-adversarial.test.mjs

# 4) 自举门禁（仓库自身；修复工作树实跑 PASS）
node bin/atk.mjs gate fast --files lib/ownership.mjs,lib/gate.mjs,lib/evidence.mjs,lib/batch.mjs,lib/release.mjs,lib/permissions.mjs,test/ownership-strict.test.mjs,test/gate-status.test.mjs,test/permissions.test.mjs,test/evidence-binding.test.mjs,test/batch.test.mjs,test/qa-m0-adversarial.test.mjs,docs/INTERNALS.md,docs/architecture/qa-review-m0.md
node bin/atk.mjs state check
node bin/atk.mjs permit matrix --json
node bin/atk.mjs batch --help
node bin/atk.mjs ownership verify-config
node bin/atk.mjs --version

# 5) 依赖/包边界/发布包
node --test test/qa-m0-adversarial.test.mjs   # E2 覆盖依赖与 lib→packages 反向依赖
npm pack --dry-run --json

# 6) 变异测试（临时目录，不碰工作区）
#    见 §4；用 git archive a4b54b7 解包后注入 8 个变异体，全部被测试捕获
```

## 附录 B：对抗测试清单（`test/qa-m0-adversarial.test.mjs`，25 条）

| 用例 | 断言对象 | 当前状态（复验后） |
|---|---|---|
| A1/A3/A5/A6 | strict 绝对路径、空 role、未映射报告一致性、SKIPPED 语义 | 绿 |
| **A2** | strict 下 `..` 路径不得借用前缀（Q-01 回归守卫） | **绿（FIXED）** |
| B1/B2/B3/B4/B5 | 陈旧 PASS 覆盖、`--plan` 不写、release 五值、并行 error+fail、动态 role 不被 shell 执行 | 绿 |
| C1/C2/C3/C4/C5/C6/C9 | 自审、gate SKIPPED、targetRunId 条件绑定、legacy 默认拒绝、大小写 hash、kind 缺失不计入、无 QA apply 拒绝 | 绿 |
| **C7** | evidence 拒绝未绑定 manifest 的 QA Hash（Q-02 回归守卫） | **绿（FIXED）** |
| **C8** | apply 拒绝 legacy ok-only gate 报告（Q-03 回归守卫；`error:"permission-denied"` + `reason:"GATE_NOT_GREEN"`，见 §8.5） | **绿（FIXED）** |
| D1/D2/D3/D4 | PERMISSIONS 已知限制、INTERNALS strict 样例、WORKFLOW 五值表、诊断输出样例 | 绿 |
| E1/E2 | 隐私脱敏、零依赖/无反向依赖 | 绿 |

合计：**25/25 绿**（复验轮；首轮为 22 绿 / 3 红）。
