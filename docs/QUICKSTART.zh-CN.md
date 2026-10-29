# 快速开始（中文摘要）

> 英文原文：[QUICKSTART.md](QUICKSTART.md)。

## 环境要求

- Node.js **>= 20.11**；**零第三方依赖**，只用 Node 内置模块。
- 一个项目目录（git 可选；工作流不依赖提交历史）。
- 可选：DeepSeek Harness，用于侧栏看板面板。

## 60 秒

```bash
npm install --global agent-team-kit     # 或用 npx / 源码里的 node bin/atk.mjs
cd my-project
atk init --project my-app
atk board            # 生成 <flowDir>/board.html
atk state check      # 校验 state.json
```

`atk init` 默认写入 `generic` 预设；已有 `agent-flow.config.json` 时拒绝覆盖，需
`--force`。但 `--force` 会重写**所有**生成的流程文件（含 `state.json`、
`ownership.json`、看板与全部角色卡），只适用于重新脚手架，不要用来改一个正在用的
项目（改角色见 [`agent-team-roles`](../skills/agent-team-roles/SKILL.md) skill）。
先预览：

```bash
atk init --project my-app --dry-run
atk init --project my-app --json
atk init --project my-app --no-plugin    # 不复制 DSH 看板插件
```

常用参数：`--preset generic|p4deck`、`--roles LEAD,DEV,QA`、
`--language en|zh-CN`、`--flow-dir <目录>`。

## 生成内容

```
agent-flow.config.json      项目配置
.agent-flow/
  state.json                唯一真值：批次 / 切片 / 工作包
  ownership.json            路径前缀 → 角色
  human-todos.json          只有人能做的待办
  runtime.json              谁在忙什么
  task-template.md          9 行任务单模板
  commands.md               命令速查
  current-batch.md          当前批次滚动记录
  board.md                  看板（由 atk 重新生成）
  roles/<ROLE>.md           每个角色的合同
  README.md                 agent 的入口页
tools/agent-board/          DSH 看板插件副本（--no-plugin 时跳过）
```

## 第一批任务

1. 编辑 `.agent-flow/state.json`：写 `batch.goal`、`batch.stopCondition`，可先
   不加切片。
2. `atk board` 或 `atk serve`（默认 `http://127.0.0.1:1421`）查看看板。
3. agent 取任务：

   ```bash
   atk queue --for DEV
   atk task <ID> --for DEV --message
   ```

4. 跑门禁并派生状态：

   ```bash
   atk gate fast --files <改动> --role DEV
   atk evidence
   atk board
   ```

## 安装 agent skills

把 `skills/agent-team-flow`、`skills/agent-team-board` 与 `skills/agent-team-roles`
复制或软链到 agent 宿主的技能目录，详见 [../skills/README.md](../skills/README.md)。

## 安装 DSH 面板（可选）

`atk init` 已复制插件（除非 `--no-plugin`）。在 DSH 中：**Plugins → Add plugin →
Install a third-party plugin**，粘贴插件目录绝对路径，启用，把
`cordis.patch.yml` 的 `insert:` 段合并进
`~/.dsh/profiles/<profile>/cordis.patch.yml`，然后**重启 DSH**。详见
[BOARD.md](BOARD.md)。
