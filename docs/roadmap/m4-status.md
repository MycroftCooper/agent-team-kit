# M4 / v0.7 交付回执与 M5 准入结论

- 文档类型：里程碑交付回执（规范 §14 M4、§16.2、§19）
- 日期：2026-11-02
- 分支：`m0/baseline-and-p0`
- 执行者：Lead(ARCH) + `worker-database`（Review/Approval 仓储）+ `worker-backend`（public API）+ `worker-web`（审查工作台）+ `worker-runtime-spike`（m4-smoke）
- 关联：[m4-contracts.md](../architecture/m4-contracts.md)、[ADR-005](../architecture/adr/ADR-005-review-model.md)、[m3-status.md](m3-status.md)

> **状态：M4 完成（MockRuntime 路径）。** Review / 返工环 / 人工验收 / 审查工作台全部可用，8/8 端到端门禁通过。独立 QA（QA-005）待做。真实 DSH 仍不可用；Scheduler 仍单实例无预算。

---

## 1. 强制交付回执（规范 §16.2）

```text
Task: ATK-401..406 (M4 / v0.7)
Source: branch m0/baseline-and-p0
Changed: contracts 追加 REJECTED 状态 / CHANGES_REQUESTED,BLOCKED 枚举 / 4 个错误码；
         packages/database 0004 迁移 + Review/Approval 仓储 + 返工上限；
         apps/backend 7 个 public 端点 + DONE 单入口门禁；
         apps/web #/reviews 审查与验收工作台（双语）；
         scripts/m4-smoke.mjs（8 条）
Build: pnpm --filter @atk/web build -> exit 0（JS 310.50 kB / gzip 92.46 kB；CSS 20.71 kB）
Tests: node scripts/test.mjs             -> 400 / 400 pass
       node scripts/test-workspace.mjs   -> 511 / 511 pass
       node scripts/check-boundaries.mjs -> PASS（8 packages / 6 edges / 0 cycles）
       node scripts/m1-smoke.mjs         -> 16 / 16
       node scripts/m2-smoke.mjs         -> 4 / 4
       node scripts/m3-smoke.mjs         -> 6 / 6
       node scripts/m4-smoke.mjs         -> 8 / 8（0 skipped）
Contracts: 见 §2；错误码 SELF_REVIEW_FORBIDDEN/EVIDENCE_MISSING/APPROVAL_STALE/REWORK_LIMIT_REACHED
Security: 自审禁止；PASS 必须有 manifestHash + 全绿测试证据；验收绑定 targetHash；
          DONE 唯一入口是人工 Approval
Evidence: 本文件 + m4-contracts + 各包 test/ + scripts/m4-smoke.mjs
Blockers: 无（M4 范围内）
Next: M5 —— 桌面启动器 / atk start / 本地部署与恢复
```

---

## 2. 关键设计裁决（M4 定稿）

| # | 裁决 | 理由 |
|---|---|---|
| 1 | **Task 增加 `REJECTED` 状态**（append-only），它是"返工等待态"，出口只有 `REJECTED→READY`（重排）与 `REJECTED→BLOCKED`（超限） | 评审要求修改不是失败，需要可重排的中间态 |
| 2 | **禁止 `REJECTED→DONE`**；`AWAITING_ACCEPTANCE→DONE` 只能由 `decideApproval(APPROVED)` 触发；直接 PATCH `status=DONE` → 409 `reason=human-approval-required` | 这是整个 M4 的核心不变量：Agent 不能把自己的工作变成"已完成" |
| 3 | **人工验收拒绝 → Task `READY`**（不是 REJECTED） | 验收拒绝时 Review 已经是 PASS，没有任何 review 状态能驱动 `REJECTED` 离开；留在 REJECTED 是死状态 |
| 4 | **自审判定**：`actor` == Review 关联 Run 的 `agentId`，或（未给 runId 时）该 Task 最近一次 Run 的 `agentId` | Task 没有 `assignee` 列；不为此临时加列，注释写明是代理判定 |
| 5 | **PASS 的证据门槛**：`manifestHash` 非空 + `evidence.tests.{passed,total}` 且 `passed===total>0`；`findings` 只有 `CHANGES_REQUESTED` 必填 | 没有证据的 PASS 只是断言 |
| 6 | **返工上限默认 3**：超过 → Task `BLOCKED`、`REWORK_LIMIT_REACHED` | 防止无限返工 |
| 7 | **事件复用既有类型**（不新增）：`review.requested`、`review.updated`、`task.updated`、`approval.recorded` | 保持 event 历史与前端订阅稳定 |

---

## 3. M4 门禁实测（`node scripts/m4-smoke.mjs`，真实 Backend + SQLite + Scheduler + Host）

```text
PASS 1 自审：403 SELF_REVIEW_FORBIDDEN；DB review=PENDING、task=REVIEWING
PASS 2 缺证据：无 manifestHash / tests 1-of-2 → 400 EVIDENCE_MISSING；DB 不动
PASS 3 合法 PASS：DB review=PASS/PASS、task=INTEGRATING
PASS 4 验收 hash：错 hash → 409 APPROVAL_STALE；对 hash → DB approval=APPROVED、task=DONE
PASS 5 直接 PATCH DONE → 409 human-approval-required；DB task 不变
PASS 6 返工环：REJECTED→READY(attempt 2)→真实 Run attempt 2 COMPLETED；超限 → 409 REWORK_LIMIT_REACHED、DB task=BLOCKED
PASS 7 SSE：review.updated + approval.recorded，15 个 id 递增
PASS 8 人工验收拒绝：DB approval=REJECTED、task=READY、event payload.decision=REJECTED
8/8 checks passed, 0 skipped, 0 failed
```

**门禁抓到的真实缺陷（M4 期间）**：合法 PASS 被 400 拒绝——Backend 把默认 `findings: []` 无条件传给 store，store 对任何显式 `findings` 校验非空。修复：只有 `CHANGES_REQUESTED` 要求 findings 非空。这是"门禁该抓的"典型：M4 的核心正路径原本走不通。

---

## 4. 已知限制（M4 结束时）

1. **独立 QA 未做**（QA-005 待安排）；M3 的 QA-004 已收口（1 BLOCKER + 6 MINOR，4 修 2 在修 1 文档）。
2. **真实 DSH 不可用**：能力全 false 占位。
3. **Scheduler 单实例无预算/限流**；返工重排后的调度依赖固定权重。
4. **workspace 未接入 Host**；`createWorktree` 已实现。
5. **无浏览器 E2E 自动化**：Web 工作台有 headless 截图证据与单元测试，但无 CI 级 E2E。
6. **JSON 仍是旧 CLI 事实源**（ADR-006 停机切换未做）。

---

## 5. 提交

见 `git log --oneline`（M4 提交：contracts 枚举/错误码、database 0004 + 仓储、backend 端点、web 工作台、m4-smoke、文档）。

回滚：删除 `packages/database/migrations/0004_*` 之前的 M4 代码即可回到 M3 形态（无 Review/Approval 写入路径）。

---

## 6. M5 准入

| 事项 | 说明 |
|---|---|
| `atk start` 单命令 | 启动 Backend + Scheduler + Runtime Host（内部凭据下发、优雅停止、状态可查） |
| 本地部署 | 数据目录、端口、日志、升级/回滚 |
| 恢复语义 | 进程崩溃后的自动恢复与人工介入边界 |
| Web 剩余工作台 | Plan / Gate / Run 详情 / 事件流 |

M5 门禁（规范）：一个命令启动本地系统；真实 3 Agent 协作；重启后可恢复；文档覆盖安装/升级/回滚。

---

## 7. 独立 QA（QA-005）结论与缺陷闭环

审查对象：M4 冻结提交 `36c9b55`（隔离解包）。报告：[qa-review-m4.md](../architecture/qa-review-m4.md)，套件 `test/m4-qa-adversarial.test.mjs`（23 条）。

**冻结 SHA 的结论：不能直接标记完成（2 MAJOR，无 BLOCKER）；修复后完成。** 当前所有缺陷已关闭（QA 在工作区复验：M4 套件 23/23、m4-smoke 9/9）。

| 缺陷 | 严重度 | 状态 |
|---|---|---|
| QA5-01 自审可绕过：`" agent-1"` / `"agent-1 "` / `"AGENT-1"` 都能 PASS | MAJOR | 已修：actor 必须完全规范化（否则 400），自审比较 casefold |
| QA5-02 验收 hash 是回显：生产代码从不写 `tasks.target_hash` | MAJOR | 已修：PASS 同事务写 hash；createApproval 必须等于它（缺失 409 `target-hash-missing`）；m4-smoke 新增换版失效 check |
| QA5-03 证据 `passed=total=1e15` 被接受 | MINOR | 已修：数值上限 → `EVIDENCE_MISSING` |
| QA5-04 rework 导致同一 Task 两条 attempt=2 | MINOR | 已修：attempt 由 review 行数推导、去重 |
| QA5-05 `store.patchTask` 可直推 DONE | MINOR | 已修：store 层拒绝，唯一入口 `decideApproval(APPROVED)` |
| QA5-06 m4-smoke 自证面（check4 回显、check6 库实例、check5 SKIP） | MINOR | 已修：check4 真绑定、check6 真实 CLI 进程、check5 改 FAIL；新增 check9 |

**威胁模型（QA5-07）**：`actor` 是客户端声明、无认证；"Agent 不能自审"是**按声明拒绝**，真正隔离依赖浏览器 token 只发给人类（ADR-008）。已写入 m4-contracts §1。

**变异测试（隔离冻结树，基线 29/29）**：3/3 被抓——去掉自审、放行 PATCH DONE、失效 hash 校验。

**QA 观察项（不判缺陷）**：m4-smoke check5 的 SKIP 机制、`/api/v1/events` 无 `aggregateId` 过滤（Web 用 `afterSeq` 有界分页兜底，建议 M6 补）、词典计数口径 292 vs 293（两边一致）。
