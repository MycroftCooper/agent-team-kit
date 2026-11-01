# 工作流（中文摘要）

> 英文原文：[WORKFLOW.md](WORKFLOW.md)。

一个任务的完整链路：

```
任务单 -> 候选快照 -> 冻结 -> QA -> verify -> apply -> 证据派生 -> 归档
 LEAD     执行者      执行者   QA    QA    集成人   evidence    LEAD
```

Role 只是权限模板；真正干活的是 `runtime.json` 里的 Agent Instance，一次执行是回执
物化的 Run（manifest = 产出方 WORKER，`qa-approval.json` = 审查方 REVIEWER）。
**不允许自审**：审查派单必须带 `--agent`，`atk batch verify` 会发现审查者就是产出者
并拒绝。详见 [ENTITIES.zh-CN.md](ENTITIES.zh-CN.md)。

## 各步要点

1. **开批次（LEAD）**：`state.json` 记录一个批次（id / 目标 / 停机条件 / 切片）。
   切片是 QA 验收与 Apply 的最小单位。
2. **任务单（LEAD）**：`atk task <ID> --for <ROLE> --message` 生成 9 行任务单，
   一条消息转发。任务单只写本次，背景留在 state.json。派单会做 `task.claim` 权限判定，
   不匹配时带原因码拒绝（见 [PERMISSIONS.zh-CN.md](PERMISSIONS.zh-CN.md)）。
3. **候选（执行者）**：在原树之外建候选快照，原树对 agent 只读；一个切片同时只有
   一个候选。
4. **门禁（执行者）**：`atk select-tests --files ...` 出计划，
   `atk gate fast --files ... --role ...` 跑快速门禁。门禁只有五种状态，且
   `ok` 恒等于 `status === "PASS"`：

   | 状态 | 含义 | 退出码 | 算通过？ |
   |---|---|---|---|
   | `PASS` | 至少跑了一个步骤且全部退出 0 | `0` | 是 |
   | `FAIL` | 有步骤执行但非 0 退出 | `1` | 否 |
   | `SKIPPED` | 有配置但没有步骤适用于本次变更 | `0` | **否**——什么都没验证 |
   | `UNCONFIGURED` | 配置为空 | `2` | **否**——配置错误 |
   | `ERROR` | 步骤无法启动 / 异常退出 | `2` | **否** |

   报告写入 `<artifactDir>/ci-fast-latest.json`，每次运行都会覆盖，旧 PASS 不会残留；
   `atk release` 只接受 `status` 恰好为 `PASS` 的报告，旧式只有 `ok: true` 的报告会被拒。
5. **冻结（执行者）**：`atk batch manifest --candidate ... --paths ... --packages <ID> --agent <实例 id>`
   产出清单与 `manifestSha256`，并记录产出方 Run；没有 `--agent` 的 manifest 过不了 QA
   审查。冻结后不得再改候选。
6. **QA**：审查派单必须带审查实例（`atk task <ID> --for QA --agent <id>`）；只验冻结
   快照；`atk batch verify` 机械核对、语义检查人工判断。QA 写结构化签名回执：

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

   判定：`verdict === "PASS"`、`manifestSha256` 非空且等于冻结值、`reviewer.function`
   为 `REVIEWER` 且 `run` / `agent` 非空、`reviewer.agent` 不是产出者或 contributor、
   `targetRunId` 与 `manifest.run.id` 一致（双方都有时）、声明的 `gates` 全部 `PASS`。
   hash / 候选字节 / commit 一变旧批准即失效；旧式只自报 `passed: true` 的回执默认被拒，
   显式逃生门为 `batch.legacyReceipts: true` 或 `--legacy-receipts`。
7. **apply（唯一集成人）**：先 `atk batch verify --require-qa --manifest <f> --qa <f>`
   （受控集成，必须 PASS）；再 `atk batch apply --manifest <f> --qa <f>` 看 dry-run 计划，
   最后 `atk batch apply --manifest <f> --qa <f> --apply --confirm-dev-closed` 真写。
   每次 `atk batch apply`（含 dry-run）都必须提供合法 QA 回执，缺失时会打印计划但
   `status: FAIL`、给出原因并退出 `1`，原树不动。不带 `--qa` 的 `verify` 只是只读诊断
   （`status: SKIPPED`，绝不打印 PASS）。漂移即停，退出码 3。真实写入还会按
   `integration.merge.development` 判定：必须有绑定 manifest 的 QA 证据，配置了
   quick/local 门禁时还要真实的绿报告（回执里自报的 gate 不算门禁报告）。
8. **证据派生（LEAD）**：`atk evidence` 从回执派生 `qaPassed` / `applied`，
   幂等；`humanAccepted`、`blocked`、`paused` 只能由 LEAD 手写。无效或旧式回执不会被
   静默忽略：计入报告 `rejected` 并在 stderr 打印原因；旧式 `passed: true` 回执默认被拒，
   显式逃生门是 `batch.legacyReceipts: true` 或 `atk evidence --legacy-receipts`。
9. **验收与归档**：人工验收后 LEAD 写 `humanAccepted: true`，再
   `atk state archive <ID> --note "理由"`；未人验会被拒绝。`atk state restore` 撤销归档。

## 证据阶梯

| 层级 | 能证明 | 不能证明 |
|---|---|---|
| typecheck / 编译 | 类型与语法一致 | 测试被执行 |
| 单元 / 集成测试 | 被测行为成立 | 产品原生行为 |
| QA 冻结快照 | 冻结字节满足任务单 | 人工接受 |
| 人工验收 | 产品被接受 | — |

每一级分开写：mock 不是原生，单项通过不是联合通过，`unknown` 不是成功。

## 轮次预算

默认单任务 ≤12 轮（QA 切片 ≤10 轮）。超预算就停笔报告：应该拆任务，不是加班。
执行者交 6 行回执（范围 / 命令 / 测试 / 阻碍 / 快照 / 停笔）；LEAD 给用户 ≤5 行。

## 人类待办

`human-todos.json` 只记录"只能人做"的事（确认 dev 已关闭、验收、轮换凭据、异机
实测）。agent 可以读、可以加，**不能勾**；没有任何命令会自动勾选。

## 退出码

`0` 成功；`1` 检查/门禁失败或安全拒绝；`2` 用法/配置错误；`3` 并发/漂移拒绝。
拿不准时停笔报告——带诚实回执的"停"比带假证据的"合"便宜。
