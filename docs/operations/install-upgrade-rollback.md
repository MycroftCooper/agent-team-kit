# 安装 / 升级 / 回滚（本地部署）

- 适用：本机单用户部署（Windows 11 / Node.js ≥ 22.5）
- 关联：`docs/architecture/m5-contracts.md`、ADR-001、ADR-007、ADR-008
- 状态：M5 交付文档

---

## 1. 安装（从零开始）

```powershell
# 1) 依赖与构建
corepack pnpm install
pnpm --filter @atk/web build

# 2) 初始化数据目录（默认 %LOCALAPPDATA%\AgentTeamKit）
#    atk start 首次运行会自动迁移并创建目录
node apps/launcher/cli.mjs start --port 1421

# 3) 查看状态
node apps/launcher/cli.mjs status --json
```

**数据目录布局**（`ATK_DATA_DIR` 可覆盖根目录）：

```text
<dataDir>/
  data/atk.db            SQLite（WAL 模式）
  runtime/               Host 的在途记录、会话 token
  logs/                  backend.log / scheduler.log / host-<i>.log
  launcher.json          子进程状态（PID/端口），不含内部凭据
```

**安全默认值**（无需配置）：
- 只监听 `127.0.0.1`；Host/Origin 白名单；写操作要 CSRF。
- 浏览器 token 与内部凭据**分离**：内部凭据只由 Launcher 从 backend stdout 读取并通过**子进程环境变量**传递，不落盘、不进日志、不出现在 `status` 输出。
- 真实 DSH 适配器**默认不可用**（能力全 false，误用会明确拒绝），必须显式 `AGENT_RUNTIME=mock`（默认）才可运行。

**验证安装**：
```powershell
curl http://127.0.0.1:1421/api/v1/system/health   # {"ok":true,"db":{"schemaVersion":4,...}}
curl http://127.0.0.1:1421/                       # SPA 200
node scripts/m5-smoke.mjs                         # 端到端门禁
```

---

## 2. 升级

```powershell
# 1) 先备份（一致性快照，不是复制文件）
node apps/backend/cli.mjs backup --data "$env:LOCALAPPDATA\AgentTeamKit\data\atk.db" --to "D:\backup\atk-$(Get-Date -Format yyyyMMdd-HHmmss)"

# 2) 停服务
node apps/launcher/cli.mjs stop

# 3) 更新代码
git pull --ff-only

# 4) 迁移 + 重启（启动时自动执行有序迁移）
corepack pnpm install
pnpm --filter @atk/web build
node apps/launcher/cli.mjs start --port 1421

# 5) 验证
node apps/launcher/cli.mjs status --json
curl http://127.0.0.1:1421/api/v1/system/health
```

**迁移规则**（ADR-006 的 SQLite 阶段）：
- 迁移文件只追加、不修改；`schema_migrations` 记录已应用版本；runner 对"列已存在"自愈并记 WARN。
- 升级前 `schemaVersion` 应 ≤ 当前代码版本；**降级代码遇到更高版本数据库会被 restore/启动拒绝**，请回滚到匹配版本或从备份恢复。
- 已知历史：v1（M1 基线）→ v2（runs/dispatch）→ v3（调度字段）→ v4（评审/验收字段），均支持原地升级，有测试覆盖。

---

## 3. 回滚

### 3.1 回滚代码（数据库兼容时）
```powershell
node apps/launcher/cli.mjs stop
git checkout <上一个良好提交>
corepack pnpm install
pnpm --filter @atk/web build
node apps/launcher/cli.mjs start --port 1421
```
如果新代码已经迁移过数据库（schemaVersion 变高），旧代码可能拒绝启动；此时用下面的数据库回滚。

### 3.2 回滚数据库（推荐与代码回滚一起）
```powershell
node apps/launcher/cli.mjs stop
node apps/backend/cli.mjs restore --from "D:\backup\atk-20261102-101500" --data "$env:LOCALAPPDATA\AgentTeamKit\data\atk.db" --force
node apps/launcher/cli.mjs start --port 1421
```
`restore` 会校验 manifest 的 `sha256` 与 `schemaVersion`；快照被篡改或版本高于当前代码时**拒绝执行**，目标文件保持不变。

### 3.3 回滚评判标准
回滚完成的标志（缺一不可）：
1. `status --json` 所有子进程 alive；
2. `/api/v1/system/health` 返回 200 且 `schemaVersion` 与代码匹配；
3. 关键数据条数（tasks/runs/events）与备份时刻一致；
4. `scripts/m5-smoke.mjs` 通过。

---

## 4. 崩溃与恢复

| 场景 | 行为 |
|---|---|
| Launcher 自己崩溃 | 子进程可能成为孤儿；`atk stop` 会按 launcher.json 的 PID 清理；PID 已死则清理陈旧状态。 |
| 某个 Host 崩溃 | 它的 lease 过期后命令被回收；新 Host 启动先 `recover()` 对账，无法确认的 Run 标 `INTERRUPTED`，**绝不**猜测完成。 |
| Scheduler 崩溃 | 无状态：重启后重新读快照，不会重复派发已领取任务（Backend 原子 claim 兜底）。 |
| Backend 崩溃 | Host/Scheduler 的请求失败并退避重试；重启后命令由 sweep + reconcile 收敛。 |
| 数据库损坏 | 用最近备份 `restore`；不要在损坏库上运行迁移。 |

**人工介入边界**：返工超限（BLOCKED）、验收过期（APPROVAL_STALE）、中断的 Run（INTERRUPTED）都需要人工决策，系统不会自动"修好"它们。

---

## 5. 已知限制（部署视角）

1. 只支持本机单用户；没有远程访问、TLS、多用户隔离（非目标）。
2. 没有安装包/签名/自动更新；`atk start` 从源码目录运行。
3. 真实 DSH 适配器不可用：当前只能跑 MockRuntime，因此"M5 真实 3 Agent 协作"只完成了 Mock 版本，真实协作需要 RT-P07/P08 验证后再评估。
4. 日志没有轮转（本地单机，按需手工清理）。

---

## 6. Phase C：旧 CLI 只读（SQLite 单一事实源）

ADR-006 的 Phase C 一旦开始，**SQLite 是唯一写者**；旧 `lib/**` CLI（`atk` 命令）降级为只读兼容入口。判据只有一处：

```text
<dataDir>/runtime/migration.lock
{ "owner": "sqlite", "phase": "C", "pid": 12345,
  "startedAt": "2026-11-02T12:00:00+08:00", "toolVersion": "0.2.0" }
```

`dataDir` 默认 `%LOCALAPPDATA%\AgentTeamKit`，`ATK_DATA_DIR` 可覆盖；Launcher 与旧 CLI 读同一文件。锁缺失 = 尚未进入 Phase B（旧 JSON 行为保持）；锁存在但 owner=sqlite / phase=C = **旧 CLI 只读**。

**只读命令（可用）**：`atk board` / `board --json` / `serve` / `status` / `doctor` / `verify` / `export`，以及 `atk state check|queue|task`。它们直接从 SQLite 投影事实（`lib/sqlite-read.mjs`），不读取也不回写 state.json。

**被拒绝的写命令**（exit 1，code `READ_ONLY_MODE`，提示 `read-only compatibility mode; use atk export or the Backend API`）：
`init`、`state import|archive|restore`、`batch apply`、`evidence`、`ownership`、`permit`、`gate`、`todo`（非 list）、`measure record`、`docs rotate`、`baseline start`、`release`、`plugin sync`、`cache clean`。
`saveState` 是中心守卫，但 evidence 直写、init、batch、ownership、gate 各自入口也会判锁——不是只守一个函数。

**陈旧/非法锁**：pid 已死 → `MIGRATION_LOCK_STALE`，**不会静默绕过**；按错误里的指引确认无进程后删除锁，或 `atk migrate --resume`；处理前先 `atk-backend backup`。
**切换只允许停机时进行**：Backend 运行时（launcher.json 存活 PID 或 `/api/v1/system/health` 可达）执行 `atk-backend import --mode replace` 会被拒绝，错误为
`database switch must run while the backend is stopped (detected backend pid <pid> on port <port>); stop it with atk stop first`。

**只读期取 JSON**：`atk export --out <file>`（可读投影，跨版本/审计用）。二进制回滚仍用 `atk-backend backup/restore`；两者职责不同：backup 是 WAL 一致性快照（回滚），export 是 JSON（迁移/审计）。
