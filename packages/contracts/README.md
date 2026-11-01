# @atk/contracts — 契约初版（M0 草案）

> 状态：**DRAFT / 未被任何服务引用**。对应规范 §4（`packages/contracts`）、§7（API 契约）、§14（ATK-005/ATK-103）。
> 本包在 M0 只是**可审查的契约基线**：定义枚举、错误码、DTO 形状、事件封装与版本号。M1（ATK-101/103）才接入 pnpm workspace、OpenAPI 生成与跨进程契约测试。

## 为什么先有它

规范 §15 要求共享 `packages/contracts` 采取**单写者策略**，且"跨 package API 变更先改契约及消费者 Mock，再分别由执行者实现，不允许 FE/BE 各自发明同名不同义字段"。所以第一件事是把"名字与含义"固定下来，而不是先写服务再倒推字段。

## 当前内容

| 文件 | 内容 |
|---|---|
| `src/version.mjs` | `CONTRACT_VERSION`、`API_MAJOR`、兼容性断言 `assertCompatible()` |
| `src/enums.mjs` | 六组状态枚举（Task/Run/Agent/Review/Integration/Acceptance）+ Gate 五值 + Function + AgentLifecycle |
| `src/errors.mjs` | 统一错误体 `{ error: { code, message, requestId, details } }` 与规范 §7.1 的九个错误码 |
| `src/dto.mjs` | Project/Requirement/Task/Run/Review decision/Approval 的**校验函数**（返回 `{ok, errors}`，不抛异常） |
| `src/events.mjs` | 事件类型、事件封装、SSE 帧编码与断线补偿语义 |
| `src/index.mjs` | 单一入口 re-export |

## 三条硬规则

1. **枚举值就是事实**：状态名在契约里写死，服务端不得自造同义状态（例如 `DONE` 与 `COMPLETED` 混用）。`RUN_COMPLETED ≠ TASK_DONE`，`QA PASS ≠ HUMAN APPROVED` 在枚举层面就分开。
2. **错误码只增不改**：新增错误码必须同时更新 `ERROR_CODES` 与本文档，并说明 HTTP 状态映射。不得复用已有 code 表达新含义。
3. **DTO 校验返回结果，不抛异常**：调用方（Backend 路由、前端表单、测试）用同一份校验，避免前后端各写一套判断。

## 与规范的对齐点

- §7.1 统一错误体与错误分类 → `src/errors.mjs`
- §7.3 SSE `id/event/data` 与 `Last-Event-ID` 补偿、`resync-required` → `src/events.mjs`
- §5.2 六组状态、不得合并 → `src/enums.mjs`
- §10.1 Gate 五值 → `src/enums.mjs` 的 `GATE_STATUSES`

## 明确的非目标（留到 M1）

- 不做 OpenAPI 文档生成（ATK-103）。
- 不做生成的 TypeScript 声明（ATK-101 引入 TS 构建后再补；现在保持零依赖 ESM，避免 M0 就引入构建链）。
- 不定义内部 API（`/internal/v1/*`）的 DTO —— 那是 M2/M3 与 Scheduler/Runtime 一起定，避免过早冻结。
- 不发布到 npm：根 `package.json` 的 `files` 尚未包含 `packages/`，M1 由 workspace 统一处理。

## 消费者（计划）

| 消费者 | 里程碑 |
|---|---|
| `apps/backend` 路由与事务校验 | M1 |
| `apps/web` 表单与 SSE 解析 | M1 |
| `packages/scheduler-core` 决策输入输出 | M3 |
| `packages/runtime-sdk` 事件对齐 | M2 |
