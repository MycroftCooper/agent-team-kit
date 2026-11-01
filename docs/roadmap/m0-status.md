# M0 / v0.3 交付回执与 M1 准入结论

- 文档类型：里程碑交付回执（规范 §14 M0、§16.2 强制回执、§19 DoD）
- 日期：2026-11-02
- 分支：`m0/baseline-and-p0`
- 基线 commit（起点）：`aec31b6f95faa30b9e0cfcaf2d6235f59c94f780`（`main`，工作区干净）
- **最终冻结 commit：`a75026c93d9a2c4a46e31f430147f97a0a8ab887`**
- 执行者：Lead(ARCH) + `worker-ownership` + `worker-gate` + `worker-evidence` + `worker-runtime-spike` + `qa-reviewer`（身份隔离，见第 6 节）
- 关联：[current-state.md](../architecture/current-state.md)、[ADR-001~008](../architecture/adr/)、[runtime-spike-dsh-magpie.md](../architecture/runtime-spike-dsh-magpie.md)、[qa-review-m0.md](../architecture/qa-review-m0.md)

> **状态：M0 门禁通过，QA 独立复核结论为"可以标记完成"。** 四类 P0 风险全部修复并由机器可复现门禁锁定；测试从 202 增加到 **325 全绿**；QA 在首轮冻结后发现的 2 个 MAJOR + 2 个 MINOR fail-open 缺陷已修复并复验。真实 DSH 适配器仍**不可**标记"可用"，M2 继续停在 MockRuntime。M1 已获用户批准并开始（见第 7 节）。

---

## 1. 强制交付回执（规范 §16.2 格式）

```text
Task: ATK-001 ~ ATK-006 (M0 / v0.3) + QA-001
Source: branch m0/baseline-and-p0, commit a75026c93d9a2c4a46e31f430147f97a0a8ab887
Changed: 第一冻结 43 files +2175/-419 与 51 新路径；QA 修复轮新增 7 个 lib 修复 + 7 个测试文件 + INTERNALS 契约补充
Build: node --check（逐个改动 .mjs）exit 0 | npm pack --dry-run exit 0 | NOT_RUN: TypeScript 构建（M1 引入）
Tests: node scripts/test.mjs        -> tests 325 / pass 325 / fail 0 / skipped 0 / todo 0 / exit 0
       node scripts/m0-repro.mjs    -> 12/12 P0 checks passed / exit 0
       node --test test/qa-m0-adversarial.test.mjs -> 25/25 pass / exit 0
       npm test (cmd) 325/325 exit 0 | npm run plugin:selftest 30/30 exit 0
Contracts: agent-flow.config.json + ownership.mode（schema 同步）; gate 报告 + status（schemaVersion 1 保留）;
           verifyManifest + status/diagnosticOnly/rejected; qa-approval 结构化（2.0 新契约）;
           atk evidence rejected 字段形状变化 + 新 reason（unbound-manifest / missing-kind）;
           atk batch apply 失败 JSON：error ∈ {verify-failed, permission-denied}
Security: 四条"看起来成功其实没做"的路径关闭（ownership/gate/QA 回执/Hash 绑定）; 12 条 P0 门禁 + 25 条对抗用例
Evidence: 本文件 + docs/architecture/{current-state,adr/*,runtime-spike-dsh-magpie,qa-review-m0,spike-evidence/**}
Blockers: RT-P07 / RT-P08 / canRunRestricted / canSpecifySessionModel 未验证（第 8 节）
Next: M1 已开始（用户批准）；M2 需先补 Runtime 证据集
```

---

## 2. 工作包状态

| 条目 | 内容 | 交付物 | 验证结果 |
|---|---|---|---|
| ATK-001 | 仓库梳理/基线与测试报告 | [current-state.md](../architecture/current-state.md) | 基线 SHA/版本/202 项测试已记录；P0 风险逐条实测复现 |
| ATK-002 | ownership 严格模式 | `lib/ownership.mjs`、`test/ownership-strict.test.mjs`(22) | strict：缺 Role→2、未知 Role→2、unmapped→1、空清单 SKIPPED；loose 21 场景逐字节等价 |
| ATK-002b | `ownership.mode` 契约补齐 | schema、`lib/config.mjs`、`test/config.test.mjs`(+4) | 非法 mode 抛 ConfigError；schema 与运行时一致 |
| ATK-003 | Gate 五值状态模型 | `lib/gate.mjs`、`test/gate-status.test.mjs`(15+) | `ok === (status==="PASS")`；UNCONFIGURED/ERROR→2、SKIPPED→0 且不称通过 |
| ATK-003b | dispatch `--version` + release BOM | `lib/dispatch.mjs`、`lib/release.mjs` | `atk release --version 0.2.0` 不再被全局拦截；BOM 报告正常识别 |
| ATK-004 | QA 回执结构化与证据绑定 | `lib/evidence.mjs`、`lib/batch.mjs`、`lib/permissions.mjs` | 伪回执/自审/坏 Hash/坏 Run/坏 Gate/未绑定 Hash 全部显式拒绝 |
| ATK-005 | ADR + contracts 初版 | `docs/architecture/adr/ADR-001..008`、`packages/contracts/**`、`test/contracts.test.mjs`(18) | 零依赖 ESM，契约测试 18/18 |
| ATK-005b/c | 文档与脚手架同步 | 5 英文 + 4 中文文档、`templates/flow/**`、skill、2 条模板守卫测试 | 三种 init 变体实跑校验 |
| ATK-006 | DSH+Magpie Runtime Spike | [runtime-spike-dsh-magpie.md](../architecture/runtime-spike-dsh-magpie.md) + 43 个脱敏证据 | Phase1 只读 + Phase2 隔离 mock 真机 ACP；生产结论=不可用 |
| QA-001 | 独立复核（两轮） | [qa-review-m0.md](../architecture/qa-review-m0.md)、`test/qa-m0-adversarial.test.mjs`(25) | 首轮 2 MAJOR + 2 MINOR；复验全部 FIXED，结论=M0 可标记完成 |

---

## 3. M0 门禁逐条核对（规范 §14）

| 门禁 | 要求 | 结果 |
|---|---|---|
| 原测试套件全通过 | 202 项基线不得减少或转红 | ✅ 202 → **325**，fail 0，skipped 0（旧断言仅 6 条因 P0 行为变更按规范更正，逐条记录并由 QA 复核） |
| 所有新增 P0 负面用例通过 | 四类风险各有可复现负面用例 | ✅ `m0-repro` 12/12 + 6 个新测试文件 + QA 25 条对抗用例 |
| 旧 CLI 不破坏 | 命令/别名/退出码保持 | ✅ `state check`/`permit matrix`/`batch --help`/`ownership verify-config`/`--version` 全通过；自举 `atk gate fast` 实跑 PASS |
| Runtime Spike 有真实命令/版本/结果 | 不许只凭 README 推断 | ✅ 真实 `dsh 0.2.1-rc.5`、ACP 协议帧、G1/G2/G3 门禁证据；未验证项全部 `UNVERIFIED` |

**结论：M0 门禁通过。**

---

## 4. 四类 P0 风险：修复前 → 修复后

| # | 修复前（[current-state.md](../architecture/current-state.md) §6 实测） | 修复后（`scripts/m0-repro.mjs` 断言） |
|---|---|---|
| P0-1 ownership | 未映射路径与缺失 Role 均 exit 0 | strict：缺 Role→**2**、未知 Role→**2**、unmapped→**1**（含 `..` 借道、绝对路径）；loose 保持旧行为 |
| P0-2 gate | 空配置/无适用步骤 exit 0 且 `ok:true` | 空配置→**UNCONFIGURED+2**；无适用步骤→**SKIPPED（ok=false）+0**；spawn 失败→**ERROR+2** |
| P0-3 batch verify | 不传 QA 也打印 `PASS` | 无 `--qa`→**SKIPPED+diagnosticOnly**（无 PASS）；`apply` 任何形态缺合法 QA→**1** |
| P0-4 evidence | 伪造 `{passed:true}` 推进 slice | 计入 `rejected`（`legacy-receipt`/`missing-kind`/`unbound-manifest`），slice 不推进 |

复跑方式：

```bash
node scripts/test.mjs        # 325 tests / 325 pass / 0 fail
node scripts/m0-repro.mjs    # 12/12 P0 regression checks
node --test test/qa-m0-adversarial.test.mjs   # 25/25 adversarial cases
```

---

## 5. 安全与边界核对

| 项 | 结论 |
|---|---|
| 用户 DSH/Magpie 配置 | **零改动**：Phase 1 24/24、Phase 2 23/23 CONFIG 文件 SHA-256 前后一致 |
| 真实模型请求 | **零**：Phase 2 的 4 次请求全部到 `127.0.0.1:6168` 本地 mock；无 3425、无外网 |
| 生产流量 | **零**：隔离 `DSH_HOME`；未触碰 desktop 会话与真实 Magpie 转发 |
| 凭据 | 未复制任何 API Key；凭据文件仅算 hash |
| 隐私 | 证据已脱敏；全目录 grep 用户名/真实主目录命中 **0** |
| 自动调度宣称 | **未宣称**可用于真实项目；`runtime-dsh` 仍实验性 |

---

## 6. 身份隔离与独立审查（规范 §0 第 5 条）

- 实施：4 个 Worker 与 Lead 持有互不重叠的文件写域；跨域改动仅 4 处，均由 Lead 事先书面批准并记录：`lib/permissions.mjs`（2 个 condition）、`lib/dispatch.mjs`、`lib/batch.mjs`、`docs/CONFIG.md`。
- 审查：`qa-reviewer` 在代码冻结后以独立身份复核，未参与任何产品代码编写；两轮审查结论见 [qa-review-m0.md](../architecture/qa-review-m0.md)。
- 首轮冻结后的 4 个缺陷全部由 QA 发现（而非作者自证），修复后由 QA 复验关闭；未发现过度收紧。

---

## 7. M1 准入结论

**允许开始 M1（已获用户批准并已开工）。** 依据：M0 四项门禁通过、P0 风险有机器可复现门禁、ADR-001~009 与 contracts 初版就位、旧 CLI 未破坏。

**M1 必须先做或必须先由用户拍板的事项：**

| 事项 | 类型 | 说明 |
|---|---|---|
| JSON → SQLite 迁移方案与备份/回滚演练（ATK-105） | 硬依赖 | 规范 §13 三阶段；切换唯一事实来源前必须完成 |
| `packages/contracts` 接入 workspace + OpenAPI | 计划内 | ATK-101/103 |
| `atk evidence` 的 `rejected` 字段形状变化 | 契约影响 | API 化时一次性迁移消费方 |
| `atk permit check` 仍接受 legacy QA 标志 | 已知限制 | 权威校验在 batch verify/apply；M4 随 policyVersion 收紧 |
| `docs/architecture`（约 263 KB）会进 npm tarball | 发布卫生 | 下次正式发布前评估排除（当前 144 files / 约 1.0 MB） |
| M2 真机适配 | 外部依赖 | RT-P07/P08/受限执行/会话级模型未验证，M2 默认 MockRuntime |

---

## 8. 遗留风险与未验证清单

| # | 未验证/风险 | 影响 | 解除条件 |
|---|---|---|---|
| 1 | RT-P07 真实 Magpie 路由未验证 | 无法证明请求确经用户网关 | 受控真实请求或隔离 Magpie 实例 |
| 2 | RT-P08 多 Agent 并行未验证 | 无法证明会话/工作区互不覆盖 | 隔离 home + mock 并行 2~3 会话 |
| 3 | `canRunRestricted`/`canSpecifySessionModel` 仅 PARTIAL | 受限执行与模型选择不能承诺 | mock 会话 + 受控命令/model 条目 |
| 4 | `canStop` 的"不误判完成"未单独核对 | 停止后是否误报完成 | 负面用例 |
| 5 | 调度/租约/generation fencing 未实现 | 多进程并发无保障 | M3 |
| 6 | JSON 仍是唯一事实来源 | 多写者会互相覆盖 | M1/ATK-104/105 切换 SQLite |
| 7 | `permit check` 的 review-evidence 接受 legacy | 诊断工具比权威校验宽松 | M4 |
| 8 | QA 观察项 Q-05（ignored-only 报 PASS）、Q-06（显式空 `--files` 回退 git 发现）、Q-09（发布包含审计文档） | 均为不阻断的语义观察/发布卫生 | M1 期间处理 Q-09；Q-05/Q-06 在 M4 状态机化时统一 |
| 9 | N-02：`atk evidence` 现在要求证据目录内有 manifest 副本才推导事实（fail-closed） | 迁移/历史项目需先把 manifest 复制到证据目录 | ATK-105 迁移工具负责补齐 |

---

## 9. 回滚方式（规范 §0 第 9 条）

| commit | 范围 | 回滚影响 |
|---|---|---|
| `a12fc6f` | M0 审计 + ADR + contracts 草案 + P0 门禁脚本 | 纯文档/新目录，无运行时影响 |
| `1e7bed0` | ownership 严格模式 + 配置 schema | 恢复"unmapped 不阻断"，P0-1 复现 |
| `fe83df2` | gate 五值 + dispatch/release 修复 | 恢复"空配置 exit 0"，P0-2 复现 |
| `0c21aaa` | QA 回执结构与证据绑定 | 恢复 P0-4 状态机污染路径，**不建议** |
| `3707d02` | 文档与脚手架同步 | 纯文档 |
| `a4b54b7` | Runtime Spike 报告与证据 | 纯文档 |
| `a75026c` | QA 缺陷修复（Q-01~Q-04） | 恢复 Q-02/Q-03 两个 fail-open，**不建议** |

数据库/用户配置层面无需回滚：本轮未写任何用户 DSH/Magpie 配置。

---

## 10. 证据索引

| 内容 | 位置 |
|---|---|
| 现状审计与 P0 复现 | [current-state.md](../architecture/current-state.md) |
| 决策记录 | [adr/](../architecture/adr/)（ADR-001~008；M1 追加 ADR-009） |
| 契约草案 | [packages/contracts/](../../packages/contracts/README.md) |
| P0 回归门禁 | [scripts/m0-repro.mjs](../../scripts/m0-repro.mjs) |
| Runtime Spike | [runtime-spike-dsh-magpie.md](../architecture/runtime-spike-dsh-magpie.md)、[spike-evidence/](../architecture/spike-evidence/) |
| QA 独立复核（含复验轮） | [qa-review-m0.md](../architecture/qa-review-m0.md) |
| 变更日志 | [CHANGELOG.md](../../CHANGELOG.md) |
