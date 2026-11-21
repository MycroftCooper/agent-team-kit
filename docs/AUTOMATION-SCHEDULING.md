# 项目 CI 定时计划

选择自动化流程，点击「添加定时 / 管理定时」，可以组合使用：

- 单次定时：在一个指定时间运行。
- 多个指定时间：在多个独立时间点运行。
- 固定间隔、指定次数：从首次时间起，按固定间隔安排 N 个时间点。
- 固定间隔、持续循环：从首次时间起持续运行，直到暂停或移除计划。

定时运行复用人工和 Agent 的执行器、实时进度、停止操作和结果归档。
每项目最多同时一个流程，整台 ATK 最多同时四个项目。人类可以停止定时运行；
Agent 不能停止调度器发起的运行。计划不自动操作 Git 或发布产品，具体行为
由项目流程和参数决定。ATK 不识别 P4Deck 或其他项目的专用参数名。

## 配置

计划是 schemaVersion 1 流程新增的可选 `schedules` 数组，保存在
`<project>/.atk/automations/<workflowId>.json`，可接受版本控制。
现有 trigger 保持手动或 Git 语义；定时、手动、Agent、Git 可以共存。
未配置 schedules 的流程保持原行为。以下片段可加入现有流程：

```json
{
  "schedules": [
    {
      "id": "once",
      "name": "一次检查",
      "type": "at",
      "enabled": true,
      "times": ["2026-12-01T18:00:00+08:00"],
      "parameters": { "mode": "quick" }
    },
    {
      "id": "dates",
      "type": "at",
      "times": ["2026-12-02T09:00:00+08:00", "2026-12-03T15:00:00+08:00"],
      "parameters": { "mode": "quick" }
    },
    {
      "id": "five-checks",
      "type": "interval",
      "startAt": "2026-12-01T09:00:00+08:00",
      "everySeconds": 3600,
      "count": 5,
      "parameters": { "mode": "quick" }
    },
    {
      "id": "hourly",
      "type": "interval",
      "enabled": false,
      "startAt": "2026-12-01T09:00:00+08:00",
      "everySeconds": 3600,
      "parameters": { "mode": "quick" }
    }
  ]
}
```

每项有稳定、流程内唯一的 id；name 可选，enabled 默认 true。参数使用流程
已有的类型和默认值；必填参数必须给全。各计划参数独立。UI 沿用已声明的
默认值，不会擅自把布尔默认值改为 true。

每流程最多 32 个计划。at.times 支持 1–100 个不同的绝对时刻；表示同一时刻
的不同偏移也视为重复。interval.everySeconds 是 60–31622400 的整数；
可选 count 为 1–1000000，包含首次时间点。不写 count 就持续循环。
count 是计划时间点数量，错过、忙时跳过的时间点也计入，不保证成功执行 N 次。

UI 按当前设备时区显示、输入时间，配置保存带 Z 或 UTC 偏移的 ISO 时间。
更换时区不移动绝对时刻。间隔按经过的固定时长计算，“1 天”表示 24 小时，
不表示跨夏令时仍保持同一当地钟点。JSON/Agent 指定的秋季夏令时重复小时，
在表单中未修改时会保留原绝对时刻。

## 运行和恢复

调度器约每两秒观察一次项目文件，只有本机 ATK 后端运行且项目未归档时才
生效。首次发现、重新启用或改变计划内容时，以当前时间为起点：已过期的
时间点只记录为跳过，不补跑。只改流程名称或步骤不重置已有计划游标。

正常观察中，到期时刻有 30 秒触发容差；休眠或阻塞后，过旧的时刻会跳过。
一次观察跨过多个时刻时，最多触发最新且仍在容差内的一个，其余记为跳过。
项目忙、需要恢复确认或全局容量已满时，本次立即跳过，不排队、不在空闲后
补跑。启动因 CLI、环境或配置变化失败时记录错误，不重试同一时间点。
多个计划同时到期也遵守同一互斥规则。

UI 显示启用状态、下次运行时间、最近调度、跳过原因和关联运行。
真实 CI 结果仍在 `.atk/runs/<runId>/`，request/result 中的来源为：

```json
{
  "type": "schedule",
  "scheduleId": "hourly",
  "scheduleName": "每小时检查",
  "scheduledAt": "2026-12-01T01:00:00.000Z"
}
```

本机游标在 `.atk/local/<machineId>/schedules.json`，调度决策日志在同目录
`schedule-events.ndjson`。它们不进入 Git、任务快照、备份或集中数据库。
游标损坏会停止定时调度并显示错误，不会清空后盲目重跑；其他触发入口保留
各自的正常校验。配置删除不删除已归档运行。没有自动清理调度日志。

启动前先持久化已消费的时间点。崩溃留下 DISPATCHING 时，重启按调度来源
查找已接受的运行并关联；找不到则标记触发中断，由用户核对记录，不重跑。
该协议优先避免重复执行，不能保证异常中断时每个时刻都执行。
不确定的实际进程仍按 RECOVERY_REQUIRED 处理。时钟回拨不倒退游标。

每台注册项目的设备独立执行计划，不提供不同克隆仓库之间的分布式去重。
换设备、恢复备份或重新接入后，只观察未来时间点。

## Agent CLI / API

已有 validate、apply --create/--revision 配置计划。用完整配置的 CAS 更新
enabled:false/true 暂停或启用，移除数组条目删除计划。启用的未来计划会自动
运行；配置一个发版计划本身不代表用户授权实际发布，仍须遵守项目授权。

```sh
atk-agent automation validate --file workflow.json --project <id>
atk-agent automation apply --file workflow.json --revision <sha256> --project <id>
atk-agent automation schedules <workflowId> --project <id>
atk-agent automation status <runId> --project <id>
```

show/list 也返回运行时 scheduling，不写回配置文件。新增只读接口是
`GET /projects/:projectId/automations/:workflowId/schedules`，human 和 Agent
API 前缀均可用，保留项目权限边界。客户端对应
`client.automation.schedules(projectId, workflowId)`。

返回 items 每项包含 id、nextAt、status（READY/PAUSED/COMPLETED）、last；
顶层 error 表示本机调度不可用。last 包含计划/观察时间、
STARTED/SKIPPED/ERROR/DISPATCHING/INTERRUPTED 状态，以及可选 runId、
跳过数量、原因和错误。实际 CI 成败以关联运行记录为准。

## 结构检查

本次使用 linus-design-guard 做前置检查：

- 三问：延后/重复执行是现有手动、Git 触发无法表达的真实需求；复用 start
  比另建执行系统更简单；可选 schedules 不改变已有 trigger。
- 数据结构：项目流程拥有计划列表，引用同流程参数；本机游标记录消费进度
  和最近决策。写入由原有 owner.lock 的唯一后端负责。
- 数据流：项目 JSON → 校验/到期计算 → 持久化消费 → start → 原归档/SSE。
- 破坏面：已检索校验器、poll、路由、CLI、客户端、表单、运行来源、备份和
  测试。旧配置默认空计划，新增来源不扩大 Agent 停止权限。
- 复杂度预算：只增加计划列表和本机游标两个概念；两种时间模型表达四种
  操作，不加 cron、队列、中央调度表或项目专用代码。裁决：放行。
