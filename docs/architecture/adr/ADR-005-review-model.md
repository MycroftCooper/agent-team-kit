# ADR-005：审核模型——Function 与 Role 分离，Review 绑定具体冻结版本

- 状态：**Proposed**
- 日期：2026-11-02
- 决策者：ARCH
- 关联：规范 §5.1、§5.2、§10.1、§10.2；ATK-004、ATK-401、ATK-402

## 背景

v0.2.0 已有基本分离：`Role`（FE/BE/QA）与 `Function`（ORCHESTRATOR/WORKER/REVIEWER）是两套概念，`lib/functions.mjs` 已实现 `reviewerChecks`（生产者/审查者身份、Function 匹配、自审拒绝、注册表校验）。`atk evidence` 也拒绝有明显自审的回执。

但审计发现两处不足（见 `current-state.md` P0-4）：

1. `atk evidence` 用 `classify()` 凭 `passed: true` / `noninteractiveQA: "passed"` 判定 QA 回执，**不看签发结构**，一个自报布尔即可把 slice 推进到 `awaiting_apply`；
2. QA 审核没有强绑定 `commitSha` / `manifestHash` / `policyVersion` / 实际 Gate 结果，审核对象是“某个候选”而不是“某个冻结版本”。

## 决策

1. **Role 与 Function 保持正交**：一个 `QA` Role 的 Agent Instance 以 `REVIEWER` Function 运行；同一 DSH Runtime 可以分别以 `WORKER+FE`、`WORKER+BE`、`REVIEWER+QA` 运行。不引入“只有某个模型才能审”的规则——独立性按**实际作者链**判定，不按模型名称。
2. **QA 回执必须是结构化签发记录**，`passed: true` 单独不成立。最小结构：
   ```jsonc
   {
     "schemaVersion": 1,
     "kind": "qa-approval",
     "manifestSha256": "<冻结 manifest 的 hash>",
     "verdict": "PASS",                       // 只有 PASS 才算通过
     "reviewer": { "run": "...", "agent": "...", "role": "QA", "function": "REVIEWER" },
     "targetRunId": "<被审查的 Run>",
     "policyVersion": "<评审所依据的策略版本>",
     "gates": [ { "name": "unit-tests", "status": "PASS", "reportSha256": "..." } ]
   }
   ```
3. **判定规则（全部满足才算 QA 事实）**：`verdict === "PASS"`；`manifestSha256` 与当前冻结 manifest 一致；`reviewer.function === "REVIEWER"`；`reviewer.run` 与 `reviewer.agent` 均非空且已在 `runtime.json` 注册；`reviewer.agent !== manifest.run.agent`（不得自审）；`targetRunId` 与 `manifest.run.id` 一致；声明的每个 gate 都是 `PASS`。
4. **候选一变，旧审核立即失效**：任何 diff 变化都会改变 `manifestSha256`，旧 QA 回执自动不再绑定，必须重新审查。不做“diff 很小就沿用”的优化。
5. **Gate 状态五值**：`PASS / FAIL / SKIPPED / UNCONFIGURED / ERROR`，只有真实 `PASS` 满足强制质量条件；`SKIPPED` 与 `UNCONFIGURED` 不得被当作通过（与 ATK-003 一致）。
6. **`batch verify` 与 `batch apply` 区分模式**：只读诊断可以不传 QA，但必须标 `status: SKIPPED` + `diagnosticOnly: true`；受控集成（`apply` 任何形态、`verify --require-qa`）缺合法 QA 直接失败。
7. **人工验收独立于 QA**：`QA PASS ≠ HUMAN APPROVED`。`Approval` 记录 `actor=HUMAN` 与 `targetHash`，换版即失效。
8. **自审不可绕过**：`enforceNoSelfReview:false` 仅作为“尚未采纳身份模型”的显式逃生门，默认开启，且启用时 UI/回执必须标注降级。

## 理由

- 三条事实链（作者、审查者、集成者）都由不可伪造的 hash/identity 串起来，才能让“完成”可审计。
- 结构化回执比布尔字段多出的成本很低，但把“伪造一条回执”的门槛从“写个 JSON”提高到“必须同时伪造 manifest、Run 身份、Gate 报告且不自审”。

## 后果

**正面**：P0-4 的污染路径被切断；任何缺失测试/伪回执/自审/失效 Hash 都无法进入“已通过集成”或“人工验收”状态（对应 M4 门禁）。

**负面 / 代价**：旧回执默认失效，需要迁移或显式 `--legacy-receipts`；QA 流程要输出更多字段；返工后必须重审，不能省步骤。

**缓解**：提供 `batch.legacyReceipts` 显式兼容开关并把拒绝原因写进报告；模板与 Skill 更新回执格式；`atk batch verify` 的输出直接列出每条不合格原因。

## 替代方案

| 方案 | 为什么否决 |
|---|---|
| 继续用 `passed: true` | 已实测可伪造并推进状态机（P0-4），等于没有审核 |
| 按模型名称判定独立性 | 同一模型可实例化多个 Agent；作者链才是事实 |
| 审核绑定 task 而非冻结版本 | 候选变化后无法判定“审的是哪一版”，会出现审旧版放新代码 |

## 兼容与迁移

M0 落地结构与判定（ATK-004）；M4 补 `ReviewAttempt` / `review_findings` 表与返工上限（ATK-401/403）。旧回执在迁移期按 `legacyReceipts` 开关处理，并在报告里标注。

## 回滚

判定逻辑集中在 `lib/evidence.mjs` 的单一导出（结构定义 + 校验函数），可整体回滚到 JSON 布尔语义；但回滚即恢复 P0-4 风险，必须同时在文档中标注为已知不安全。
