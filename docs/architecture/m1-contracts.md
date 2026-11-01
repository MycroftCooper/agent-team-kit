# M1 契约：store 接口 / HTTP API / SSE / i18n

- 状态：M1 实施中的**单一事实来源**，三个并行 Worker 都以此为准
- 日期：2026-11-02
- 关联：ADR-002、ADR-003、ADR-008、ADR-009；规范 §6、§7、§11
- 变更纪律：任何一方要改这里的形状，先 message Lead；不允许各自发明同名字段。

---

## 0. 目录与归属

| 包 | 归属 | 内容 |
|---|---|---|
| `packages/database` | worker-database | SQLite schema/迁移/仓储/JSON 导入导出 |
| `apps/backend` | worker-backend | HTTP API、SSE、本地鉴权、静态服务 |
| `apps/web` | worker-web | React SPA、i18n、设计令牌 |
| `packages/contracts` | Lead | 枚举/错误码/DTO 校验（M0 已交付，M1 只增强） |

测试位置：各包自己的 `test/*.test.mjs`，由 `node scripts/test-workspace.mjs` 统一运行（Node < 22.5 时打印 SKIPPED，不是 PASS）。

---

## 1. `@atk/database` store 接口（backend 唯一的数据入口）

所有方法**同步**（`node:sqlite` 是同步 API），返回纯 JSON 可序列化对象；失败用错误对象抛出：

```js
// 错误形状：{ code, message, details? }
// code ∈ contracts.ERROR_CODES（见 packages/contracts/src/errors.mjs）
// 典型：VALIDATION_ERROR / NOT_FOUND / TASK_VERSION_CONFLICT / TASK_DEPENDENCY_BLOCKED
```

```js
export function openStore({ file, migrate = true }) : Store

Store = {
  close(): void,
  health(): { ok: true, file: string|null, schemaVersion: number,
              counts: { projects, tasks, runs, events, agents } },

  // Projects
  listProjects(): Project[],
  getProject(id): Project,
  createProject(dto): Project,              // dto = contracts.validateProject
  updateProject(id, { expectedVersion, changes }): Project,

  // Requirements
  listRequirements({ projectId }): Requirement[],
  createRequirement(dto): Requirement,

  // Tasks (spec §5.2 状态机；客户端不得直接设 status)
  listTasks({ projectId?, status?, roleRequired?, functionRequired?, q?, limit? }): Task[],
  getTask(id): Task,
  createTask(dto): Task,                    // dto = contracts.validateTask, 新建为 READY
  patchTask(id, { expectedVersion, changes }): Task,  // CAS：版本不符 → TASK_VERSION_CONFLICT

  // Runs / Agents / Reviews / Approvals（M1 只读为主）
  listRuns({ taskId?, status?, limit? }): Run[],
  getRun(id): Run,
  listAgents(): Agent[],
  upsertAgent(dto): Agent,
  listReviews({ status? }): Review[],
  listApprovals({ taskId?, status? }): Approval[],
  createApproval(dto): Approval,            // dto = contracts.validateApproval

  // 概览（Backend /projects/:id/overview 直接返回）
  overview(projectId): {
    project: Project,
    counts: {
      tasksByStatus: Record<string, number>,
      runsRunning: number,      // status ∈ {STARTING, RUNNING}（“在飞”）
      runsTotal: number,
      awaitingAcceptance: number
    },
    blocked: Task[],
    awaitingAcceptance: Task[],
    recentEvents: Event[]      // 最近 20 条，seq 降序
  },

  // 事件（追加式；backend 的 SSE 依赖它）
  appendEvent({ projectId, aggregateType, aggregateId, type, payload }): Event,
  listEvents({ projectId?, afterSeq?, limit? }): Event[],   // seq 升序
  latestSeq(): number,
}
```

**导入导出（M1 的 `atk migrate` 载体，属于 database 包）**

```js
export function importStateJson(store, { stateJson, ownership, runtime, now?, dryRun = false })
  : { status: "PASS"|"SKIPPED", dryRun, counts: {...}, problems: [{level, code, detail}], manifest: {...} }
export function exportStateJson(store, { projectId? }): { state: object, manifest: {...} }
```

规则：`dryRun` 只统计不写；重复执行必须幂等（同 id 覆盖/跳过而非重复插入）；`problems` 里的 `level: "error"` 非空时 `status` 不得为 `PASS`。

**表（schema v1，最小可行集）**
`projects, requirements, tasks, task_dependencies, agent_profiles, agent_instances, runs, run_leases, dispatch_commands, plans, reviews(review_attempts), approvals, gate_results, events, schema_migrations`
每表含 `id TEXT PRIMARY KEY`（`events` 用 `seq INTEGER PRIMARY KEY AUTOINCREMENT`）、`created_at TEXT NOT NULL`、需要并发的实体带 `version INTEGER NOT NULL DEFAULT 0`。WAL + `busy_timeout` 开启。

**已裁决的实现细节（M1，双方按此对齐）**

| 项 | 决定 |
|---|---|
| 实体 JSON 字段 | 见 `packages/database` 的 JSDoc；`Task.deps` 是 task id 数组；`Event` 由 `contracts.createEvent()` 产出并由库里回填 `seq` |
| 并发冲突错误码 | Task 用 `TASK_VERSION_CONFLICT`；Project/Run 等用 `VERSION_CONFLICT`；两者都带 `details.currentVersion` |
| `createTask` | 忽略客户端 `status`，新建恒为 `READY`；缺 `id` 时服务端生成 `TASK-<base36>`；`deps` 指向不存在任务 → `VALIDATION_ERROR` + `details.missingDeps` |
| import 幂等 | 同一行重复导入不产生重复记录；**但重复 id 不得静默覆盖**：记 `problems: [{level:"error", code:"DUPLICATE_ID"}]`，`status` 不为 `PASS` |
| 旧数据无 Run | 旧 `state.json`/`runtime.json` 没有 Run 记录 → `runs` 表为空、`counts.runsTotal=0`，这是**如实为空**，不是迁移失败，必须写进 `manifest` |
| project 映射 | project id 取 `agent-flow.config.json` 的 `project`，缺失则 `"default"` |
| memory store | `createMemoryStore()`，可从 `@atk/database/memory` 导入（backend/QA 用来避开 SQLite） |

---

## 2. HTTP API（`@atk/backend`，绑定 `127.0.0.1:1421`）

统一前缀 `/api/v1`。请求/响应 `application/json; charset=utf-8`。

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/api/v1/system/health` | `{ ok, version, db: health(), uptimeMs }`，**无鉴权**（只读诊断） |
| GET | `/api/v1/session` | 引导：`{ token, csrf, actor: "HUMAN", expiresAt }`，仅 loopback + 合法 Host/Origin |
| GET | `/api/v1/projects` | `{ items: Project[] }` |
| POST | `/api/v1/projects` | 建项目 |
| GET | `/api/v1/projects/:id/overview` | store.overview |
| GET | `/api/v1/tasks?projectId=&status=&q=&limit=` | `{ items: Task[] }` |
| POST | `/api/v1/tasks` | 建任务（`status` 由服务端定 READY） |
| GET | `/api/v1/tasks/:id` | 详情 + `allowedActions` |
| PATCH | `/api/v1/tasks/:id` | 必须带 `expectedVersion`；冲突 `409 TASK_VERSION_CONFLICT` |
| GET | `/api/v1/runs?taskId=&limit=` | `{ items: Run[] }` |
| GET | `/api/v1/runs/:id` | Run 详情 |
| GET | `/api/v1/agents` | `{ items: Agent[] }` |
| GET | `/api/v1/reviews` | `{ items: Review[] }` |
| GET | `/api/v1/approvals?taskId=` | `{ items: Approval[] }` |
| GET | `/api/v1/events?afterSeq=&limit=` | `{ items: Event[] }` |
| GET | `/api/v1/events/stream` | SSE；`Last-Event-ID` 补偿；缺口 → `system.resync-required` |
| GET | `/` 及静态资源 | 服务 `apps/web/dist`（存在时），SPA fallback 到 `index.html` |

**错误体**（必须用 `packages/contracts.errorBody`）：`{ error: { code, message, requestId, details? } }`。
**并发**：写请求支持 `Idempotency-Key`（M1 只记录，不强制）；`PATCH` 必须 `expectedVersion`。

**鉴权（ADR-008）**
- 绑定 `127.0.0.1`；校验 `Host` ∈ {`127.0.0.1`, `localhost`（可带端口）}，否则 403。
- 除 `/system/health` 与 `/session` 外，所有请求需 `x-atk-token`；`/session` 下发 token（进程内随机，写盘 `%LOCALAPPDATA%\AgentTeamKit\runtime\session-token`，权限收紧）。
- **写请求**（POST/PATCH/DELETE）额外需要 `x-atk-csrf`（值 = `/session` 返回的 `csrf`），缺失或错误 403。
- **Origin 规则**：浏览器请求必须同源；无 `Origin` 的写请求仅当带 `x-atk-client: cli` 时放行（CLI 场景），否则 403。测试必须覆盖"缺 Origin → 403"。
- 状态码：`POST` 创建 → 201；`GET`/`PATCH` → 200。
- SPA 通过 `/session` 自举；**禁止**把 token 放进 URL。
- **SSE 必须用 `fetch` + `ReadableStream` 消费**（`EventSource` 无法设置 `x-atk-token` 头，而 token 不允许进 URL）：手动解析 `id:`/`event:`/`data:`/心跳注释帧，重连带 `Last-Event-ID` 头。

---

## 3. SSE 帧（`packages/contracts/events.mjs` 已实现编码/解析/补偿判定）

```
id: 12
event: task.updated
data: {"taskId":"T-1","status":"REVIEWING","version":3}
```
- 心跳：`: keep-alive <ts>` 每 25s。
- 断线：浏览器带 `Last-Event-ID`；服务端用 `resumePlan(lastEventId, oldestAvailable, latest)` 决定 `replay` 还是发 `system.resync-required`（前端收到后必须整体重取快照，不许假装还在实时）。

---

## 4. 前端（`@atk/web`）必须满足

1. **双语（用户明确要求）**：`zh-CN` 与 `en`，顶栏**语言切换按钮**，`data-testid="lang-toggle"`；默认读 `navigator.language`（`zh*` → zh-CN，否则 en），选择持久化 `localStorage["atk.lang"]`；`<html lang>` 随切换更新。**组件内不得硬编码可见文案**，全部走字典。
2. 页面：概览（项目/task 计数/阻塞/待人工验收）、任务看板（列表+看板两种视图、状态筛选）、任务详情（含 Run/Review/Approval）、Agent 列表、事件流。M1 允许「审查与验收」「设置」为占位页但必须在导航里可见。
3. 状态色只表达语义（成功/警告/错误），元数据用中性色；深色专业工具风；设计令牌集中在 `src/styles/tokens.css`。
4. 数据：`useApi` hook（fetch + token + 错误码处理）；SSE 触发重新拉取（`resync-required` 时全量刷新）。
5. 不使用第三方 UI 库；React 19 + TS 严格模式（`noUnusedLocals`/`noUnusedParameters` 已开）。
6. 测试：i18n 字典完整性（en 与 zh-CN 的 key 集合必须完全相同）、`t()` 插值与缺失 key 兜底、语言解析/持久化、状态→标签/颜色映射、SSE 帧解析与 resync 判定。放 **`apps/web/test/*.test.mjs`**（node:test，不依赖 DOM；`scripts/test-workspace.mjs` 只收集 `<pkg>/test/**`，不放 `src/`）。

---

## 5. 验收命令（所有 Worker 交付时必须给真实输出）

```bash
node scripts/test.mjs          # 旧套件必须仍是 325/325（不许因 M1 变红）
node scripts/test-workspace.mjs
node scripts/check-boundaries.mjs
pnpm --filter @atk/web build   # tsc --noEmit + vite build
node apps/backend/cli.mjs migrate --dry-run --json
node apps/backend/cli.mjs serve   # 然后 curl /api/v1/system/health
```
