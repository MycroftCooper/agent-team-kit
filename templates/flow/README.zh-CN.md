# {{PROJECT}} 工作流

> 流程目录：`{{FLOW_DIR}}`，语言：`{{LANGUAGE}}`。本页路径默认相对该目录。

**唯一入口。** 接活前只读本页 + `current-batch.md`，约 3k 字符足够开工。

**不要读 `state.json`**（文件大且面向机器）。用下面三条命令代替：

```bash
atk task <ID> --for <ROLE> --message   # 单个任务单，可直接转发
atk queue --for <ROLE>                # 我的队列
atk state board --compact             # 给 agent 的极简看板
```

## 权威地图

| 内容 | 权威位置 | 怎么用 |
|---|---|---|
| 工作包 / 切片 / 归档状态 | `state.json` | 只给脚本读；人用命令 |
| 写域 | `ownership.json` | `atk ownership map <路径>` |
| 验收回执 | `layout.evidenceDir` | `atk evidence` 派生事实 |
| 人类视图 | `board.md` / `atk serve` / DSH 面板 | 事件驱动（SSE），不要轮询 |
| 当前批次与决议 | `current-batch.md` | 滚动维护，每批覆盖 |
| 命令全集 | `commands.md` | 不在此页的命令不属于契约 |
| 角色合同 | `roles/<ROLE>.md` | 开工前先读自己的角色卡 |
| 人类待办 | `human-todos.json` | 只有用户能勾选 |

## 角色与写域

{{ROLES_TABLE}}

单写者：`atk ownership check --role <ROLE>` 把"约定"变成可执行检查。同一路径
命中两个角色属于配置错误，不是合并冲突。

## 实体与 Function

Role 只是权限模板。真正的执行者是 `runtime.json` 里的 Agent Instance（`id` +
`capabilities`），一次执行是回执物化的 Run：manifest 是产出方 `WORKER`，结构化签名的
`qa-approval.json` 是审查方 `REVIEWER`（`kind: "qa-approval"`、`verdict`、
`manifestSha256`、`reviewer`、`targetRunId`、声明的 `gates`）。单独一个
`passed: true` 不是 QA 事实；旧式回执默认被拒，除非项目显式启用
`batch.legacyReceipts` / `--legacy-receipts`。

**不允许自审。** 审查派单必须带 `--agent <id>`；`atk batch verify` 会发现审查者就是
产出者并拒绝。不要绕过 `no-self-review` 拒绝。

**受控集成。** `atk batch verify --require-qa` 与任何形态的 `atk batch apply`
（含 dry-run）都必须有合法 QA 回执，缺失直接退出 `1`；不带 `--qa` 的 `batch verify`
只是只读诊断（`status: "SKIPPED"`，不构成批准）。

**权限默认拒绝。** `atk permit check <操作>` 返回判定与机器可识别原因码（改码、审查、
集成、预算、生产访问、验收等）；主体 × 操作矩阵由工具包维护，本项目不能放宽。

## 一个任务的生命周期

```
1 LEAD    在 state.batch.slices 开切片，生成任务单
2 LEAD    一条消息转发任务单（不要另写文档）
3 DEV     在原树之外建候选快照
4 DEV     冻结：atk batch manifest --candidate ... --packages <ID> --agent <id>
5 QA      出结构化签名 qa-approval.json（kind: "qa-approval"、verdict、
          manifestSha256、reviewer、targetRunId、声明的 gates）
6 QA      verify：atk batch verify --manifest ... --qa ...
7 BE/LEAD apply：先 dry-run（必须带合法 --qa），再 --apply --confirm-dev-closed
8 LEAD    派生：atk evidence（QA -> 待应用，apply -> 待人工验收）
9 人      验收；LEAD 写 humanAccepted，再 atk state archive 归档
```

以下情况不得推进：manifest 未冻结、QA 未由合法签名回执绑定、原树漂移、用户未确认
dev 已关闭、夹带未验切片。

## 门禁分层

| 层 | 命令 | 能证明什么 |
|---|---|---|
| 快速 | `atk gate fast --files ... --role <ROLE>` | 写域 + 格式 / 类型 / 选测 |
| 完整 | `atk gate quick` | 冻结可用 |
| 重层 | `atk gate local` | 交付候选可用 |
| QA | 冻结快照上的定向检查 | 可放行 |
| 人验 | dev 实机 / 原生 | 可归档 |

只有 `status: "PASS"` 才是门禁通过；`SKIPPED` / `UNCONFIGURED` / `ERROR` 都不算通过，
`atk release` 也只接受明确的 `PASS` 报告。

## 证据阶梯

`typecheck 通过` ≠ `测试通过`，`测试通过` ≠ `人工验收`。`skipped` 不是通过，
`mock` 不是原生，单项通过不是联合通过。每一级分开写，不得合并。

## Token 纪律

1. 任务单由命令生成，≤200 字、固定 9 行；不要手写。
2. 回执固定 6 行：范围 / 命令 / 测试 / 阻碍 / 快照 / 停笔。
3. 超预算就停笔报告：单任务 ≤12 轮；入场只读本页 + `current-batch.md`。

## 归档与轮转

- `atk state archive <ID> --note "理由"`：前置 `verification.humanAccepted === true`，
  写入归档时间、理由与证据；`atk state import` 不会打回归档项。
- 看板保留独立的「已完成归档」区，不混进活跃看板。
- 长文档用 `atk docs rotate` 轮转（默认 dry-run + 并发保护）。

## 分支与发布

- 日常开发在 `{{DEV_BRANCH}}`；**所有 agent 的提交都进 {{DEV_BRANCH}}**。
- `{{RELEASE_BRANCH}}` 是发布线：只接受从 `{{DEV_BRANCH}}` 的 `--no-ff` merge，并打
  `{{TAG_PREFIX}}<semver>` tag；不要在发布线上直接开发。
- 发布：门禁通过后执行 `atk release --version x.y.z`（默认 dry-run，校验分支 /
  工作树 / 版本文件 / 门禁新鲜度），确认后加 `--apply`。

## 底线

原树对 agent 只读；Apply 前必须 fresh verify；QA 独立；单写者；未经用户授权不做
生产访问、打包或发布；不虚报证据。
