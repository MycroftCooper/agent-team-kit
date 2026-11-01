# 自举开发（中文摘要）

仓库本身也是这个工作流的使用者。自举最大的风险是：**改工具把工具改坏，然后用它验证自己的管线也跑不起来**。本页是隔离与恢复契约。

## 隔离模型

| 层 | 机制 |
|---|---|
| 真值树 | `main` 工作区保持已知可用；高风险改动不进主树 |
| 候选工作区 | `node scripts/selfhost.mjs prepare <TICKET>` 在仓库外创建 git worktree（`../agent-team-kit-candidates/`），天然满足 `workspace-isolated` |
| 冻结 | 主检出里执行 `atk batch manifest --candidate <候选>` |
| 审查 | 独立 Agent Instance（`agent-qa-01/02`）或人类审查 manifest |
| 应用 | `atk batch verify` 通过 + 绿 gate 报告 + QA 证据，才允许真实 apply |
| 清理 | 候选坏了直接 `node scripts/selfhost.mjs remove <TICKET>` 删除，绝不合并 |

## 快照与恢复

```bash
node scripts/selfhost.mjs snapshot --label 改动前
node scripts/selfhost.mjs restore latest              # dry-run
node scripts/selfhost.mjs restore latest --apply      # 恢复 + 自检
node scripts/selfhost.mjs restore latest --code-only --apply
node scripts/selfhost.mjs restore latest --workflow-only --apply
```

快照包含 `bin/ lib/ scripts/ test/ package.json`、配置、schema 与
`.agent-flow/`（不含 `.backup/` 与生成的 `board.html`）。`selfhost.mjs` 不 import
`lib/`，所以 `atk` 被改坏时它仍能运行。

## 健康检查

```bash
node scripts/selfhost.mjs status      # git、配置/state、atk、gate 报告、备份
node scripts/selfhost.mjs guard       # 坏了返回 1
node scripts/selfhost.mjs verify --full
atk gate fast / quick / local         # 都写 <artifactDir>/ci-fast-latest.json
```

## 恢复手册

| 症状 | 恢复 |
|---|---|
| `atk` 起不来 | `node scripts/selfhost.mjs restore latest --code-only --apply` |
| 配置非法、所有命令拒绝 | `... restore latest --workflow-only --apply` |
| state/ownership/runtime 损坏 | 恢复 workflow 快照，再 `atk state check` |
| selfhost 脚本自身坏了 | `git restore --source=<baseline-tag> -- scripts bin lib package.json` |
| apply 后门禁红 | 停止并看回执，不重试 apply；必要时回退基线 |

## 纪律

1. 不为推进而绕过红门禁/权限拒绝；`apply` 被拒是停止信号。
2. 门禁、权限矩阵、角色写域属于安全面，必须人工批准 + 独立审查。
3. 一写者一写域；交付前跑 `atk ownership check --role <ROLE> --files ...`。
4. 改 gate 逻辑、权限注册表、配置加载、batch/apply 路径前先 snapshot。
5. 候选可丢弃；不做“差一点就合”。
