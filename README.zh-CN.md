# Agent Team Kit

通过网页管理多个本地项目，由外部 Agent 主动领取任务的独立协作工具。

当前版本 **2.0.0-alpha.1**。这是一次不保留兼容层的重构：旧任务池、旧 CLI、DSH
插件、模型运行时和 worktree 流程均已退出生产代码。工具不配置模型、不转发请求，
不启动外部 Agent，也不会自动清理旧数据库或用户项目。

## 启动

需要 **Node.js 24**。发布包包含构建好的网页，没有生产依赖；安装位置与目标项目无关。

以下 npm 安装方式适用于新版本正式发布后；本次 GitHub 源码提交不等于 npm 发布：

```powershell
npm install -g agent-team-kit@next
atk start
# 打开输出的 http://127.0.0.1:1421
atk status
atk stop
```

源码开发：

```powershell
corepack pnpm install --frozen-lockfile
node scripts/build-web.mjs
node apps/launcher/cli.mjs start
# 也可构建并安装独立发布包：
npm pack
npm install -g ./agent-team-kit-2.0.0-alpha.1.tgz
# 前后端可以分别启动；前端开发服务器为 http://127.0.0.1:5173
pnpm --filter @atk/web dev
```

新数据目录默认 `%LOCALAPPDATA%\AgentTeamKit\Next`，可通过 `--data <目录>` 覆盖。
在网页中注册已有项目目录即可；无需在项目里安装依赖、添加插件或初始化 Git。

## 使用流程

1. 人工在网页新建需求，进入 **DRAFT 预排池**。
2. 外部 PM 身份以固定 **ORCHESTRATOR** 阶段领取，提交分工、依赖、文件范围和验收要求。
3. 人工批准具体计划版本后，一次性发布 **READY** 执行任务。
4. 外部 Agent 领取任务和文件锁，在项目目录执行，持续续租，回传检查结果和交付记录。
5. 按批准计划配置可选独立评审；中间任务 **VERIFIED** 后推进依赖，人工任务在“待我处理”完成。
6. 所有任务满足要求后，对整份计划统一人工验收。无需每个中间任务反复点确认。

PM 不能执行或评审自己规划的任务；WORKER 不能自审；Agent 凭据不能代替人工批准。

## 文件锁与交付

- 同文件、父目录和子文件的写入冲突会等待；不同文件可以并行。
- 执行结束并确认停止、快照与回执持久化后即释放锁，不等待评审和验收。
- 失联只会将锁标为异常占用；需要确认旧执行停止后才能释放。
- 评审或验收目标变化会失效；已验证任务的合法后继修改保留历史记录。
- 修改直接发生在项目目录，失败、停止和取消不会自动回滚代码。
- 这是协议层的协作锁，不能阻止编辑器和不遵守协议的进程写入文件。

全局 SQLite 保存权威状态。项目资料默认写入各自 `.agent-team/`，包括计划、
执行前后快照、检查证据和验收记录。资料生成失败会显示在网页并可重试。

## 外部 Agent

![网页工作台](docs/screenshots/overview.png)

在网页创建角色、团队和 Agent 身份，保存只展示一次的凭据。接入时通过外部环境
变量 `ATK_AGENT_TOKEN` 提供凭据，`ATK_URL` 默认为 `http://127.0.0.1:1421`。

```powershell
atk-agent connect
atk-agent claim --wait 30000
atk-agent watch <runId> --generation <n>
atk-agent submit <runId> plan --file plan-receipt.json
atk-agent submit <runId> result --file result-receipt.json
atk-agent submit <runId> review --file review-receipt.json
```

`watch` 与实际执行同时运行，只维护租约，不会启动或终止 AI。出现 `STOP REQUIRED`、
续租失败或停止请求时，外部执行端必须停止写入。模型和登录由外部 Agent 自己管理。

## 文档与验证

- [架构与状态机](docs/ARCHITECTURE.md)
- [完整 Agent 协议及样例](docs/AGENT-PROTOCOL.md)
- [启动、备份、恢复](docs/OPERATIONS.md)
- [模块处置及阶段验收](docs/REFACTOR.md)
- [测试证据、性能及边界](docs/VALIDATION.md)

网页采用 Linear 风格，支持中英双语、列表与看板、计划审批、人工待办、实时事件、
交付差异和多项目切换。第一版限定本机单用户，不提供远程执行或模型网关。
