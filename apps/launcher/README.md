# @atk/launcher（M5）

`atk`：一条命令启动本地 Agent Team Kit（Backend + Scheduler + N 个 Runtime Host），不传内部凭据。

- 契约：[docs/architecture/m5-contracts.md](../../docs/architecture/m5-contracts.md) §1 / §0
- 关联：ADR-001（多进程）、ADR-007（启动器）、ADR-008（本地访问安全）、ADR-010（内部凭据）
- 零第三方依赖；Node >= 22.5（与 workspace 其余包一致）

## 命令

```text
atk start  [--port 1421] [--data <dir>] [--hosts 1] [--runtime mock] [--detach]
atk stop   [--data <dir>] [--force]
atk status [--data <dir>] [--json]
atk logs   [--data <dir>] [--follow]
```

| 命令 | 行为 | 退出码 |
|---|---|---|
| `start` | 拉起 backend → 等 health → 读 token → scheduler → hosts；写 `launcher.json` | 0 ok / 1 失败 / **2 已有存活实例** |
| `stop` | hosts → scheduler → backend；SIGTERM 等 5s，超时 SIGKILL；幂等 | 0（无实例也 0） |
| `status` | 每个子进程的 PID/存活/端口/健康；`--json` 机器可读 | 0 全健康 / 1 有 down 或 state 损坏 / 0 未运行 |
| `logs` | 打印 `logs/*.log`；`--follow` 追加 | 0 |

`status` 的 `running` 语义（QA6-02）：**所有 child 都 alive 且 health.ok** 才为 true；backend 被杀时 `running:false`、exit 1，同时保留 `statePresent:true` 和每个 child 的 `alive` 供排查。

数据目录默认 `%LOCALAPPDATA%\AgentTeamKit`（`ATK_DATA_DIR` 覆盖）：

```text
<dataDir>/
  data/atk.db          SQLite（backend serve 自动迁移）
  runtime/             各 Host 的 ATK_HOST_STATE_FILE（host-<i>.json）
  logs/                backend.log scheduler.log host-<i>.log launcher.log
  launcher.json        进程清单（不含 token）
```

## 状态文件（`launcher.json`）

```json
{
  "version": 1,
  "port": 1421,
  "startedAt": "2026-11-01T20:00:00.000Z",
  "children": [
    { "name": "backend", "pid": 100, "role": "backend" },
    { "name": "scheduler", "pid": 101, "role": "scheduler" },
    { "name": "host-1", "pid": 102, "role": "host" }
  ]
}
```

- 原子写：临时文件 + fsync + rename；读侧对缺失/损坏/超范围文件一律返回 `null`。
- **闭集校验**：多出字段（尤其任何 token/secret/credential 键）直接抛错，避免未来重构把凭据写盘。
- PID 是 `status`/`stop` 的唯一依据；进程死了 → `start` 清理陈旧状态后重启。
- **损坏状态（QA6-01）**：`launcher.json` 无法解析但 `runtime/launcher.pid` 存活时，`stop` 通过该 supervisor 的**内存子进程清单**按序清理；没有存活 supervisor 时 `stop`/`status` 明确 exit 1 并**保留** `launcher.json` 与 `launcher.pid`，`start` 也拒绝盲启（fail closed）。

## 内部 token 的处理（评审重点）

1. `start`/supervisor 从 backend stdout 读取一次 `internal token: <t>`；
2. 只放进 scheduler 与 hosts 的 **子进程 env**（`ATK_INTERNAL_TOKEN`），backend 自己的 env 永远没有它；
3. token 不写 `launcher.json`、不写日志、不进 `status` 输出：
   - backend 的 token 行被特殊处理，日志只记 “internal credential received …”；
   - 任何包含 `internal token:` 或 `x-atk-internal` 的行都不写原文，统一替换为 `[redacted] internal credential line filtered`；
   - 之后所有子进程输出还会按已知 token 做 `[REDACTED]` 替换；
   - 单测断言 state/日志/`status` JSON 都不含 token 字符串。

## 进程模型

`atk start` 会拉起一个 detached **supervisor**（`node cli.mjs __supervise`，日志 `logs/launcher.log`）。原因：backend 的 token 只在 stdout 出现一次，supervisor 必须活着持有子进程管道；命令本身在系统就绪后退出（`--detach` 目前是显式意图，行为相同）。

- 子进程命令与契约一致：`apps/backend/cli.mjs serve …`、`apps/scheduler/cli.mjs`、`apps/runtime-host/cli.mjs --owner host-<i>`；
- hosts 的 `ATK_HOST_STATE_FILE=<dataDir>/runtime/host-<i>.json`，崩溃后新 Host 的 `recover()` 能对账（ADR-010）；
- **有序停止**：supervisor 收到 stop 请求后按 hosts（新→旧）→ scheduler → backend 发送 SIGTERM，5s 超时再 SIGKILL；`atk stop` 本身也带同样的 fallback，因此 supervisor 崩溃时仍能清理；
- supervisor 的 stop 信号用 token-free 文件 `runtime/stop.request`（Windows 上无法可靠地向其它进程投递 POSIX 信号）；`process.kill` 仅用于本机子进程的 SIGTERM/SIGKILL；
- 所有 `spawn` 都带 `windowsHide: true`，不依赖 `pkill`。

## 模块

| 文件 | 内容 |
|---|---|
| `cli.mjs` | 子命令解析、supervisor 启动/就绪等待、stop/status/logs |
| `src/launcher.mjs` | `createLauncher({ dataDir, port, hosts, runtime, spawnImpl, fetchImpl, … })` → `start()/stop()/status()/readState()`；测试注入 fake spawn/clock/kill |
| `src/state.mjs` | `launcher.json` 校验、原子写、读、删除 |
| `src/health.mjs` | `checkHealth` / `waitForHealth`（默认 30s）、`loopbackUrl`、PID 存活探测 |

## 测试

```text
node --test apps/launcher/test/*.test.mjs
node apps/launcher/cli.mjs --help
```

单测覆盖：状态文件往返/原子写/闭集；start 幂等 + 存活实例 exit 2；死 PID 陈旧清理；损坏 `launcher.json` 的 stop/status/start fail-closed；SIGTERM 忽略时的 SIGKILL 升级；backend 未打印 token 即退出；health 超时；stop 顺序（hosts→scheduler→backend）与二次 stop 幂等；token 不落盘；CLI `--help`/未知参数/空 status/损坏状态退出码。
