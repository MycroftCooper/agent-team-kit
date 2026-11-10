# 团队资源 / Team resources

ATK 在启动时创建 `<ATK 数据目录>/resources`。Windows 默认路径是
`%LOCALAPPDATA%\AgentTeamKit\Next\resources`。这是当前 ATK 安装内的小队共用资源库；
已接入的 Agent 可读取。目录跟随服务的数据目录，和项目自己的 `.agent-team` 分开。

在「Agent 团队 → 资源」选择分类并点击「新建资源」，或者把整个资源子目录复制进相应分类。
复制后，网页点击「刷新」即可看到，Agent 查询时直接看到磁盘上的最新资源。

```text
resources/
├── agent/reviewer/AGENT.md
├── skill/release-notes/SKILL.md
├── mcp/local-tools/mcp.json
└── cli/check-release/main.mjs
```

每项资源的 ID 是 `<分类>/<名称>`。名称用小写英文字母、数字、连字符或下划线，最多
64 个字符。入口文件是 UTF-8 文本，最大 128 KiB。同目录可以附带脚本或参考资料；
`show` 读取入口，并返回它的本机路径，Agent 可据此读取同目录的资料。

```sh
atk-agent resources list
atk-agent resources list --kind skill
atk-agent resources show agent/reviewer
atk-agent resources show skill/release-notes
atk-agent resources run cli/check-release -- --format json
```

`connect` 和领取成功的任务说明会带上资源查询入口。`AGENT.md` 是可复用的工作说明；
ATK 中登记的身份、角色、项目权限和已批准的角色说明仍然有效。Agent 可以按需读取
`SKILL.md`。CLI 资源是 Node.js 的 `main.mjs`，可以包装机器上已安装的其他工具。
`run` 在调用者当前工作目录中运行，`--` 后的参数原样传入脚本，脚本的标准输出和退出码
直接返回给调用者。源码运行时也可用 `node <ATK 仓库>/apps/agent-cli/cli.mjs` 代替 `atk-agent`。

## ATK 自带的制作技能

ATK 自带四个技能，开箱即可在「Agent 团队 → 资源 → Skills」看到，也会出现在
`atk-agent resources list --kind skill` 的结果中。Agent 收到制作资源的任务时，可按类型读取：

| 要制作的资源 | 读取技能 |
| --- | --- |
| Agent 工作说明与接入 | `atk-agent resources show skill/atk-create-agent` |
| 可复用的 Skill | `atk-agent resources show skill/atk-create-skill` |
| MCP 配置或新服务 | `atk-agent resources show skill/atk-create-mcp` |
| CLI 脚本或工具包装 | `atk-agent resources show skill/atk-create-cli` |
| 自动化管线与触发条件 | `atk-agent resources show skill/atk-create-automation` |

## 自带资源与自定义资源

自带资源随 ATK 更新，可在资源页点「查看」。其中「自带 CLI」列出 `atk`（启动、停止、备份等）
和 `atk-agent`（连接、领任务、续租、提交和查询资源），查看内容和对应命令的 `--help` 一致。
外部 Agent 也可用 `atk-agent resources show cli/atk-agent` 查用法。要执行自带 CLI 时直接使用该命令。

自带资源只读，名称在所属分类内保留。通过网页不能用同名创建；放入资源目录的同名文件会保留在磁盘上，
但不会被 ATK 识别成可用资源。需要使用已有的同名自定义资源时，请给它的目录换个名字。

四类自定义资源都可在资源页点「编辑」或「删除」。编辑只保存入口文件，保留同目录的附带文件。
若文件在打开后已从磁盘修改，请重新打开再编辑。确认删除会把整个目录移到 ATK 数据目录下的
`resource-trash/`，页面可复制实际回收位置。找回时，把资源文件夹移回原分类目录即可。

## 接入 MCP 服务

ATK 当前没有自带 MCP 服务；这里管理的是用户添加的 MCP 资源。

对于本机 stdio MCP 服务，资源目录中放一个 `mcp.json`，例如：

```json
{ "transport": "stdio", "command": "node", "args": ["server.mjs"] }
```

把 `server.mjs` 放在同一个资源目录下。在支持 MCP 的 Agent 客户端中注册本地服务，
启动命令为 `atk-agent`，参数为 `["resources", "serve-mcp", "mcp/local-tools"]`。
启动环境需要提供 `ATK_AGENT_TOKEN`（端口不是默认值时也要提供 `ATK_URL`）。客户端
启动这条命令后，就可以用标准输入输出列出和调用 MCP 工具。`serve-mcp` 从资源目录启动服务，
并保持标准输入输出用于 MCP 通信。实际启动的程序不会继承 `ATK_AGENT_TOKEN`。

对于已经运行的 Streamable HTTP MCP 服务，使用
`{"transport":"http","url":"https://your-server.example/mcp"}`，在客户端填入该 URL，
并由客户端完成授权。HTTP 地址无需 `serve-mcp`。

只把希望与本机 ATK Agent 共享的文件放入资源库。凭据通过客户端环境或授权流程提供。
文件被放入或创建时，ATK 只将其列入资源库。只有 Agent 运行 `run`，或 MCP 客户端调用
`serve-mcp` 时，才会在客户端环境中启动对应程序。任务原有的项目文件范围仍然适用。
