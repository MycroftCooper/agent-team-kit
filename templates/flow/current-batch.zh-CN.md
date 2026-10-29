# 当前批次（滚动维护，≤60 行）

> 历史在归档里；本文件只放"现在"。状态真值仍是 `state.json`，渲染看
> `atk state board`。每批开始时覆盖本页。

## 批次

- **ID**：`{{BATCH_ID}}`
- **目标**：一句话，由 LEAD 写。
- **停机条件**：满足什么条件本批结束。
- **不包含**：明确推迟到后续批次的工作。

## 进度

切片状态不在这里手写：以 `state.json`（`batch.slices`）或 `atk state board` 为准。
回执落盘后跑 `atk evidence` 自动派生 `qaPassed` / `applied`。

## 本批滚动决议（最新在上，>10 条移入归档）

1. {{DATE}} —— `atk init` 初始化工作流；角色合同与写域生效。
2. {{DATE}} —— LEAD 维护 `state.json`、`runtime.json` 与人类待办；agent 只建议，
   由 LEAD 落账。

## 待用户决定

1. 确认批次目标与停机条件。
2. 确认 Apply 前没有在途操作会被覆盖。

## 每批收尾记 4 个数（`atk measure record`）

入场读取行数、角色轮次、门禁耗时、freeze → QA 间隔。
