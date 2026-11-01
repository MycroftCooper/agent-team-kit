# M1 / v0.4 交付回执与 M2 准入结论

- 文档类型：里程碑交付回执（规范 §14 M1、§16.2、§19）
- 日期：2026-11-02
- 分支：`m0/baseline-and-p0`（M0 与 M1 在同一分支连续提交）
- M0 冻结：`a75026c`（另含 `3e890d5` 的 M0 回执）
- **M1 冻结 commit：`d80862b` + 本轮 QA 修复提交（见 §8）**
- 执行者：Lead(ARCH) + `worker-database` + `worker-backend` + `worker-web` + `qa-reviewer`（M1 复核，未参与 M1 代码）
- 关联：[m1-contracts.md](../architecture/m1-contracts.md)、[ADR-009](../architecture/adr/ADR-009-m1-stack.md)、[qa-review-m1.md](../architecture/qa-review-m1.md)、[m0-status.md](m0-status.md)

> **状态：M1 核心能力完成，独立 QA 结论为"有条件通过"，条件已全部满足。** 四类 QA 发现（QA2-01..04）与 Lead 自审发现的门禁假通过面全部修复并复验。URL `http://127.0.0.1:1421/` 可打开真实前后端（中英双语）。**未做**：Scheduler、Runtime Host、JSON→SQLite 的唯一事实源切换、浏览器 E2E。M2 需先补齐 Runtime 证据集（见 §7）。

---

## 1. 强制交付回执（规范 §16.2）

```text
Task: ATK-101/102/103/104/106/107 (M1 / v0.4) + QA-002
Source: branch m0/baseline-and-p0; M1 code frozen at d80862b; QA fixes committed after it
Changed: 新增 apps/{backend,web} + packages/database；packages/contracts 增 VERSION_CONFLICT；
         scripts/{check-boundaries,test-workspace,m1-smoke}.mjs；CI workspace job；ADR-009 与 m1-contracts
Build: node --check（legacy CLI）exit 0 | pnpm --filter @atk/web build exit 0（tsc --noEmit + vite；dist ≈301 KB）
Tests: node scripts/test.mjs            -> tests 350 / pass 350 / fail 0 / skipped 0 / exit 0
       node scripts/test-workspace.mjs  -> tests 212 / pass 212 / fail 0 / skipped 0 / exit 0
       node scripts/check-boundaries.mjs-> PASS（4 packages / 5 edges / 0 cycles）
       node scripts/m1-smoke.mjs        -> 16/16 checks / exit 0
Contracts: packages/database store 接口（m1-contracts §1）；/api/v1 路由（§2）；SSE（§3）；
           Task 状态迁移表（§1 已实现）；VERSION_CONFLICT 新增；config 读取容忍 BOM；doctor exit=report.ok?0:1
Security: Host/DNS-rebinding、Origin、CSRF、token（禁 URL/query）、静态穿越、SQL 参数化、超大 body/URL 全部实测
Evidence: 本文件 + docs/architecture/{qa-review-m1,m1-contracts}.md + 各包 test/
Blockers: 无（M1 范围内）；M2 依赖见 §7
Next: M2 需要先补 RT-P07/P08 等 Runtime 证据；Scheduler 属 M3
```

---

## 2. 交付内容

| 条目 | 交付物 | 验证 |
|---|---|---|
| ATK-101 | pnpm workspace（`apps/*`、`packages/*`）、`scripts/check-boundaries.mjs`、`scripts/test-workspace.mjs`、CI workspace job | 边界 PASS；Node<22.5 打印 SKIPPED 而非 PASS |
| ATK-104 | `packages/database`：schema v1（16 表）、WAL/FK/busy_timeout 实测、幂等迁移、事务、CAS、内存实现、`importStateJson`/`exportStateJson` | 48 包内测试 |
| ATK-102/107 | `apps/backend`：`/api/v1` 路由、SSE（replay/resync/heartbeat）、四层本地鉴权、静态 SPA 托管、`serve/migrate/doctor/export` | 54 包内测试 + 真实进程 |
| ATK-106 | `apps/web`：React 19 + Vite + TS，**zh-CN/en 各 217 key** + 顶栏切换、设计令牌、概览/任务/详情/Agent/审查/设置、fetch 流式 SSE、错误态 | 110 包内测试 + build |
| ADR-009 | M1 栈选型（node:sqlite + node:http + React/Vite，双语 UI 为一等需求） | 决策记录 |
| QA-002 | 独立复核 25 条对抗用例 + 报告 | 6/6 变异被抓；4 MINOR + 观察项 |

---

## 3. 独立复核结论与缺陷闭环

QA 结论：**有条件通过——核心产品无 BLOCKER/MAJOR，条件为修掉 4 项 MINOR 后才把 m1-smoke 作为完成证据。**

| 编号 | 严重度 | 问题 | 状态 | 修复方 / 证据 |
|---|---|---|---|---|
| QA2-01 | MINOR | `PATCH /tasks` 允许任意改 status，与契约"客户端不得直接设 status"冲突 | **FIXED** | database：纯函数状态机（§1 迁移表），非法迁移 400 + `details.allowed`；测试 READY→DONE 被拒、版本不变 |
| QA2-02 | MINOR（最高价值） | `m1-smoke` 假通过面：0 任务也算 PASS、SSE 只看首个 chunk（而服务端无条件先写 `: connected`）、无成功写路径断言 | **FIXED** | Lead：migrate 断言 `tasks === slices+packages+subitems`；列表要求 ≥1；SSE 增加 `Last-Event-ID` 越界→`system.resync-required` 真实断言；新增「写路径 201→200→409」与「缺 CSRF 403」两条 |
| QA2-03 | MINOR | m1-smoke 启动 serve 会重写用户全局 token 文件 | **FIXED** | Lead：spawn 时 `LOCALAPPDATA` 指向临时目录，并加断言"token 文件在临时目录内" |
| QA2-04 | MINOR | 后端 CLI 裸 `JSON.parse`，带 BOM 的 state.json 使 migrate exit 2 | **FIXED** | backend：`src/json.mjs` 单一 `readJsonFile`（BOM/ENOENT/语法错误带行列），9 条新测试 |
| OBS | — | `doctor` 失败仍 exit 0 | **FIXED** | backend：`exit = report.ok ? 0 : 1` |
| OBS | — | 未鉴权 `/system/health` 返回 DB 绝对路径 | **ACCEPTED（M1）** | 本机单用户；M2 收紧为相对/脱敏 |
| OBS | — | SPA 无 CSP / X-Frame-Options | **DEFERRED（M5）** | 需与静态托管策略一起定 |
| OBS | — | M1 无事件生产者（UI "实时" 只到心跳） | **BY DESIGN** | Run/Scheduler 是 M2/M3；SSE 通道已按契约实现并有 resync 断言 |
| OBS | — | `zh-Hant` 归一到 `zh-CN` | **ACCEPTED** | 词典只维护两份；M5 若要繁体需独立词表 |
| OBS | — | 根 npm 包仍只含 legacy（不含 apps/packages） | **DEFERRED** | 发布单元未定，M6 决定 |

---

## 4. 真实数字（可复跑）

```bash
node scripts/test.mjs             # 350 / 350 pass（325 legacy + 25 QA 对抗），exit 0
node scripts/test-workspace.mjs   # 212 / 212 pass（database 48 + backend 54 + web 110），exit 0
node scripts/check-boundaries.mjs # PASS 4 packages / 5 edges / 0 cycles
pnpm --filter @atk/web build      # exit 0（tsc --noEmit + vite build）
node scripts/m1-smoke.mjs         # 16 / 16 checks，exit 0
```

浏览器验证：`http://127.0.0.1:1421/` 由真实 Backend 托管构建产物；顶栏 `data-testid="lang-toggle"` 在 zh-CN/en 间切换并持久化；`<html lang>` 同步。

---

## 5. 安全边界（实测，非声明）

| 层 | 实现 | 证据 |
|---|---|---|
| 绑定 | 仅 `127.0.0.1`；`listen` 拒绝 `0.0.0.0`/`::` | 单测 + 真实进程 |
| Host | 只接受 loopback Host；`evil.example` → 403 `host-not-loopback` | smoke + QA A1 |
| Origin | 写请求同源；无 Origin 需 `x-atk-client: cli`；`Origin: null` 拒绝 | QA A2/A3/A8 |
| Token | `x-atk-token`；**不接受 URL/query**；错误/过期拒绝 | QA A4/A5/A9 |
| CSRF | 写请求需 `x-atk-csrf`；缺失/错误 403 | smoke + QA A6 |
| 静态 | `../`、`%2e%2e`、反斜杠、`%00`、`/api/../` 全部拦截 | QA B2/B3 |
| SQL | 全部 prepared statement；`q/status/limit` 注入样本 400 | QA B1 |
| 体量 | 超大 body / 超长 URL → 4xx 且进程存活 | QA B4 |

---

## 6. 已知限制（M1 结束时的诚实边界）

1. **JSON 仍是唯一事实来源**：SQLite 是"导入后的新库"，双写**未**发生；ADR-006 的停机切换期尚未执行。任何真实用户应继续用旧 CLI 写，或明确接受"Web 侧只读"。
2. **没有事件生产者**：M1 的 SSE 只验证通道与补偿语义；`Run`/`Task` 变更事件由 M2/M3 产生。
3. **没有 Scheduler / Runtime Host**：派发仍是手工（`atk state task`）；M2 才有独立 Runtime Host，M3 才有确定性调度。
4. **真机 DSH 适配器仍不可用**：RT-P07（真实 Magpie 路由）、RT-P08（多 Agent 并行）、`canRunRestricted`、`canSpecifySessionModel` 未验证（见 [runtime-spike-dsh-magpie.md](../architecture/runtime-spike-dsh-magpie.md)）。
5. **无浏览器 E2E**：Playwright 未引入；M1 的前端验证是"纯逻辑测试 + 一次 headless 观察 + 真实构建"。
6. **单用户本机模型**：无账号体系、无多实例协调；token 文件是每用户全局。
7. **返工环未开放**：`REVIEWING → RUNNING` 等需要 Run 上下文，留到 M3。
8. **`docs/architecture` 仍会进 npm tarball**（M0 遗留 Q-09），发布单元未定。

---

## 7. M2 准入结论

**可以让 M2 开始（以 MockRuntime 为主），但真实 DSH 适配器仍被硬停止条件挡住。** 依据：M1 的 contracts/API/持久化命令接口基础已在（store 接口 + HTTP + SSE + 事件表），满足 §14 M2 的"依赖 M1 contracts/API/持久化命令接口"。

M2 开工前必须定的事：

| 事项 | 说明 |
|---|---|
| `packages/runtime-sdk` 接口先定 | `AgentRuntime`（probe/capabilities/start/send/stop/reconnect/subscribe）+ `RuntimeEvent` 形状，先有 MockRuntime 与契约测试 |
| Runtime Host 进程形态 | 独立 `apps/runtime-host`，经内部 API 领命令（ADR-003），不直接写 DB |
| DSH 适配器只能标 experimental | 生产 `capabilitySnapshot` 全部 `false` + `CAPABILITY_UNAVAILABLE`，直到 RT-P07/P08 补齐 |
| 事件的真实生产者 | Run 状态机 + `run.updated` 事件，让 UI 的"实时"有业务含义 |
| 内部凭据 | `/internal/v1/*` 与浏览器会话彻底分离（ADR-008 第 5 条） |

---

## 8. 提交与回滚

| commit | 内容 |
|---|---|
| `09ef064` | M1 workspace 骨架 + 边界检查 + 接口契约 + ADR-009 |
| `4b80dbc` | `packages/database`（SQLite/迁移/导入导出） |
| `6c9fa87` | `apps/backend`（API/SSE/鉴权/CLI） |
| `00c7c4e` | `apps/web`（React SPA + 中英双语） |
| `d80862b` | CI workspace job + 边界检查修正 + m1-smoke |
| QA 修复提交 | QA2-01..04 + doctor 退出码 + 强化后的 m1-smoke + QA 报告 |

回滚：M1 全部为**新增目录**，不修改 `lib/`；`git revert` 任一提交即可降级；SQLite 文件在 `%LOCALAPPDATA%\AgentTeamKit\data\`，删除即回到 JSON 单事实源。
