# M6 契约：JSON→SQLite 切换与 v1.0 收口

- 状态：M6 实施契约（收口阶段）
- 关联：规范 §11、§14（M6）、ADR-006（三阶段迁移）、ADR-002（只有 Backend 写 SQLite）
- 纪律：形状变更先 message Lead。

---

## 0. 范围内与硬不变量

**做**：事件聚合过滤（M1 遗留）、JSON↔SQLite 切换的数据层支撑、`export`/`import` 操作面、`switchReadiness`、切换演练门禁、v1.0 文档收口。

**不做**：真实 DSH 适配器；远程/多用户；安装包。

**硬不变量**：
1. **切换可回滚**：`import --mode replace` 单事务，任一步失败整体回滚，原数据仍在。
2. **不清迁移账本**：replace 清业务表但**不清 `schema_migrations`**（否则重启会重跑迁移）。
3. **切换前置条件**：存在活跃 Run/租约时 `switchReadiness.ok=false`，禁止切换。
4. **两条恢复路径语义不同**：`backup/restore` 是二进制快照（同版本回滚）；`export/import` 是可读 JSON（跨版本、审计、人工编辑）。
5. 事件查询向后兼容：`listEvents` 仍返回数组（分页元数据挂不可枚举属性），新代码用 `listEventsPage`。

---

## 1. 数据层（packages/database）

```js
store.listEvents({ projectId?, aggregateId?, aggregateType?, type?, afterSeq?, limit? })
  -> Event[]            // 数组 + 不可枚举 .items/.hasMore/.nextAfterSeq（兼容既有调用）
store.listEventsPage(...) -> { items, hasMore, nextAfterSeq? }
store.importStateJson(store, { stateJson, runtime, ownership, config, mode:"merge"|"replace", force, now, projectId? })
store.verifySwitchReadiness() -> { ok, schemaVersion, counts, blockers: [{code, ...}] }
```
- 过滤：精确匹配 + `afterSeq` 严格大于 + seq 升序；`limit` 默认 100、上限 1000；非法参数 `VALIDATION_ERROR`。
- 迁移 `0005_events_index.sql`：`idx_events_type_seq (type, seq)`；schemaVersion 5；v1→v5 原地升级有测试。
- `verifySwitchReadiness` 的 blockers：`active-run`（QUEUED/STARTING/RUNNING）、`active-lease`。

## 2. Backend

- `GET /api/v1/events?aggregateId=&aggregateType=&type=&afterSeq=&limit=` → `{ items, hasMore, nextAfterSeq? }`；负例 400。
- `node apps/backend/cli.mjs export --data <db> --to <file> [--json]`；`import --from <file> --data <db> [--mode merge|replace] [--force] [--json]`。
- `/api/v1/system/health` 增加 `switchReadiness`（store 无该方法时**省略字段**而不是 500）。

## 3. M6 门禁（`node scripts/m6-smoke.mjs`）

1. **过滤**：真实库 >1000 事件，`aggregateId` 只返回该聚合的事件，分页 `afterSeq` 续页无重无漏。
2. **切换演练**：`export` → 空库 `import` → 再 `export`，两次 JSON 语义等价（任务/事件数一致）。
3. **replace 回滚**：构造坏记录 → `import --mode replace` 失败 → 原库行数与内容不变（读库断言）。
4. **replace 成功且不重跑迁移**：成功 replace 后重启 → `schemaVersion===5`、`migrationWarnings()===[]`。
5. **切换前置**：有活跃 Run 时 `health.switchReadiness.ok === false` 且 blockers 含 `active-run`；Run 结束后 `ok === true`。
6. **v1 库升级**：用一个真正的 v1 库（M1 结构）打开 → 迁移到 v5，数据保留、事件可查询。
