# ADR-001：前端 / Backend / Scheduler / Runtime Host 代码与进程分离

- 状态：**Proposed**（待用户批准后方可作为 M1 实施依据）
- 日期：2026-11-02
- 决策者：ARCH
- 关联：规范 §2、§4、§14（M0/ATK-005）；ADR-002、ADR-003、ADR-008

## 背景

v0.2.0 是单进程单包 CLI：`bin/atk.mjs` + `lib/*.mjs`，所有能力（状态机、门禁、冻结/集成、看板渲染）在同一个 Node 进程里按命令调用。规范要求演进为四个独立构建目标与独立进程：Web、Backend、Scheduler、Runtime Host，默认同机运行。

拆分的压力来自三处：

1. **生命周期不同**：浏览器关闭不能让调度和运行停止；`runtime-host` 持有长命的 Agent 子进程，重启成本远高于 HTTP 服务。
2. **故障隔离**：一个 adapter 崩溃不应带走业务事实来源；Scheduler 崩溃不应丢任务。
3. **写权限边界**：只有 Backend 允许写数据库；如果 Scheduler/Runtime 只通过 API 交互，这条边界才有可能被静态检查（依赖方向检查）与运行时检查同时保证。

## 决策

1. 建 pnpm workspace，`apps/{web,backend,scheduler,runtime-host}` 与 `packages/*` 各自独立 `package.json`、独立构建、独立启动入口。
2. **依赖方向是架构约束，不是风格偏好**：
   - `web` → 仅 `contracts` + `api-client`；
   - `scheduler` → `scheduler-core` + `contracts` + 内部 API Client；
   - `runtime-host` → `runtime-sdk` + `workspace` + `contracts`；
   - `backend` → `database` + `domain` + `permission` + `quality`；
   - `backend` **不得**依赖具体 `runtime-dsh` / `runtime-codex`；
   - 任何包不得导入另一个包的私有文件（禁止跨包根的相对路径导入）。
3. 进程拓扑固定为 `atk launcher` 拉起 `atk-backend`、`atk-scheduler`、`atk-runtime-host` 三个子进程，浏览器只访问 Backend（`127.0.0.1:1421`）。
4. Scheduler 与 Runtime Host **不开放公网/浏览器端口**；v1.0 之前经 Backend 的 `/internal/v1/*` + 短期内部凭据通信，后续可换 Windows Named Pipe。
5. 依赖方向检查与循环依赖检测进 CI；违反即失败。

## 理由

- 与规范 §2 的独占职责表一一对应：每个子系统只有一份职责，禁止项都是可检查的依赖关系。
- 单机多进程保留“本地优先、可离线、无容器”的定位，不引入 Redis/K8s/分布式数据库。
- 独立进程让“崩溃后依 Backend 事实重建”成为可测试场景（负面测试必须能杀进程）。

## 后果

**正面**：可独立重启、可独立测试、可静态检查越权依赖；Scheduler 可换成无服务纯函数测试。

**负面 / 代价**：进程间通信与幂等复杂度上升；Windows 上的子进程回收、端口占用、启动时序都要专门处理；调试跨进程链路比单进程难。

**缓解**：内部 WebSocket/HTTP 契约先用 `packages/contracts` 固化并写契约测试；`atk doctor` 只读诊断端口与版本；每个进程都允许“无状态重启”。

## 替代方案

| 方案 | 为什么否决 |
|---|---|
| 继续单进程 + 模块分层 | 无法满足“浏览器关闭服务继续”“Runtime 崩溃不带走 Backend”，也无法真正隔离写权限 |
| 桌面应用（Electron）单进程打包 | 规范 §3 明确不采用；Windows 打包与升级成本高，且掩盖进程边界问题 |
| 微服务 + 容器 | 违反“本地优先、单用户、不引入分布式”的非目标 |

## 兼容与迁移

- 既有 `lib/*.mjs`、`bin/atk.mjs`、`plugins/dsh-agent-board` **原位保留**，M1 不做大重构；新服务通过 CLI/API 复用旧能力。
- 旧 CLI 在 M0 保持全部命令与退出码不变（见 `current-state.md` §7）。
- 拆分顺序：M1（workspace + backend + web）→ M2（runtime-host）→ M3（scheduler），每条里程碑独立可回滚。

## 回滚

每个 `apps/*` 是独立提交；回滚到 `m0/*` 分支即回到单进程 CLI，`lib/` 不依赖任何新增包。
