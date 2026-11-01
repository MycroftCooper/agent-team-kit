# M6 / v1.0-candidate 交付回执

- 日期：2026-11-02 · 分支：`m0/baseline-and-p0`
- 关联：[m6-contracts.md](../architecture/m6-contracts.md)、ADR-006、[install-upgrade-rollback.md](../operations/install-upgrade-rollback.md)

> **状态：M6 门禁通过（7/7）。** 事件聚合过滤已补齐；JSON→SQLite 切换有可回滚的单事务 replace、可读 export/import 与 `switchReadiness` 前置检查；v1 库可原地升到 v5。独立 QA（QA-007）待做，因此 v1.0 **尚未**宣发。

## 1. 交付

| 条目 | 内容 | 验证 |
|---|---|---|
| ATK-601 | `listEvents({projectId, aggregateId, aggregateType, type, afterSeq, limit})` + `listEventsPage()`；数组返回保持向后兼容 | 105 条事件分页 40/40/25 无重复 seq；memory/sqlite 一致 |
| ATK-602 | 迁移 `0005_events_index.sql`（schemaVersion 5）；`importStateJson(mode: merge|replace)` 单事务；`verifySwitchReadiness()` | v1→v5 原地升级；replace 失败 fingerprint 不变；replace 后 reopen 不重跑迁移 |
| ATK-603 | `GET /api/v1/events` 过滤参数（默认 100、上限 1000、非法 400 带字段）；health `switchReadiness` | 真实 HTTP 过滤/分页/负例 |
| ATK-604 | `export`（可读 JSON：`{exportedAt, stateJson, runtime, manifest}`）与 `import`（merge/replace，replace 非空库需 `--force`，非 PASS 时 exit 1） | export→import→export 语义等价；坏 record → exit 1 且库不变 |

## 2. M6 门禁（`node scripts/m6-smoke.mjs`，真实 SQLite + 真实 backend CLI）

```text
PASS  events filter by aggregate and page without gaps or duplicates
PASS  switchReadiness blocks while a run is active and clears when it ends
PASS  export then import reproduces the same data
PASS  a failing replace leaves the database intact
PASS  a successful replace keeps the migration bookkeeping
PASS  backup, tamper and restore
PASS  a v1 database upgrades in place to v5
7/7 checks passed
```

## 3. 门禁抓到的真实缺陷（M6 期间）

**`replace` 会"成功"地丢数据**：旧 importer 只认 `packages/subitems/batch.slices`，对非空的 `batch.tasks` **静默忽略**——于是清表后只导入 project、报告 `PASS`、CLI exit 0，目标库的 tasks/agents 已被清空。

修复为 fail-closed：写入/清表**之前**校验不认识的集合，报 `IMPORT_WRITE_FAILED`、`status:"SKIPPED"`、零写入；同时补了"清表后写入中途失败"的回滚测试（注入 createTask 异常，断言完整 fingerprint 前后 deepEqual），因为旧测试只覆盖"写入前校验失败"，从未执行过真正的回滚路径。CLI 在 `status !== "PASS"` 时 exit 1（已验证）。

**教训**：这与 M2/M5 的假绿同源——**没被执行过的路径等于没测**。"replace 失败回滚"必须构造一个在事务中途失败的用例，而不是校验阶段的失败。

## 4. 已知限制（v1.0 前必须知道）

1. **真实 DSH 不可用**：所有"多 Agent"演示都是 MockRuntime。
2. 老 CLI（`lib/**`）仍以 JSON 为事实源：ADR-006 第 3 阶段的**切换入口**已就绪（export/import/replace/readiness），但"旧 CLI 改读 SQLite"的代码切换尚未执行。
3. 无安装包/自动更新；仅 Windows 本机。
4. Web 无 CI 级浏览器 E2E。
5. 独立 QA 未做（QA-007 待安排）；M5 的 QA6-04（凭据扫描口径）与 QA6-05（dataDir 未隔离浏览器 token）为已知限制。

## 5. 下一步（v1.0 收口清单）

1. QA-007：M6 独立复核（重点：replace 的 fail-closed 是否覆盖所有未知集合、切换中断后 system 是否可辨识、v1→v5 升级后的行为等价）。
2. 旧 CLI 切换（ADR-006 第 3 阶段代码面）+ 回滚演练文档。
3. 全仓一致性清扫：ADR/契约/回执 30+ 份与代码对账；README 重写为"如何跑起来 + 当前能力边界"。
4. 演示库切到 schema 5，`atk start` 一键跑通。
