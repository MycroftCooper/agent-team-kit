# 现状审计（M0 / ATK-001）

> 文档类型：实施前基线审计
> 对应规范：`Agent-Team-Kit-2.0-AI-Implementation-Technical-Spec.md` §0 第 1 条、§1、§14（M0）
> 审计日期：2026-11-02
> 审计角色：ARCH（Lead）
> 结论摘要：仓库是**可运行、测试全绿的 v0.2.0 单包 CLI**；规范里的 `apps/*`、`packages/*`、SQLite、独立 Scheduler、独立 Runtime Host、Backend API、React Web **全部尚未存在**。§1.2 列出的 4 类 P0 风险**全部实测复现**（见第 6 节）。M0 阶段只做可靠性与契约基线，不得直接开始 M1 迁移。

---

## 1. 基线事实（可复核）

| 项 | 值 | 采集方式 |
|---|---|---|
| Git Commit | `aec31b6f95faa30b9e0cfcaf2d6235f59c94f780` | `git rev-parse HEAD` |
| 起始分支 / 工作区 | `main`，`git status --short` 输出为空（干净） | `git branch --show-current`、`git status --short` |
| M0 工作分支 | `m0/baseline-and-p0` | `git checkout -b m0/baseline-and-p0` |
| 包版本 | `agent-team-kit@0.2.0`，`"type": "module"`，`engines.node >= 20.11` | `package.json` |
| 第三方依赖 | **0 个**（无 `dependencies` / `devDependencies`） | `package.json` |
| Node | `v24.16.0` | `node -v` |
| npm | `11.13.0` | `cmd /c "npm -v"` |
| pnpm | `11.6.0`（已有，但仓库尚未使用 workspace） | `cmd /c "pnpm -v"` |
| Git | `2.45.1.windows.1` | `cmd /c "git --version"` |
| OS | Windows 11 专业版 build 26200 | `Win32_OperatingSystem` |
| 跟踪文件数 | 146 | `git ls-files` |
| 测试基线 | `node scripts/test.mjs` → **202 tests / 202 pass / 0 fail / exit 0**（约 7.8s） | 见文末「证据」 |

代码体量（不含 `.agent-flow/.backup/**`）：

| 区域 | 行数 |
|---|---|
| `lib/**` + `bin/atk.mjs` | 8161 |
| `test/**` | 4478 |
| `scripts/**` | 615 |
| `plugins/dsh-agent-board/**` | 1323 |
| `docs/**`（20 个 md） | 2057 |
| `templates/` + `presets/` + `skills/` | 1803 |

---

## 2. 仓库实际结构

```text
agent-team-kit/
├─ bin/atk.mjs               # CLI 入口，只依赖 lib/dispatch.mjs
├─ lib/                      # 25 个 ESM 模块（单包，无子包边界）
├─ test/                     # 23 个 node:test 文件，全部在 OS 临时目录造项目
├─ plugins/dsh-agent-board/  # DSH 看板插件（cordis.patch.yml + host/client JS）
├─ tools/agent-board/        # 插件副本目录（.gitignore 忽略）
├─ skills/                   # 3 个 Agent Skill（flow / board / roles）
├─ templates/flow/           # `atk init` 写出的全部脚手架内容（含中英双语）
├─ presets/                  # generic / p4deck 两份起始配置
├─ docs/                     # 20 个面向人的文档（部分中英双语）
├─ scripts/                  # test / selftest / selfhost / selfhost-verify
├─ examples/minimal/         # 最小可运行样例项目
├─ .agent-flow/              # 本仓库自我托管的工作流状态（state/board/runtime/roles）
├─ agent-flow.config.json    # 本仓库自己的项目配置
└─ .agent-flow/.backup/      # 历史 init/selfhost 备份（已被 .gitignore 忽略）
```

**没有** `apps/`、`packages/`、`pnpm-workspace.yaml`、`tsconfig.json`、任何构建产物目录。规范 §4 的目标目录是**纯目标态**，当前 0% 落地。

---

## 3. 现有能力清单

| 模块 | 行数 | 职责与关键契约 |
|---|---|---|
| `lib/dispatch.mjs` | 184 | 命令表（18 个命令 + 7 个别名）、全局 flag 解析、上下文注入、`VERSION` |
| `lib/context.mjs` | 30 | 由 `loadConfig` 组装 `ctx`：`config/root/paths/rel/roles/labels/log/relOf` |
| `lib/config.mjs` | 318 | `agent-flow.config.json` schema v1 校验、`mergeDeep` 默认值合并、路径解析（拒绝绝对/越界路径）、`assertInsideRoot` |
| `lib/state.mjs` | 1033 | `state.json` 唯一事实来源：check / board / queue / task / import / archive / restore |
| `lib/ownership.mjs` | 174 | 路径前缀 → Role 映射，最长前缀优先；`map` / `check` / `verify-config` |
| `lib/gate.mjs` | 360 | `gate fast`（按变更选择步骤，preflight 串行 + main 并行）、`gate quick/local`；写 `ci-fast-latest.json` |
| `lib/select-tests.mjs` | 267 | 变更文件 → 分组 → 适用步骤 → 测试计划 |
| `lib/baseline.mjs` | 144 | 不依赖 git commit 的变更基线（`baseline start/changed`） |
| `lib/batch.mjs` | 536 | `manifest`（冻结候选树 + `manifestSha256`）/ `verify`（漂移、候选、QA 绑定、身份） / `apply`（备份后写入） |
| `lib/evidence.mjs` | 348 | 扫描证据目录 → 派生 `qaPassed` / `applied` → 写回 `state.json`（幂等） |
| `lib/permissions.mjs` | 676 | 拒绝优先的决策流水线（RBAC ∧ Scope ∧ Ownership ∧ State ∧ Policy ∧ Approval）+ 审计 jsonl |
| `lib/permission-registry.mjs` | 392 | 主体 × 操作矩阵、reason code 枚举 |
| `lib/functions.mjs` | 325 | `ORCHESTRATOR/WORKER/REVIEWER` 分类、Agent Instance 能力校验、`reviewerChecks` |
| `lib/board.mjs` | 992 | markdown 看板、自包含 HTML、`serve`（文件监听 + SSE） |
| `lib/plugin.mjs` | 182 | DSH 插件副本同步/校验 |
| `lib/init.mjs` | 595 | 脚手架与采纳既有项目（`--force` 会覆盖） |
| `lib/release.mjs` | 151 | 开发分支 → 发布分支合并与打 tag（默认 dry-run，消费 gate 报告） |
| 其他 | — | `util/labels/docs/cache/human-todos/measure/sync` |

**CLI 命令面**：`init` `state`（check/board/queue/task/import/archive/restore）`board` `serve` `evidence` `ownership` `permit` `batch` `baseline` `cache` `gate` `release` `select-tests` `tests` `todo` `measure` `sync` `docs` `plugin` `help`。

**退出码约定（现有，必须保持）**：`0` 通过；`1` 检查/门禁失败或拒绝；`2` 用法/配置错误；`3` 并发或原始树漂移拒绝。

---

## 4. 与 2.0 规范的能力差距

| 规范章节 | 目标 | 现状 | 差距 |
|---|---|---|---|
| §4 monorepo | `apps/{web,backend,scheduler,runtime-host}` + 10 个 `packages/*` | 单包 `lib/` | **0%**，M1 起 |
| §6 数据库 | SQLite WAL + Drizzle + 事务 + 迁移 | JSON 原子覆盖 | **0%**，M1 起 |
| §7 开放 API | `/api/v1/*` + SSE + 幂等键 + 版本冲突 | 无 HTTP 服务端（仅看板只读 SSE） | **0%**，M1 起 |
| §7.2 内部 API | `/internal/v1/*` + 内部凭据 | 无 | **0%**，M1/M3 起 |
| §8 Scheduler | 独立进程、DAG、租约、generation fencing | `atk task` 手工派工 | **0%**，M3 起 |
| §9 Runtime Host | 独立进程 + `AgentRuntime` 适配器协议 | 无适配器层（仅看板插件） | **0%**，M2 起 |
| §11 Web | React SPA + 设计系统 + Playwright | 静态 HTML 看板 | **0%**，M1/M5 起 |
| §5 实体/状态机 | 15 类实体、6 组状态、`domain` 纯函数 | 部分（Task/Run 概念以 manifest/receipt 承载） | 约 30% |
| §10 QA/集成 | Gate 五值、冻结版本绑定、返工上限 | Gate 二值（passed/failed）、QA 绑定部分实现 | 约 40%（**P0 需先修**） |
| §12 安全 | loopback + Origin/CSRF + 内部凭据 + argv 执行 | 无 HTTP 服务端；`gate` 的 shell 命令按配置字符串执行 | 部分 |
| §13 迁移 | JSON → SQLite 三阶段 + `atk migrate` | 无 `migrate`；`init --force` 会覆盖 | **0%**，M1 |

---

## 5. 规范 §1.2 风险 → 代码定位

| # | 规范描述的风险 | 代码位置 | 现状 |
|---|---|---|---|
| 1 | ownership 未映射路径不阻断、缺 `--role` 使检查失去意义 | `lib/ownership.mjs:57-74`（`checkFiles` 把 unmapped 单独收集）、`:138`（role 可空）、`:152`（hint 非阻断） | 已复现，见 P0-1 |
| 2 | gate 无适用步骤/空配置可能成功退出 | `lib/gate.mjs:190-193`（空 steps 直接 `return 0`）、`:304-307`（空 command 直接 `return 0`）、`:261`（无适用步骤时 `results.every` 为真 → `ok: true`） | 已复现，见 P0-2 |
| 3 | `batch verify/apply` 的 QA 参数可选 | `lib/batch.mjs:301-360`（`if (qaPath)` 整块跳过）、`:368`（`--qa` 可选） | 已复现，见 P0-3 |
| 4 | `evidence` 按 `passed: true` 等自报字段识别回执 | `lib/evidence.mjs:68-75`（`classify` 只认布尔字段）、`:198-233`（不看签发结构） | 已复现，见 P0-4 |
| 5 | JSON 原子覆盖 ≠ 多进程事务 | `lib/state.mjs` 全量读改写 `writeJson` | 无单写入者/版本检查，M1 由 Backend 事务解决 |
| 6 | `init --force` 会覆盖生成状态 | `lib/init.mjs` | 无 `migrate` 命令，M1 补齐 |

---

## 6. P0 风险实测复现（本审计的硬证据）

复现方式：在 OS 临时目录用最小项目（配置 + ownership + state + runtime + 一个 candidate 树）驱动真实 CLI；不接触本仓库状态。命令与输出为原始摘录。

### P0-1 ownership 未映射路径放行、Role 可缺失

```powershell
# 未映射文件 docs/x.md，且不传 --role
node bin/atk.mjs ownership check --files docs/x.md --json
# 观测：{"ok":true,"role":null,"checked":1,"violations":[],"unmapped":["docs/x.md"]}  → EXIT=0

# 即使传了 --role DEV，未映射仍然放行
node bin/atk.mjs ownership check --role DEV --files docs/x.md --json
# 观测：{"ok":true,...,"unmapped":["docs/x.md"]}                                   → EXIT=0
```

**危害**：一个未登记的路径（新建目录、跨包目录）可以被任意角色写入而不触发任何失败；缺 `--role` 时检查只验证“归属一致性”，等于什么也没验证。

### P0-2 gate 空配置静默成功

```powershell
node bin/atk.mjs gate fast      # gates.fast.steps 为空
# 观测：No fast gate steps configured (gates.fast.steps is empty). Nothing to run.  EXIT=0
node bin/atk.mjs gate quick     # gates.quick 为 null
# 观测：No quick command configured (gates.quick is null). Nothing to run.         EXIT=0
```

**危害**：CI/交付脚本用退出码判定“门禁通过”，未配置或未执行与真实通过不可区分。`runFast` 在“无步骤适用”时 `results.length === 0` → `ok: true`，同样静默通过。

### P0-3 `batch verify` 不传 QA 也报 PASS

```powershell
node bin/atk.mjs batch verify --manifest artifacts/agent-flow/BATCH-01-manifest.json
# 观测：PASS BATCH-01: 3 check(s) passed | receipt artifacts/evidence/BATCH-01/verify-xxx.json
#       EXIT=0   （全程没有任何 QA 审查）
```

**危害**：只读诊断与受控集成共用同一条“PASS”输出，人工/脚本无法区分“验过了且审过”和“只是算了两个 hash”。

### P0-4 `atk evidence` 采信自报布尔，直接把状态机推进

伪造回执（只有自报字段，无 `schemaVersion` / `kind` / `verdict` / `reviewer` / gate 证据）：

```json
{ "manifestSha256": "950112C7…", "passed": true, "batchId": "S1", "originalApplied": false }
```

```powershell
node bin/atk.mjs evidence --json
# 观测：qaApprovals: 1，changes: slice:S1 → status awaiting_apply, qaPassed true   EXIT=0
```

同一份回执走 `batch verify --qa` 时**被正确拒绝**：

```powershell
node bin/atk.mjs batch verify --manifest … --qa artifacts/evidence/BATCH-01/qa-approval.json
# 观测：FAIL BATCH-01: reviewer-identity (qa-approval.json has no reviewer identity …)  EXIT=1
```

**危害（本审计最严重的一条）**：两条证据通道判定不一致，而**唯一会写 `state.json` 的那条是最弱的**。一个只有 `passed:true` 的文件即可把 slice 推进到 `awaiting_apply`，进而被看板/`sync`/`archive` 当作既成事实。`permissions.mjs` 的 QA 独立性检查在这条路径上完全没生效。

---

## 7. 兼容性红线（M0 不得破坏）

1. `bin/atk.mjs` 与全部既有命令名、别名、退出码语义保持可用；本规范新增能力只能是**增量**。
2. `agent-flow.config.json` schemaVersion 仍为 1；新增配置项必须有默认值，旧配置不改也能跑。
3. `state.json` / `ownership.json` / `runtime.json` 既有字段不变；新增字段可选。
4. `manifestSha256` 的确定性 payload 算法（`batch.manifestTag` + `batchId` + 排序文件行）不得改动，否则历史 manifest 全部失效。
5. 零第三方依赖的运行时约束在 `lib/` 与 CLI 内继续成立（Web/服务层才允许引入依赖）。
6. `node scripts/test.mjs` 202 项基线：允许增加用例，不允许减少或转红。

---

## 8. M0 工作包与验证口径

| 条目 | 交付物 | 验证方式（必须真实运行） |
|---|---|---|
| ATK-001 | 本文档 | 命令与输出可复核；`git rev-parse HEAD` 固定基线 |
| ATK-002 | ownership 严格模式 | `node scripts/test.mjs` 全绿 + 严格模式 6 类用例退出码符合预期 |
| ATK-003 | Gate 五值状态 | 五值映射表 + `--plan` 可解析 + release 拒绝非 PASS |
| ATK-004 | QA 回执结构 + 证据绑定 | 旧回执被拒且原因可读；自审/伪 hash/缺 gate 各自被拦 |
| ATK-005 | ADR + contracts 初版 | `docs/architecture/adr/*.md` + `packages/contracts/` 与契约测试 |
| ATK-006 | Runtime Spike | RT-P01~P10 逐条状态；无法验证一律 UNVERIFIED，不得写 PASS |
| QA | 独立复核 | 独立身份审查冻结 diff + 负面用例；不得自审 |

---

## 9. 结论

- 当前仓库**可以继续作为 v0.2.0 CLI 使用**，其状态机、角色合同、权限矩阵、manifest/证据链在有纪律使用时是有效的。
- 但规范点名的 4 个 P0 缺陷**全部真实存在并可复现**，其中 P0-4（`evidence` 采信自报布尔）会直接污染唯一事实来源，必须在任何自动化调度之前修掉。
- `apps/*`、`packages/*`、SQLite、Scheduler、Runtime Host、Web 全部为**待创建目标**，不存在“已实现”假象。
- M0 完成且门禁通过前，**不得**把自动调度描述为可用于真实项目；M1 起需要用户批准。

---

## 证据

```text
$ node scripts/test.mjs
ℹ tests 202
ℹ pass 202
ℹ fail 0
ℹ duration_ms 7781.2226
EXIT=0

$ git rev-parse HEAD
aec31b6f95faa30b9e0cfcaf2d6235f59c94f780

$ git status --short
(empty)
```

M0 复现脚本：`scripts/m0-repro.mjs`（可重复执行，输出逐条 PASS/FAIL，作为 M0 门禁与 QA 复核的机器可读证据）。
