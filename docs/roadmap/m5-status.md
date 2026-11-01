# M5 / v0.8 交付回执

- 日期：2026-11-02 · 分支：`m0/baseline-and-p0`
- 关联：[m5-contracts.md](../architecture/m5-contracts.md)、[install-upgrade-rollback.md](../operations/install-upgrade-rollback.md)、ADR-007

> **状态：M5 完成（MockRuntime 路径）。** `atk start` 一条命令启动本地系统；备份/恢复/回滚有文档与门禁；Web 有 Run 详情与实时事件流。独立 QA（QA-006）待做。真实 DSH 仍不可用，因此"真实 3 Agent 协作"只完成 Mock 版本。

## 1. 回执

```text
Task: ATK-501..504 (M5 / v0.8)
Changed: apps/launcher（新应用：start/stop/status/logs + detached supervisor）；
         apps/backend CLI backup/restore + serve --pidfile；
         apps/web #/runs 列表/详情 + 实时事件流；
         scripts/m5-smoke.mjs；docs/operations/install-upgrade-rollback.md
Build: pnpm --filter @atk/web build -> exit 0（JS 328.77 kB / gzip 96.90 kB；CSS 22.78 kB）
Tests: test.mjs 423/423 | test-workspace 573/573 | boundaries PASS（9 packages / 6 edges / 0 cycles）
       m1 16/16 | m2 4/4 | m3 6/6 | m4 9/9 | m5 4/4（0 skipped）
Security: 内部凭据只经子进程 env 传递；launcher.json/日志/status 均不含凭据值（门禁断言）
Known: 真实 DSH 不可用；无安装包/自动更新；日志无轮转；Web 无 CI 级浏览器 E2E
Next: M6 —— JSON→SQLite 停机切换与 v1.0 收口
```

## 2. 交付

| 条目 | 内容 |
|---|---|
| ATK-501 | `apps/launcher`：`atk start\|stop\|status\|logs`；detached supervisor 持有 backend stdout 以接收一次性内部凭据；有序停止（hosts→scheduler→backend）；重复 start exit 2；陈旧状态自动清理；Windows 用 `runtime/stop.request` 让 supervisor 执行有序停止 |
| ATK-502 | 恢复语义：Host 的 `ATK_HOST_STATE_FILE` 落在 `<dataDir>/runtime/`，新 Host 启动 `recover()` 对账；Scheduler 无状态重启；Backend 重启后命令由 sweep+reconcile 收敛 |
| ATK-503 | `atk-backend backup/restore`：`node:sqlite backup()` 一致快照（含未 checkpoint 的 WAL；直接复制 .db 在 WAL 下会 `database error`），manifest `{createdAt,schemaVersion,bytes,sha256}`，restore 校验 sha256/版本、临时文件+rename 原子替换、`--force` 语义；`serve --pidfile` |
| ATK-504 | Web `#/runs`、`#/runs/:id`：时间线按 seq 升序去重、fetch+ReadableStream 实时流（不用 EventSource，token 不进 URL）、`system.resync-required` 后重连补齐、词典 en/zh 349/349 |

## 3. M5 门禁（`node scripts/m5-smoke.mjs`，真实 launcher + backend + scheduler + 2 hosts）

```text
PASS  atk start brings up backend, scheduler and two hosts, and work runs
      4 children alive, health ok, 2 completed run(s)
PASS  the internal credential is not persisted anywhere
      no credential value in launcher.json, logs or status output
PASS  a killed host is reported down and atk stop is idempotent
      host <pid> reported down; stop idempotent; port released
PASS  a backup can be restored and started
      manifest schemaVersion 4, 3 run(s) preserved
4/4 checks passed
```

## 4. 期间发现并修复的真实缺陷

| 缺陷 | 发现方式 | 修复 |
|---|---|---|
| `apps/scheduler/cli.mjs`/`apps/runtime-host/cli.mjs` 长驻进程打印 attached 后立即退出（timer 全 unref） | m4-smoke check6 与 launcher E2E | 两个 CLI 增加 `keepAlive` 模式，长驻时 ref 定时器 |
| launcher 把 backend stdout 原样写日志 → **内部凭据横幅落盘** | m5-smoke 第 2 条 | supervisor 对 `/internal token:|x-atk-internal/` 行一律不写原文，只记 `[redacted]` |
| M4 自审可被空格/大小写绕过 | QA-005 | actor 必须完全规范化 + 自审前 casefold 比较（Backend 与 store 双层） |
| M4 验收 hash 是"回显"（生产从不写 `tasks.target_hash`） | QA-005 | PASS 同事务写 `target_hash`；createApproval 必须等于它；m4-smoke 新增换版失效 check |
| M4 `store.patchTask` 可直推 DONE；`review_attempts` 重复 attempt | QA-005 | store 拒绝 DONE；attempt 由 review 行数推导并去重 |
| M3 QA F4 用例仍按旧语义直接 PATCH DONE | 全量回归 | 改为经 PASS review + 人工 approval 的合法链（Lead 维护，QA 已知） |

## 5. 已知限制

1. **真实 DSH 不可用**：M5 的"多 Agent 协作"是 Mock 版本；真实协作需 RT-P07/P08。
2. 无安装包/签名/自动更新；`atk start` 从源码目录运行。
3. 日志无轮转；本地单机场景手工清理。
4. Web 无 CI 级浏览器 E2E（有 headless 截图与单测）。
5. JSON 仍是旧 CLI 的事实源，ADR-006 的停机切换未做（M6）。

## 6. 提交

见 `git log --oneline`（M4 修复 + M5 两组提交）。

回滚：删除 `apps/launcher` 即回到"M4 + 手工启动"；数据层不受影响。
