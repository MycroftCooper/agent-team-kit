# ADR-007：部署形态——Windows 用户态 Launcher，暂不做 Windows Service

- 状态：**Proposed**
- 日期：2026-11-02
- 决策者：ARCH
- 关联：规范 §2.2、§12.3、§14（ATK-506）；ADR-001、ADR-008

## 背景

目标平台是 Windows 10/11 单用户本地优先。规范 §2.2 要求 `atk start/stop/status/doctor` 四个运维命令，并规定：`stop` 先停止派发 → 对账会话 → 受控停止，默认不丢弃执行证据；`doctor` 只读检查 Node/Git/DSH/Magpie 配置与端口，不修改凭据。

关键约束：Agent 子进程需要与**当前登录用户**的 DSH/Magpie 配置、Git 凭据、用户级环境变量一致。Windows Service 运行在 Session 0 / 独立账户下，天然拿不到这些。

## 决策

1. **v1.0 之前只做用户态 Launcher**，不做 Windows Service、不做开机自启（用户可自行放快捷方式）。理由：Session 0 隔离会让 Agent 无法访问用户配置与桌面交互，且调试/回收复杂。
2. **单实例**：`atk start` 先取 PID 锁文件（`%LOCALAPPDATA%\AgentTeamKit\runtime\atk.pid`，含启动时间与端口），已存在则拒绝重复启动；PID 存活但端口不响应视为脏锁，需 `--force-restart` 且必须确认。
3. **就绪探测**：`start` 逐个拉起 `atk-backend` → 等 `/api/v1/system/health` 返回 OK → 拉起 `atk-scheduler` / `atk-runtime-host` → 各自心跳上报。任一步超时按失败处理并回收已拉起进程。
4. **`stop` 是受控停机**：先拒绝新派发 → 等待在途 Run 落账或超时 → 对账会话（不确定的标 `INTERRUPTED`，不误判完成）→ 停止子进程。**默认不删除执行证据与租约记录**。
5. **`doctor` 只读**：Node/Git 版本、端口占用、DSH/Magpie 探测、配置是否存在、日志目录可写、DB 可读。**不修改任何凭据或用户配置**，输出机器可读 + 人读两种。
6. **日志与数据目录固定**（规范 §12.3）：`%LOCALAPPDATA%\AgentTeamKit\{data,backups,logs,worktrees,cache,runtime}`；项目仓库内只保留可版本控制的 `agent-flow.config.json`、角色合同与策略。
7. **浏览器关闭不停止服务**：Web 是纯客户端；关闭标签页不影响 Backend/Scheduler/Runtime。

## 理由

- 用户态是“能用”的前提：Agent 必须继承用户会话的凭据与环境。
- 单实例锁 + 就绪探测可以避免两个 Backend 同时持有 SQLite（ADR-002 单写者）造成的锁竞争与数据风险。
- 受控停机保护证据链，符合“不得以退出码/进程消失判定完成”的原则。

## 后果

**正面**：无需管理员权限安装；与用户 DSH/Magpie 环境一致；停机可控且可审计；`doctor` 让环境问题在派发前暴露。

**负面 / 代价**：不随开机启动；用户关掉终端/注销后服务停止（这正是我们希望的行为，但需要文档说明）；Windows 上子进程回收（job object / `kill` 树）要做专门测试。

**缓解**：`status` 汇报每进程 PID、端口、心跳、最近错误；`stop` 提供 `--timeout` 与 `--force`（后者需确认并写审计）。

## 替代方案

| 方案 | 为什么否决 |
|---|---|
| Windows Service | 拿不到用户配置/凭据，桌面交互受限，调试成本高 |
| 托盘常驻 + 全局快捷键 | 不是 M0-M5 的需求，先保证 CLII 可用；后续可作为包装层 |
| Docker/容器 | 违反本地优先与 Windows 单用户定位 |

## 兼容与迁移

`atk start/stop/status/doctor` 是**新增**命令（M5/ATK-506 实现），不影响既有 `atk serve`。既有 CLI 在无守护进程时仍可直接对项目运行。

## 回滚

删除 Launcher 只影响便捷性：三个进程也可分别手工启动，`lib/` 与既有 CLI 不受影响。
