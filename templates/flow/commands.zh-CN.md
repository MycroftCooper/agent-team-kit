# 命令速查

> 找命令只看这一页。所有命令都支持 `--cwd <dir>` 与 `--config <file>`。
> 不在此页的命令不属于工作流契约。

## 状态与任务

| 命令 | 作用 |
|---|---|
| `atk state check [--strict] [--verbose]` | 校验 state.json（包 / 切片 / 依赖 / 负责人 / 证据） |
| `atk state board` | 生成 Markdown 看板 |
| `atk state board --compact` | 给 agent 的极简视图（ID / 状态 / 优先级 / 负责人） |
| `atk queue --for <ROLE> [--json]` | 我的队列 |
| `atk task <ID> --for <ROLE> [--agent <id>] [--function <NAME>] [--message] [--json]` | 单个任务单 |
| `atk state import` | 从 Markdown 台账（`paths.todoSource`）导入 |
| `atk state archive <ID> --note "理由"` | 归档；前置 `verification.humanAccepted === true` |
| `atk state restore <ID>` | 撤销归档 |

## Function 与职责分离

| 规则 | 命令 / 文件 |
|---|---|
| 审查派单必须带审查实例 | `atk task <ID> --for QA --agent <id>` |
| 调度器拒绝自审 | 该 Role 拥有的任务，或该实例已产出的 manifest |
| manifest 记录产出 Run | `atk batch manifest ... --agent <id>` |
| 批准记录审查 Run | `qa-approval.json` → 结构化签名 `kind: "qa-approval"` 回执 |
| verify 拒绝自审 | `atk batch verify --manifest <f> --qa <f>`（`no-self-review`、`reviewer-identity` 等） |
| 受控集成必须提供合法 QA | `atk batch verify --require-qa` / `atk batch apply` 缺合法 `qa-approval.json` 直接退出 `1`；省略 `--qa` 只是只读诊断（`status: SKIPPED`） |

## 证据与门禁

| 命令 | 作用 |
|---|---|
| `atk evidence [--collect-temp] [--dry] [--legacy-receipts]` | 回执 → 验收事实（幂等）；无效回执计入 `rejected` |
| `atk ownership check --role <ROLE> [--files a,b] [--strict]` | 写域越界检查（`--strict` 失败关闭：必须有 Role、未映射阻断） |
| `atk ownership map <path>` | 查路径归属 |
| `atk ownership verify-config` | 写域配置自查（重叠 / 缺口） |
| `atk select-tests [--files a,b] [--since-baseline]` | 选测计划 |
| `atk gate fast [--files a,b] [--role <ROLE>] [--since-baseline]` | 变更范围快速门禁 |
| `atk gate quick` / `atk gate local` | 完整 / 重层门禁 |

门禁状态只有 `PASS` / `FAIL` / `SKIPPED` / `UNCONFIGURED` / `ERROR`；只有 `PASS`
满足门禁，`atk release` 也只接受明确的 `PASS` 报告。

## 权限

| 命令 | 作用 |
|---|---|
| `atk permit check <操作> [--subject 主体\|--agent 实例] [--task ID] [--files a,b]` | 判定并返回机器可识别原因码；追加审计 |
| `atk permit matrix [--group G] [--json]` | 主体 × 操作矩阵（A / C / N） |
| `atk permit explain <操作>` | 单元格条件与原因码 |
| `atk permit audit [--tail N]` | 只追加的决策审计 |

## 批次与缓存

| 命令 | 作用 |
|---|---|
| `atk batch manifest --candidate <dir> --paths a,b --packages <ID> --agent <id> [--contributors a,b]` | 冻结候选 manifest 并记录产出 Run |
| `atk batch verify --manifest <f> [--qa <f>] [--require-qa] [--legacy-receipts]` | 原树漂移 / 候选改动 / QA 回执绑定 / 审查者独立性；不带 `--qa` 只是只读诊断（`status: SKIPPED`，不算通过） |
| `atk batch apply --manifest <f> [--qa <f>] [--apply --confirm-dev-closed]` | 默认 dry-run（计划本身也必须有合法 QA 回执）；两个 flag 才真写 |
| `atk baseline start` / `atk baseline changed` | 不依赖 git commit 的本片基线 |
| `atk release --version <semver> [--note] [--apply]` | 发布：开发分支 → 发布分支 `--no-ff` merge + tag（默认 dry-run，校验分支/工作树/版本/门禁） |
| `atk cache status` / `atk cache clean` | 查看 / 清理共享构建缓存 |
| `atk measure record` / `atk measure summary` | 记录 / 汇总量测 |
| `atk sync` | import → evidence → board 一条命令收尾 |
| `atk docs rotate [--apply] [--keep N]` | 长文档轮转（默认 dry-run） |

## 看板与插件

| 命令 | 作用 |
|---|---|
| `atk board` | 生成静态 HTML 看板（`board.md` 由 `atk state board` 生成） |
| `atk serve` | 启动实时看板（文件监听 + SSE，30 秒兜底） |
| `atk plugin sync [--out <dir>]` | 复制 DSH 看板插件到本项目 |
| `atk plugin verify` | 校验项目内插件副本是否与工具包一致 |

## 人类待办

| 命令 | 作用 |
|---|---|
| `atk todo` | 列出人类待办 |
| `atk todo add "标题" [--note "说明"]` | 新增 |
| `atk todo toggle\|done\|undone <ID>` | 勾选 / 取消——**只有用户能勾** |
| `atk todo remove <ID>` | 删除 |

## init 之后的第一组命令

```bash
atk board
atk queue --for {{ROLE}}
atk task <ID> --for {{ROLE}} --message
atk plugin sync
```
