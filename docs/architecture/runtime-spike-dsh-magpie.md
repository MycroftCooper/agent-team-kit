# DSH + Magpie Runtime Spike 报告（ATK-006 / ATK-006b）

- 状态：**Phase 1 只读探测完成 + Phase 2 隔离 DSH_HOME + 本地 mock 端点实测完成，等待 Lead 复核**
- 日期：2026-11-02（Phase 1 观测窗口 02:20:33–02:25:40；Phase 2 02:31–02:40 +08:00）
- 执行者：Worker `worker-runtime-spike`
- 分支 / commit：`m0/baseline-and-p0` / `aec31b6f95faa30b9e0cfcaf2d6235f59c94f780`
- 规范原文：`%USERPROFILE%\Downloads\Agent-Team-Kit-2.0-AI-Implementation-Technical-Spec.md`（**仓库外文件**，只读引用；§9.1 定义 `RuntimeCapabilities` 七项能力，§9.2 定义 RT-P01~RT-P10 矩阵与硬停止条件）
- 关联：[ADR-004](adr/ADR-004-runtime-model-boundary.md)
- 证据目录：[spike-evidence/](spike-evidence/)（Phase 1：21 个文件；Phase 2：22 个文件；大体积可再生生成物已裁剪为 summary/sample，见 §6.0）

> **最终结论（Phase 1 + Phase 2 合并）：真实 DSH 适配器仍**不能**标记为“生产可用”，但硬停止条件 ①（可靠启动）与 ②（观察结束状态）已在**隔离 DSH_HOME + 本地 mock 模型端点**下用真实 ACP 协议帧排除；③（阻止模型配置被覆盖）在两次 hash 快照中均为零写入。M2 可以基于 ACP v1 实现 `runtime-dsh` 的**实验性**适配（能力矩阵按实测标注），但**不得**在 RT-P07（真实 Magpie 路由）与剩余能力验证通过前宣称“可用”。

---

## 0. 结论速览

### 0.1 决策

| 问题 | 结论 |
|---|---|
| 真实 DSH 适配器能否标记“可用”？ | **不能（生产不可用）**；Phase 2 证明 ACP 路径在隔离+mock 下可跑通，但真实 Magpie 路由（RT-P07）、受限执行、会话级模型切换、多 Agent 并行仍未验证 |
| M2 是否可以用 `runtime-dsh` 替换 `MockRuntime`？ | **不可以直接替换**；可作为**实验性适配器**并行开发，`capabilitySnapshot` 必须按本报告实测结果逐项标注 |
| 硬停止条件 ① 可靠启动会话 | **已排除（限定隔离+mock）**：`initialize` → `session/new` 得到稳定 sessionId，进程退出码可控 |
| 硬停止条件 ② 观察结束状态 | **已排除（限定隔离+mock）**：`session/prompt` 返回 `stopReason: end_turn`，`session/update` 通知可机器解析 |
| 硬停止条件 ③ 阻止模型配置被覆盖 | **两次验证均零写入**：Phase 1 24/24、Phase 2 23/23 用户 DSH/Magpie CONFIG 文件 SHA-256 不变 |
| 是否产生真实模型请求 / 生产流量 | **没有**。Phase 2 的模型请求全部打到 `127.0.0.1:<mock>`；用户 Magpie（3425）与真实 Provider 均未被本 Spike 使用 |
| 是否创建用户会话 | **没有**。所有会话只落在隔离 `%TEMP%\atk-spike-phase2\home\sessions`；用户 `~/.dsh/sessions` 数量不变 |

### 0.2 能力口径校正（按规范 §9.1，替代 Phase 1 的临时口径）

Phase 1 报告曾按任务描述把能力归纳为“八项”并自造第 8 项；现依据规范原文 §9.1 校正为 **`RuntimeCapabilities` 七项**（规范路径见文首）：

```ts
export interface RuntimeCapabilities {
  canStart: boolean; canSend: boolean; canObserveStructuredEvents: boolean;
  canStop: boolean; canReconnect: boolean; canSpecifySessionModel: boolean; canRunRestricted: boolean;
}
```

§9.1 同时规定：实际不支持的能力必须 `false` 并返回 `CAPABILITY_UNAVAILABLE`；禁止靠正则解析终端文字推断 QA 完成、空闲或模型路由。本轮所有能力结论均来自 ACP JSON-RPC 帧或配置 dump，无终端文字解析。

### 0.3 证据边界（沿用 Phase 1 的诚实声明）

- **文档/代码存在 ≠ 运行时能力已验证**；Phase 2 的“已验证”只覆盖实际跑过的帧。
- **Phase 2 使用的是本地 mock 模型端点，不是用户真实的 Magpie/Provider**。因此它排除了“会话能不能起、事件能不能看”，但**不能**证明真实模型路由、真实 Token 计费、真实 Provider 错误处理。
- **未做网络抓包**；零外流的证明来自：隔离配置 baseURL 断言（G2）、mock 请求计数、Magpie usage 在空闲对照窗口同样增长（见 §3.5 G3）。
- 用户用户名/主目录已在公开证据中脱敏（见 §7），脱敏只替换路径字符串，不改变任何 hash/数值。

---

## 1. 环境与版本表

| 项目 | 值 | 证据 |
|---|---|---|
| 操作系统 | Windows 11 专业版（10.0.26200，25H2，64-bit） | [02-environment.txt](spike-evidence/02-environment.txt) |
| Windows PowerShell | 5.1.26100.9711（本机无 `pwsh`） | 同上 |
| Node.js / npm | v24.16.0 / 11.13.0 | 同上 |
| Git / ATK commit | 2.45.1.windows.1 / `aec31b6…`（`m0/baseline-and-p0`） | 同上 |
| DSH CLI | `@deepseek-ai/dsh` **0.2.1-rc.5**（`dsh --version` → `0.2.1-rc.5`，exit 0） | [03-dsh-cli-probes.txt](spike-evidence/03-dsh-cli-probes.txt) |
| DSH 桌面应用 | `%DSH_APP%\DeepSeek Harness.exe`；`app.asar` 182,766,714 B，SHA-256 `E1B6F25F…2C6915`；`runtime/versions.json` = node 24.21.0 / pnpm 11.28.5 | [02-environment.txt](spike-evidence/02-environment.txt) |
| DSH 运行态 | 6 个 `DeepSeek Harness` 进程；Web GUI `127.0.0.1:2675`（pid 42588）；`DSH_HOME=%USERPROFILE%\.dsh`、`DSH_PROFILE=desktop` | [10-ports.txt](spike-evidence/10-ports.txt)、[11-processes.txt](spike-evidence/11-processes.txt) |
| Magpie | **0.1.2629**（`magpie.exe`，SHA-256 `F5CA4783…FA4AB7E`）；监听 `127.0.0.1:3425`（pid 28160） | [14-magpie-dsh-route.txt](spike-evidence/14-magpie-dsh-route.txt) |
| 系统代理 | WinINET `ProxyEnable=1`、`127.0.0.1:7897`、bypass 含 `localhost;127.*`；进程无 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`；WinHTTP Direct | [12-proxy-env.txt](spike-evidence/12-proxy-env.txt) |
| Phase 2 隔离环境 | `DSH_HOME=%TEMP%\atk-spike-phase2\home`（进程级覆盖，未写用户目录）；mock 端点 `127.0.0.1:6168` | [phase2/g1-assertions.json](spike-evidence/phase2/g1-assertions.json) |

### 1.1 实现路径澄清

`%DSH_APP%\resources\app.asar` 是 182 MB 打包文件而非目录，`app.asar\dsh\` 是 asar 虚拟路径，普通 FS API 不可读。真实可读实现树是 npm 全局包 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\`（CLI + 内嵌 `node_modules\@deepseek-ai\dsh-*`）。本文所有包版本与 README 引用来自该树。

### 1.2 环境事实：本机是“活的”生产环境

- DSH 桌面应用与 Web GUI 正在运行，`~/.dsh/sessions` 有 28 个用户会话；观测窗口内多个会话日志持续写入（其他并行 Agent）。
- Magpie 正在服务这些会话：`routing/2026-11-02.jsonl` 与 `usage.jsonl` 持续增长，**空闲 8 秒对照窗口内仍增长 +1,066 B / +10,587 B**（见 [phase2/g3-assertions.json](spike-evidence/phase2/g3-assertions.json)）。这是 Phase 2 G3 必须区分背景流量与测试流量的原因。
- 用户 `desktop` profile 以 `link:` 挂载了本仓库插件 `dsh-agent-team-kit-board`（只读观察）。

---

## 2. 能力矩阵（规范 §9.1 七项，Phase 2 实测校正）

判定口径：`SUPPORTED` = 本轮有真实运行证据；`PARTIAL` = 部分路径验证；`UNVERIFIED` = 未运行验证。**Phase 2 证据全部来自隔离 DSH_HOME + mock 端点**，不代表生产环境。

| # | 能力（§9.1 字段） | 结论 | Phase 2 实测证据 | 限制 |
|---|---|---|---|---|
| 1 | `canStart` 启动会话 | **SUPPORTED（隔离+mock）** | ACP `initialize`（protocolVersion 1）→ `session/new` 返回 sessionId `b5d1dc4c-…`；进程可启动、可退出 | 仅 mock 模型；未在真实 Magpie/Provider 下验证 |
| 2 | `canSend` 发送消息 | **SUPPORTED（隔离+mock）** | 同一 sessionId 两次 `session/prompt`，分别收到 `MOCK_REPLY_1` / `MOCK_REPLY_2`，`stopReason: end_turn` | 同上 |
| 3 | `canObserveStructuredEvents` 结构化事件 | **SUPPORTED（隔离+mock）** | 捕获 `session/update` 通知，`update.sessionUpdate = agent_message_chunk / usage_update`；可按帧区分 | 权限请求、工具调用等事件未触发 |
| 4 | `canStop` 停止 | **PARTIAL** | `session/close` → 进程 exit code 0；强制 kill 后无孤儿进程 | “任务不被误判完成”未单独验证（中断回合的状态未核对） |
| 5 | `canReconnect` 重连 | **SUPPORTED（隔离+mock）** | 重启进程后 `session/list` 列出 2 个既有会话；`session/resume` 成功返回 configOptions，并在恢复会话上完成一轮 prompt | 未验证跨 cwd/跨 ownership 的拒绝语义 |
| 6 | `canSpecifySessionModel` 会话级模型选择 | **PARTIAL** | `session/new` 返回 `configOptions`（`id: model`，select，当前值 `["mock","mock/mock-model"]`）；说明会话级模型选项由原生协议暴露 | 未执行 `session/set_config_option` 实际切换并验证下一轮生效 |
| 7 | `canRunRestricted` 受限执行 | **UNVERIFIED** | 隔离 profile 已挂载 sandbox 相关插件（dump 可见 `sandbox`/`sandbox-policy`/`pwsh-sandbox`/`fs-sandbox`） | 未触发任何工具调用，未验证沙箱实际约束 |

**结论**：按 §9.1 的“必须诚实”原则，适配器现在应返回 `canStart/canSend/canObserveStructuredEvents/canReconnect = true（仅当运行环境与本次 PoC 等价）`，`canStop/canSpecifySessionModel = false（PARTIAL 不足以承诺）`，`canRunRestricted = false`。若面向用户真实环境（desktop/Magpie），全部应返回 `false` 直到 RT-P07 等验证完成。

### 2.1 实测 CLI 自省能力（Phase 1，不属于七项）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `dsh --version`（×2） | 0 | `0.2.1-rc.5` |
| `dsh --help` / `dsh plugin --help` | 0 | launcher / 插件管理帮助 |
| `dsh --dump-config`（无 `--profile`） | 1 | `error: --profile <name> is required` |
| `dsh --profile desktop --dump-config`（及 `--dump-default-config`、`--dump-config-schema`） | 1 | `error: profile "desktop" is managed exclusively by the Electron application` |
| `dsh --profile acp --dump-config` / `--dump-config-schema` | 0 | 17,354 B 树 / 603,257 B Schema（不挂载） |

### 2.2 已确认的 DSH 自动化接口

| 接口 | 包 | 形态 | 文档事实（原样引用见 [15](spike-evidence/15-dsh-automation-surfaces.txt)） |
|---|---|---|---|
| ACP v1 | `dsh-acp-app` + `dsh-acp` | `dsh --profile acp`，stdout 仅 ACP JSON-RPC | `initialize` → `session/new` → `session/prompt` → `session/close`；另有 `session/list`/`session/resume`/`session/set_config_option`/`session/cancel` |
| SDK | `dsh-sdk-app` / `dsh-sdk-minimal` | `dsh --profile sdk`，stdio JSON-RPC | provider/model 与 cwd 由初始化请求传入 |
| Headless | `dsh-headless` | `dsh --profile headless "<task>"` | 一次性任务；`--json` 事件流；`--session-id` 续接；exit 0/1 |

---

## 3. RT-P01 ~ RT-P10 逐条结果（Phase 1 + Phase 2 合并）

| 用例 | 操作 | 通过标准（规范 §9.2） | 实际结果 | 状态 | 证据 |
|---|---|---|---|---|---|
| RT-P01 CLI/ACP 探测 | `dsh --version/--help/--dump-config*` | 明确版本和能力、失败时清晰错误 | 版本/帮助/配置转储可用；`desktop` 被拒错误清晰；ACP 能力由 `initialize` 声明 | **PASS** | [03](spike-evidence/03-dsh-cli-probes.txt)、[08](spike-evidence/08-dsh-profile-probes.txt)、[phase2/protocol-frames-key.txt](spike-evidence/phase2/protocol-frames-key.txt) |
| RT-P02 启动新会话 | Phase 2：隔离 DSH_HOME 启动 `dsh --profile acp` → `initialize` → `session/new` | 获得稳定 sessionId、Run 事件及退出结果 | sessionId `b5d1dc4c-…`；`session/update` 事件可观测；`session/close` 后 exit 0 | **PASS（隔离+mock）** | [phase2/acp-summary.json](spike-evidence/phase2/acp-summary.json) |
| RT-P03 发送两轮消息 | 同一 sessionId 连续两次 `session/prompt` | 同一会话连续调用成功 | 两轮均 `stopReason: end_turn`，mock 分别返回 `MOCK_REPLY_1/2` | **PASS（隔离+mock）** | [phase2/acp-summary.json](spike-evidence/phase2/acp-summary.json)、[phase2/mock-requests.summary.json](spike-evidence/phase2/mock-requests.summary.json)、[sample](spike-evidence/phase2/mock-requests.sample.ndjson) |
| RT-P04 运行中状态 | 两轮之间读事件流 / prompt 响应 | 可靠区分运行中/结束/需输入，或明确不支持 | 可区分：prompt 未返回=运行中；`stopReason`=结束；`session/update` 有序到达。“需输入/权限”未触发，协议声明支持但在本轮未观测 | **PARTIAL** | 同上 |
| RT-P05 停止/异常退出 | `session/close`；运行中强制 kill | 子进程回收、任务不被误判完成 | close → exit 0；kill 后 `session/list` 仍可列出会话、无孤儿 `dsh --profile acp` 进程；“误判完成”未单独核对 | **PARTIAL** | [phase2/acp2-summary.json](spike-evidence/phase2/acp2-summary.json)、[phase2/g1-isolated-home-runtime-files.txt](spike-evidence/phase2/g1-isolated-home-runtime-files.txt) |
| RT-P06 重启对账 | 杀进程后重启 → `session/list` → `session/resume` → prompt | 会话可恢复，或明确标记不可恢复且不双启动 | `session/list` 列出 2 个会话；`session/resume` 成功并返回 configOptions；恢复会话上 prompt 成功 | **PASS（隔离+mock）** | [phase2/acp2-summary.json](spike-evidence/phase2/acp2-summary.json) |
| RT-P07 Magpie 路由验证 | 只读检查 3425/配置/连接；Phase 2 未使用真实 Magpie | 实际请求经过用户指定网关，未切换官方 Provider | Phase 1 已证实路由存在且活着（3425 监听、baseURL 指向、ESTABLISHED 连接）；Phase 2 **故意改用 mock**，**没有**发出任何经 3425 的请求 | **PARTIAL** | [10](spike-evidence/10-ports.txt)、[14](spike-evidence/14-magpie-dsh-route.txt) |
| RT-P08 多 Agent 并行 | 2 个独立会话、独立工作区 | 无配置相互覆盖 | Phase 2 时间盒内未执行（会话串行；`session/list` 可见多会话但未并行驱动） | **UNVERIFIED** | — |
| RT-P09 原生配置前后比对 | 55 文件 SHA-256 前/后快照（Phase 1）+ 24 CONFIG 复发验证（Phase 2） | 结束后配置未被无授权改写 | Phase 1：24/24 一致；Phase 2：23/23 用户 DSH/Magpie CONFIG 一致（`<repo>\agent-flow.config.json` 由并行 Worker 修改，非用户配置） | **PASS** | [01](spike-evidence/01-config-snapshot-before.json)、[17](spike-evidence/17-config-snapshot-after.json)、[18](spike-evidence/18-config-snapshot-diff.txt)、[phase2/rt-p09-recurrence.json](spike-evidence/phase2/rt-p09-recurrence.json) |
| RT-P10 代理回环访问 | 记录代理变量 + 隔离目录 Node TCP 回环 | 系统代理下 loopback 正常或明确诊断 | 进程无代理变量；WinINET 启用但 bypass 含回环；Node TCP 2675/3425 均 2 ms 连通、3426 ECONNREFUSED | **PARTIAL** | [12](spike-evidence/12-proxy-env.txt)、[13](spike-evidence/13-loopback-tcp.json) |

### 3.5 Phase 2：隔离 DSH_HOME + 本地 mock 端点实测

**安全模型**：进程级 `DSH_HOME=%TEMP%\atk-spike-phase2\home`；profile 由 `dsh` 在隔离 home 内自动初始化后，由本 Spike 写入 mock provider 的 patch；mock 端点为本地 Node 内置 `http`，只实现 `GET /v1/models`、`POST /v1/chat/completions`（SSE/非流式）、`POST /v1/responses`；使用假 key `MOCK_API_KEY=mock-fake-key`；未复制用户凭据。

#### G1 隔离校验：**PASS**

- 命令：`$env:DSH_HOME=%TEMP%\atk-spike-phase2\home; dsh --profile acp --dump-config` → exit 0，12,126 B。
- 输出中不出现用户 `%USERPROFILE%\.dsh` 路径（结构化检查为 false）；`dsh` 自动在隔离 home 下创建 `profiles\acp\`（4 个文件），证明 `DSH_HOME` 覆盖生效。
- 运行时证据：两次 ACP 运行后，会话只写入 `%TEMP%\atk-spike-phase2\home\sessions\**`（2 个 session 目录），用户 `~/.dsh/sessions` 数量保持 28。
- 证据：[phase2/g1-isolated-home-dump-config.txt](spike-evidence/phase2/g1-isolated-home-dump-config.txt)、[phase2/g1-assertions.json](spike-evidence/phase2/g1-assertions.json)、[phase2/g1-isolated-home-runtime-files.txt](spike-evidence/phase2/g1-isolated-home-runtime-files.txt)

#### G2 模型端点替换：**PASS**

- 在隔离 profile 写入 patch：`llm-pi-ai.providers.mock.baseURL = http://127.0.0.1:6168/v1`、`agent-default-model.provider/model = mock / mock/mock-model`、`acp.provider/model = mock / mock/mock-model`。
- 再次 `dsh --profile acp --dump-config` → exit 0；断言：mock URL 出现在生效配置、`agent-default-model` 与 `acp` 的 provider 均为 mock；残余 `deepseek-official` 仅 1 处，是 `searchProvider: deepseek-official`（Web 搜索，不是模型 baseURL）。
- 证据：[phase2/g2-dump-config-with-mock.txt](spike-evidence/phase2/g2-dump-config-with-mock.txt)、[phase2/g2-assertions.json](spike-evidence/phase2/g2-assertions.json)

#### G3 零外流校验：**PASS（带背景流量说明）**

- 基线（mock 启动前）：Magpie usage 1,544,266 B、routing 3,991,707 B、用户 sessions 28、隔离 home 4 文件。
- mock 启动后：usage 1,544,799 B（+533 B）、routing 3,997,003 B（+5,296 B）——**此时测试尚未开始**，增长来自本机其他活跃 DSH 会话。
- ACP 运行后：usage 1,546,392 B、routing 4,012,874 B；mock 记录到的模型请求：**2 次**（run 1 两轮）+ **2 次**（run 2 恢复后一轮 + 中止测试），全部是 `POST /v1/chat/completions` 到 `127.0.0.1:6168`，没有一个请求走 `127.0.0.1:3425` 或外网。
- 背景对照：**空闲 8 秒（无任何测试）** usage +1,066 B、routing +10,587 B → 证明 Magpie 增长是背景生产流量，不是本 Spike 造成。
- 证据：[phase2/g3-baseline.json](spike-evidence/phase2/g3-baseline.json)、[phase2/g3-after-mock-start.json](spike-evidence/phase2/g3-after-mock-start.json)、[phase2/g3-after-acp-run.json](spike-evidence/phase2/g3-after-acp-run.json)、[phase2/g3-assertions.json](spike-evidence/phase2/g3-assertions.json)、[phase2/mock-requests.summary.json](spike-evidence/phase2/mock-requests.summary.json)、[phase2/mock-requests2.summary.json](spike-evidence/phase2/mock-requests2.summary.json)（原始 53 KB 捕获不入库，见 §6.0；sample 与 summary 保留前 3 条记录）

#### 协议帧与退出码（关键摘录）

| 步骤 | 命令/方法 | 结果 |
|---|---|---|
| 启动 | `cmd /c dsh --profile acp`（env: 隔离 DSH_HOME + MOCK_API_KEY） | 进程启动；stdout 为 NDJSON ACP 帧 |
| 初始化 | `initialize {protocolVersion:1, clientCapabilities:{}, clientInfo:{name:"atk-spike-phase2"}}` | `protocolVersion: 1`；`agentInfo.name=deepseek-harness-acp`；`sessionCapabilities: {close,list,resume}`；`authMethods: []` |
| 新会话 | `session/new {cwd: %TEMP%\...\ws, mcpServers: []}` | `sessionId: b5d1dc4c-b5b8-4d54-8d5c-03dc266e4f62`；`configOptions[0] = {id:"model", currentValue:"[\"mock\",\"mock/mock-model\"]"}` |
| 第一轮 | `session/prompt {sessionId, prompt:[{type:"text",...}]}` | `stopReason: end_turn`；通知 `agent_message_chunk`（`MOCK_REPLY_1`）+ `usage_update` |
| 第二轮 | 同上（同一 sessionId） | `stopReason: end_turn`；`MOCK_REPLY_2` |
| 关闭 | `session/close {sessionId}` | `{}`；随后进程 exit code 0 |
| 异常 | 运行中 `kill` | 子进程结束；重启后 `session/list` 仍列出该会话；无孤儿进程 |
| 重启对账 | `session/list {cwd}` → `session/resume {sessionId, cwd, mcpServers:[]}` → prompt | list 返回 2 个会话；resume 返回 `configOptions`；恢复后 prompt → `MOCK_REPLY_2`、`stopReason: end_turn` |

完整帧：[phase2/acp-frames.ndjson](spike-evidence/phase2/acp-frames.ndjson)、[phase2/acp2-frames.ndjson](spike-evidence/phase2/acp2-frames.ndjson)；摘要：[phase2/acp-summary.json](spike-evidence/phase2/acp-summary.json)、[phase2/acp2-summary.json](spike-evidence/phase2/acp2-summary.json)。

#### 为什么这仍不足以宣称“可用”

1. **RT-P07 未过**：规范要求“实际请求经过用户指定网关，未切换为官方 Provider”。Phase 2 为避免生产流量**主动用 mock 替代 Magpie**，因此真实 Magpie 路由链（DSH→3425→上游）仍未验证。
2. **能力仅部分**：`canStop`/`canSpecifySessionModel` 只到 PARTIAL，`canRunRestricted`/RT-P08 未验证。
3. **环境不等价**：mock 模型没有真实 Provider 的错误、限流、计费、长流式行为；Phase 2 断言的“可靠”只限协议层。
4. **desktop profile 不可复用**：CLI 明确拒绝 `desktop`，ATK 只能面向 `acp/sdk/headless` 新 profile，这与“复用用户现成会话”是不同产品路径。

---

## 4. 硬停止条件结论（规范 §9.2）

规范原文（§9.2）：“若无法可靠启动会话、观察结束状态或阻止模型配置覆盖，先停在 Mock Runtime，不得将真实 DSH 适配器标记‘可用’。”

| 硬停止条件 | Phase 1 | Phase 2 | 综合判定 |
|---|---|---|---|
| ① 无法可靠启动会话 | 未验证 | **已排除（隔离+mock）**：ACP `initialize`+`session/new` 稳定返回 sessionId，进程可控退出 | 条件不再以“无法启动”为由成立 |
| ② 无法观察结束状态 | 未验证 | **已排除（隔离+mock）**：`stopReason` + `session/update` 可机器判定 | 条件不再以“无法观察”为由成立 |
| ③ 无法阻止模型配置被覆盖 | 零写入（Phase 1） | 零写入（Phase 2，23/23 用户 CONFIG 不变） | 短期零写入成立；长期行为仍无法验证（适配器未实现） |

**最终结论（回答“现在能否标记 DSH 适配器可用”）**：

> **生产环境：不能。** 隔离 PoC 只证明 ACP 协议路径可用；真实 Magpie 路由（RT-P07）、受限执行、多 Agent 并行、会话级模型切换仍未验证，且 PoC 使用的是 mock 模型而非用户真实 Provider。
> **研究/开发环境：可以**把 ACP 适配器作为 `packages/runtime-dsh` 的**实验性实现**推进，但 `capabilitySnapshot` 必须严格照 §2 标注（生产运行时全部降级为 `false` + `CAPABILITY_UNAVAILABLE`），并在 UI/调度上继续默认使用 `MockRuntime`。
> 满足 RT-P07 + P08 + 剩余能力后，才能在用户真实环境复跑同一矩阵并考虑标“可用”。

### 4.1 改判所需的最小证据集

1. RT-P07：一次受控请求经真实 Magpie（3425）并可在 Magpie 侧核对，**未切换官方 Provider**；
2. `session/set_config_option` 实际切换 model 并验证下一轮生效（canSpecifySessionModel → SUPPORTED）；
3. 一次工具调用 + 沙箱拒绝路径（canRunRestricted）；
4. 2 个会话并行、独立工作区、配置不互相覆盖（RT-P08）；
5. 断开/超时/Provider 错误下的停止与恢复（canStop 补全）；
6. 用户真实环境复跑 RT-P01~P10，配置 hash 前后一致。

---

## 5. 未验证清单与所需人工授权

| # | 未验证项 | 为什么本轮不能做 | 所需授权 / 建议 |
|---|---|---|---|
| 1 | RT-P07 真实 Magpie 路由 | Phase 2 用 mock 规避生产流量；Magpie 正承载用户会话 | 批准一次受控、可计费上限的真实请求；或提供独立测试用 Magpie 实例/隔离配置 |
| 2 | 受限执行（canRunRestricted） | 需真实工具调用 | 在隔离会话里跑 `echo`/文件写入并检查沙箱策略与拒绝路径 |
| 3 | 会话级模型切换 | 需 `session/set_config_option` | 隔离 mock 环境即可（无需真实模型），下一轮可补 |
| 4 | RT-P08 多 Agent 并行 | 时间盒内未做 | 隔离 home + mock，并行 2 个 ACP 会话 |
| 5 | 停止“不误判完成” | 未核对中断回合持久化状态 | 中断后检查 session 日志的 `turn/end` 与 `stopReason` |
| 6 | desktop profile 能否被观察 | CLI 明确拒绝 Electron 管理的 profile | 产品决策：ATK 只面向 acp/sdk/headless，或接入 Web GUI 只读协议（需单独授权） |
| 7 | 凭据注入 | 本轮 mock 使用假 key，未读用户密钥 | 约定只从环境变量继承、日志脱敏 |

> 底线不变：不写用户 `~/.dsh`、不写 `~/.config/magpie`、不碰 `cordis.patch.yml`、不发真实模型请求；隔离目录用完删除，并以 hash 前后比对作为证据。

---

## 6. 证据文件清单

### 6.0 生成物裁剪说明（仓库重量控制）

为控制仓库体积（`docs/architecture/**` 目标 < 300 KB），两类**可再生、体积大**的生成物不直接入库，改为 summary/sample 保留可复现性与校验值：

1. **ACP profile JSON Schema**：原 `09-dsh-dump-config-schema-acp.json`（603,221 B）已替换为 [09-dsh-dump-config-schema-acp.summary.json](spike-evidence/09-dsh-dump-config-schema-acp.summary.json)。summary 记录 `sourceCommand`、`bytes`、`sha256`（原完整文件 hash）、`$schema` 版本、`title`、`topLevelProperties`（前 40 个顶层键）与 `propertyCount`；**完整 schema 不入库**，可用 `dsh --profile acp --dump-config-schema` 重新生成，并用该 sha256 校验一致性。
2. **mock 端点 HTTP 捕获**：原 `mock-requests.ndjson` / `mock-requests2.ndjson`（各 ~53 KB）已替换为 `*.sample.ndjson`（前 3 条记录，`body.tools` schema 省略以控制体积，prompt/messages 保留）+ `*.summary.json`（原始总字节、sha256、请求数、model/path/status 计数）；**原始文件不入库**，可由本地 mock harness 复现，sha256 用于一致性校验。

裁剪只影响可再生的转储/捕获文件；哈希、时间戳、退出码、协议帧与结论均未改变。Phase 1 的原始日志（`08-dsh-profile-probes.txt`、`15-dsh-automation-surfaces.txt`）里出现的原文件名是当时的真实输出，按原始证据原则保留原文未改；实际文件以本节与索引为准。

### 6.1 Phase 1（spike-evidence/，21 个文件）

| 文件 | 用途 |
|---|---|
| [01-config-snapshot-before.json](spike-evidence/01-config-snapshot-before.json) | 55 个配置/运行时文件 SHA-256、大小、mtime（BEFORE） |
| [02-environment.txt](spike-evidence/02-environment.txt) | OS/Node/npm/git/ATK commit/DSH 版本/app.asar hash/Magpie/DSH 环境变量/会话计数 |
| [03-dsh-cli-probes.txt](spike-evidence/03-dsh-cli-probes.txt) | `dsh --version`(×2)/`--help`/`plugin --help` 完整输出、退出码、耗时 |
| [04](spike-evidence/04-dsh-dump-config-desktop.yml)/[05](spike-evidence/05-dsh-dump-default-config.yml)/[06](spike-evidence/06-dsh-dump-config-schema.json) | desktop profile 被 CLI 拒绝（exit 1）的三份原文 |
| [07-dsh-dump-config-acp.yml](spike-evidence/07-dsh-dump-config-acp.yml) | ACP profile 组成树（17,354 B） |
| [08-dsh-profile-probes.txt](spike-evidence/08-dsh-profile-probes.txt) | profile 探测命令/退出码/耗时 |
| [09-dsh-dump-config-schema-acp.summary.json](spike-evidence/09-dsh-dump-config-schema-acp.summary.json) | ACP profile JSON Schema 摘要（原 603,221 B 完整 schema 不入库；含 sourceCommand/bytes/sha256/顶层键） |
| [10-ports.txt](spike-evidence/10-ports.txt) | 2675/3425 监听与连接表 |
| [11-processes.txt](spike-evidence/11-processes.txt) | DeepSeek Harness ×6、magpie ×1、node 进程快照 |
| [12-proxy-env.txt](spike-evidence/12-proxy-env.txt) | 代理变量 + WinINET/WinHTTP 设置 |
| [13-loopback-tcp.json](spike-evidence/13-loopback-tcp.json) | Node 回环 TCP 结果 |
| [14-magpie-dsh-route.txt](spike-evidence/14-magpie-dsh-route.txt) | Magpie 版本/hash、DSH→Magpie 配置摘录（凭据脱敏）、活跃连接 |
| [15-dsh-automation-surfaces.txt](spike-evidence/15-dsh-automation-surfaces.txt) | ACP/SDK/headless 包元数据、README 引用、`rejectElectronProfile` 代码、mock/replay 缺失核对 |
| [16-evidence-index.txt](spike-evidence/16-evidence-index.txt) | 本目录索引 + 每文件 SHA-256 |
| [17-config-snapshot-after.json](spike-evidence/17-config-snapshot-after.json) | 同一批 55 文件 AFTER 快照 |
| [18-config-snapshot-diff.txt](spike-evidence/18-config-snapshot-diff.txt) | RT-P09 判定：CONFIG 0 变化 / RUNTIME_STATE 7 变化 |
| [19-session-and-process-audit.txt](spike-evidence/19-session-and-process-audit.txt) | 会话数、进程与命令行审计 |
| [20-safety-audit.txt](spike-evidence/20-safety-audit.txt) | 执行/拒绝执行命令清单、无新会话声明 |
| [21-git-state.txt](spike-evidence/21-git-state.txt) | 只读 git 状态与 .gitignore 检查 |

### 6.2 Phase 2（spike-evidence/phase2/）

| 文件 | 用途 |
|---|---|
| [g1-isolated-home-dump-config.txt](spike-evidence/phase2/g1-isolated-home-dump-config.txt) / [g1-assertions.json](spike-evidence/phase2/g1-assertions.json) | G1：DSH_HOME 覆盖生效、输出无用户 `.dsh` 路径 |
| [g1-isolated-home-runtime-files.txt](spike-evidence/phase2/g1-isolated-home-runtime-files.txt) | G1 运行时：DSH 实际写入的隔离 home 文件（含 sessions） |
| [g2-dump-config-with-mock.txt](spike-evidence/phase2/g2-dump-config-with-mock.txt) / [g2-assertions.json](spike-evidence/phase2/g2-assertions.json) | G2：生效配置 baseURL = mock、provider 全部替换 |
| [g3-baseline.json](spike-evidence/phase2/g3-baseline.json) / [g3-after-mock-start.json](spike-evidence/phase2/g3-after-mock-start.json) / [g3-after-acp-run.json](spike-evidence/phase2/g3-after-acp-run.json) / [g3-assertions.json](spike-evidence/phase2/g3-assertions.json) | G3：基线/运行后对比、空闲对照窗口、结论 |
| [mock-requests.sample.ndjson](spike-evidence/phase2/mock-requests.sample.ndjson) / [mock-requests.summary.json](spike-evidence/phase2/mock-requests.summary.json) / [mock-requests2.sample.ndjson](spike-evidence/phase2/mock-requests2.sample.ndjson) / [mock-requests2.summary.json](spike-evidence/phase2/mock-requests2.summary.json) | mock 端点 HTTP 捕获：sample 前 3 条记录（tools 省略）、summary 含原始 bytes/sha256/请求数/model/path/status 计数；原始 53 KB 捕获不入库 |
| [acp-frames.ndjson](spike-evidence/phase2/acp-frames.ndjson) / [acp-summary.json](spike-evidence/phase2/acp-summary.json) / [acp-stderr.log](spike-evidence/phase2/acp-stderr.log) | 运行 1：完整 ACP 帧、摘要、stderr（空） |
| [acp2-frames.ndjson](spike-evidence/phase2/acp2-frames.ndjson) / [acp2-summary.json](spike-evidence/phase2/acp2-summary.json) / [acp2-stderr.log](spike-evidence/phase2/acp2-stderr.log) | 运行 2：异常 kill、session/list、resume |
| [protocol-frames-key.txt](spike-evidence/phase2/protocol-frames-key.txt) | 关键协议帧摘录（截断） |
| [rt-p09-recurrence.json](spike-evidence/phase2/rt-p09-recurrence.json) | Phase 2 结束后 24 个 CONFIG 的 RT-P09 复发验证 |
| [phase2-evidence-index.txt](spike-evidence/phase2/phase2-evidence-index.txt) | Phase 2 证据索引 + SHA-256 |

---

## 7. 证据脱敏说明

- **原因**：仓库将发布到 GitHub，证据中不应包含本机用户名与真实主目录。
- **规则（Phase 1 + Phase 2 全部证据文件与本文）**：
  | 原值 | 占位符 |
  |---|---|
  | `C:\Users\<用户名>` | `%USERPROFILE%` |
  | `C:\Users\<用户名>\AppData\Local\Temp` | `%TEMP%` |
  | 仓库绝对根路径（含 `/` 与 JSON 转义形式） | `<repo>` |
  | DSH 桌面安装根路径（含 JSON 转义形式） | `%DSH_APP%` |
- **实现**：字节级字面替换（只替换路径字符串），未重新格式化、未重新序列化、未改动任何数字/时间戳/hash 字段。
- **影响范围**：Phase 1 + Phase 2 证据文件与本文正文共 21 个文件；共替换 200+ 处路径字符串。
- **声明**：**脱敏不改变任何 hash、字节计数、时间戳、端口、退出码、版本号与结论**。证据索引中的 SHA-256 是脱敏**后**文件自身的 hash，用于完整性校验；文中引用的配置/应用 hash 是脱敏**前**被测对象的 hash，未被替换。
- **可复现性**：命令原文保留，只把本机绝对路径换成占位符；复现时按占位符替换为本机路径即可。

---

## 附录 A：命令与退出码（Phase 1 + Phase 2）

| 命令 / 操作 | 退出码 / 结果 |
|---|---|
| `dsh --version`（×2）/ `--help` / `plugin --help` | 0 |
| `dsh --dump-config`（无 `--profile`） | 1；`error: --profile <name> is required` |
| `dsh --profile desktop --dump-config*` | 1；`error: profile "desktop" is managed exclusively by the Electron application` |
| `dsh --profile acp --dump-config` / `--dump-config-schema` | 0 |
| Phase 2 G1：`DSH_HOME=<temp> dsh --profile acp --dump-config` | 0；自动创建隔离 profile |
| Phase 2 G2：同上（mock patch 后） | 0；baseURL 断言为 mock |
| Phase 2 ACP：`initialize` / `session/new` / `session/prompt`×2 / `session/close` | 全部成功；进程 exit 0 |
| Phase 2 ACP：运行中 kill；重启 `session/list` / `session/resume` / prompt | kill 后无孤儿；list/resume/prompt 成功；exit 0 |
| `node loopback-probe.js` | 0；2675/3425 connected，3426 ECONNREFUSED |

## 附录 B：安全证据摘要

- **用户配置零改动**：Phase 1 24/24 CONFIG 一致；Phase 2 23/23 用户 DSH/Magpie CONFIG 一致（另 1 个 `<repo>\agent-flow.config.json` 由并行 Worker 修改）。
- **零真实模型请求**：Phase 2 所有模型请求都记录在 mock 端点（`127.0.0.1:<mock>`），共 4 次（2 轮 + 2 次异常/恢复测试）；mock 之外无请求。
- **零生产 Magpie 流量**：隔离 profile baseURL = mock；Magpie usage 增长在空闲对照窗口同样出现，属背景生产会话。
- **零用户会话写入**：隔离 home `sessions` 只有测试会话；用户 `~/.dsh/sessions` 数量不变（28）。
- **写域**：仅 `docs/architecture/runtime-spike-dsh-magpie.md`、`docs/architecture/spike-evidence/**` 与临时隔离目录；未改 `lib/**`、`test/**`、包配置、`.agent-flow/**`、用户 `~/.dsh`、`~/.config/magpie`；未执行改 git 状态的命令。

## 附录 C：与规范 §9.1/§9.2 的对应

| 规范要求 | 本报告对应 | 结论 |
|---|---|---|
| §9.1 `RuntimeCapabilities` 七项 | §2 能力矩阵 | 4 项 SUPPORTED（隔离+mock）、2 项 PARTIAL、1 项 UNVERIFIED |
| §9.1 不支持必须 `false` + `CAPABILITY_UNAVAILABLE` | §2 结论段 | 生产环境全部应 false；实验环境按实测标注 |
| §9.2 RT-P01~P10 矩阵 | §3 表 | P01/P02/P03/P06/P09 PASS；P04/P05/P07/P10 PARTIAL；P08 UNVERIFIED |
| §9.2 硬停止条件 | §4 | ①② 在隔离+mock 下排除；③ 两次零写入；生产可用仍需 §4.1 证据 |
| §9.2 记录 DSH/Magpie/ATK/Windows/Node 版本与命令、退出码 | §1、附录 A | 已记录；网关请求 ID/真实路由未取得（RT-P07 未过） |
| §0 第 3 款 隔离测试配置 | G1 隔离 DSH_HOME | 已做到 |
| §0 第 4 款 不得声称未运行通过 | 全文 | 未运行用例全部标 UNVERIFIED/PARTIAL，无 PASS 造假 |

---

*Phase 1 仅 RT-P09 为 PASS；Phase 2 使 RT-P01/P02/P03/P06 达到“隔离+mock”通过，但生产可用结论不变：不标“可用”。*
