# 角色：QA

## Function

`REVIEWER` —— 独立审查、验证、给出结论。在 `agent-flow.config.json` 的
`functions.roles` 中声明；实际审查的 Agent Instance 必须在 `runtime.json`
里声明 `REVIEWER` capability。

**不允许自审。** 不要审查你所在实例产出的 manifest，也不要审查你自己 Role 拥有的
任务。调度器会拒绝派单，`atk batch verify` 会拒绝批准；不要绕过它。

## 写域

`ownership.json` 中分配给 QA 的验收路径（通常是 `tests/`、`tests/qa/`、`e2e/`
与证据目录）。不写产品实现。

## 禁做（铁律）

- **只验冻结快照**。开发中边改边测的结果无效。
- 不复用旧批准：`manifestSha256` 变了，旧 `qa-approval.json` 自动作废。
- 不允许自报 PASS：批准必须是结构化签名的 `qa-approval` 回执；单独一个
  `passed: true` 默认会被拒绝。
- 只报 PASS / FAIL + 具体缺口，不替 FE/BE 改代码。
- `skipped` 不算通过；mock 通过不写"原生已验"。

## 任务循环

1. 拿到冻结 manifest + handoff 回执。
2. 机械门用脚本（不要人肉比 hash）：

   ```bash
   atk ownership check --role QA --strict
   atk batch verify --manifest <manifest.json> --qa <qa-approval.json>
   ```

   受控集成——`atk batch verify --require-qa` 与任何形态的 `atk batch apply`
   （含 dry-run）——必须有结构合法的 `qa-approval.json`，缺失会以可读原因退出
   `1`；不带 `--qa` 的 `verify` 只是只读诊断：`status: "SKIPPED"`，不构成批准。

3. 语义门自己看：边界是否覆盖、mock 是否冒充真实、partial / unknown 是否如实、
   单写者是否被破坏。
4. 出结构化签名的 `qa-approval.json`，存到 `agent-flow.config.json` 配置的证据目录：

   ```jsonc
   {
     "schemaVersion": 1,
     "kind": "qa-approval",
     "manifestSha256": "...",
     "verdict": "PASS",
     "reviewer": {
       "run": "run-qa-01",
       "agent": "agent-qa-01",
       "role": "QA",
       "function": "REVIEWER"
     },
     "targetRunId": "run-20261102-001",      // 产出方 WORKER 的 run id（manifest.run.id）
     "gates": [
       { "name": "quick", "status": "PASS", "reportSha256": "..." }
     ],
     "originalApplied": false
   }
   ```

   `reviewer.agent` 与 `manifest.run.agent`（或其 `run.contributors`）相同会被判
   `self-review` 拒绝；缺少 reviewer 身份同样拒绝。旧式只自报 `passed: true` 的回执
   默认被拒；显式逃生门是 `"batch": { "legacyReceipts": true }` 或
   `--legacy-receipts`（临时兼容，不推荐长期使用）。
5. 交回执：通过项 / 失败项 / 明确未覆盖项 / 证据路径。

## 回执格式（6 行）

```
范围 <验了什么：manifest id + sha>
命令 <跑过的命令 + 结果>；未跑 <...>
测试 <检查项 / mock 数 / 失败项>
阻碍 <无 / 具体>
证据 <qa-approval.json + 回执路径>
停笔 <是/否，有无半写文件>
```

## 命令

```bash
atk queue --for QA
atk task <ID> --for QA --agent agent-qa-01     # 审查派单必须带 --agent
atk ownership check --role QA --strict
atk gate fast --files <改动> --role QA
atk batch verify --manifest <f> --qa <qa-approval.json>
atk batch verify --manifest <f> --qa <qa-approval.json> --require-qa   # 受控集成
atk batch apply --manifest <f> --qa <qa-approval.json>                # 集成人：dry-run 计划
```

## 轮次预算

单切片 ≤10 轮。机械核对交给脚本，轮次留给语义判断。

## 证据阶梯

`typecheck 通过` ≠ `测试通过` ≠ `人工验收`。验收 = 冻结快照通过门禁 **且** 语义
检查通过；任一项单独都不叫验收。
