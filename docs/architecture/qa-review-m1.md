# M1 独立 QA 复核报告（QA-002）

- 文档类型：独立复核报告（Reviewer / QA Function，身份隔离）
- 审查对象：分支 `m0/baseline-and-p0`，冻结 commit **`d80862b805739d229af126411f0e4a0c2bade051`**（M1 共 5 个提交：`09ef064` 脚手架 / `4b80dbc` database / `6c9fa87` backend / `00c7c4e` web / `d80862b` 工具与 CI）
- 审查者：`qa-reviewer`（REVIEWER/QA）。M1 产品代码、测试、脚本与文档由 Lead、worker-database、worker-backend、worker-web 编写；审查者未参与，只做独立验证与对抗测试。
- 审查环境：Windows 11，Node **v24.16.0**，pnpm 11.6.0；仓库根目录 `E:\CodeProject\agent-team-kit`。
- 起始工作区：`git status --porcelain` 为空，HEAD = `d80862b`。审查结束时工作区只有审查者新增的两个文件（`test/m1-qa-adversarial.test.mjs`、本报告）；未修改任何产品代码/他人测试，未执行任何改变 git 状态的命令。
- 后端真实服务：审查期间 Lead 在 `127.0.0.1:1421` 跑着 demo 服务，**未被停止或修改**（仅 `doctor` 做过一次端口占用探测）。所有对抗性联调都在随机端口/`14214` + 临时数据库上完成。

> **结论摘要：有条件通过。** 鉴权边界（loopback + Host + Origin + token + CSRF）、静态文件围栏、SQL 参数化、迁移/CAS 幂等与 SSE resync、i18n 完整性全部经独立验证通过；6 个变异体全部被测试抓到。发现 **4 个 MINOR**（其中 3 个集中在 M1 唯一门禁 `m1-smoke.mjs` 的自证/隔离面）+ 若干 OBSERVATION；没有 BLOCKER/MAJOR。**M1 可以标记完成，但建议先修掉 m1-smoke 的 3 个假通过面与 token-file 副作用**（小改动），否则“M1 完成”的证据链会弱于它声称的强度。详细理由见 §7。

---

## 1. 执行清单（真实命令 / 退出码 / 关键输出）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `git rev-parse HEAD` + `git log --oneline -5` + `git status --porcelain` | 0 | `d80862b…`；5 个 M1 提交齐全；工作区干净 |
| 2 | `node scripts/test.mjs`（冻结树、未加本报告测试前） | **0** | `tests 325 / pass 325 / fail 0 / cancelled 0 / skipped 0 / todo 0`（M0 未退化） |
| 3 | `node scripts/test-workspace.mjs` | **0** | `workspace tests: 21 file(s)`；`tests 193 / pass 193 / fail 0 / skipped 0 / todo 0` |
| 4 | `node scripts/check-boundaries.mjs --json` | **0** | `ok: true`、4 packages、5 edges（`backend->contracts`、`backend->database`、`database->contracts`、`database->database`、`web->contracts`）、0 cycles |
| 5 | `cmd /c "pnpm --filter @atk/web build"` | **0** | `tsc --noEmit && vite build`；dist：`index.html 445 B`、`index.css 15,529 B`、`index.js 285,388 B`（gzip 0.28 / 3.27 / 85.76 kB） |
| 6 | `node scripts/m1-smoke.mjs --verbose` | **0** | **12/12 checks passed**（migrate PASS projects=1 tasks=1 agents=4；health schemaVersion=1；无 token 403 NOT_AUTHORIZED；forged Host 403 host-not-loopback；session token/csrf；authenticated projects/tasks；PATCH 无 expectedVersion→400；SSE 200 text/event-stream；SPA / 与深链 fallback；404 NOT_FOUND；SIGINT 退出） |
| 7 | 自己起真实服务：`node apps/backend/cli.mjs migrate --data %TEMP%\atk-m1-manual\atk.db --from .agent-flow/state.json` + `serve --port 14214 --data … --web-dist apps/web/dist` | 0 | 见 §2.3（health/session/403/200/SSE/SPA 深链全部实跑通过） |
| 8 | `node --test test/m1-qa-adversarial.test.mjs`（本报告对抗套件，Node 24） | **0** | **25/25 pass**，0 skipped/todo（鉴权 A1–A9、注入/穿越 B1–B4、数据 C1–C6、i18n D1–D4、隐私/打包 E1–E2） |
| 9 | `node scripts/test.mjs`（加入本报告测试后） | **0** | `tests 350 / pass 350 / fail 0 / skipped 0 / todo 0`（325 基线 + 25 条 M1 对抗用例；Node < 22.5 时该文件打印 SKIPPED 且不注册测试，见 §6.3） |
| 10 | 变异测试：`git archive d80862b` 解包到 `%TEMP%` + node_modules junction，逐个改坏实现 | 0 | **6/6 变异被测试抓到**（见 §5）；工作区未改动 |
| 11 | `npm pack --dry-run --json`（经 `cmd /c` 捕获） | 0 | 148 files / 1,114,969 B；**不含** `apps/**`、`packages/**`、`node_modules`、`dist` |
| 12 | 脚本探针：BOM state / 零任务迁移 / doctor / PATCH status | 0 | 见 §4 与 §3：零任务迁移 status PASS；BOM state 迁移 exit 2；doctor report.ok=false 但 exit 0；PATCH 可直接把 READY 改成 DONE/CANCELLED |

### 1.1 `m1-smoke.mjs` 逐条结果（exit 0，12/12）

| 检查 | 结果 |
|---|---|
| migrate reports PASS and maps the legacy state | PASS（projects=1 tasks=1 agents=4） |
| health answers without a token and reports the schema | PASS（schemaVersion=1） |
| a read without a token is refused with a JSON 403 | PASS（NOT_AUTHORIZED） |
| a non-loopback Host is refused | PASS（403 host-not-loopback） |
| session bootstrap returns a token and a csrf value | PASS（token 43 / csrf 43） |
| an authenticated project list returns the migrated project | PASS（agent-team-kit） |
| an authenticated task list works and PATCH requires expectedVersion | PASS（tasks=1；PATCH 无 version → 400） |
| the event stream opens and delivers a keep-alive or an event frame | PASS（首个 chunk 是 `: connected …`，见 §3 QA2-02） |
| the SPA index is served at / with a no-cache header | PASS（445 B） |
| a client-side route falls back to the SPA index | PASS（/tasks/TASK-1 → 200） |
| an unknown API path is a JSON 404 | PASS（NOT_FOUND） |
| the server process shuts down without hanging | PASS（SIGINT 后退出） |

---

## 2. 关键联调（真实 `serve`，端口 14214，临时库）

### 2.1 迁移

`node apps/backend/cli.mjs migrate --data %TEMP%\atk-m1-manual\atk.db --from .agent-flow/state.json --json`
→ exit 0；`status: PASS`；项目 `agent-team-kit`，tasks=1（仓库自身 state 里是 1 个 slice），agents=4；runs 如实为 0。

### 2.2 服务与 API（真实 HTTP）

| 请求 | 结果 |
|---|---|
| `GET /api/v1/system/health`（无 token） | 200；`db.schemaVersion=1`；注：响应含**绝对 db 文件路径**（见 QA2-06） |
| `GET /api/v1/tasks`（无 token） | **403** `NOT_AUTHORIZED` |
| `GET /api/v1/session` | 200；token 43 字符、csrf 43 字符、actor HUMAN |
| `GET /api/v1/tasks` + `x-atk-token` | 200，items=1 |
| `GET /api/v1/projects` + token | 200，`agent-team-kit` |
| `POST /api/v1/projects`（token + csrf + same-origin） | **201** |
| 同 POST 缺 `x-atk-csrf` | **403** `NOT_AUTHORIZED` |
| `GET /api/v1/events/stream` + token | 200 `text/event-stream; charset=utf-8`，首 chunk `: connected …` |
| `GET /tasks/TASK-1`、`/agents`、`/reviews`（SPA 深链） | 全部 200、含 `<div id="root">`、`cache-control: no-cache` |

### 2.3 真实 CLI 与端口 1421 隔离

- 全程只使用随机端口与 `14214`；`1421` 上的 Lead demo 服务未被连接（`doctor` 的 `portIsFree` 探测除外，它只是尝试 bind 后失败）。
- 但 **`m1-smoke`/`serve` 会重写共享的 `%LOCALAPPDATA%\AgentTeamKit\runtime\session-token`**（实测 mtime `03:31:05 → 03:36:20`），这对并发运行的 1421 服务有副作用，见 QA2-03。

---

## 3. m1-smoke 自身审查（当“被测物”审）

**开发者提到的 try/finally 提前杀服务 bug：已确认修复。** 现在的结构是：先 `waitForHealth`（第 176 行）→ `try { … for (const runCheck of checks) results.push(await runCheck()) }`（第 318–319 行）→ `finally { if (!server.killed) server.kill() }`（第 320–322 行）。所有检查在服务存活期间执行，`finally` 只负责收尾；若服务在任一检查前死亡，对应 `fetch`/socket 会失败并被该 check 捕获为 FAIL。**这一条判 PASS。**

但把门禁当被测物后，仍有 3 个“看起来通过、实际没验证”的面（详见 QA2-02/03）：

1. **0 任务早退 PASS**：`check("an authenticated task list works …")` 在 `tasks.length === 0` 时直接 `return "0 tasks …"`（m1-smoke.mjs:241），不执行 PATCH 验证；而 migrate 检查只断言 `counts.projects >= 1`（:156），不断言 tasks。实测“导入 0 任务的 state”也会得到 `status: PASS, counts.tasks: 0` → **迁移一旦静默丢掉全部任务，m1-smoke 仍 12/12 通过**。
2. **SSE 检查同义反复**：`expect(text.includes(":") || text.includes("event:"))`（:269）对首个 chunk 永远成立，因为服务端在鉴权后**无条件先写 `: connected <ts>`**（sse.mjs:141；本次实跑首 chunk 正是该注释帧）。因此 replay/事件投递/Last-Event-ID 全部坏掉时该检查仍 PASS。另外 M1 目前没有任何“事件生产者”（`server.mjs` 不调用 `store.appendEvent`，迁移 events=0），所以 SSE 在本轮实际上只被验证到“能建流”。
3. **写成功路径未覆盖**：smoke 只测了“PATCH 缺 expectedVersion → 400”，没有一次成功的写（201/200），也没有 CSRF/Origin 缺失的边界；这些由 workspace 测试覆盖，但“端到端门禁”本身没锁住写能力。

---

## 4. A/B/C/D/E 逐项结论表

判定：**PASS** = 契约要求满足；**FAIL** = 与契约冲突；**OBSERVATION** = 记录项（未强制/已声明）。

### A. 鉴权与本地访问（ADR-008 / m1-contracts §2）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| A1 `Host: localhost.evil.com` / `127.0.0.1.evil.com` / 任意外域 | 403 `host-not-loopback` | 403（三种全拒） | PASS |
| A1b 合法 `localhost[:port]` / `127.0.0.1[:port]` / `[::1]` | 放行 | 200 | PASS |
| A2 无 `Host`（HTTP/1.0 raw） | 403 `host-missing` | 403 | PASS |
| A3 跨源写（合法 token+csrf，`Origin: http://evil.example`） | 403 `origin-mismatch` | 403 | PASS |
| A3b `Origin: null` | 拒绝 | 403（`origin-invalid`） | PASS |
| A3c 无 `Origin` 且无 CLI 标记 | 403 `origin-missing` | 403 | PASS |
| A4 无 `Origin` + `x-atk-client: cli` + token + csrf | 放行（契约的 CLI 白名单） | 201 | PASS |
| A4b CLI 标记 + 跨源 `Origin` | 不得绕过 Origin | 403 `origin-mismatch` | PASS |
| A4c CLI 标记但缺 csrf / 缺 token | 403 | `csrf-missing` / `token-missing` | PASS |
| A5 token 放 query | 不生效（token 只能进 header） | 403 `token-missing`；`/session` 不发布带 token 的 URL | PASS |
| A6 错 token / 过期 token | 403 `token-invalid` / `token-expired` | 均 403 | PASS |
| A7 有 token 无 `x-atk-csrf` 的 POST/PATCH | 403 `csrf-missing` | 403 | PASS |
| A8 头名大小写（`X-ATK-TOKEN`/`X-ATK-CSRF`/`Origin`） | HTTP 大小写不敏感，正常放行 | 读 200、写 201 | PASS |
| A9 未鉴权端点边界 | 只有 `/system/health`、`/session` 匿名；其余 403；`/session` 若带跨源 Origin 也必须拒 | 全部符合 | PASS |

附加：`/session` 返回 token+csrf；写请求的 `Origin` 仅允许 `http:` 且必须与 Host 的 hostname:port 同源；`safeEqual` 为常数时间比较。

### B. 静态文件与注入

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| B1 `/../secret`、`/%2e%2e/…`、`/assets/../../…`、反斜杠、`%00`、`//…` | 不得离开 dist | 全部被 URL 规范化或 `insideRoot` 拦截；返回 index fallback/4xx，**未泄漏** dist 外文件 | PASS |
| B2 `/api/../…`、`/api/%2e%2e/…` 混淆 | 不得泄露静态文件、不得跳过鉴权 | 规范化后仍是受保护 API（无 token → 403）；无 `package.json` 泄漏 | PASS |
| B3 `q/status/limit/afterSeq` 注入与边界 | SQL 片段/负数/非数字/超长 → 400 或 200（参数化），绝不 500 | 10 组非法过滤全部 400 `VALIDATION_ERROR`；4000 字符 + SQL 片段的 `q` → 200（LIKE 参数化） | PASS |
| B4 超大 body / 超长 URL | 4xx 或拒绝连接，服务不死 | 2 MB body 被 400 拒绝（或连接被 reset）；20 KB URL 无 HTTP 响应（`-1`）；两次探测后 health 仍 200 | PASS |
| B5 目录穿越的边界说明 | — | `static.mjs` 是词法围栏（`path.relative`），dist 内若有符号链接会被跟随；dist 是构建产物、受信输入，判 OBSERVATION 不判缺陷 | OBSERVATION |

### C. 数据 / 并发 / SSE

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| C1 同一库连续 migrate（openStore 两次） | 不重复建表、不重复记录迁移 | `schema_migrations` 恰 1 行；schemaVersion 1 | PASS |
| C1b 同一库连续 `cli.mjs migrate` 两次 | 任务不翻倍 | 第一次 tasks=3，第二次 `counts.tasks=0`，DB 任务数不变 | PASS |
| C2 恶意 state.json（`../`、绝对路径、重复 id、非 ASCII、缺字段） | 路径逃逸/重复 id → 错误且**零部分写入**；非 ASCII 只记录 info；缺字段派生并 warning | 全部符合（`PATH_ESCAPE`/`DUPLICATE_ID` → status SKIPPED 且 tasks=0） | PASS |
| C3 PATCH 版本冲突（CAS） | 旧 version → 409 `TASK_VERSION_CONFLICT` + `details.currentVersion` | 一致；缺 expectedVersion → 400；POST 带 status → 400 server-owned | PASS |
| C4 SSE 合法 Last-Event-ID | 只 replay 连续、升序、完整的帧 | Last-Event-ID 0 → 帧 id 1,2,3 升序；`system.resync-required` 单独分类 | PASS |
| C5 SSE 非法/未来/已剪枝 Last-Event-ID | 必须 resync（`gap` / `invalid-last-event-id`），不能假装实时 | 三种全部返回 `system.resync-required`；`resumePlan(1,5,6)` = resync | PASS |
| C6 PATCH 允许直接改 `status` | m1-contracts §1：“客户端不得直接设 status” | `PATCH {changes:{status:"DONE"}}` → **200 且状态变 DONE**；再改 CANCELLED 也成功 | **MINOR（QA2-01）** |

### D. 前端 / i18n（不依赖 worker 的测试）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| D1 `src` 内 i18n 目录外零 CJK 硬编码 | 0 命中 | 自写扫描（去注释后）→ 0 命中 | PASS |
| D2 en / zh-CN 字典 key 集合一致、无空值、占位符一致 | 完全一致 | 各 **217 keys**；key 集合一致；占位符 `{{x}}` 集合一致；无空值 | PASS |
| D3 状态映射覆盖 contracts 全部枚举 | Task 10 / Run 7 / Agent 7 / Review 5 / Integration 5 / Acceptance 3 / Gate 5 / Function 3 全覆盖，且标签在双字典存在 | 8 组全部覆盖、无遗漏/多余；所有 `status.*` key 在 en/zh 均存在；未知值 fallback `status.unknown` | PASS |
| D4 语言解析/持久化边界 | zh*→zh-CN、非法值→en、storage 抛错不崩、持久化 key `atk.lang` | zh-TW/zh-Hant/ZH-hans→zh-CN；非法/空→en；throwing storage → null/false；写入/读取往返一致 | PASS |
| D5 语言切换 UI 契约 | `data-testid="lang-toggle"`、`<html lang>` 同步 | 源码存在 testid；`applyDocumentLanguage` 由 provider 调用；localStorage key 正确 | PASS |

### E. 隐私与发布

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| E1 密钥/令牌 | 0 命中 | `apps/**`、`packages/**`、`scripts/**`、M1 文档：无 `sk-*`、无长 Bearer、无私钥 | PASS |
| E2 本机用户名/绝对路径 | 0 命中 | 无用户名；无 `C:\Users\<真实名>`；仅文档占位符 | PASS |
| E3 `npm pack --dry-run` | 仍可用；不得把 node_modules/dist 打进包 | exit 0；148 files / 1.11 MB；**不含** node_modules/dist/apps/packages（M1 workspace 包为 `private`，不在根包发布范围，属预期） | PASS |
| E4 包边界 | 允许边、无环、无未声明依赖 | `check-boundaries` PASS（5 edges / 0 cycles）；contracts 零依赖 | PASS |

---

## 5. 变异测试结果（`git archive d80862b` 临时树，工作区未动）

方法：解包到 `%TEMP%`，用 junction 指向已安装的 `node_modules`；基线 6 个测试文件全绿后，逐个注入变异、跑对应测试、恢复。

- 基线：`auth / sse / static / tasks / import-export / stream` 测试 → exit 0。

| 变异 | 目标测试 | 结果 | 被抓到的失败用例（示例） |
|---|---|---|---|
| M1 缺 `Origin` 的写请求无条件放行 | `auth.test.mjs` | **CAUGHT** | `write requests require Origin (CSRF boundary) unless the CLI marker is present` |
| M2 task CAS 不再报 stale version | `packages/database/test/tasks.test.mjs` | **CAUGHT** | `patchTask is a real CAS: version conflict keeps the old version and data` |
| M3 SSE 永远 replay、不再 resync | `sse.test.mjs` | **CAUGHT** | `a pruned event log produces system.resync-required…`、`an invalid Last-Event-ID asks the client to resync` |
| M4 静态围栏 `insideRoot` 恒 true | `static.test.mjs` | **CAUGHT** | `a built dist is served, SPA routes fall back … traversal is contained` |
| M5 legacy import 不跳过已存在任务 | `import-export.test.mjs` | **CAUGHT** | `importing the same data again is idempotent (skip, not duplicate)` |
| M6 resync 帧被当作普通事件 | `apps/web/test/stream.test.mjs` | **CAUGHT** | `classifies the resync frame before generic event types` |

结论：M1 自己的测试对鉴权、CAS、SSE、静态围栏、迁移幂等与 web 帧分类**真的能失败**；6/6 变异被捕获。

---

## 6. 缺陷清单

严重度：BLOCKER = 阻断 M1；MAJOR = 明确契约违反且影响数据/安全；MINOR = 局部偏差/门禁强度问题；OBSERVATION = 记录项。

### QA2-01（MINOR）HTTP PATCH 允许客户端任意直接设置 `task.status`，与“server-owned / 客户端不得直接设 status”冲突

- 位置：`apps/backend/src/server.mjs` `PATCHABLE_TASK_FIELDS` 含 `status`；`validateTaskChanges` 只校验枚举；`store.patchTask` 无状态机校验。对比：`POST /tasks` 显式拒绝 status（400 `task.status is server-owned`）。
- 复现：
  1. `POST /api/v1/projects` → 201；
  2. `POST /api/v1/tasks` → 201，`status: READY`；
  3. `PATCH /api/v1/tasks/T-1`，`{expectedVersion:0, changes:{status:"DONE"}}` → **200，status=DONE**；再 `{expectedVersion:1, changes:{status:"CANCELLED"}}` → 200。
- 期望（依据）：`docs/architecture/m1-contracts.md` §1 Tasks 注明“spec §5.2 状态机；客户端不得直接设 status”；§2 PATCH 只要求 `expectedVersion`。既然 POST 明确拒绝，PATCH 也不应在 M3 状态机落地前允许任意跳变（尤其 READY→DONE/CANCELLED，绕开 review/acceptance）。
- 影响：M1 的 SPA 目前是只读的（`apiPatch` 未接到 UI），且调用方是持有 token 的本机 HUMAN，因此不构成越权；但它让“服务端拥有状态”的契约在 API 层不成立，M3 接入 scheduler/agent 后会变成真实缺口。
- 建议：M1 内 PATCH 拒绝 `status`（返回 400，提示“status transitions land with the scheduler”），或把该例外写进 m1-contracts 并记录过渡规则；归属 worker-backend/Lead。

### QA2-02（MINOR）`scripts/m1-smoke.mjs` 存在三处“假通过面”

- 位置/证据：
  1. `m1-smoke.mjs:241` `if (tasks.length === 0) return "0 tasks …"` → 任务列表检查变成 PASS；`:156` 只断言 `counts.projects >= 1`。实测导入 0 任务的 state → `migrate status PASS, counts.tasks 0` → smoke 仍会 12/12。
  2. `m1-smoke.mjs:269` `text.includes(":") || text.includes("event:")` 对首 chunk 恒真：实测首 chunk 是 `: connected <ts>`（`sse.mjs:141` 无条件先写注释帧），所以 replay/事件投递坏掉也 PASS；同时 M1 没有任何事件生产者（`server.mjs` 无 `appendEvent`，迁移 events=0），SSE 实际只被验证到“能建流”。
  3. 门禁没有成功写路径（201/200）与 CSRF/Origin 缺失负例；这些只有 workspace 单测覆盖。
- 期望：门禁应验证“已知仓库 state（1 slice → ≥1 task）”确实迁移出任务，并在 SSE 上断言**事件帧或 Last-Event-ID replay**（例如先 `store.appendEvent` 再连流），而不是依赖 always-on 的注释帧；成功写路径应至少一条。
- 影响：M1 的唯一端到端门禁强度低于其声称的“12 assertions”，可能放行“迁移丢任务/SSE 坏掉”的回归。
- 归属：Lead（scripts/m1-smoke.mjs）。

### QA2-03（MINOR）`m1-smoke` 声称全部在临时目录，实际会重写共享的用户 token 文件

- 位置：`m1-smoke.mjs` 用 `cli.mjs serve` 启动服务（未传固定 token，`:163-167`）；`serve` 会 `persistSessionToken` 到 `%LOCALAPPDATA%\AgentTeamKit\runtime\session-token`（`paths.mjs` / `auth.mjs`），脚本只在结束时删临时 DB（`:347`），不恢复 token 文件。
- 复现（实测）：smoke 前 token 文件 mtime `2026-11-02T03:31:05` → smoke 后 `03:36:20`（本审查随后手动 `serve` 又更新到 `03:38:14`）。
- 影响：与真实运行中的 1421 服务共享同一 token 文件；一次 smoke 会让“基于 token 文件的 CLI 鉴权”与 1421 服务内存中的 token 不一致（CLI 会 403，直到重新 bootstrap/重启服务）。CI 单机单任务问题不大，本地并发开发时会踩到。
- 建议：smoke 启动服务时把 `LOCALAPPDATA`/`XDG_DATA_HOME` 指向临时目录（`env` 注入），或给 `serve` 增加 `--token`/`--no-persist`（测试用）；归属 Lead。

### QA2-04（MINOR）Windows BOM：`cli.mjs` 的 state/ownership/runtime/config 读取不容忍 UTF-8 BOM，迁移直接 exit 2

- 位置：`apps/backend/cli.mjs` `JSON.parse(fs.readFileSync(...))` 与 `readOptionalJson()` 没有 `stripBom`；M0 已在 `lib/util.mjs` 建立 `stripBom`/`readJsonStrict` 约定（并在 release 修过 BOM 报告）。
- 复现：用 UTF-8 BOM 写 `state.json`（Notepad、PowerShell 5.1 `Set-Content -Encoding utf8` 的默认产物）→ `node apps/backend/cli.mjs migrate --data … --from bom-state.json` → **exit 2**，`atk-backend: cannot parse state JSON …: Unexpected token '﻿'`。
- 期望：与工具链既有约定一致，BOM 容错读取；否则最常见的 Windows 编辑器产物无法迁移。
- 归属：worker-backend（`apps/backend/cli.mjs`），建议直接复用 `lib/util.mjs` 的 `stripBom`/`readJsonStrict`（或把该工具函数抽到 contracts/util 供 apps 使用；注意包边界允许 backend 只依赖 contracts/database，不能 import `lib/`）。

### OBSERVATION

- **QA2-05** `doctor` 在 `report.ok=false`（本次 1421 被占用 → `port-1421 FAIL`）时仍 **exit 0**；自动化若只看退出码会把诊断失败当成功。建议 `doctor` 用非 0 退出码表达 `!ok`，或文档明确“只看 JSON 的 ok 字段”。
- **QA2-06** 未鉴权的 `/api/v1/system/health` 返回 `db.file` **绝对路径**（用户目录）与版本号；本地信息暴露有限，可考虑只返回 basename 或在 `/session` 后返回。
- **QA2-07** SPA/静态响应缺少 `Content-Security-Policy`、`X-Frame-Options`/`frame-ancestors`（本地 UI 可被恶意页面 iframe 套壳；M1 UI 只读，风险低）。ADR-008 未要求，建议 M5 安全硬化时补。
- **QA2-08** M1 没有事件生产者（API 写任务不会 `appendEvent`；迁移 events=0），SSE 当前只是 keep-alive 通道，UI 的“Live”指示器不会收到业务更新。若这是 M2/M3 的既定范围，请在文档中写明；否则属于“看起来实时、其实没有事件”。
- **QA2-09** token 文件是“每用户全局”而非“每实例”：同机同时跑两个 `serve`（不同端口）会互相覆盖 token 文件（M1 默认单实例 1421，可接受）。建议 M2 引入 instance id/pipe 时一并改。
- **QA2-10** `resolveLanguage("zh-Hant"/"zh-TW")` 映射到 `zh-CN`（简体），与契约“zh* → zh-CN”一致，但对繁体用户是 UX 近似；记录不判缺陷。
- **QA2-11** `npm pack` 不包含 M1 `apps/**`、`packages/**`（根包仍是 legacy CLI，M1 包 `private`）；若 M1 计划随 npm 发布，需在 M2 明确发布单元。

---

## 7. 结论

### 7.1 M1 能否标记完成

**有条件通过：M1 可以标记完成，但建议先完成 3 个低成本修复，再把它写进状态文档。**

- 已真实达成（独立验证）：
  - 鉴权四层（loopback 绑定 / Host 白名单 / Origin+CLI 白名单 / token+CSRF）全部符合 ADR-008 与 m1-contracts §2；跨源、`Origin: null`、无 Host、token 入 query、头名大小写等边界均已实测。
  - 静态服务对原始/编码/反斜杠穿越全部围栏；API 前缀混淆既不泄文件也不跳鉴权。
  - SQL 全部参数化，注入/负数/超长 limit 全部 400；迁移与 CLI 迁移幂等（无任务翻倍）；CAS 409 正确；SSE 非法/未来/剪枝 Last-Event-ID 全部 resync。
  - i18n：自写扫描 0 处 CJK 硬编码、217×2 key 完全一致、8 组状态枚举全覆盖；构建 exit 0（tsc + vite）。
  - 变异测试 6/6 抓到；`m1-smoke` 的服务存活结构 bug 已确认修复。
- 条件（建议在标记 M1 完成前处理；都很小）：
  1. QA2-02：把 m1-smoke 的 0-task 早退与 SSE 注释帧同义反复改成真实断言（失败即门禁红）；
  2. QA2-03：smoke 用临时 `LOCALAPPDATA` 或 `--token`/`--no-persist`，停止重写共享 token 文件；
  3. QA2-01：明确 PATCH status 的策略（M3 前拒绝，或在契约中写明过渡规则并加测试）；
  4. QA2-04：BOM 容错（Windows 常见输入）建议同批修。
  若 Lead 决定把上述作为 M1 已记录的限制延后，需要把“M1 门禁证据强度有限”与“PATCH status 过渡期例外”写入 `docs/roadmap/m1-status.md`，而不是只写“M1 完成”。
- 无 BLOCKER、无 MAJOR；其余 OBSERVATION 可在 M2/M5 处理。

### 7.2 “QA PASS ≠ 生产可用”边界声明

即使 M1 标记完成，本结论**不构成生产可用性背书**：

1. **没有 Scheduler / Runtime Host / 真实 DSH 适配器**：M1 只有本地 HTTP + SQLite + SPA；M2 的 Runtime 与 M3 的 Scheduler 未开始，真实 DSH/Magpie 仍不可用（M0 Spike 结论仍为“不可用”）。
2. **JSON 仍是唯一事实来源**：M1 的 SQLite 是从 `state.json` 导入的读模型；`state.json → SQLite` 的切换（ATK-105）未做，没有多进程事务与迁移演练。
3. **单用户本机模型**：无 TLS、无多用户/角色认证、无审计签名；session token 是进程内短期凭据，ADR-008 的内部 API 凭据（scheduler/runtime 分离）尚未实现。
4. **事件驱动未闭环**：M1 无事件生产者，SSE 的 replay/resync 只在测试与手工 store 注入下验证过；UI “Live” 语义要等 Runtime/Scheduler。
5. **前端未做浏览器 E2E**：i18n/路由/状态映射是纯逻辑单测 + 构建校验，没有 Playwright/真实 DOM 验证；M5 才补。
6. **发布单元未定**：M1 code 不在 npm 包内；仓库仍以 legacy CLI 为发布物。

---

## 附录 A：复跑命令

```bash
# M0 回归（Node 20/22/24）
node scripts/test.mjs                 # 冻结树 325/325；加入本报告测试后 Node >= 22.5 为 350/350

# M1 workspace（Node >= 22.5；<22.5 打印 SKIPPED，不冒充 PASS）
node scripts/test-workspace.mjs      # 193/193
node scripts/check-boundaries.mjs    # PASS（4 packages / 5 edges / 0 cycles）
cmd /c "pnpm --filter @atk/web build"  # tsc --noEmit + vite build，exit 0
node scripts/m1-smoke.mjs            # 12/12（注意它会重写共享 token 文件，见 QA2-03）

# 对抗套件（Node >= 22.5；<22.5 整个文件打印 SKIPPED 且不注册测试）
node --test test/m1-qa-adversarial.test.mjs   # 25/25

# 真实联调（自定义端口/临时库；不要动 1421）
node apps/backend/cli.mjs migrate --data %TEMP%\atk-m1-manual\atk.db --from .agent-flow/state.json --json
node apps/backend/cli.mjs serve  --port 14214 --data %TEMP%\atk-m1-manual\atk.db --web-dist apps/web/dist

# 变异测试（见 §5）：git archive d80862b 解包到临时目录 + node_modules junction，
# 注入 6 个变异体后对应测试全部变红；工作区不变。
```

## 附录 B：对抗测试清单（`test/m1-qa-adversarial.test.mjs`，25 条）

| 组 | 用例 | 结果 |
|---|---|---|
| A1–A9 | Host 白名单/DNS rebinding、无 Host、跨源/null/缺 Origin、CLI 标记不越权、token 只走 header、错误/过期 token、CSRF、头名大小写、匿名端点边界 | 全绿 |
| B1–B4 | 静态穿越（含编码/反斜杠/%00）、`/api/..` 混淆、SQL/整数注入、超大 body/URL | 全绿 |
| C1–C6 | migrate/openStore 幂等、真实 CLI 迁移两次、恶意 state 零部分写入、PATCH CAS 409、SSE replay、SSE 非法/未来/剪枝 resync | 全绿 |
| D1–D4 | 自写 CJK 扫描、双字典 key/占位符一致、8 组状态映射覆盖、语言解析/持久化边界 | 全绿 |
| E1–E2 | 密钥/真实路径扫描、发布包不含 node_modules/dist 且 contracts 零依赖 | 全绿 |

合计 **25/25 绿**；该文件在 Node < 22.5 时打印 `SKIPPED … not a pass` 且不注册测试，以保持 legacy CI（Node 20）的 325 基线不退化。
