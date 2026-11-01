# M4 契约：Review / 返工环 / 人工验收 / 审查工作台

- 状态：M4 实施契约
- 关联：规范 §6.3、§9、§14（M4）；ADR-005（Review 模型）；M0 的 Gate 五值模型
- 纪律：形状变更先 message Lead。

---

## 0. 范围与硬不变量

**做**：`reviews` / `review_attempts` / `approvals` 的写入路径（表 M1 已建但未用）、返工环、人工验收（绑定 `targetHash`）、审查工作台（Web，双语）、`scripts/m4-smoke.mjs`。

**不做**：真实 DSH 适配器；Scheduler 的预算/限流（M5）；JSON→SQLite 停机切换（M6）。

**硬不变量**：
1. **Agent 不能批准自己**：`reviewer` 不得是产生该 Run 的 agent，也不得是任务当前 assignee（自审一律 403 `SELF_REVIEW_FORBIDDEN`）。
2. **PASS 必须有证据**：缺 `manifestHash`、缺测试证据、或测试 `passed !== total` 的 PASS 一律拒绝（`EVIDENCE_MISSING`）。
3. **验收绑定 targetHash**：Approval 的 `target_hash` 与目标当前 hash 不一致 → 409 `APPROVAL_STALE`，Task 不动（换版即失效）。
4. **返工有上限**：同一 Task 的 review attempt 达到 `maxAttempts`（默认 3）后不再允许 REJECTED→READY，Task 置 `BLOCKED` 并记录原因。
5. **人工验收是 DONE 的唯一入口**：`AWAITING_ACCEPTANCE → DONE` 只能由 `approvals` 的 APPROVED 触发（Agent/Runtime 都不能直接把 Task 置 DONE）。
6. 所有状态变化写事件，**复用 contracts 既有类型**（不新增类型，保持 event 历史稳定）：
   - `review.requested`（创建 Review，payload 含 `taskId, reviewId, attempt`）
   - `review.updated`（提交结论/返工/超限，payload 含 `taskId, reviewId, status, verdict, actor, attempt`）
   - `task.updated`（返工重排、BLOCKED，payload 含 `reason: "rework" | "rework-limit"`）
   - `approval.recorded`（创建验收单与裁决都用它，payload 含 `taskId, approvalId, decision?, status, targetHash, actor`）
   全部经 SSE 推送。

---

## 1. Store 方法（packages/database）

```js
createReview({ taskId, runId, actor, attempt? }) -> Review   // status PENDING；同 Task 只允许一个活跃 Review
getReview(id) -> Review
listReviews({ taskId?, status?, limit? }) -> Review[]
submitReview({ id, expectedVersion, verdict, manifestHash, commitSha, findings, evidence, actor })
  -> { review, task }        // verdict: PASS | CHANGES_REQUESTED | BLOCKED
reworkTask({ taskId, reviewId, reason, actor }) -> { review, task, attempt }   // CHANGES_REQUESTED → Task REJECTED → READY（受 maxAttempts）
createApproval({ taskId, scope, targetHash, actor, status? }) -> Approval
listApprovals({ taskId?, status?, limit? }) -> Approval[]
decideApproval({ id, decision, actor, targetHash }) -> { approval, task }
  // decision: APPROVED | REJECTED；APPROVED 且 targetHash 匹配 → Task DONE；不匹配 → APPROVAL_STALE
```

**状态迁移**（走既有 `taskStatusMachine`，不得绕过）：
- Review 生命周期：`PENDING → PASS | CHANGES_REQUESTED | BLOCKED`；`reviews.status` 与 `reviews.verdict` 都使用同一组值（`REVIEW_STATUSES` / `REVIEW_VERDICTS` 已 append `CHANGES_REQUESTED`、`BLOCKED`，`FAIL` 保留）。
- **`REJECTED` 是 M4 新增的 Task 状态**（contracts `TASK_STATUSES` 已 append），它是"返工等待态"，不在主链上：
  - `REVIEWING → REJECTED`（审查要求修改）
  - `AWAITING_ACCEPTANCE → READY`（人工验收拒绝；**不是** REJECTED——`REJECTED` 只能由 `reworkTask` 离开，而验收拒绝时 Review 已是 PASS，留在 REJECTED 就没有出口）
  - `REJECTED → READY`（返工重排，回到可调度）
  - `REJECTED → BLOCKED`（返工超限）
  - `REJECTED → CANCELLED`（通用非终态出口）
  - **禁止 `REJECTED → DONE`**：任何绕过验收直达 DONE 的边都不允许存在。
- PASS：Task `REVIEWING → INTEGRATING`；Review `status=PASS`。
- CHANGES_REQUESTED：Task `REVIEWING → REJECTED`；Review `status=CHANGES_REQUESTED`。
- BLOCKED：Task `REVIEWING → BLOCKED`；Review `status=BLOCKED`。
- 返工超限：Task `REJECTED → BLOCKED`，Review `BLOCKED`，details.reason=`rework-limit`。
- 验收：`AWAITING_ACCEPTANCE → DONE` 仅经 `decideApproval(APPROVED)`；`REJECTED` → Task 回 `REJECTED`（继续返工）。

**校验**：
- `createReview`：Task 必须是 `REVIEWING`（否则 409 `TASK_VERSION_CONFLICT` details.reason=`not-reviewing`）；`runId` 若给，必须存在且属于该 Task。
- `submitReview`：`expectedVersion` CAS；PASS 必须带 `manifestHash` + `evidence.tests.{passed,total}` 且 `passed===total`；`CHANGES_REQUESTED` 必须带 `findings.length>0`；自审校验（actor 不在 `run.agentId` / `task.assignee`）。
- `createApproval`：Task 必须 `AWAITING_ACCEPTANCE`；`targetHash` 非空。
- `decideApproval`：`targetHash` 必须等于 approval 里的值**且**等于 Task 当前 `targetHash`（若有）→ 否则 409 `APPROVAL_STALE`。

**判定细则（M4 定稿）**：
- **威胁模型（必须读）**：`actor` 是**客户端声明**，M4 没有身份认证；省略 `actor` 时默认 `HUMAN`。因此"Agent 不能自审/自批"在 M4 的准确含义是"**按声明的 actor 拒绝**"：它挡住误用与自报身份，**挡不住刻意伪造**。真正的隔离依赖 M1 的浏览器 token 只发给人类操作者、Agent 进程没有该 token（ADR-008）。身份认证与审计签名留给后续里程碑。
- **actor 规范化**：`actor` 必须满足 `actor === actor.trim()`，否则 400 `VALIDATION_ERROR`（`reason=actor-not-normalized`）；自审比较前 `actor` 与作者 id 统一 `trim().toLowerCase()`。空格/大小写变体因此无法绕过（QA5-01）。
- **自审的"作者"判定**：Task 没有 `assignee` 字段（M3 的 `claimTask` 没有写回，M4 也不临时加列）。因此作者 = `review.runId` 对应 Run 的 `agentId`；若未给 `runId`，取该 Task 最近一次 Run 的 `agentId`（优先非终态 Run，其次最新）。代码注释必须写明这是"缺少 assignee 字段时的代理判定"，M5 若引入 `tasks.assignee` 再收紧。
- `reworkTask({ ..., maxAttempts? })`：`maxAttempts` 可选，默认 3。
- **候选 hash 的唯一来源**：`submitReview(PASS)` 在同一事务里写 `tasks.target_hash = manifestHash`；`createApproval` 必须与 `task.target_hash` 严格相等（缺失 → `target-hash-missing`），否则 `APPROVAL_STALE`。这条保证"换版即失效"不是回显（QA5-02）。
- **DONE 的唯一入口**：`store.patchTask` 本身也拒绝 `status=DONE`（`reason=human-approval-required`），除非走 `decideApproval(APPROVED)`。

---

## 2. Backend API（public，浏览器会话 + CSRF）

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/api/v1/reviews` | `{ taskId, runId?, actor }` → 201 Review；非 REVIEWING → 409 |
| GET | `/api/v1/reviews?taskId=&status=` | 列表（分页 `limit` ≤ 100） |
| POST | `/api/v1/reviews/:id/submit` | `{ expectedVersion, verdict, manifestHash?, commitSha?, findings?, evidence? }` → 200 `{review, task}`；自审 403 `SELF_REVIEW_FORBIDDEN`；证据不足 400 `EVIDENCE_MISSING`；CAS 冲突 409 |
| POST | `/api/v1/reviews/:id/rework` | `{ reason }` → 200 `{review, task, attempt}`；超上限 409 `REWORK_LIMIT_REACHED` |
| POST | `/api/v1/approvals` | `{ taskId, scope, targetHash }` → 201 |
| POST | `/api/v1/approvals/:id/decide` | `{ decision, targetHash }` → 200 `{approval, task}`；hash 不符 409 `APPROVAL_STALE` |
| GET | `/api/v1/approvals?taskId=` | 列表 |

新增错误码（`packages/contracts`）：`SELF_REVIEW_FORBIDDEN`(403)、`EVIDENCE_MISSING`(400)、`APPROVAL_STALE`(409)、`REWORK_LIMIT_REACHED`(409)。
写操作走既有 CSRF/Origin 规则；所有成功写都发事件并由 SSE 推送。

---

## 3. Web（审查与验收工作台，双语）

页面 `#/reviews`（与既有 `#/tasks` 并列）：
- 待审列表（Task、Run、attempt、状态徽标）；选中后右侧显示"评审"面板：verdict 选择、manifestHash/commitSha/测试证据输入、findings 列表；提交后显示结果与错误（自审/证据不足/CAS 冲突要显示**服务端 code**的本地化文案）。
- 验收面板：显示 `targetHash`（前 12 位可复制）、批准/拒绝按钮；`APPROVAL_STALE` 显示"目标已变更，需重新验收"。
- 双语：所有新增文案 en/zh-CN 两份；缺键要有守卫测试（沿用 M1 的完整性检查）。
- 只读优先：写操作失败必须显示服务端错误，不吞。

---

## 4. M4 门禁（`node scripts/m4-smoke.mjs`）

1. **自审被拒绝**：作者 agent 提交 PASS → 403 `SELF_REVIEW_FORBIDDEN`，Review 仍 PENDING。
2. **缺证据被拒绝**：PASS 无 manifestHash / 测试证据 `passed<total` → 400 `EVIDENCE_MISSING`，Task 不动。
3. **PASS 推进**：合法 PASS → Review PASS、Task `REVIEWING → INTEGRATING`。
4. **验收绑定 hash**：错 hash → 409 `APPROVAL_STALE` 且 Task 仍 `AWAITING_ACCEPTANCE`；正确 hash → Task `DONE`。
5. **返工环**：CHANGES_REQUESTED → Task `REJECTED → READY`、attempt+1；Scheduler 能重新领取（新 Run、attempt 2）并跑到 COMPLETED；达到上限 → Task `BLOCKED`（reason `rework-limit`）。
6. **DONE 唯一入口**：直接 PATCH Task 到 DONE 必须 409（状态机拒绝），只有 Approval 能触发。
7. **事件与 SSE**：上述每一步都有对应事件，SSE 客户端能收到（真连接）。
