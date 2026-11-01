# ADR-002：只有 Backend 写 SQLite

- 状态：**Proposed**
- 日期：2026-11-02
- 决策者：ARCH
- 关联：规范 §6、§7.2、§14（ATK-104）；ADR-001、ADR-003、ADR-006

## 背景

v0.2.0 的唯一事实来源是 `state.json`，由 `lib/state.mjs` 全量读改写 + 原子覆盖实现。规范 §1.2 第 5 条指出：**JSON 原子覆盖不等于多进程读改写事务**。一旦 Scheduler、Runtime Host、Web 都可能改状态，多写者会互相覆盖。

规范同时要求 SQLite 成为唯一业务事实来源（§6），Scheduler 与 Runtime Host 通过内部 API 交互。

## 决策

1. **SQLite 写入只允许 Backend 进程**。`packages/database` 只被 `apps/backend` 依赖；Scheduler / Runtime Host / Web 一律不得引入。
2. 所有状态变更走 Backend 的单一事务边界：校验（状态机 → 权限 → 版本）→ CAS 更新 → 追加事件 → 提交。任何一步失败整体回滚。
3. 启用 WAL + `busy_timeout`；每个连接明确事务边界，禁止跨事务的“先内存标记再异步落库”。
4. 乐观并发：实体带 `version`，写操作要求 `expectedVersion`（或 `If-Match`），冲突返回 `TASK_VERSION_CONFLICT`。
5. 数据库文件位于 `%LOCALAPPDATA%\AgentTeamKit\data\atk.db`，**不放进项目仓库**；升级前备份、迁移后核对记录数与 Hash。
6. 事件表只追加；业务当前状态由主表提供。大日志写文件，库里只存路径/大小/索引。

## 理由

- 单写者把“多进程竞态”压缩成“单进程内的串行事务”，这是本地优先架构里成本最低的正确性来源。
- 依赖方向可静态检查：`packages/database` 出现在 `scheduler` 的 import 里就是构建失败。
- WAL 允许 Backend 内部并发读，同时保持单写者语义。

## 后果

**正面**：事务正确性有唯一落点；迁移、备份、审计都在一处；内部 API 契约天然成为审计边界。

**负面 / 代价**：Backend 成为单点；Scheduler 每次决策要读快照、每次领取要回调 Backend，延迟与可用性都依赖它。Windows 上 SQLite 原生模块的安装与多进程锁定需要专门验证。

**缓解**：`snapshot` 接口返回一致快照 + 版本号；Scheduler 完全无状态，重启从 Backend 重建；`better-sqlite3` 与 Node 24 的兼容性在 M1 先做锁定架构测试再定驱动。

## 替代方案

| 方案 | 为什么否决 |
|---|---|
| 继续用 JSON + 文件锁 | 无法提供真正的事务与 CAS；崩溃窗口内可产生半写状态；已有 P0 证据表明证据链会污染事实源 |
| 每个进程各开一个 SQLite 连接写 | 多写者竞态 + 锁竞争；与“唯一事实来源”冲突 |
| 引入 Postgres/Redis | 违反本地优先与“不引入分布式”的非目标 |

## 兼容与迁移

- `state.json` 在 M1 迁移期仍可被旧 CLI 读取；迁移走三阶段（见 ADR-006）。
- `atk export` 必须能把 SQLite 导出为旧 JSON 结构，供旧工具与人工核对。

## 回滚

保持迁移前的 JSON 备份与 `migrate` manifest；`atk export` + 迁移 manifest 可在失败时重建 JSON 事实源。DB 文件独立于仓库，删除即回到 JSON 模式（只读兼容期）。
