# ADR-004：Runtime 与模型边界——用 Agent 原生配置 + Magpie，ATK 不改 Provider

- 状态：**Proposed**
- 日期：2026-11-02
- 决策者：ARCH
- 关联：规范 §2、§9、§12.1；ADR-001

## 背景

ATK 要驱动真实 Agent（DSH 先行，Codex 后续）。模型路由由用户既有的 Magpie / DSH 原生配置拥有。规范的非目标明确：不开发自己的 LLM 网关、不替代 Magpie、不管理 Provider API Key。

同时规范 §0 第 3 条与 §12.1 要求：不得未经授权访问生产服务、默认不读写用户的模型 Provider/网关配置。

## 决策

1. **ATK 只做会话控制，不做模型路由**：`Runtime Host` 通过 `AgentRuntime` 适配器（`probe/capabilities/start/send/stop/reconnect/subscribe`）操作 Agent 原生会话。
2. **不支持的的能力必须诚实地 false**：任何适配器未在隔离 PoC 中验证的能力（结构化事件、停止、重连、会话级模型选择、受限执行）一律返回 `false` 并给出 `CAPABILITY_UNAVAILABLE`；**禁止用正则解析终端文字**推断“QA 完成/已空闲/走了哪个模型”。
3. **配置文件只读**：ATK 默认只读探测 DSH/Magpie 配置与端口；不写 `cordis.patch.yml`，不改 Provider 路由，不改系统代理。需要会话级模型选择时，只允许走 Runtime 原生支持的会话级参数。
4. **凭据不进入 ATK**：Agent 子进程只继承必需环境变量；日志脱敏；`.env`/密钥不落库、不落日志、不进提示词。
5. **真机验证前置**：M2 的 DSH 适配器只有在 §9.2 的 Spike 用例（RT-P01~P10）具备真实命令、版本与结果时才允许标“可用”；否则停在 `MockRuntime`。
6. 硬停止条件（任一条成立即不得接真机）：无法可靠启动会话 / 无法观察结束状态 / 无法阻止模型配置被覆盖。

## 理由

- 模型网关是用户资产，ATK 越权写入会直接破坏用户生产环境，风险与收益完全不对等。
- 适配器协议把“平台差异”收敛到一个接口，后续加 Codex 不需要改调度与业务层。
- 能力探测 + 显式 `false` 让“不可用”成为一等公民，避免“看起来在跑，其实没观察到”。

## 后果

**正面**：ATK 可以安全地在开发机上与用户现有 DSH/Magpie 共存；切换模型供应商完全不影响 ATK；审计时能证明“我们没有改你的网关”。

**负面 / 代价**：能力受限于平台原生协议；某些场景（例如需要强制模型选择的自动化）在 DSH 原生不支持时做不到。

**缓解**：`runtime-dsh` 只在 PoC 通过后创建；`probe()` 在启动时给出清晰的能力矩阵，UI 与调度据此降级。

## 替代方案

| 方案 | 为什么否决 |
|---|---|
| ATK 自带模型网关/代理 | 违反非目标，重复 Magpie 能力，且要管理密钥 |
| 用 PTY + 正则解析终端输出 | 脆弱、无法证明真实状态，规范明令禁止 |
| 直接编辑 `cordis.patch.yml` 做会话级控制 | 会改写用户生产配置，不可回滚，规范不建议 |

## 兼容与迁移

`packages/runtime-sdk` 定义接口与事件类型；`MockRuntime` 先行（ATK-201）。真机适配器（ATK-203）只承诺 PoC 证实过的能力，并在 `capabilitySnapshot` 里记录当次矩阵。

## 回滚

删掉 `packages/runtime-dsh` 即回到 MockRuntime；Runtime Host 不影响 Backend 事实源。用户 DSH/Magpie 配置自始至终未被写入（Spike 的 hash 前后比对作为证据）。
