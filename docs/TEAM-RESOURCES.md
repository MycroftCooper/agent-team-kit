# 团队资源 / Team resources

资源分为两种归属：全局资源和项目专用资源。ATK 自带资源属于全局，随安装包提供且只读；
用户创建的全局共享资源保存在 `<ATK 数据目录>/resources`，Windows 默认是
`%LOCALAPPDATA%\AgentTeamKit\Next\resources`。原来的资源与命令仍然属于全局，不会自动搬迁。

项目专用资源保存在 `<项目 docsRoot>/resources`，默认是 `<项目>/.agent-team/resources`。
自定义 `docsRoot` 时跟随该目录；搬迁项目需连同资料目录一起移动并更新项目路径。
项目资源不改变已登记的 Agent 身份或角色，也不会自动安装到某个外部客户端。

在「Agent 团队 → 资源」选择分类，点击「新建全局资源」或「新建项目资源」，
或者把整个资源子目录复制进对应范围的分类目录。当前项目由标题栏工作空间决定，页面分别显示
ATK 自带、全局共享和当前项目专用资源，目录可分别复制。
复制后，网页点击「刷新」即可看到，Agent 查询时直接看到磁盘上的最新资源。

```text
resources/
├── agent/reviewer/AGENT.md
├── skill/release-notes/SKILL.md
├── mcp/local-tools/mcp.json
└── cli/check-release/main.mjs
```

每项资源在自己的范围内用 `<分类>/<名称>` 标识；完整归属由 `scope`、项目的 `projectId`
和该 ID 一起确定。不同项目和全局可存在同名自定义资源，各自独立，不会自动覆盖或回退。
名称用小写英文字母、数字、连字符或下划线，最多
64 个字符。入口文件是 UTF-8 文本，最大 128 KiB。同目录可以附带脚本或参考资料；
`show` 读取入口，并返回它的本机路径，Agent 可据此读取同目录的资料。

```sh
atk-agent resources list
atk-agent resources list --kind skill
atk-agent resources show agent/reviewer
atk-agent resources show skill/release-notes
atk-agent resources run cli/check-release -- --format json

# 项目范围必须显式指定；不从工作目录或上一次领取的任务推断。
atk-agent resources list --scope project --project <projectId>
atk-agent resources show skill/release-notes --scope project --project <projectId>
atk-agent resources run cli/check-release --scope project --project <projectId> -- --format json
atk-agent resources serve-mcp mcp/local-tools --scope project --project <projectId>
```

`connect` 带上全局查询入口；领取成功后的 `spec.resources` 保留该入口，并在
`spec.resources.project` 提供当前项目的 `ref`、`command` 和查询说明。Agent 只能通过 API
访问其小队已获授权的项目资源，不能枚举所有项目的资源。`AGENT.md` 是可复用的工作说明；
ATK 中登记的身份、角色、项目权限和已批准的角色说明仍然有效。Agent 可以按需读取
`SKILL.md`。CLI 资源是 Node.js 的 `main.mjs`，可以包装机器上已安装的其他工具。
`run` 在调用者当前工作目录中运行，`--` 后的参数原样传入脚本，脚本的标准输出和退出码
直接返回给调用者。源码运行时也可用 `node <ATK 仓库>/apps/agent-cli/cli.mjs` 代替 `atk-agent`。

## ATK 自带的制作技能

ATK 自带五个制作技能和两个 Linus 设计/审查技能，开箱即可在「Agent 团队 → 资源 → Skills」看到，也会出现在
`atk-agent resources list --kind skill` 的结果中。Agent 收到制作资源的任务时，可按类型读取：

| 要制作的资源 | 读取技能 |
| --- | --- |
| Agent 工作说明与接入 | `atk-agent resources show skill/atk-create-agent` |
| 可复用的 Skill | `atk-agent resources show skill/atk-create-skill` |
| MCP 配置或新服务 | `atk-agent resources show skill/atk-create-mcp` |
| CLI 脚本或工具包装 | `atk-agent resources show skill/atk-create-cli` |
| 自动化管线与触发条件 | `atk-agent resources show skill/atk-create-automation` |

动手前的结构决策使用 `atk-agent resources show skill/linus-design-guard`；需求、设计、spec、
代码与 PR 审查使用 `atk-agent resources show skill/linus-review`。这两份技能按原文随包提供，
属于只读全局资源，所有项目均可查询；项目范围不能创建同名资源或覆盖它们。

## 自带资源与自定义资源

自带资源随 ATK 更新，可在资源页点「查看」。其中「自带 CLI」列出 `atk`（启动、停止、备份等）
和 `atk-agent`（连接、领任务、续租、提交和查询资源），查看内容和对应命令的 `--help` 一致。
外部 Agent 也可用 `atk-agent resources show cli/atk-agent` 查用法。要执行自带 CLI 时直接使用该命令。

自带资源只读，名称在所有范围的所属分类内保留。通过网页不能用同名创建；放入资源目录的同名文件会保留在磁盘上，
但不会被 ATK 识别成可用资源。需要使用已有的同名自定义资源时，请给它的目录换个名字。

四类自定义资源都可在资源页点「编辑」或「删除」。编辑只保存入口文件，保留同目录的附带文件。
若文件在打开后已从磁盘修改，请重新打开再编辑。确认删除会把整个目录移到所属范围的
`resource-trash/`：全局位于 ATK 数据目录，项目位于该项目的 `docsRoot`。页面可复制实际回收位置。
找回时，把资源文件夹移回原范围的分类目录即可。要改变资源归属，明确选择目标目录，手动移动整个
资源目录及附带文件；同名目标需先解决冲突，ATK 不自动覆盖。

## API 与项目资料边界

人类全局资源 API 仍是 `/api/v1/resources/:kind` 和 `/api/v1/resources/:kind/:name`，
支持原有列表、读取、创建、编辑、删除。Agent 全局 API 的列表和读取仍位于 `/api/agent/v1/resources`。
网页项目资源使用 `/api/v1/project-resources/<projectId>/:kind` 和对应的 `/:name` 路径；
Agent 使用 `/api/agent/v1/project-resources/<projectId>?kind=<kind>` 列表，以及
`/api/agent/v1/project-resources/<projectId>/:kind/:name` 读取。任务说明和 CLI 也使用这些独立路径，
使不认识项目资源的旧后端直接拒绝请求，避免忽略参数后误操作全局资源。

原资源路径继续接受范围查询参数以兼容现有调用方：
省略 `scope` 或使用 `scope=global` 操作全局资源；项目范围必须附加
`?scope=project&projectId=<projectId>`。只传 `projectId`、只传 `scope=project` 或无效 scope
会报 `INVALID_RESOURCE_SCOPE`，不静默按全局处理。列表与条目返回 `scope`，项目条目还返回 `projectId`。

创建和编辑仍使用 `{name, content}` / `{revision, content}`，删除仍通过 `revision` 查询参数
校验入口版本。Agent API 只读；普通任务文件范围仍禁止写入 `docsRoot`，包括其中的资源和回执。
制作项目资源时可在批准的工作范围内准备资源包，再由用户导入或通过人类资源页创建。

项目资料目录必须可用且保持真实路径，资源目录不能与其他项目或全局资源库重叠。
创建项目或修改路径时即拒绝冲突，避免保存新配置后影响已有项目；读取时仍检查路径变化。
项目 CLI 会核对响应中的 `scope` 和 `projectId`。旧版后端忽略项目参数，或返回归属不符的条目时，
CLI 报 `RESOURCE_SCOPE_MISMATCH` 并在启动脚本/MCP 前停止；网页也拒绝显示或操作归属不符的项目资源。
无项目参数的全局命令仍兼容旧响应。
备份已包含整个项目 `docsRoot`，因此也包含项目资源及附带文件；恢复继续采用覆盖同名文件、保留其他文件的语义。
如需资源随 Git 分发，应纳入 `resources/`，同时忽略运行快照与回执，避免把整个资料目录一并忽略。

## 接入 MCP 服务

ATK 当前没有自带 MCP 服务；这里管理的是用户添加的 MCP 资源。

对于本机 stdio MCP 服务，资源目录中放一个 `mcp.json`，例如：

```json
{ "transport": "stdio", "command": "node", "args": ["server.mjs"] }
```

把 `server.mjs` 放在同一个资源目录下。在支持 MCP 的 Agent 客户端中注册本地服务，
启动命令为 `atk-agent`，参数为 `["resources", "serve-mcp", "mcp/local-tools"]`。
项目专用服务还需在这些参数后附加 `["--scope", "project", "--project", "<projectId>"]`。
启动环境需要提供 `ATK_AGENT_TOKEN`（端口不是默认值时也要提供 `ATK_URL`）。客户端
启动这条命令后，就可以用标准输入输出列出和调用 MCP 工具。`serve-mcp` 从资源目录启动服务，
并保持标准输入输出用于 MCP 通信。实际启动的程序不会继承 `ATK_AGENT_TOKEN`。

对于已经运行的 Streamable HTTP MCP 服务，使用
`{"transport":"http","url":"https://your-server.example/mcp"}`，在客户端填入该 URL，
并由客户端完成授权。HTTP 地址无需 `serve-mcp`。

只把希望与本机 ATK Agent 共享的文件放入资源库。凭据通过客户端环境或授权流程提供。
文件被放入或创建时，ATK 只将其列入资源库。只有 Agent 运行 `run`，或 MCP 客户端调用
`serve-mcp` 时，才会在客户端环境中启动对应程序。任务原有的项目文件范围仍然适用。
