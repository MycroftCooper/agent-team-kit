# 项目自动化接入与运行协议设计

定时计划的配置、执行和恢复协议见 [CI 定时计划](AUTOMATION-SCHEDULING.md)。

状态：第一版已实现，验证记录见 [VALIDATION.md](VALIDATION.md)。日期：2026-11-17。

本方案约定项目内目录、配置格式、Agent CLI/API、进度和结果协议。人、Agent 和 Git
触发共用执行器；项目文件持有自动化定义、日志和结果。实现阶段以本文为契约。

按本次需求，不迁移旧数据库配置和运行历史，也不提供旧自动化 API、命令字符串或进度协议的兼容层。
已有项目重新接入。本文记录实现契约；不读取或迁移旧自动化表，也不自动删除旧数据。

## 1. 决策与边界

三问体检：

- 真问题：配置跟随本机数据库，项目换设备后需要重配；Agent 无法发起可在 UI 观察的运行；完整报告缺少逐次归档。
- 更简单的方法：项目 JSON 文件加项目运行目录，复用现有后端、项目身份、顺序执行器和 UI。无需新服务、工作流语言或可插拔调度框架。
- 会破坏什么：当前自动化表、API、编辑器、内置模板、制作 skill、备份恢复和测试均需调整；具体清单见第 13 节。任务/Agent 领取协议保持原有职责。

第一版固定以下规则：

1. 一个 JSON 文件定义一条自动化，文件是唯一配置来源。
2. 一个运行目录保存一次执行的配置快照、参数、日志、结果和产物。
3. 后端是通过 ATK 接口修改配置、启动进程和写入运行记录的唯一执行方。
4. Agent CLI 是 API 客户端。Agent 不在 CLI 进程里另起一套 CI，也不伪造运行状态。
5. 同项目一次一条自动化，全实例最多四条；容量满立即返回冲突，不引入持久化队列。
6. 步骤顺序执行、失败即停。不做 DAG、矩阵、条件表达式、步骤间变量传递或自动重试。
7. 中央 SQLite 继续管理项目登记、身份和业务任务，但不保存自动化配置、触发游标、运行正文、日志、结果或产物。
8. 第一版仅支持本机文件系统和单个后端拥有项目执行权；不支持多设备同时操作同一个共享运行目录。

核心实体只有四个：自动化定义、运行请求、运行记录、输出文件。参数、触发器、步骤都是定义中的结构，
不再增加独立“CI 注册中心”或“CLI 注册表”。

## 2. 项目目录及所有权

所有自动化路径固定相对于登记的 `project.root`，不跟随可自定义的 `docsRoot`：

```text
<project.root>/
  .atk/
    .gitignore
    automations/
      local-check.json
      pre-release.json
    runs/
      <runId>/
        request.json
        definition.json
        state.json
        events.ndjson
        log.ndjson
        result.json
        steps/
          <stepId>/
            output/
            exports/
              <exportId>/
                <file-or-directory-contents>
    local/
      owner.lock
      <machineId>/
        triggers.json
```

- `automations/*.json`、`.atk/.gitignore`：项目配置，建议纳入版本管理。
- `runs/`：项目的运行记录和产物，默认不进 Git，不自动清理。
- `local/`：项目执行锁、本机 Git 触发游标，默认不进 Git，不随备份恢复执行状态。
- `steps/<stepId>/output/`：提供给 CI 的本次独立输出目录，由 CI 写入。
- `steps/<stepId>/exports/`：步骤退出后由 ATK 收集的证据文件，由 ATK 写入。
- `definition.json`：执行时的配置原文快照；后续编辑或删除配置不改变旧记录。
- `request.json`：本次请求与执行环境身份，接受后不修改。
- `state.json`：活动运行的原子状态快照；结束后读取 `result.json` 为准。
- `events.ndjson`：持久化的状态、进度、信息和恢复事件。
- `log.ndjson`：带步骤、来源和顺序的完整标准输出/标准错误。
- `result.json`：ATK 最终结果，仅在已确认进程停止、完成文件收集后原子发布。

新建 `.atk/.gitignore` 的内容固定为：

```gitignore
/runs/
/local/
**/*.tmp
```

只在显式“创建配置/应用配置”时建立目录及缺失的忽略文件；查询和登记项目不生成演示流程。
已有忽略文件不覆盖；校验提示若项目上层规则把整个 `.atk/` 忽略，配置将不能被 Git 管理。

运行目录由时间前缀加 UUID 标识，例如 `20261117T070128Z-<uuid>`；时间使用 UTC。
机器标识和本机 `projectId` 只进入运行/本机状态，不进入可提交的定义。
克隆项目后仍需在新 ATK 登记本机路径和身份，但无需重新定义 CI。
被 Git 忽略的历史不随 clone 同步，需要复制 `.atk/runs/` 或使用备份。
跨设备复制时不复制 `.atk/local/`；同机搬迁必须先停止原后端并确认没有待核对运行。

`.atk/` 是独立保留目录，不允许与其他登记项目的根目录、资料目录或资源库重叠。
普通任务文件写入范围不得包含 `.atk/`；项目快照遍历也跳过它，避免把运行输出视为任务交付。
Agent 修改定义走专用 API；在任务中修改 CI 适配脚本仍遵守已有任务文件范围。

## 3. 配置格式 v1

文件编码为 UTF-8，使用严格 JSON。禁止注释、重复键和未知字段。使用 JSON 而非 YAML，
让 UI、CLI、API 和手工编辑共享一种可验证的数据格式。

示例文件：`.atk/automations/local-check.json`。其中适配脚本是后续项目接入要提供的入口，当前尚不存在。

```json
{
  "schemaVersion": 1,
  "id": "local-check",
  "name": "本地检查",
  "description": "检查版本并执行项目静态检查和测试",
  "parameters": {
    "mode": {
      "type": "string",
      "title": "检查范围",
      "enum": ["quick", "local"],
      "default": "quick"
    },
    "timeoutMs": {
      "type": "integer",
      "title": "项目内单项检查超时（毫秒）",
      "minimum": 1000,
      "maximum": 1800000,
      "default": 900000
    }
  },
  "trigger": {
    "type": "manual"
  },
  "steps": [
    {
      "id": "versions",
      "name": "版本一致性",
      "cli": "node",
      "args": ["scripts/validate-versions.mjs"],
      "cwd": ".",
      "timeoutMs": 60000,
      "env": {},
      "exports": [],
      "result": { "protocol": "exit-code" }
    },
    {
      "id": "checks",
      "name": "静态检查与测试",
      "cli": "node",
      "args": [
        "scripts/atk-ci.mjs",
        "--mode", "${params.mode}",
        "--timeout-ms", "${params.timeoutMs}",
        "--output-dir", "${step.dir}/output"
      ],
      "cwd": ".",
      "timeoutMs": 3600000,
      "env": {
        "CI": { "value": "true" }
      },
      "exports": [
        {
          "id": "report",
          "path": "${step.dir}/output/result.json",
          "kind": "file",
          "required": true
        },
        {
          "id": "check-logs",
          "path": "${step.dir}/output/logs",
          "kind": "directory",
          "required": false
        }
      ],
      "result": { "protocol": "atk-ci-result/v1", "exportId": "report" }
    }
  ]
}
```

### 3.1 字段与默认值

- 顶层必填：`schemaVersion: 1`、`id`、`name`、`steps`。
- 顶层可选：`description` 默认空字符串；`parameters` 默认空对象；`trigger` 默认 `manual`。
- `id` 必须与文件名一致，格式为 `[a-z][a-z0-9-]{0,63}`。步骤 ID、导出 ID、参数名同格式；
  参数名另允许大写字母和下划线，以 `[A-Za-z][A-Za-z0-9_]{0,63}` 校验。
- 步骤必填：`id`、`name`、`cli`、`args`。`cwd` 默认 `.`，`timeoutMs` 默认 `900000`，
  `env` 默认空对象，`exports` 默认空数组，`result` 默认 `{"protocol":"exit-code"}`。
- 一条流程包含 1–20 个步骤；步骤、参数和导出 ID 在所属范围内唯一。每条流程最多 32 个参数，每步最多 16 个导出。
- 配置最大 128 KiB；名称最多 128 个字符，描述最多 2048 个字符；每步最多 128 个参数项，每项展开后最多 8192 字符。
- 步骤超时必须是 1000–86400000 毫秒的整数，不能使用参数替换，必须覆盖该步骤可能的最长运行。
  示例中的参数 `timeoutMs` 传给项目 CI，步骤字段 `timeoutMs` 是 ATK 的外层上限，两者职责不同。
- 不支持继承、include、远端配置或平台条件覆盖；跨平台差异放入项目适配脚本。

### 3.2 参数类型与填入规则

第一版只支持 `string`、`integer`、`number`、`boolean`；字符串可以定义 `enum`、`maxLength`，
数字可以定义 `minimum`、`maximum`。`string.maxLength` 默认 4096，最大 8192。
integer 限定为 JavaScript 的安全整数，拒绝不能精确表示的整数值。
可选元数据为 `title`、`description`。

每个参数必须二选一：设置经过类型校验的 `default`，或设置 `required: true`。
不支持“未提供时删除整段命令”的隐式行为。默认值与显式传入值使用同一校验器。
未知参数、缺失必填值、空值或类型不匹配，在创建运行前拒绝。

API 参数保留 JSON 原生类型；命令参数中的整数/数字转换成十进制字符串，布尔值转换成 `true`/`false`。
字符串空值是否允许由 `enum`/`maxLength` 外的固定规则决定：第一版允许空字符串，但拒绝 NUL、CR、LF。
不支持数组、对象、表达式求值或任意 shell 片段。

`args` 中允许以下占位符，可出现在参数项的全部或一部分；每项展开后仍是一个 argv 元素：

- `${params.<name>}`：校验并补齐默认值后的参数。
- `${project.root}`：本机项目绝对根目录。
- `${run.id}`、`${run.dir}`：本次运行 ID 和绝对目录。
- `${step.id}`、`${step.dir}`：当前步骤 ID 和绝对目录。

仅 `args` 支持上述全部占位符。`exports.path` 只支持 `run`、`step` 目录/ID 占位符；
`cli`、`cwd`、超时、环境变量定义和触发器均不支持占位符。未知占位符直接报错。
需要字面量 `${` 时写成 `$${`，展开前按单次扫描转义，不进行递归展开。
可提交定义中的路径分隔符统一用 `/`；展开后的实际目录使用宿主系统路径，文件索引中的相对路径仍统一用 `/`。

### 3.3 CLI、工作目录和环境

`cli` 指实际进程入口，`args` 定义启动格式。二者合起来满足“哪个 CLI、如何填参启动”。

- `cli` 可为 PATH 中的命令名，或项目内以 `./` 开头的相对可执行文件路径；不能是机器绝对路径，不能包含参数或占位符。
- 后端在执行前解析入口，记录实际解析路径。Node 项目使用 `cli: "node"` 时使用 ATK 当前 Node 进程的可执行文件。
- `cwd` 是项目内相对目录。默认项目根目录；相对脚本参数由该工作目录解释。
- ATK 使用 argv 启动，不自动拼接 shell 命令；重定向、管道、`&&`、条件 flag 等放入项目脚本。
- Windows 第一版不隐式执行 `.cmd`/`.bat`，不切换到 `shell: true`。遇到这类入口返回 `CLI_UNSUPPORTED`，
  项目改用 Node 脚本或显式解释器的文件入口。`pnpm ci:quick` 应由项目的 Node 适配入口调用包管理器 JS 入口，
  不能把未经转义的参数拼入 `cmd /c`。这项限制必须在 UI 校验和接入 skill 中可见。
- 子进程继承 ATK 后端环境，移除全部 `ATK_*` 变量，再应用配置中的 `env` 和规定的运行变量。
- 每个 `env` 值只能是 `{"value":"固定字符串"}` 或 `{"fromEnv":"本机变量名","required":true}`。
  `required` 默认 true；false 且本机变量缺失时，不向子进程设置该变量。
- 注入保留变量 `ATK_RUN_ID`、`ATK_STEP_ID`、`ATK_RUN_DIR`、`ATK_OUTPUT_DIR`，不能由定义覆盖。
  `ATK_OUTPUT_DIR` 固定为 `${step.dir}/output`。
- `env` 不能设置 `ATK_*` 名称，`fromEnv` 也不能引用 `ATK_*`，防止把身份凭证重新注入 CI。
- 密钥通过 `fromEnv` 引用，禁止定义专门的密钥参数；ATK 不把引用解析后的值写入请求、事件或结果。
  项目 CLI 自己输出的日志仍可能包含密钥，ATK 不承诺自动识别所有敏感文本。

### 3.4 触发器

手动流程使用 `{"type":"manual"}`。手动和 Agent API 调用始终可用，不取决于触发器类型。
Git 触发配置示例：

```json
{
  "type": "git-commit",
  "branch": "dev",
  "parameters": { "mode": "quick" }
}
```

`trigger.parameters` 使用同一套参数校验；未写的值取默认值，必填值不全则配置校验失败。
后端每两秒观察本地分支：第一次观察只记录基线；后续新提交只有在当前检出该分支、
已跟踪文件无修改、项目可运行且容量空闲时执行。不 fetch、切分支或逐个补跑中间提交。
忙时不推进游标，空闲后检查最新提交；回退到已处理提交的祖先只更新忽略位置，不触发。

游标按 `machineId + workflowId + 定义revision + branch` 保存到项目本机目录。
分支/定义变化或新设备首次接入均重新建立基线，不自动执行历史提交。
每步开始前重新检查 Git 分支和提交；偏离时停止后续步骤并结束为 `INTERRUPTED`。
运行请求记录启动时的 Git 提交与 tracked dirty 状态；手动运行允许 dirty，但 UI 明示该事实。
没有 Git 的项目可正常手动或由 Agent 运行。

## 4. 配置读写与项目接入

配置 `revision` 为原始文件字节的 SHA-256，表示精确文件版本，不进入文件正文。
文件名/ID 是项目内稳定标识，不使用数据库 ID；换设备重新登记不会改动 ID。

UI、Agent CLI 和手工编辑遵循同一 JSON 契约：

1. UI/CLI 提交定义到后端，后端校验，使用预期 revision 检测冲突后写入项目文件。
2. 创建要求 `expectedRevision: null` 且目标文件不存在；更新/删除要求精确匹配当前 revision。
3. 后端写入使用服务内串行、保存前 hash 复核、同目录临时文件、flush 与原子替换。
   revision 保证 ATK API 客户端之间的并发控制；不承诺对不参与协议的外部编辑器提供跨进程 CAS。
4. 外部编辑的文件在查询、启动和 Git 轮询时重新读取。UI 可主动刷新，文件监听只作为加速提示。
5. 无效文件显示具体错误并禁用该流程；不使用上一次缓存的有效版本偷偷运行，其他有效流程继续可用。
6. 启动请求必须包含 revision，后端读取匹配版本并快照；接受后配置再变化，本次继续使用快照。
7. 运行期间允许更新定义，新运行才生效；活动或待核对运行引用的定义不允许通过 API 删除。
8. 不自动提交 Git。内置流程改成可复制的模板，只有保存后才产生项目配置。

接入过程为：登记工作空间 → 检查项目现有 CI CLI → 建立定义（必要时准备适配脚本）→
validate → apply → 手动试跑 → 检查 UI、日志和归档 → 按需启用 Git 触发。
配置校验不安装依赖、不启动 CI；执行计划只展示补齐参数后的 argv、工作目录和导出路径。

## 5. Agent CLI

新增 `atk-agent automation` 命名空间。所有在线操作都要求显式 `--project <projectId>`，
使用已有 `ATK_URL` 和 `ATK_AGENT_TOKEN`，不从 cwd 或最近任务推断项目。
`--file`、`--params-file` 是 CLI 本机输入文件，客户端读取内容后提交 JSON，服务端不读取请求提供的任意本机路径。

```sh
atk-agent automation list --project <projectId>
atk-agent automation show local-check --project <projectId>
atk-agent automation validate --file draft.json --project <projectId>
atk-agent automation apply --file draft.json --create --project <projectId>
atk-agent automation apply --file draft.json --revision <sha256> --project <projectId>
atk-agent automation remove local-check --revision <sha256> --project <projectId>

atk-agent automation run local-check --revision <sha256> --param mode=quick --param timeoutMs=900000 --request-id <uuid> --project <projectId>
atk-agent automation run local-check --revision <sha256> --params-file params.json --request-id <uuid> --wait --project <projectId>
atk-agent automation runs --limit 20 --project <projectId>
atk-agent automation status <runId> --project <projectId>
atk-agent automation logs <runId> --follow --project <projectId>
atk-agent automation stop <runId> --project <projectId>
```

- 默认输出机器可读 JSON。`logs` 默认逐段显示纯文本；`--json` 输出带序号的 NDJSON。
- `validate` 返回配置字段错误和入口可用性检查；不运行任何项目命令。缺少本机 CLI 是环境错误，不修改定义。
- `apply` 必须二选一 `--create` / `--revision`，不会自动覆盖；返回新的 revision。
- `run` 默认异步，HTTP 接受后立即输出 `runId`、状态、运行目录和 UI 可定位的项目/运行标识。
- `--param` 可重复，值按声明类型解析；字符串保留原文，整数/数字严格解析，布尔值仅接受 `true`/`false`。
  重复参数名报错。`--param` 与 `--params-file` 互斥；参数文件是普通 JSON 对象。
- `--request-id` 为 UUID；未给时 CLI 生成并先输出到 stderr。网络重试必须复用同一值。
- `--wait` 轮询同一运行直到结束，断开 CLI 或 Agent 不会停止后端 CI。Ctrl+C 只停止等待；停止 CI 需显式 `stop`。
- 异步命令成功退出码为 0；参数/API/认证等错误为 2。等待成功为 0，已结束但未成功为 1，
  进入 `RECOVERY_REQUIRED` 为 3 并退出等待，提示需要在 UI 核对进程。
- `status` 保持查询命令语义，读取成功就返回 0，调用方读取 JSON 的 `status` 判定 CI 结果。
- 第一版不提供离线执行命令。ATK 未运行时明确报错，避免 Agent 绕开 UI 启动无人记录的第二套 CI。

内置 `atk-create-automation` skill 后续调整为：检查项目约定 → 读取当前定义/revision →
编写同格式草稿 → validate → apply → run → 跟踪 runId 并检查归档。
skill 不包含独立执行逻辑，不再依赖浏览器人类会话。

## 6. HTTP API

人类前缀为 `/api/v1`，继续使用现有 session/CSRF；Agent 前缀为 `/api/agent/v1`，继续使用 Bearer 凭证。
两者后面的项目路径和 JSON 契约一致，由共同业务服务处理：

```text
GET    /projects/:projectId/automations
POST   /projects/:projectId/automations/validate
GET    /projects/:projectId/automations/:workflowId
PUT    /projects/:projectId/automations/:workflowId
DELETE /projects/:projectId/automations/:workflowId?revision=<sha256>
POST   /projects/:projectId/automations/:workflowId/runs
GET    /projects/:projectId/automation-runs?limit=20&cursor=<opaque>
GET    /projects/:projectId/automation-runs/:runId
GET    /projects/:projectId/automation-runs/:runId/logs?cursor=<opaque>&limitBytes=65536
GET    /projects/:projectId/automation-runs/:runId/events?afterSeq=0&limit=100
GET    /projects/:projectId/automation-runs/:runId/events/stream
GET    /projects/:projectId/automation-runs/:runId/files/:stepId/:exportId?path=<relative>
POST   /projects/:projectId/automation-runs/:runId/stop
POST   /projects/:projectId/automation-runs/:runId/confirm-stopped
```

### 6.1 配置请求

validate 接收 `{"definition":{...}}`，返回 `valid`、字段级 `errors`、环境 `diagnostics`；
不创建文件。PUT 接收 `{"expectedRevision":null,"definition":{...}}`，更新时用真实 hash 替代 null。
返回 `{"workflowId":"local-check","revision":"<sha256>","definition":{...}}`。

列表返回 `items`，有效项包含 ID、revision、定义和环境诊断；无效文件项包含 `fileName`、
`valid:false` 和 `errors`，不能生成可运行 revision。配置缺失时返回空列表，不读取旧数据库表。
validate 中结构错误以 HTTP 200 的 `valid:false` 返回；PUT/run 中非法输入以 HTTP 422 拒绝。

### 6.2 启动请求和幂等

```json
{
  "revision": "<sha256>",
  "parameters": { "mode": "quick", "timeoutMs": 900000 },
  "idempotencyKey": "9a793da9-f350-4148-88d3-935fcac467ba"
}
```

成功接受返回 HTTP 202：

```json
{
  "projectId": "<local-project-id>",
  "workflowId": "local-check",
  "runId": "20261117T070128Z-<uuid>",
  "status": "STARTING",
  "runPath": ".atk/runs/20261117T070128Z-<uuid>",
  "reused": false
}
```

后端从凭证/会话推导 `requestedBy`，客户端不能自行指定发起人。`parameters` 补齐默认值后归档。
幂等键按项目和调用身份隔离，作用于同 workflowId、revision 和补齐参数后的规范请求；
重复调用返回原 runId 和当前状态，`reused:true`。同键不同请求返回 `IDEMPOTENCY_CONFLICT`。
幂等查询先于 revision、容量和入口可用性重新检查，保证已接受请求在配置修改后仍可正确重试。
请求键随 `request.json` 持久保存，启动时可重建内存索引，不依赖中央数据库。

顺序为：鉴权/幂等 → 校验定义和参数 → 检查容量/执行锁 → 创建目录及请求快照 → 持久化接受 → 返回。
持久化成功前不拉起进程。进程启动失败也形成有 runId 的失败记录。拒绝的请求不产生运行目录。

### 6.3 查询、事件和错误

- 详情返回请求摘要、配置 revision、状态、每步进度/时间、日志最新位置、结果和归档文件清单。
  不默认把全部日志塞进详情。列表使用运行 ID 的稳定排序和不透明游标，每页上限 100。
- 日志 API 返回 `items`、`nextCursor`、`endOfFile`、`complete`，默认最多 64 KiB、上限 256 KiB。
  游标绑定 runId 和已读完整记录边界；运行中 `endOfFile:true` 不代表 `complete:true`。
- files 接口对于 file 导出返回归档文件；对于 directory 导出，不传 path 返回文件清单，传相对 path 返回对应文件。
  不接受路径越界、链接跳转或不存在的 exportId。报告原件与普通产物使用同一接口。
- events 返回本次运行的事件记录；stream 使用相同事件的 `seq` 作为 SSE ID，支持 `Last-Event-ID`。
  Agent 和 UI 均可订阅自己有权读取的项目运行。
- 项目自动化列表在页面可见时每两秒刷新以发现新运行；选中的运行订阅事件后按通知拉详情，
  事件流重连/页面恢复时重读权威文件。HTTP 轮询是 fallback，事件本身不作为完成的唯一证据。
- 自动化事件保存在项目事件文件，不写中央 `events` 表；现有全局 SSE 如发送刷新提示也只作内存通知。
- 常用错误：401 `UNAUTHENTICATED`；跨项目返回 404 `NOT_FOUND`；403 `AUTOMATION_FORBIDDEN`；
  409 `REVISION_CONFLICT`、`AUTOMATION_BUSY`、`IDEMPOTENCY_CONFLICT`、`RECOVERY_REQUIRED`；
  422 `INVALID_DEFINITION`、`INVALID_PARAMETERS`、`CLI_UNAVAILABLE`、`CLI_UNSUPPORTED`、`PATH_ESCAPE`；
  503 `PROJECT_UNAVAILABLE`、`AUTOMATION_STORAGE_UNAVAILABLE`。
- 配置删除成功返回 200 `{"removed":true}`，保留历史。stop 是幂等操作，已结束时返回当前记录，不重复结束。

### 6.4 身份与权限

项目绑定的受信 Agent 可查询、配置和发起本项目自动化；可以停止自己发起的运行，
人类会话可以停止任何运行。第一版不增加第二套自动化身份、凭证或角色体系。
Git 发起的运行由人类停止。`confirm-stopped` 只允许人类会话调用。

这明确扩大现有 Agent API 能力：配置和执行 CI 意味着能执行项目命令，不是只读资源查询。
所有操作校验身份所属项目、项目可用状态；不允许客户端指定任意 cwd、runDir 或命令覆盖定义。
重新签发凭证会使旧凭证失效。Agent 离线不自动终止已经由后端接管的 CI，运行仍在 UI 可见并可由人停止。删除发起 CI 的 Agent 前，需先停止活动或不确定的运行并确认结束；不提供单独的撤销操作。
第一版不宣称对不可信项目脚本提供系统沙箱；普通任务写入限制也不能约束任意外部进程。

## 7. 运行记录和生命周期

`request.json` 固定包含：`schemaVersion`、`runId`、`workflowId`、`definitionRevision`、补齐的 `parameters`、
`idempotencyKey`、`requestedBy`、`acceptedAt`、`machineId`、`backendInstanceId`、本机项目 ID/根目录和 Git 信息。
`requestedBy` 取 `{"type":"human"}`、`{"type":"agent","agentId":"..."}` 或
`{"type":"git","branch":"dev","commit":"..."}`。不保存认证 token 或实际密钥环境值。

整体运行状态固定为：

- `STARTING`：请求已持久化，正在准备或拉起首个步骤。
- `RUNNING`：执行步骤或收集本步骤文件。
- `STOPPING`：已请求停止，等待确认进程树结束。
- `RECOVERY_REQUIRED`：旧后端消失或终止失败，无法确认进程树已停止；保留项目占用。
- `SUCCEEDED`、`FAILED`、`CANCELED`、`INTERRUPTED`：终态。

步骤状态为 `PENDING`、`RUNNING`、`SUCCEEDED`、`FAILED`、`CANCELED`、`INTERRUPTED`、`SKIPPED`；
步骤的当前 `phase` 可为 `starting`、`executing`、`collecting`，不再增加并行状态机。

正常路径：STARTING → RUNNING → SUCCEEDED/FAILED。失败或停止时未执行步骤标记 SKIPPED。
正常停止路径：RUNNING → STOPPING → CANCELED；超时终止确认后为 FAILED，错误原因 TIMEOUT。
启动失败为 FAILED，实际退出码 null。Git 漂移或已确认停止的后端关闭为 INTERRUPTED。
取消和失败仍尽力收集已有日志/产物，收集失败不覆盖原始失败原因，而是追加 diagnostics。

每步保存开始/结束时间、解析后的实际 executable/argv/cwd、退出码/信号、进度、诊断和导出清单。
文件收集是步骤完成的一部分：必需导出缺失、结果协议错误等可使退出码 0 的步骤失败。

终态发布顺序：确认进程及其受管子进程停止 → 关闭日志 → 收集并校验导出 →
写终态事件 → 原子发布 `result.json` → 更新可重建索引。result 存在时即使 state 仍旧也以 result 为准。
`run.finished` 可以先落盘，但必须等 result 持久化后才向 SSE 客户端发布，以免通知后仍读不到最终结果。
后端在响应“已完成”前保证结果已持久化。运行结束后不再修改 request、definition、日志、事件或 result。
日志/事件流式追加，在状态边界和正常结束时 flush/fsync，运行中至多每秒持久化一次。
进程/系统崩溃可能丢失尚未落盘的最后一段输出，恢复诊断必须说明记录可能不完整，不能将其发布成正常成功。

### 7.1 后端崩溃、停止失败和存储错误

项目执行锁包含 machineId、后端实例和进程身份。另一个 ATK 实例不得同时取得相同真实项目根目录的执行权。
后端首次修改配置或启动运行前，以排他文件创建取得项目 owner lock，并持有至后端关闭；
其他实例可以只读浏览，写配置/运行返回 AUTOMATION_BUSY。配置写入与执行因此共用单一写入拥有者。
同一设备检测到死去的锁拥有者后可接管核对工作，不能直接把 PID 存活当成同一个进程，也不能只杀一个重用 PID。

重启扫描所有无最终结果的运行：能确认进程树已停止则归档为 INTERRUPTED；不能确认则标为 RECOVERY_REQUIRED。
另一机器复制来的未完成记录也进入待核对状态，不尝试终止原机器 PID。完整终态历史只读展示。
第一版不恢复/续跑旧命令，不根据“很久没有日志”判断完成。

UI 的确认停止操作要求用户先核对并停止旧进程，再调用 `confirm-stopped`，记录原因并结束为 INTERRUPTED。
未核对前保留项目占用，阻止新运行、项目搬迁、完整备份和后端热重载；本机疑似仍活动的运行也占用全局容量。
执行器必须具备受管进程树的停止与结束确认；不能只等 shell 父进程退出就宣布所有写入停止。
CI 入口必须前台执行并等待自己的子进程，不允许脱离管理后在后台继续写入。

磁盘写失败时停止接受新运行，活动运行请求终止；无法持久化时向 UI/CLI 返回明确存储故障，
不发布内存中的成功结果。目录保留用于恢复核对，不转存中央数据库。

## 8. 标准输出进度协议

普通文本保持普通日志。需要结构化进度的 CLI，在 stdout 输出一行 `::atk::` 加 JSON；
只解析完整 UTF-8 行，不解析 stderr，不从任意 JSON 文本猜测协议。

```text
::atk::{"schemaVersion":1,"type":"progress","percent":40,"current":"rust-test","message":"正在执行 Rust 测试"}
::atk::{"schemaVersion":1,"type":"heartbeat"}
::atk::{"schemaVersion":1,"type":"info","values":{"testsPassed":120,"testsFailed":0}}
```

- `progress`：`percent` 可省略或为 0–100 数值；`current` 和 `message` 可选，各最多 512 字符。
  允许仅报告当前检查名，不制造百分比。步骤内已接受的百分比单调不减。
- `heartbeat`：更新生产者最近响应时间，不代表任何检查已完成。
- `info`：最多 16 项，key 最长 64 字符，值为字符串/有限数字/布尔值；字符串最长 512 字符。
- 单行协议最大 16 KiB。无效、未知版本/类型或超长协议行只进入日志并产生有上限的诊断，不改变成功判定。
- 协议行也保留原文日志。后端绑定实际 stepId，CI 不能替其他步骤上报、写最终状态或覆盖发起人。
- backend 每五秒刷新自己的观察时间；分别显示 `lastObservedAt`、`lastOutputAt`、`lastProducerHeartbeatAt`。
  后端仍在观察进程与 CI 自己有响应是两件事。
- 生产者 30 秒没有输出/心跳时提示“暂无新输出”；没有明确配置的超时到期，不自动判死。

UI 始终显示已完成步骤、当前步骤、当前内部检查名、耗时和最近输出时间。
当前步骤没有明确百分比时，整体百分比为 null，使用不定进度条；不再把“两步完成一步”当成真实执行的 50%。
有明确百分比时，整体按步骤等权平均计算；全部成功才显示最终 100%，失败/取消保留实际进度并突出终态。
采集文件期间显示“归档结果”，即使生产者已报告 100% 也不能提前显示成功。

`log.ndjson` 的每条记录含 `seq`、`at`、`stepId`、`stream: stdout|stderr`、`text`。
使用流式 UTF-8 解码，单条文本至多 64 KiB，再按 UTF-8 边界拆分；seq 表示 ATK 接收顺序，
不声称能恢复两个操作系统管道之间的原始严格顺序。

`events.ndjson` 每条含 `seq`、`at`、`type`、`stepId`（可空）、`data`；日志和事件各自递增编号。
事件类型固定为 `run.started`、`step.started`、`step.progress`、`step.info`、`step.heartbeat`、
`step.finished`、`run.stopping`、`run.recovery-required`、`run.finished`、`run.diagnostic`。
UI 通知以已追加的事件为来源，SSE 重放不会再产生执行动作。

## 9. 导出文件和 CI 结果协议

### 9.1 导出收集

`exports` 定义 CI 导出源路径。可为相对于项目根目录的固定路径，或引用本次 run/step 目录。
不允许绝对路径、glob、URL、项目外路径，或通过符号链接/junction 逃出项目。
固定项目路径只允许普通项目输出区域，不能读取 `.git`、其他运行目录或 `.atk/local`。
引用 `.atk/` 内部的导出源，第一版统一限定为当前步骤的 `steps/<stepId>/output/`，
使用 `${step.dir}/output/...`；`${run.dir}` 可用于拼出同一路径，不开放其他受管目录作为导出源。
本次运行目录中也不能把 request、definition、state、result、日志、事件或 exports 自身作为导出源。

每步拉起进程之前保存固定导出源的存在性、大小、修改时间和内容摘要；退出后只接受本次新增或内容发生变化的固定路径输出。
内容与运行前相同的固定路径文件视为无法证明新鲜，必需导出失败 `EXPORT_NOT_FRESH`；不靠 mtime 单独证明归属。
目录按逐文件清单对比，只归档新建/内容变化的文件，不能把旧日志混入本次证据。
这是固定输出路径的保守 fallback；报告即使内容相同也是合理情况，因此优先让 CI 使用独立 output 目录。
ATK 不删除、覆盖或清空项目原输出目录来“制造新鲜文件”。

步骤结束后，把文件复制到 `steps/<stepId>/exports/<exportId>/<basename>`；目录复制其内容到对应 exportId 目录。
收集时拒绝链接、设备文件和源目录包含目标目录的递归复制。逐文件记录归档相对路径、字节数、SHA-256、媒体类型。
复制过程中源文件变化则重试一次，再变化记为 `EXPORT_CHANGED`，不能发布为完整证据。
下载接口只服务归档副本，按 stepId/exportId 和相对路径寻址，不提供任意磁盘文件读取。

每个运行最多收集 1 GiB、10000 个文件，结构化结果文件最大 1 MiB；超限产生 EXPORT_LIMIT。
必需导出失败使步骤 FAILED；可选导出失败仅警告并明确 `collected:false`。
失败、取消或超时运行也保留可收集的部分文件，不伪装为成功。

### 9.2 两种结果模式

`result.protocol: "exit-code"`：只按进程退出码和必需导出判定。导出的任意项目 JSON 作为原文件保存，
ATK 不猜测其中的 `ok`、`passed` 等字段。

`result.protocol: "atk-ci-result/v1"`：`exportId` 必须引用一个 required=true 的 file 导出，
ATK 从归档副本读取并校验以下结果。报告绑定本次 runId/stepId，防止拿旧结果当成功：

```json
{
  "schemaVersion": 1,
  "runId": "20261117T070128Z-<uuid>",
  "stepId": "checks",
  "status": "passed",
  "summary": "全部检查通过",
  "checks": [
    { "id": "web-test", "name": "Web tests", "status": "passed", "durationMs": 52313 },
    { "id": "rust-test", "name": "Rust tests", "status": "passed", "durationMs": 92346 }
  ]
}
```

报告必填 `schemaVersion`、`runId`、`stepId`、`status`；`status` 只能是 passed/failed。
`summary` 可选，最多 2048 字符；`checks` 可选，最多 10000 项，id 唯一，name 最多 128 字符，
status 为 passed/failed/skipped，durationMs 为非负整数，另允许最多 2048 字符的 `message`。
未知字段、重复键、非有限数字和不匹配的 runId/stepId 都报 RESULT_INVALID。
passed 报告包含 failed 检查也是 RESULT_INVALID；SKIPPED 只表示子检查跳过，不替代整个步骤的成功依据。

成功必须同时满足：进程退出码为 0、所有必需导出归档成功、报告有效且 status=passed。
非零退出码永远不会被 passed 报告改成成功；退出码 0 加 failed 报告仍然 FAILED。
报告缺失/无效不能退回 exit-code 模式。取消、超时和恢复中断的控制结果优先于报告。
stdout 进度只用于展示，不能代替结果协议。

### 9.3 ATK 最终结果

运行根目录 `result.json` 是 ATK envelope，与 CI 生产的报告不同。包含：

- `schemaVersion:1`、runId、workflowId、definitionRevision、终态、startedAt/endedAt/durationMs。
- requestedBy 和 Git 摘要；完整请求和参数通过同目录 request.json 查询。
- steps：每步时间、状态、exitCode、signal、error、最后进度、归档清单、规范化 CI 报告。
- `error`：稳定 code 与可读 message；`diagnostics`：收集、协议、观察和恢复警告。
- `logPath`、`eventsPath` 和文件引用均相对于本次运行目录，完整复制运行目录即可读取。

以下展示一个单步骤流程的最终结果形状。所有字段均为必填，未知 Git 信息、进度、信号和错误用 null 表示，
无导出/无诊断用空数组表示；`report` 只有协议模式成功解析时为第 9.2 节报告对象，否则为 null。

```json
{
  "schemaVersion": 1,
  "runId": "20261117T070128Z-<uuid>",
  "workflowId": "single-check",
  "definitionRevision": "<sha256>",
  "status": "SUCCEEDED",
  "startedAt": "2026-11-17T07:01:28.000Z",
  "endedAt": "2026-11-17T07:04:00.000Z",
  "durationMs": 152000,
  "durationEstimated": false,
  "requestedBy": { "type": "agent", "agentId": "agent-example" },
  "git": { "available": true, "branch": "dev", "commit": "<git-sha>", "dirtyTracked": false },
  "steps": [
    {
      "id": "checks",
      "name": "静态检查与测试",
      "status": "SUCCEEDED",
      "startedAt": "2026-11-17T07:01:28.000Z",
      "endedAt": "2026-11-17T07:04:00.000Z",
      "durationMs": 152000,
      "process": {
        "cli": "node",
        "resolvedExecutable": "<absolute-node-executable>",
        "args": ["scripts/check.mjs"],
        "cwd": "<absolute-project-root>",
        "envKeys": ["ATK_RUN_ID", "ATK_STEP_ID", "ATK_RUN_DIR", "ATK_OUTPUT_DIR"]
      },
      "exitCode": 0,
      "signal": null,
      "error": null,
      "progress": { "percent": 100, "current": null, "message": null },
      "exports": [],
      "report": null,
      "diagnostics": []
    }
  ],
  "error": null,
  "diagnostics": [],
  "logPath": "log.ndjson",
  "eventsPath": "events.ndjson"
}
```

`envKeys` 只列出配置显式设置和 ATK 注入的变量名，不包含继承环境的键值。
`process` 对未启动步骤为 null；未开始步骤的时间、耗时、退出码均为 null。
每个导出项固定包含 `id`、`kind`、`collected`、`sourcePath`、`archivePath`、`files`、`error`；
sourcePath 是执行时解析的源路径，archivePath 是运行内相对目录，收集失败时 archivePath 为 null。
files 中每项为 `path`（相对于运行目录）、`bytes`、`sha256`、`mediaType`。
error/diagnostics 每项都使用 `{"code":"稳定错误码","message":"可读说明"}`，终态第一次主失败写入 error，后续问题写入 diagnostics。

UTC 时间使用 ISO 8601；正常运行耗时使用单调计时器。崩溃恢复只能按持久化时间估计时，标注 `durationEstimated:true`。
最终结果不依赖当前配置、当前 `projectId` 或原项目绝对路径才能解释；本机绝对路径仅作为执行时证据保存在请求/步骤中。
无有效最终结果的目录不展示为成功，损坏文件显示诊断且不影响读取其他运行。

## 10. UI 接入和可观察性

自动化列表来自项目文件，显示配置来源路径、revision、有效性和本机入口检查结果。
编辑器提供表单和 JSON 两种视图，保存同一份定义；冲突时保留编辑内容，提示重新读取/比较，不覆盖外部修改。
参数表单由类型、默认值、enum 和范围生成。启动前展示本次参数和实际命令参数列表。

运行历史统一显示 human/agent/git 来源、Agent 名称/ID、提交、参数摘要和状态。
Agent 发起运行无需用户切换页面或打开 Agent 终端；进入项目自动化页即可看到同一个 runId。
日志分页跟随，历史完整日志留在项目文件；不再把后端截断后的 32000 字符当作完整日志。
结果区显示结构化检查项和归档文件，可定位运行目录；exit-code 模式明确显示“未接入详细结果协议”。

## 11. P4Deck 重新接入方案

重新创建 `local-check.json` 和 `pre-release.json`，不读取旧数据库的内置流程。
保留版本检查，再由项目提供 `scripts/atk-ci.mjs` 适配入口调用现有 quick/local CI。
本节是接入设计，不在本次修改 P4Deck。

适配入口职责固定为：

1. 按 argv 接收 mode、项目检查超时和独立 output-dir；读取 ATK_RUN_ID/ATK_STEP_ID。
2. 保留原 CI 的检查集合、失败判定和发布限制，不实现第二套检查逻辑。
3. 支持把原生 summary 和每项日志写入本次 output-dir，避免 `*-latest.json` 和共享 logs 互相覆盖。
4. 在检查开始/完成时发 progress/current，长检查期间发 heartbeat；未知进度只报检查名。
5. 在退出前生成 atk-ci-result/v1 报告；原生 JSON 和原始日志也可作为单独 exports 保存。
6. 若项目暂不改结果/进度协议，先用满足 CLI 入口规则的最小包装脚本、exit-code 模式和固定路径导出重新接入，
   接受保守的新鲜度判定和较弱的进度展示；Windows 的 pnpm.cmd 入口限制仍然适用。

完整结果协议接入需要项目配合改输出路径；仅改 ATK 配置不能凭空得到 CI 内部进度和详细结果。

## 12. 本机状态、索引、备份与留存

第一版采用目录扫描加内存索引；索引随文件变更/执行增量更新，启动和手动刷新可重建。
不新增自动化数据库表或项目级 SQLite；性能确有需要后再增加可删除的索引缓存。
配置/运行正文永远不靠索引恢复。没有 Git 配置或没有运行历史均可正常工作。

中央数据库仍保存本机项目路径、身份、团队和业务任务；自动化接口使用 projectId 做授权定位，
文件中的 workflowId/runId 做项目内寻址。项目归档后历史可读，禁止配置修改和启动。
项目搬迁要求没有活动/待核对运行，连同 `.atk/` 移动；重新登记或更新路径后扫描即可发现定义和完整历史。

备份实现必须显式纳入每个项目的 `.atk/automations/`、`.atk/runs/` 和 `.atk/.gitignore`，
不依赖 docsRoot 恰好在项目内，也不复制 `.atk/local/` 的 owner lock 和触发游标。
备份/恢复必须等待自动化已停止且不存在待核对进程；恢复完成后重新建立本机 Git 基线。
新备份格式与旧备份恢复行为不做本次兼容，源代码和 CI 适配脚本仍由项目版本控制/代码备份负责。

第一版不提供自动删除、日志轮转或历史清理 API，防止先定义不完整的引用/幂等保留规则。
单次 log.ndjson 达到 256 MiB 时终止该运行并记 LOG_LIMIT；禁止静默截断后仍报告成功。
磁盘空间由现有系统错误报告；后续清理功能必须明确哪些运行可删，以及删除后幂等请求如何响应。

## 13. 数据流、控制流和现有破坏面

数据流：人/Agent 草稿 → 共同校验器 → 项目配置文件；启动时读取配置 → 请求及定义快照 →
子进程 stdout/stderr/报告文件 → 项目日志/事件/导出 → 最终结果 → UI/Agent 查询。
已完成记录保持不可变，直到未来用户显式清理；本机执行锁和触发游标另有生命周期。

控制流：UI、Agent、Git 三个入口统一进入 start；经过幂等、revision、参数、容量和执行权检查后运行同一顺序执行器。
新增明确的结果收集阶段和恢复核对路径，移除数据库定义/日志写入及后端重启时直接判定已终止的捷径。
文件 I/O 与中央业务数据库之间不做分布式事务；自动化操作按项目串行，并通过持久化请求和终态结果恢复。

实现时需要改动的现有边界：

- `apps/backend/src/project-automations.mjs`：存储来源、参数执行、结果归档、状态恢复、容量/幂等；配置与文件模块独立。
- `apps/backend/src/automation-git.mjs`：保留 Git 观察逻辑，接入文件定义和项目本机游标。
- `apps/backend/src/server.mjs`：人/Agent 共同项目路由、事件和文件读取；停止使用旧自动化端点。
- `apps/backend/src/service.mjs`：取消项目创建/启动时向数据库 seed 内置流程，加入 .atk 路径约束和忙碌判断。
- `packages/database/src/index.mjs`：新实现不再读写 automations/automation_runs/automation_trigger_states；无旧数据导出任务。
  旧数据库残留表无需自动删除，不允许把“不迁移”实现成启动时破坏性清空。
- `packages/project-files/src/index.mjs`：.atk 保留目录、写入范围/快照排除和真实路径校验。
- `apps/agent-cli/cli.mjs`、`packages/agent-client/src/index.mjs`：automation 子命令、参数解析、幂等请求、等待和日志跟随。
- `apps/web/src/automations.tsx` 及样式：文件配置、参数表单、新状态、不定进度、详细结果和归档入口。
- `apps/backend/resources/skill/atk-create-automation/SKILL.md` 与内置 CLI 帮助：允许使用 Agent API 配置/运行，并解释 Windows CLI 入口限制。
- `apps/backend/src/operations.mjs`：新备份文件范围、忽略本机状态、恢复后刷新和新的空闲条件。
- `apps/desktop/dev-runtime.mjs` 与后端重载检查：活动/待核对自动化继续阻止自动重载。
- `test/automations.test.mjs`、HTTP/Agent、项目文件、operations 测试：旧数据库/命令字符串/旧 marker 假设需要替换。
- `scripts/e2e.mjs`、`scripts/desktop-e2e.mjs`：创建配置、Agent 发起、参数输入、结果/日志和进度断言改用新协议。
- README、架构、操作、资源和验证文档：更新存储位置、接入方法、权限和备份说明。

这里的破坏性是用户已同意重新接入的自动化契约切换；不改变任务计划审批、Agent 领取和业务任务回执协议。
不迁移、不双写、不同时维护“数据库配置”和“文件配置”，也不在本次设计中执行任何数据删除。

## 14. 实现顺序与验收标准

后续实现按同一版本分四步完成，不把中间状态当成已交付的新架构：

1. 文件定义/校验器/项目目录边界及内存索引；固定 fixture 验证 JSON、revision 和路径规则。
2. 共同执行器、运行文件、日志、导出、结果协议和停止/恢复；覆盖失败与异常 I/O。
3. 人/Agent API、CLI、UI、skill 和 Git 触发，端到端验证同一个 runId。
4. 备份恢复、文档和 P4Deck 接入说明；项目 CI 适配器作为独立项目改动另行实施。

必须通过的验收场景：

- 只复制项目配置到另一目录/另一台已准备工具链的设备，重新登记即可识别；定义中没有旧 projectId/绝对路径。
- 人与 Agent 配置同一文件，旧 revision 保存/启动明确冲突；无效外部编辑不能触发旧缓存定义。
- Agent 异步启动后 UI 发现同一运行，显示来源、真实进度、最近输出、完整日志和最终结果。
- 参数枚举、类型、必填、边界和重复值错误在执行前拒绝；包含空格、引号或 shell 字符的合法参数保持单个 argv。
- Windows 原生命令与显式文件解释器正常工作，.cmd/.bat 不会静默进入 shell；CLI 环境缺失诊断可读。
- 同一个幂等请求网络重试只产生一个 runId；同键不同参数冲突；后端重启后仍能找到已接受请求。
- 全局容量和同项目执行锁不会因并发请求、另一 ATK 实例或失败恢复被绕过。
- 退出码 0 但报告失败/缺失/错 runId，及非零退出但报告通过，均不能成功；未知项目 JSON 只归档。
- 下一次 CI 覆盖 latest 文件不会改变旧归档；固定路径旧结果、目录旧日志、链接越界和复制中变化均可识别。
- 没有进度协议时使用不定进度；heartbeat 不伪造完成；生产者报 100% 后仍等待退出和归档。
- 停止、超时、后端崩溃、进程树无法确认和磁盘满不会产生虚假的成功；待核对运行阻止再次执行。
- 删除定义仍可读取历史；完整复制运行目录可解释旧结果；损坏单个目录不会让其他历史消失。
- 新备份能恢复定义和历史但不会恢复执行锁/旧 Git 游标；没有旧数据迁移步骤。
- 跨项目读写/停止/文件下载受身份限制，Agent 不能自填发起人或使用恢复确认接口。
- 自动化运行和配置的正文、日志、结果、游标及持久化事件不进入中央 SQLite。

守门裁决：以上四个核心实体与统一执行路径足以覆盖本次需求，可以据此实现。
真实项目配置需按本契约重新接入；验证使用独立临时项目，不修改已有用户项目的配置和数据。
