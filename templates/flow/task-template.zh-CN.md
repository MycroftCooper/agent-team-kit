# 任务单模板（≤200 字，固定 9 行）

> 任务单由命令生成，不需要手写：
> `atk task <ID> --for <ROLE> --message`
> 直接输出下面同格式、可直接转发的任务单。本页用于人工补写与格式说明。

## 模板

```
任务 <ID> | <bug|feature|refactor> | <P0|P1|P2> | <模块>
范围 <一句话：这次要改什么>
写域 <具体路径或 glob；跨角色写 "FE:... / BE:...">
依赖 <任务 ID 或"无"；写"无"表示可以立刻开工>
退出 <可判定的完成条件 + 必须跑过的命令>
禁做 <本片特别禁止的事；通用禁区在角色卡里>
门禁 <本片要跑的命令，例如 atk gate fast --files ... --role {{ROLE}}>
证据 <manifest / 回执 / QA json 路径>
预算 <N> 轮；超限停笔报告
```

## 填写规则

1. **只写本次**。背景与历史留在 `state.json` 的 `note` / `evidence` 里。
2. **退出条件必须可执行**：写"`atk gate fast` 通过 + 新增 2 个测试"，不写"完成适配"。
3. **禁做只写增量**：生产访问、真实工具、打包发布等通用禁区已在角色合同里。
4. 一行一件事，不用小标题、表格或截图。

## 为什么有上限

任务单超过 200 字说明任务没拆干净。应拆任务，而不是加背景——执行者只读任务单、
自己的角色卡和队列。

## 示例

```
任务 UI-42 | feature | P1 | 设置 / 主题
范围 在设置 reducer 中加入深色主题覆盖，不接 UI 入口
写域 src/settings/** 及相邻 *.test.ts
依赖 无
退出 reducer 返回覆盖值；新增 2 个测试；atk gate fast --files src/settings/theme.ts --role DEV 通过
禁做 不改 src/settings/index.tsx；不新增 IPC
门禁 atk gate fast --files src/settings/theme.ts --role DEV
证据 artifacts/evidence/UI-42/manifest.json
预算 8 轮
```
