# agent-team-kit

[![ci](https://github.com/MycroftCooper/agent-team-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MycroftCooper/agent-team-kit/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](package.json)

可复用的多 agent 交付工作流：状态机 CLI（`atk`）+ 角色合同与可执行的写域检查 +
证据门禁（缺回执就不推进）+ 看板（Markdown / HTML / SSE / DeepSeek Harness 插件）。

- **零第三方依赖**：仅 Node.js >= 20.11 内置模块，ESM，在任何项目里裸 `node` 可跑。
- **配置驱动**：路径、角色、门禁、看板插件身份都来自 `agent-flow.config.json`，
  代码里没有项目私有知识。
- **对 agent 友好**：9 行任务单、6 行回执、每角色一个队列命令、极简看板视图，
  以及三个可安装的 skill。

## 60 秒开始

```bash
npm install --global agent-team-kit      # 或 npx agent-team-kit <cmd>
cd my-project
atk init --project my-app                # 配置 + 流程目录 + 看板插件副本
atk board                                # 渲染看板
atk state check                          # 校验 state.json
```

agent 侧：

```bash
atk queue --for DEV
atk task <ID> --for DEV --message        # 可直接执行的任务单
atk gate fast --files <改动> --role DEV
atk evidence                             # 从回执派生 qaPassed / applied
```

`init` 常用参数：`--preset generic|p4deck`、`--roles LEAD,DEV,QA`、
`--language en|zh-CN`、`--flow-dir <目录>`、`--force`、`--dry-run`、
`--no-plugin`、`--json`。

## 四层结构

```
                 +---------------------------------------+
 人  ----------> |  看板（Markdown / HTML / SSE / DSH）  |  只读视图
                 +---------------------------------------+
                                  ^ 派生
                 +---------------------------------------+
                 |  证据门禁（回执 / manifest / 批准）    |  什么算完成
                 +---------------------------------------+
                                  ^ 产出
                 +---------------------------------------+
 agent ---------> |  角色合同（ownership.json + 角色卡）  |  谁能写哪里
                 +---------------------------------------+
                                  ^ 协调
                 +---------------------------------------+
                 |  状态机（state.json + atk CLI）        |  有什么、在哪个阶段
                 +---------------------------------------+
```

1. **状态机**：`state.json` 是唯一真值；每条 `atk` 命令都是确定性的查询或状态
   迁移。状态不来自聊天记录。
2. **角色合同**：`ownership.json` 用路径前缀分配写域（最长前缀优先、一个路径只属于
   一个角色），`atk ownership check` 强制执行；每个角色有一张卡（写域、禁做、任务
   循环、6 行回执、命令、轮次预算、证据阶梯）。
3. **证据门禁**：候选快照 → 冻结 manifest（`manifestSha256`）→ QA 批准绑定该 hash
   → verify → apply 回执 → `atk evidence` 派生。归档要求
   `verification.humanAccepted === true`。
4. **看板**：Markdown、静态 HTML、实时 SSE 服务与 DSH 侧栏面板都渲染同一份
   `state.json`；看板永远不是输入。

更多见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `atk init` | 把工作流脚手架进项目（或适配已有布局） |
| `atk state check\|board\|queue\|task\|import\|archive\|restore` | 状态机 |
| `atk board [--json\|--compact]` | 渲染 HTML 看板 |
| `atk serve` | 实时看板（文件监听 + SSE，兜底轮询） |
| `atk evidence [--collect-temp\|--dry]` | 从回执派生验收事实 |
| `atk ownership map\|check\|verify-config` | 写域检查 |
| `atk batch manifest\|verify\|apply` | 冻结 / 校验 / 应用候选批次 |
| `atk baseline start\|changed` | 不依赖 git commit 的改动基线 |
| `atk cache status\|clean` | 查看 / 清理共享构建缓存 |
| `atk gate fast\|quick\|local` | 配置驱动的门禁 |
| `atk select-tests` | 由改动文件生成选测计划 |
| `atk todo list\|add\|toggle\|done\|undone\|remove` | 人类待办 |
| `atk measure record\|summary` | 量测记录与汇总 |
| `atk sync` | import → evidence → board 一条命令 |
| `atk docs rotate` | 长文档轮转（默认 dry-run） |
| `atk plugin sync\|verify` | 安装 / 校验 DSH 看板插件副本 |

别名：`atk task`、`atk queue`、`atk check`、`atk import`、`atk archive`、
`atk restore`、`atk tests`。所有命令都支持 `--cwd <dir> --config <file>`。

## 看板与 DeepSeek Harness

`atk init` 默认复制看板插件（`--no-plugin` 可跳过）。在 DSH 的 **Plugins** 页安装
`config.plugin.dir`，把生成的 `cordis.patch.yml` 的 `insert:` 段合并进 profile
patch，然后**重启 DSH**——插件树与客户端 bundle 在启动时组合。路由、SSE 行为与
排障见 [docs/BOARD.md](docs/BOARD.md)。

## Agent skills

[`skills/agent-team-flow`](skills/agent-team-flow/SKILL.md) 教 agent 取任务、遵守
写域、跑门禁、交 6 行回执；[`skills/agent-team-board`](skills/agent-team-board/SKILL.md)
覆盖看板渲染、服务、插件安装与状态诚实；[`skills/agent-team-roles`](skills/agent-team-roles/SKILL.md)
按项目实际情况新增、删除、改名或调整 agent（角色），且不需要重跑 `atk init`。
安装说明见 [skills/README.md](skills/README.md)。

## 示例

[`examples/minimal/`](examples/minimal/README.md) 是一个可直接渲染的迷你项目：

```bash
node bin/atk.mjs --cwd examples/minimal board
```

## 文档

- [快速开始](docs/QUICKSTART.zh-CN.md)（[English](docs/QUICKSTART.md)）
- [架构](docs/ARCHITECTURE.zh-CN.md)（[English](docs/ARCHITECTURE.md)）
- [配置](docs/CONFIG.md) · [角色与写域](docs/ROLES.md) ·
  [工作流](docs/WORKFLOW.zh-CN.md)（[English](docs/WORKFLOW.md)）
- [看板与插件](docs/BOARD.md) · [迁移](docs/MIGRATION.md) ·
  [发布](docs/PUBLISHING.md) · [FAQ](docs/FAQ.md) ·
  [内部契约](docs/INTERNALS.md)

## 环境

Node.js >= 20.11，无运行时依赖。测试用内置 runner：

```bash
npm test          # node --test "test/*.test.mjs"
npm run selftest  # 测试 + 看板插件自测
```

## 许可

MIT，见 [LICENSE](LICENSE)。

