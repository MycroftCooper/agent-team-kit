# M5 契约：一条命令启动本地系统 / 部署与恢复 / 剩余工作台

- 状态：M5 实施契约
- 关联：规范 §10、§12、§14（M5）；ADR-001（多进程）、ADR-007（启动器）、ADR-008（本地访问安全）
- 纪律：形状变更先 message Lead。

---

## 0. 范围与硬不变量

**做**：`apps/launcher`（`atk start|stop|status`）、Backend `backup/restore`、Web 的 Runs 详情与实时事件流、`docs/operations/`（安装/升级/回滚）、`scripts/m5-smoke.mjs`。

**不做**：真实 DSH 适配器（仍不可用）；安装包/签名/自动更新；M6 的 JSON→SQLite 停机切换。

**硬不变量**：
1. **一条命令**：`atk start` 之后系统可用（Backend + Scheduler + N 个 Host 全部就绪），不需要手工传内部凭据。
2. **内部凭据不下发到磁盘**：由 Launcher 从 Backend stdout 读取后通过**子进程环境变量**传递，不写状态文件、不进日志。
3. **有序停止**：Hosts → Scheduler → Backend；先 SIGTERM，超时再强杀；`atk stop` 幂等。
4. **崩溃后 `atk start` 可恢复**：残留状态文件（死 PID）不会阻止启动；Host 的 in-flight 记录会被 `recover()` 对账，绝不复用为"已完成"。
5. **状态可查**：`atk status` 输出每个子进程的 PID/存活/端口/健康，机器可读（`--json`）。
6. **数据可备份/恢复**：`backup` 产出的一致性快照可在另一个目录 `restore` 后直接启动（schema 版本校验，不匹配拒绝）。

---

## 1. `apps/launcher`（新应用）

```text
atk start  [--port 1421] [--data <dir>] [--hosts 1] [--runtime mock] [--detach]
atk stop   [--data <dir>] [--force]
atk status [--data <dir>] [--json]
atk logs   [--data <dir>] [--follow]
```
- 数据目录默认 `%LOCALAPPDATA%\AgentTeamKit`（`ATK_DATA_DIR` 可覆盖），含 `data/atk.db`、`runtime/`、`logs/`、`launcher.json`。
- `launcher.json`：`{ version, port, startedAt, children: [{name, pid, role}] }`，**不含内部 token**；PIDs 用于 status/stop。
- 子进程：
  - `backend`: `node apps/backend/cli.mjs serve --port <port> --data <db> --web-dist apps/web/dist`
  - `scheduler`: `node apps/scheduler/cli.mjs`（env `ATK_BACKEND_URL`、`ATK_INTERNAL_TOKEN`）
  - `host-<i>`: `node apps/runtime-host/cli.mjs --owner host-<i>`（env 同上 + `AGENT_RUNTIME`、`ATK_HOST_STATE_FILE`）
- 启动顺序：backend 就绪（轮询 `/api/v1/system/health`）→ 解析 stdout 的 `internal token: <t>` → scheduler → hosts。
- 任一子进程非预期退出 → 记录并在 `status` 中标记 `down`；`atk start` 遇已有存活实例 → 明确报错退出 2（不盲目双启）。
- 日志：`logs/<child>.log`（追加，行首带 ISO 时间与角色）。
- 退出码：0 ok，1 运行失败，2 用法/已有实例。

## 2. Backend `backup` / `restore`

```text
node apps/backend/cli.mjs backup  --data <db> --to <dir>   # 一致性快照（SQLite backup API 或 VACUUM INTO）
node apps/backend/cli.mjs restore --from <dir> --data <db> # 目标已存在则拒绝，除非 --force
```
- 快照包含：数据库文件 + `manifest.json`（`{ createdAt, schemaVersion, bytes, sha256 }`）。
- `restore` 必须校验 manifest 的 sha256 与 schemaVersion；版本高于当前代码 → 拒绝并提示升级。
- 两者都要幂等安全：backup 不修改源库；restore 先写临时文件再原子替换。

## 3. Web：Runs 详情与实时事件流

- `#/runs` 列表 + 详情：Run 状态、attempt、exitCode、时间线、关联 Task/Review。
- 详情页订阅 `/api/v1/events/stream`（非 `EventSource`，沿用 fetch + ReadableStream + `Last-Event-ID`），展示增量事件；断线显示 `system.resync-required` 后自动重连并补齐。
- 双语；错误码本地化沿用 M4；只读，不新增写操作。

## 4. M5 门禁（`node scripts/m5-smoke.mjs`）

1. `atk start --port <free> --data <temp> --hosts 2` → `atk status --json` 显示 backend/scheduler/2 hosts 全部 alive，Backend health 200。
2. 种子 3 个 READY 任务 → 等 N 秒 → 至少 2 个 Run 被派出并完成（多 Host 并行）；`status` 的 host 数量与 launcher.json 一致。
3. **内部凭据不落盘**：`launcher.json`、日志文件、`status --json` 输出中都不含内部 token；Host 能工作说明凭据只经环境变量传递。
4. **有序停止**：`atk stop` → 所有子进程退出、端口释放、`atk stop` 再跑一次仍 exit 0。
5. **崩溃恢复**：`start` 后强杀一个 Host（`kill -9` 等效）→ `atk status` 标记该 host down → `atk start` 拒绝双启（exit 2）或 `atk stop` 后重建 → 新 Host 的 `recover()` 对账，对应 Run 不是 `COMPLETED`（`INTERRUPTED`）。
6. **备份/恢复**：`backup` → 新目录 `restore` → 用恢复后的库 `atk start` → health 200 且任务数一致；篡改 manifest 的 sha256 → restore 拒绝。
7. **Web 构建**：`pnpm --filter @atk/web build` exit 0；`#/runs` 路由存在（静态断言）。
