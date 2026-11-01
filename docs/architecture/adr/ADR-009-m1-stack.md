# ADR-009：M1 落地选型——node:sqlite + node:http + React/Vite（含中英双语 UI）

- 状态：**Proposed**（M1 实施依据）
- 日期：2026-11-02
- 决策者：Lead(ARCH)
- 关联：规范 §3、§4、§11、§12；ADR-001、ADR-002、ADR-008

## 背景

规范 §3 的推荐栈是 Fastify + Zod/OpenAPI + SQLite(WAL, Drizzle) + React/Vite/Tailwind/shadcn + TanStack Query。规范同时写明：

> 如果更偏好保留"零第三方依赖"特性，只保留在 legacy/core 与 CLI 的兼容层；Web、服务、调度不受这一旧约束限制。
> `better-sqlite3` 或数据库驱动应在 Windows 锁定架构测试后最终确定。

M0 的实测环境事实（本机，只读验证）：

| 事实 | 结果 | 影响 |
|---|---|---|
| `node:sqlite` 内置模块 | **可用**（`DatabaseSync`/`StatementSync`/`Session`/`backup`，Node 24.16.0） | 无需原生模块编译，Windows 上零构建风险 |
| npm registry | 可达 | Web 依赖可安装 |
| pnpm | 11.6.0 已就绪 | workspace 可用 |
| CI 矩阵 | Node 20 / 22 / 24 × ubuntu/windows | `node:sqlite` 在 Node 20 不存在 → 新服务测试必须按 Node 版本门控 |

## 决策

1. **数据库驱动用内置 `node:sqlite`（`DatabaseSync` + WAL），不引入 `better-sqlite3` / Drizzle。**
   - 理由：Windows 本机与 CI 都免去原生编译；与"本地优先、可离线"一致；`node:sqlite` 提供事务、预处理语句、备份 API，足以覆盖 M1 需求。
   - 代价：SQL 手写、迁移手写。用 `packages/database/migrations/`（有序 .sql + `schema_migrations` 表）+ 仓储层封装来抵消。
   - 版本门控：`apps/*` 与 `packages/database` 的 `engines.node >= 22.5.0`；测试脚本在低于该版本时打印 `SKIPPED (node:sqlite unavailable)` 并退出 0，**不允许**让 Node 20 的 CI 变红，也**不允许**把 skip 说成 pass。
2. **Backend HTTP 用 Node 内置 `http` + 小型路由表，不引入 Fastify。**
   - 理由：M1 的接口面很小（十几个路由）；契约校验已经由 `packages/contracts` 的 DTO 校验器承担；少一个依赖就少一处在 Windows/CI 上的不确定性。
   - 代价：没有内建 schema 校验、序列化优化与插件生态。用 `packages/contracts.validate*` + 统一错误信封（ADR-008 的 Host/Origin/CSRF/内部凭据）补偿。
   - 迁移路径：HTTP 契约（路径、DTO、错误码、SSE 帧）与框架无关；将来要换 Fastify，只替换连接层，不动业务与契约。
3. **Web 用 React 19 + Vite + TypeScript；样式用 CSS 设计令牌，不引入 Tailwind/shadcn。**
   - 理由：规范 §11.3 的核心要求是"设计 Token 统一"，而不是某个 CSS 框架；手写令牌集（颜色/圆角/间距/字号/行高/focus）在深色专业工具风格下更可控，且避免一堆构建链路。
   - 代价：没有工具类便利；用 `src/styles/tokens.css` + 少量语义类约束。
   - 数据层：TanStack Query 暂不引入；M1 用 `useApi` hook + SSE 失效（接口形状与 Query 的 stale/invalidate 对齐，后续可替换）。
4. **中英双语是一等需求**：Web 必须支持 `zh-CN` / `en` 切换，默认跟随浏览器语言并持久化到 `localStorage`；所有用户可见文案走字典，不允许硬编码中文或英文在组件里。
   - 字典位置：`apps/web/src/i18n/{en,zh-CN}.ts` + `I18nProvider`/`useT()`；切换按钮在顶栏，`data-testid="lang-toggle"`。
   - 术语必须与 CLI/文档一致（Task/Run/Review/Approval/Gate 等概念不做意译漂移）；状态值本身（PASS/FAIL 等）不翻译，只翻译标签。
5. **进程与端口**：Backend 绑定 `127.0.0.1:1421`，Vite 开发端口 `5173` 代理到 1421；生产模式由 Backend 直接服务 `apps/web/dist` 静态产物，浏览器只访问 1421。
6. **包边界**（可静态检查）：`web` → contracts；`backend` → contracts + database；`database` → contracts；任何包不得反向依赖 `lib/` 或 `apps/`。

## 后果

**正面**：M1 可在无原生编译、无容器、无外部服务的条件下完成；CI 的 Node 20 任务不受影响（新服务测试按版本跳过并明确标注）；Web 具备统一设计令牌与双语能力。

**负面 / 代价**：SQL 与 HTTP 是手写层，需要更严格的测试覆盖；没有 Drizzle 的迁移工具与类型推导。

**缓解**：数据库层用事务 + CAS 版本 + 迁移测试（含"迁移可重复执行"）；HTTP 层用契约测试（每个路由的 DTO 正/负例）；边界检查进 CI。

## 替代方案

| 方案 | 为什么否决 |
|---|---|
| better-sqlite3 + Drizzle | Windows/CI 需原生编译，安装失败会阻塞整条流水线；收益（类型推导）在本项目规模下有限 |
| Fastify + Zod | 多两个依赖与插件面；契约校验已由共享 packages/contracts 承担 |
| Tailwind + shadcn | 构建链与依赖显著变重；规范真正要求的是统一设计 Token |
| Electron 桌面壳 | 规范 §3 明确不采用 |

## 回滚

M1 是新增 `apps/`+`packages/`，不修改 `lib/` 与 CLI；删除新增目录即回到 M0 的单进程 CLI。SQLite 文件在 `%LOCALAPPDATA%\AgentTeamKit\data\atk.db`，删除即回到 JSON 事实源（ADR-006 的 A 阶段）。
