# @atk/runtime-sdk（M2）

Runtime 抽象层：`AgentRuntime` 契约、运行时校验函数、确定性 `MockRuntime`，以及 **DSH 真机适配器的“不可用”占位**。

- 契约来源：[docs/architecture/m2-contracts.md](../../docs/architecture/m2-contracts.md) §1（规范 §9.1/§9.2、ADR-004、ADR-010）
- 状态：M2 实施中；本包没有第三方依赖，也不发起网络请求或子进程
- 真机结论依据：[runtime-spike-dsh-magpie.md](../../docs/architecture/runtime-spike-dsh-magpie.md)（ATK-006/006b）

## 导出

| 入口 | 内容 |
|---|---|
| `@atk/runtime-sdk` | `RUNTIME_CAPABILITY_KEYS`、`RUNTIME_EVENT_TYPES`、`ALL_CAPABILITIES_FALSE`、`CAPABILITY_UNAVAILABLE`、`CapabilityUnavailableError`、`validateCapabilities()`、`validateStartRunInput()`、`validateRuntimeEvent()`、`validateRuntimeSessionHandle()`、`validateRuntimeHealth()`、`validateAgentRuntime()`、`unsupportedCapabilities()`、`assertCapabilities()` |
| `@atk/runtime-sdk/mock` | `createMockRuntime()` |
| `@atk/runtime-sdk/dsh` | `createDshRuntimeStub()`、`DSH_UNSUPPORTED_DETAIL` |

所有校验函数返回 `{ ok, errors }`（与 `@atk/contracts` 风格一致），不抛异常；`CapabilityUnavailableError.code === CAPABILITY_UNAVAILABLE`。

## MockRuntime

```js
import { createMockRuntime } from "@atk/runtime-sdk/mock";

const runtime = createMockRuntime({
  scenario: "complete",            // complete | fail | hang | crash | { steps: [...] }
  capabilities: { canStop: false }, // 覆盖默认全 true（仅 Mock 默认全 true）
  kind: "mock",
  sessionIdFactory: (input, n) => `session-${n}`, // 可选，保证测试确定性
  // 故障注入
  startFails: false,               // boolean | string | Error
  slowStartMs: 0,
  crashAfterMs: null,
  ignoreStop: false,
  neverEnds: false,
  probeOk: true,
  probeDetail: undefined,
});
```

场景 DSL：`{ steps: [{ emit?: RuntimeEvent }, { delayMs?: number }, { end?: { reason, exitCode } }] }`。

行为约定：

- `start()` 返回稳定 `sessionId`（默认 `mock-session-N`）、`startedAt` 与 capabilities 快照；
- 事件顺序：`session.started` → 场景步骤/`send()` 事件 → `session.ended`；
- `send(sessionId, prompt)` 回显 `output(stdout, prompt)` + `state(idle)`，同一会话可连续发送；
- `stop()` 触发 `session.ended(cancelled, null)`（`ignoreStop` 时忽略）；
- `unsubscribe()` 只解除投递，不结束会话；`stop()`/会话结束/`_dispose()` 会清理全部计时器；
- 所有计时器 `unref()`，`hang`/`neverEnds` 不会阻止测试进程退出；
- 同一场景运行两次（忽略 `at`）事件序列完全一致。

诊断属性（**不属于** `AgentRuntime` 接口，统一用 `_` 前缀以免与方法混淆；`validateAgentRuntime()` 只校验 `kind` 与七个接口方法，忽略这些成员）：`_pendingTimers`、`_sessionCount`、`_dispose()`。

## DSH 占位（`createDshRuntimeStub()`）

**这不是真机适配器。** 它的存在是为了让上层提前接上“真机不可用”的路径：

- `capabilities()`：七项全部 `false`（冻结对象）；
- `probe()`：`{ ok: false, kind: "dsh", detail: "experimental: RT-P07/P08 unverified" }`；
- `start/send/stop/reconnect/subscribe`：一律 reject `CAPABILITY_UNAVAILABLE`。

M2 的硬纪律（ADR-010 §5）：真实 DSH 适配器在 RT-P07/P08、受限执行、会话级模型选择验证通过前，不得默认启用、不得把能力标为 `true`。测试里有专门的锁：mock 默认全 `true`、stub 必须全 `false`，两者不能混淆。

## 测试

```bash
node --test packages/runtime-sdk/test/*.test.mjs
node scripts/test-workspace.mjs
node scripts/check-boundaries.mjs
```
