# 工作流（中文摘要）

> 英文原文：[WORKFLOW.md](WORKFLOW.md)。

一个任务的完整链路：

```
任务单 -> 候选快照 -> 冻结 -> QA -> verify -> apply -> 证据派生 -> 归档
 LEAD     执行者      执行者   QA    QA    集成人   evidence    LEAD
```

## 各步要点

1. **开批次（LEAD）**：`state.json` 记录一个批次（id / 目标 / 停机条件 / 切片）。
   切片是 QA 验收与 Apply 的最小单位。
2. **任务单（LEAD）**：`atk task <ID> --for <ROLE> --message` 生成 9 行任务单，
   一条消息转发。任务单只写本次，背景留在 state.json。
3. **候选（执行者）**：在原树之外建候选快照，原树对 agent 只读；一个切片同时只有
   一个候选。
4. **门禁（执行者）**：`atk select-tests --files ...` 出计划，
   `atk gate fast --files ... --role ...` 跑快速门禁；`skipped` 不算通过。
5. **冻结（执行者）**：`atk batch manifest --candidate ... --paths ... --packages <ID>`
   产出清单与 `manifestSha256`；冻结后不得再改候选。
6. **QA**：只验冻结快照；`atk batch verify` 机械核对，语义检查人工判断；写
   `qa-approval.json` 绑定当前 hash。hash 变了旧批准自动作废。
7. **apply（唯一集成人）**：先 `atk batch verify`（必须 PASS），再 dry-run，最后
   `atk batch apply --apply --confirm-dev-closed`。漂移即停，退出码 3。
8. **证据派生（LEAD）**：`atk evidence` 从回执派生 `qaPassed` / `applied`，
   幂等；`humanAccepted`、`blocked`、`paused` 只能由 LEAD 手写。
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
