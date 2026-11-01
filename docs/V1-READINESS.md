# v1.0 就绪说明（v1.0 candidate）

- 日期：2026-11-02 · 分支：`m0/baseline-and-p0` · HEAD：见 `git log -1`
- 适用：Windows 11 单机、Node.js ≥ 22.5
- **状态：v1.0 candidate —— 完整链路在 Mock 运行时下可用；不可生产使用**（原因见 §4）。

---

## 1. 一条命令跑起来

```powershell
corepack pnpm install
pnpm --filter @atk/web build
node apps/launcher/cli.mjs start --port 1421        # 默认 1 个 Host
node apps/launcher/cli.mjs status --json            # backend/scheduler/host 全部 alive
# 浏览器打开 http://127.0.0.1:1421/  （中英双语，右上角可切换）
node apps/launcher/cli.mjs stop
```

内部凭据由启动器从 backend 的 stdout 读取一次，**只经子进程环境变量传递**：不落盘、不进日志、不出现在 `status` 输出（`m5-smoke` 断言）。

## 2. 当前可用能力（Mock 运行时，全部有门禁与独立 QA）

| 能力 | 门禁 |
|---|---|
| 建任务/依赖、调度派发（DAG、环整体拒绝、确定性排序、容量/写域冲突） | `m3-smoke` 6/6 |
| 执行：领取命令 → 运行会话 → 上报事件 → 完成；崩溃后回收为 `INTERRUPTED` 而非猜测完成 | `m2-smoke` 4/4 |
| 评审：自审拒绝、PASS 必须有 manifestHash + 全绿测试证据、返工上限 | `m4-smoke` 9/9 |
| 人工验收：绑定候选 hash（换版即失效）、`DONE` 唯一入口 | `m4-smoke` 9/9 |
| 一条命令启动/有序停止/崩溃恢复/备份恢复 | `m5-smoke` 4/4 |
| 事件流：聚合过滤、分页无重无漏、SSE 实时推送与断线补齐 | `m6-smoke` 12/12 |
| JSON↔SQLite 切换：replace 单事务可回滚、`switchReadiness` 前置检查 | `m6-smoke` 12/12 |
| 旧 CLI 只读视图（ADR-006 Phase C）：写命令 fail-closed，读走 SQLite 投影 | `phase-c-readonly` 5/5 |

Web 页面：概览 / 任务 / Runs（时间线 + 实时流）/ Agent / 审查与验收 / 设置，全部双语。

## 3. 门禁与测试（HEAD 实测）

```text
node scripts/test.mjs             -> 475 / 475
node scripts/test-workspace.mjs   -> 604 / 604
node scripts/check-boundaries.mjs -> PASS（9 packages / 6 edges / 0 cycles）
m1 16/16 · m2 4/4 · m3 6/6 · m4 9/9 · m5 4/4 · m6 12/12
独立 QA：QA-001..007 全部签字（每轮对抗套件 + 变异测试 ≥3 处）
```

## 4. 明确不可用的部分（这是"不可生产"的具体含义）

1. **真实 DSH 适配器不可用**：只有能力全 false 的占位（`CAPABILITY_UNAVAILABLE`）；RT-P07/P08 仍未验证。所有"多 Agent"演示均为 MockRuntime。
2. **无安装包/签名/自动更新**：从源码目录运行。
3. **无 CI 级浏览器 E2E**：Web 有单元测试与 headless 截图证据。
4. **JSON 仍是老 CLI（`lib/**`）的兼容事实源**：Phase C 下它只读 SQLite 投影；`JSON export/import` 不含 runs/events/leases，`replace` 会重置执行历史。
5. 单机、单用户、Windows；无远程访问/TLS/多用户隔离（非目标）。
6. 日志无轮转；无选主（多 Scheduler 靠 Backend 原子 claim 兜底，正确但不经济）。

## 5. 工程纪律（本项目沉淀的规则）

1. **门禁断言最终业务事实**，而不是过程状态：M2 曾因只断言 Run 状态，让"命令永不 DONE"的缺陷 3/3 假绿。
2. **新增门禁用例必须证明它在旧/坏实现下会红**：QA 用"去掉事务"变异让 M6 的回滚检查 FAIL，才证明该检查有效。
3. **防御按数据结构定义，不按样例枚举**：M6 的 fail-closed 从"只堵 `tasks`"演进到"未知非空数组/对象在任意深度一律拒绝"。
4. **提交信息里的每个"和/都/任何"必须有对应用例**：一次"arrays and objects"的说法比实现早一步，被 QA 用一个对象打穿。
5. **里程碑完成 = 门禁绿 + 独立 QA 签字**；M4/M5/M6 的 BLOCKER/MAJOR 全部出现在"门禁绿"之后。

## 6. 已知历史与回滚

- 数据库迁移：v1（M1）→ v2（runs/dispatch）→ v3（调度）→ v4（评审/验收）→ v5（事件索引）；均支持原地升级，有 v1→v5 行为级测试。
- 回滚：`atk-backend backup/restore`（二进制快照，整库回滚）或 `atk-backend export/import`（可读 JSON，跨版本/审计）。运维步骤见 `docs/operations/install-upgrade-rollback.md`。
