# Codex / DSH 单次 Bug 执行器

`atk-agent run` 使用本机 Codex 或 DSH CLI，领取一个明确指定的 Bug，修复后运行检查、
提交回执并退出。它不配置模型、不批准或验收任务、不提交或推送 Git，也不常驻轮询。
ATK 后端仍只负责协作；AI 进程由这个独立的外部客户端启动。

## 使用

需要 Node.js 24、Git。默认引擎为 Codex，需要支持 `exec --json --output-schema --output-last-message` 的
Codex CLI。先在外部终端完成 `codex login`，用 `codex login status` 确认登录。
模型沿用 Codex 配置，执行时使用 `workspace-write` 沙箱；不会使用绕过审批或沙箱的参数。
Windows 自动寻找 PATH 中的原生 `codex.exe`；只有 `.cmd/.bat` 包装器时需用
`--codex <codex.exe 的完整路径>` 指定原生可执行文件。

1. 在 ATK 登记已有 Git 项目，创建该项目的 WORKER 身份。
2. 在「Bug 单」创建 Bug，选择该 WORKER 的角色并声明文件范围。
3. 在外部 PowerShell 设置凭据，运行一次：

```powershell
$env:ATK_URL = 'http://127.0.0.1:1421'
$env:ATK_AGENT_TOKEN = '<该项目 WORKER 的凭据>'
node apps/agent-cli/cli.mjs run --task <bugId> --check 'node --test test/example.test.mjs'
# 安装包也可直接使用：atk-agent run --task <bugId> --check '<检查命令>'
```

### 使用 DSH

增加 `--engine dsh` 即切换到 DeepSeek Harness 的 headless CLI。支持 `dsh` 在 PATH
中的独立可执行文件，以及 Windows 官方桌面版附带的 `resources/runtime/cli/bin/dsh.cmd`：

```powershell
node apps/agent-cli/cli.mjs run --engine dsh --task <bugId> --check '<检查命令>'
# 桌面版未加入 PATH 时，直接指定已有的 CLI，无需安装另一个 DSH：
node apps/agent-cli/cli.mjs run --engine dsh --dsh '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd' --task <bugId> --check '<检查命令>'
```

桌面版通过其原生 Electron-as-Node 入口调用，不把 `.cmd` 路径拼进 shell。
执行器固定运行 `--profile headless --json --permission-mode workspace-write --approval-policy never -`，
任务经 stdin 传入，不启动 DSH 网页或另一个服务。模型的最终回答需为
`{"outcome":"IMPLEMENTED"|"BLOCKED","summary":"..."}`；执行器只读取该会话末尾
`reason.kind=completed` 的 `final` 事件，拒绝缺失、失败、截断或错会话的结果。
日志里的工具输出和普通文字不会被当作成功回执。

Windows 官方桌面版若没有单独选择 headless 模型，会自动沿用当前 desktop profile 的
provider、model 和 reasoningEffort，仅生成本次运行的临时选择文件。
连接和认证仍由 DSH 自己处理，不复制凭据、修改桌面设置或加载桌面 UI 插件。
已有 headless 模型选择优先。自定义环境可用重复的 `--dsh-patch <文件>` 明确传入
headless 配置；指定后不自动生成桌面模型选择覆盖层。

Codex 与 DSH 共用文件范围审计、租约、停止、检查及幂等提交逻辑。
默认状态分别在 `runners/codex/` 与 `runners/dsh/` 下，已有 Codex 调用不变。

`--check` 可重复，执行器顺序运行任务规定的检查及这些额外命令。命令使用项目根目录和
本机 shell，必须来自已批准任务或操作者；检查的退出码及日志由执行器采集，不采信
模型自述的测试结果。Bug 单目前不声明强制检查，使用时应显式提供项目验证命令。

`--wait` 为领取等待时间，默认 0，最大 30000 毫秒。没有可领任务时退出并返回 `idle:true`。
`--timeout-ms` 是每个 Agent/检查命令的超时，默认 900000 毫秒，范围 1000–86400000。
检查非零、无效 JSON、实现受阻或范围审计失败会提交 FAILED。只有 Codex 报告
IMPLEMENTED、检查通过且范围审计通过，才提交 COMPLETED；Bug 随后进入待人工验收。
Agent 无法在沙箱内自行运行某项测试时应在摘要说明；最终检查由执行器独立运行。

ATK 凭据不会传入 Agent 或检查子进程。项目文件范围仍是协议约束；Agent 的
`workspace-write` 沙箱针对整个项目，不提供逐文件的写入隔离。执行器比较执行前后的
Git 可见文件内容及 HEAD/分支，发现范围外变化即拒绝完成，不自动回滚。忽略文件、
Git 索引和其他 Git 元数据不属于这项内容审计；遵守协议仍是必要条件。
已有未提交改动会作为基线保留。目标项目必须是有初始提交、检出分支的 Git 工作区。

## 停止与恢复

执行器按 ATK 规定周期续租，并在租约到期前预留五秒停止时间。停止请求、续租错误、
续租超时或 Ctrl+C 会停止进程树；只有监督器确认子进程全部结束，才提交停止后的回执。
Windows 使用 kill-on-close Job Object，POSIX 使用进程组，复用现有自动化的监督机制。
无法确认停止时保留恢复状态，不声明 `stopped:true`。

默认状态位于 ATK 数据目录 `runners/<引擎>/<身份与服务哈希>/`，可用 `--state-dir` 覆盖。
不要把状态目录放在 Git 可见的源码目录里，也不要把 ATK 凭据写入配置或日志。
`current.json` 保存本轮状态，各运行目录保存任务快照、日志、Agent 输出、检查证据和回执。

提交前保存稳定的幂等键，待确认回执单独保存在 `receipts/`。网络失败后用同一身份、服务和
状态目录再次运行，先重放待确认交付并核对服务端状态，然后退出；不会再次调用 Agent。
未确认保存的回执会保留并报错。

崩溃留下 `runner.lock`、RUNNING 或 RECOVERY_REQUIRED 时不会自动重新领取。
先在 ATK 查看运行状态，确认旧执行器、监督器和子进程已停止，按现有停止/恢复流程
释放占用，再将旧 `runner.lock` 与 `current.json` 移到备份位置。失败改动不会自动撤销。

## ATK 自身的真实验证

以下命令会调用真实 Codex、修改本仓库，并使用独立数据目录；不属于普通测试：

```powershell
node scripts/codex-dogfood.mjs
# 首轮受阻、核对原因并修正后，可显式重试同一 Bug：
node scripts/codex-dogfood.mjs --retry
```

验证目标是客户端 `replay()` 对未确认保存的回执静默成功的问题。只允许修改
`packages/agent-client/src/index.mjs` 和 `test/agent-client.test.mjs`。
执行器独立运行客户端回归与 HTTP 测试。服务、身份、任务及运行记录保存在
`artifacts/codex-dogfood/data`，执行证据在 `artifacts/codex-dogfood/runner`，
结果摘要为 `artifacts/codex-dogfood/report.json`。任务保留待人工验收，不自动关闭。

2026-11-18 的 Windows 实测已完成：首轮保留测试受限的失败记录，重试后由执行器独立
运行客户端回归和全部 HTTP 测试，两项均退出 0，范围审计无越界，交付已持久化为
COMPLETED，Bug 为 AWAITING_ACCEPTANCE。客户端回归覆盖 false、缺失、null、0、1 和
字符串 "true" 六种无效确认。另有执行器 8 项、原自动化 24 项及全仓库回归 126 项通过。

查看这份独立工作空间：

```powershell
node apps/launcher/cli.mjs start --data artifacts/codex-dogfood/data --port 1431
# 使用命令输出的私密 browserUrl 打开。不要分享访问码。
node apps/launcher/cli.mjs stop --data artifacts/codex-dogfood/data
```

## 实现范围

真实缺口是 CLI 会领取和续租，却缺少一次 AI 执行的生命周期。采用现有
`createAgentClient`，只增加单次入口和 Codex / DSH 子进程适配；任务与租约由后端拥有，
外部执行器只拥有进程和本地恢复记录，不新增业务队列或数据库状态。

原有自动化进程监督代码移入 `packages/platform/src/managed-process.mjs`，后端保留
原模块的转导出，调用契约不变。Agent CLI 新增 `run`，原领取/回执/审批接口不变。
进程监督、范围审计、检查失败、停止、租约超时和提交丢响应由
`test/codex-runner.test.mjs` 验证，原自动化测试覆盖提取后的共享监督实现。

共享生命周期在 `apps/agent-cli/agent-runner.mjs`，CLI 参数和 DSH 结果解析在
`runner-engines.mjs`；原 `codex-runner.mjs` 入口保留。`test/codex-runner.test.mjs`
分别验证两个引擎的完整流程，`test/runner-engines.test.mjs` 验证原生入口发现及 DSH 终态协议。
可显式运行 `node scripts/dsh-runner-smoke.mjs --dsh '<DSH CLI 路径>'`，使用真实模型
修复隔离的故障测试项目，再经 ATK 保存交付；它不修改 ATK 源码，也不自动验收。

2026-11-18 已用 Windows 桌面版 DSH 0.2.2-rc.3 完成真实模型验证：沿用 desktop 模型选择，
领取隔离项目的故障任务，将加法函数中的减法修正为加法，独立回归退出 0，范围审计无越界，
回执持久化后进入 AWAITING_ACCEPTANCE。最新证据入口为
`artifacts/dsh-runner-smoke/latest.json`，具体运行目录中的 `report.json` 包含前后快照及检查日志。
Codex / DSH 共 16 项生命周期测试、13 项入口与结果协议测试均通过，全仓库回归 151/151 通过。
