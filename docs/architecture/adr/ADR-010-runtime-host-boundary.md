# ADR-010：Runtime Host 只经内部 API；MockRuntime 优先，真实适配器 experimental

- 状态：**Proposed**（M2 实施依据）
- 日期：2026-11-02
- 决策者：Lead(ARCH)
- 关联：规范 §8、§9、§14（M2）；ADR-003、ADR-004、ADR-008、ADR-009；[m2-contracts.md](m2-contracts.md)

## 背景

M1 已落地 SQLite 事实源、HTTP API 与 SSE，但没有任何 Run 的真实执行者：任务靠手工 CLI 派发，UI 的"实时"只有心跳。M2 要引入独立的 Runtime Host 去真正驱动 Agent 会话。

两条外部约束决定了这一层不能做"顺手就行"的设计：

1. **规范 §8.3**：启动结果未知时必须先对账，禁止盲目二次启动；进程可能随时崩溃。
2. **M0 的 Spike 结论**：真实 DSH 的 ACP 路径在隔离 + mock 环境下已验证可跑通（RT-P02/P03/P06 PASS），但真实 Magpie 路由（RT-P07）、多 Agent 并行（RT-P08）、受限执行、会话级模型选择仍未验证。

## 决策

1. **Runtime Host 是独立进程，且不写数据库**：它只经 Backend 的 `/internal/v1/*` 领命令、上报事件、续租、对账。数据库仍只有 Backend 一个写者（ADR-002）。
2. **内部凭据与浏览器彻底分离**：`x-atk-internal` 由 Backend 启动时生成并通过环境变量下发子进程；内部路由**不接受**浏览器会话 token，反之亦然。
3. **租约 + 单调 generation 做 fencing**：Host 每次续租提升 generation；任何事件/结果上报必须携带当前 generation，过期上报一律 409 `STALE_GENERATION`，绝不覆盖新运行。
4. **MockRuntime 先行**：`packages/runtime-sdk` 先定义接口与 MockRuntime（确定性、可注入故障、无网络无子进程），M2 的端到端验收全部建立在 MockRuntime 上。
5. **DSH 适配器只能标 experimental**：`packages/runtime-dsh` 在 RT-P07/P08 补齐前，生产能力矩阵全部 `false` + `CAPABILITY_UNAVAILABLE`，只允许在隔离 `DSH_HOME` + mock 端点下运行。真实适配器**不得**默认启用。
6. **workspace（git worktree）是源码隔离，不是安全沙箱**：`packages/workspace` 只管"每个 Run 独立工作区 + 受控清理"；网络/凭据隔离仍靠运行环境策略。
7. **重启语义**：Host 重启后必须先 `reconcile`，把无法确认的 Run 标 `INTERRUPTED` 而不是猜测完成；这是 M2 门禁的硬性一条。

## 理由

- 单写者 + 内部 API 把"多进程并发"压缩成"Backend 内串行事务"，这是本地优先架构里最省成本的正确性来源。
- MockRuntime 让状态机、租约、对账、SSE 全部可以先被测试覆盖，等真机证据齐了再换实现而不动上层。
- generation fencing 是唯一能证明"旧进程不会覆盖新运行"的机制，且可被负面测试直接验证。

## 后果

**正面**：崩溃可枚举可测试；UI 的实时事件有真实生产者；真实适配器风险被隔离在 experimental 边界内。

**负面 / 代价**：一次执行需要多次内部 HTTP 往返；租约超时/续租/对账参数需要调优；Host 必须自己实现"未知即阻断"的保守逻辑。

**缓解**：内部 API 全部幂等；租约与心跳参数配置化；`m2-smoke` 把"重启不误报完成""不二次启动"作为必测项。

## 替代方案

| 方案 | 为什么否决 |
|---|---|
| Host 直连 SQLite | 多写者竞态，违反 ADR-002；无法验证租约 |
| 内存队列派发 | 崩溃即丢命令，无法证明"不丢任务" |
| 先上真机 DSH 适配器 | RT-P07/P08 未验证，等于把未验证能力伪装成可用（违反规范 §0 第 4 条） |

## 回滚

删除 `apps/runtime-host` + `packages/runtime-*` 即回到 M1 形态：手工派发、无自动执行；Backend 的 Run 表为空但不影响 M1 功能。
