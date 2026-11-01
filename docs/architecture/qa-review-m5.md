# M5 独立 QA 复核报告（QA-006）

- 文档类型：独立复核报告（Reviewer / QA Function，身份隔离）
- 审查对象：分支 `m0/baseline-and-p0`，**冻结 commit `910bb08`**（M5 功能提交 `364e076` + lockfile/`m3-smoke` 适配 `910bb08`）
- 审查者：`qa-reviewer`（REVIEWER/QA）。M5 实现由 Lead、`worker-runtime-spike`、`worker-backend`、`worker-web` 完成，审查者未参与。
- 环境：Windows 11，Node v24.16.0。
- **冻结树口径**：审查期间工作区出现未提交的 **M6 WIP**（`0005_events_index.sql`、`apps/backend/src/server.mjs`、`packages/database/src/model.mjs`），它会让当前工作区的 test/smoke 全部变红（例如 test.mjs 329/4 fail、workspace 488/17 fail、m1..m5 smoke 均 exit 1）。因此本报告所有 M5 数字都来自 `git archive 910bb08` 隔离解包树 `E:\CodeProject\atk-qa-m5-frozen`（各包 `node_modules/@atk/*` 均指向解包树）。
- 审查期间 Lead 的 `127.0.0.1:1421` 服务未被停止/修改；QA 全部使用临时 dataDir + 随机端口；未改产品代码/他人测试，未改变 git 状态，未 commit。
- 交付：`test/m5-qa-adversarial.test.mjs`（24 条）、本报告。

> **结论：M5 在冻结 SHA 上可以标记完成。** 冻结门禁全绿，未发现 BLOCKER/MAJOR；QC 套件 24 条中 22 绿、2 红，均为 **MINOR**（损坏状态文件导致无法停机、`status --json.running` 在 backend 死亡时仍为 true），另有 5 个 OBSERVATION（含 m5-smoke 覆盖缺口、凭据正则的口径问题、session token 不在 dataDir 内、backup 源侧 0 字节 `-wal`、manifest 带绝对路径）。**QA PASS ≠ 生产可用**，边界见 §7。

---

## 1. 执行清单（真实命令 / 退出码 / 输出）

### 1.1 冻结树 `910bb08`（隔离解包）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `node scripts/test.mjs` | 0 | **423 tests / 423 pass / 0 fail / 0 skipped** |
| 2 | `node scripts/test-workspace.mjs` | 0 | 56 文件 / **573 tests / 573 pass** |
| 3 | `node scripts/check-boundaries.mjs` | 0 | **PASS：9 package(s) / 6 edge(s) / 0 cycle(s)** |
| 4 | `node scripts/m1-smoke.mjs` | 0 | **16/16** |
| 5 | `node scripts/m2-smoke.mjs` | 0 | **4/4** |
| 6 | `node scripts/m3-smoke.mjs` | 0 | **6/6** |
| 7 | `node scripts/m4-smoke.mjs` | 0 | **9/9**（0 skipped） |
| 8 | `node scripts/m5-smoke.mjs`（含 `--verbose` 复跑） | 0 | **4/4, 0 skipped**：start/2 hosts + work；credential not persisted；killed host down + idempotent stop；backup→restore→start |
| 9 | `node --test test/m5-qa-adversarial.test.mjs` | 1 | **24 tests / 22 pass / 2 fail**：C3 损坏 `launcher.json` 后 stop 留下整棵进程树；C4 backend 死亡后 `status --json.running` 仍为 true |
| 10 | 变异测试（隔离树 `atk-qa-m5-mut`，见 §5） | — | **3/3 变异被 QA 测试抓到** |
| 11 | 真实 launcher 探针（临时 dataDir/随机端口） | — | start/status/stop 全链路、杀 host、杀 supervisor、fallback、损坏状态、env token、backup/restore 均实测（见 §3/§4） |

### 1.2 关键真实行为（探针结果）

- `atk start --hosts 2`：backend/scheduler/2 hosts 全 alive；health 200；3 个种子任务 → **2 个 COMPLETED Run**；等待 2.5s 后子进程仍全部存活（M5 刚修的 keepAlive 回归通过）。
- 双 start：**exit 2**，状态文件里的 PID 集合不变（未 spawn 第二棵树）。
- 杀一个 host：`status --json` 该 child `alive:false`、CLI **exit 1**、health 仍 ok；`atk stop` 251ms，所有 PID 真实消失、health 不可达、二次 stop exit 0。
- 杀 supervisor：SIGKILL 后子进程因 stdout 管道断开在约 100ms 内自行退出；`stop` 91ms 清掉状态；无孤儿。
- **无 supervisor 的 fallback**（人工制造合法 launcher.json + 存活 dummy 子进程）：`stop` 等待 **15,144ms** 后 fallback `launcher.stop()` 杀掉 dummy、删状态、exit 0——fallback 真的在杀，而不是只改状态。
- `status --json`：无 token 键/值；`launcher.json` 严格 `{version,port,startedAt,children[{name,pid,role}]}`。
- **错误父进程 token**（`ATK_INTERNAL_TOKEN=WRONG-PARENT-...` 启动 launcher）：系统仍正常起、完成 2 个 Run ⇒ 子进程拿到的是 launcher 从 backend stdout 捕获的 token（env 覆盖父环境），而不是继承父环境；host CLI 无 token 直接启动 → exit 2。
- backup：源库 main 文件 sha/bytes 不变；manifest sha/bytes 与快照一致；篡改快照 → restore exit 1 且目标文件保持 `SENTINEL`；篡改 manifest sha / schemaVersion 999 → 拒绝；restore 到另一目录行数一致（6==6），并在该目录启动 health 200、counts.tasks=6；非空目标 backup 无 `--force` → exit 1，有 `--force` → 0 且保留无关文件；已存在 target restore 无 `--force` → exit 1 且原内容不变。

---

## 2. `m5-smoke` 门禁自审（把门禁当被测物）

**结构**：4 条 check，任一 FAIL → exit 1；前置缺失（launcher/backend 不存在）→ exit 2；`started` 标志 + finally 用 `stop --force` 清理。不会“跳过还绿”，这一点 PASS。

**逐条核实与缺口**：

| 门禁点 | 事实 | 自审结论 |
|---|---|---|
| “凭据不落盘”的检测 | 检查 `status --json` 无 token 字段、`launcher.json` 不含 phrase、logs 中 `internal token:` 后不能跟非 `[REDACTED]` 值，且 logs 去掉 `[REDACTED]` 后不能出现 `[A-Za-z0-9_-]{40,}` | **只扫 logs + launcher.json + status**，不扫 `runtime/`、DB、其它文件；门禁文案 “not persisted anywhere” 比实际断言强。当前 token 是 43 字符 base64url，40+ 能覆盖；但**形状正则会误报 SQLite 内部字符串**：我在 `atk.db-wal` 中直接匹配到 44–58 字符的 `indexsqlite_autoinde...` 等（若把门禁扩到全目录会假红）；反过来，若 token 改为 <40 字符或含 `+`/`=` 等非 base64url 字符，40+ 会漏（第一条 banner 正则仍能兜住“未过滤的 banner”，但“无 banner 前缀的落盘”会漏）。结论：**门禁对当前实现有效，但对 token 形状/扫描范围是耦合的**；应把“扫描范围”写进契约，或捕获 token 值做精确扫描。 |
| 杀 host 是否真杀 | `process.kill(host.pid)`（Windows 默认终止）→ 轮询 `status` 该 child `alive:false`；**是真实 PID**，不是只改状态 | 真实；但门禁只断言 `alive:false`（status 用 `process.kill(pid,0)` 判断），没有再次用 `process.kill(pid,0)` 直接确认，也没有断言 scheduler/backend 仍活、stop 后所有 PID 死。我的 QA 补了这些。 |
| backup→restore→start 是否在恢复后的库启动 | `restore --data <restoredDir>/data/atk.db`，然后在 `restoredDir` 上 `start --port <new>`，health counts `runs >= before`；**确实换了目录/库** | 真实；但 **不测 manifest 篡改**（契约 §4.6 明确要求）、不比较精确行数（`>=` 可被“多出来”或 before=0 掩盖）、不测 restore 原子性与 `--force`。我的 QA 补了 tamper/精确行数/`--force`。 |
| stop 幂等 | 第一次 stop 后只断言 `status.running===false` 且 health 不可达；第二次 stop exit 0 | **第二次 no-op 确实可能掩盖第一次没停干净**：`commandStop` 在没有 state 时直接 “not running”，而 `launcher.stop()` 即使子进程 `exited:false` 也会 `removeState` + exit 0。冻结实现通过，但门禁没有“所有 PID 必须死”的直接断言。变异 M1（commandStop 立即返回）会让 A3/A4 变红，而 m5-smoke 只看到第二次 stop 的 0 —— 建议门禁加 PID 级断言。 |
| 有序停止（hosts→scheduler→backend） | 实现按 hosts(reverse)→scheduler→backend 顺序逐个 SIGTERM→等待→SIGKILL；Windows 上 SIGTERM 即终止 | 代码有顺序；**门禁没有断言顺序**。另外：杀 supervisor 时子进程常因 stdout EPIPE 自行退出，会掩盖 `launcher.stop` 未按序/未 kill 的实现问题（见 §5 变异经验）。 |
| 崩溃恢复（Run 不是 COMPLETED） | 契约 §4.5 要求；m5-smoke check3 只做“杀 host → status down + stop 幂等”，**没有 `atk start` 重启后 `recover()`/Run INTERRUPTED 的断言** | **门禁缺口**（我的 QA 也未独立验证 Run INTERRUPTED：人工制造 in-flight 状态后重启得到 COMPLETED，说明该场景需要专门构造/更严格夹具，不能算门禁覆盖）。 |
| Web 构建（契约 §4.7） | m5-smoke 不构建 web；m5-status 记录 `pnpm --filter @atk/web build` 通过 | 门禁缺口（文档数字来自回执，不在 4 条 check 内）。 |
| 契约 §4 共 7 项 vs 实际 4 项 | 4 条 check 合并了 1/2/5/6 的部分内容；缺 4.5 恢复、4.6 tamper、4.7 web build、2 的 2 hosts 并行证据（只要求 ≥2 completed，可能由 1 个 host 完成） | **MINOR 门禁覆盖缺口**（QA6-03）。 |

---

## 3. A–F 结论表（期望 · 实际 · 判定）

判定：**PASS** = 冻结满足；**FAIL** = 冻结违反（缺陷）；**OBSERVATION** = 记录项。

### A. 启停与幂等（5 条，全 PASS）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| A1 一条命令起全树 + 工作完成 + 长驻 | 4 children alive、health 200、≥2 completed、等待后仍活 | 一致（真实 launcher 进程树） | PASS |
| A2 双 start | exit 2、不 spawn 第二棵、PID 不变 | 一致 | PASS |
| A3 杀 host | status 标 down、exit 1、stop 清全部、端口释放、二次 stop 幂等 | 一致（PID 级验证） | PASS |
| A4 stop --force | 全部子进程死、端口释放 | 一致 | PASS |
| A5 陈旧状态（PID 全死） | 下次 start 自动清理并成功 | 一致（新 PID，不复用旧 PID） | PASS |

### B. 凭据隔离（3 条，全 PASS）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| B1 全目录/状态/日志不落内部凭据 | 无未过滤 `internal token:` 值、无 `x-atk-internal` 原值、状态闭形无 token 字段 | 一致；日志有可见的 `internal credential received`/`[redacted]` 证据 | PASS |
| B2 凭据真经 env 传递 | 错误父 token 不影响子进程；host 无 token 拒绝 | 一致：错误父 token 下工作照常完成；host CLI 无 token exit 2 | PASS |
| B3 status --json 无凭据 | 无 token 键/值/43 字符形状 | 一致 | PASS |

> 补充：**浏览器 session token** 不在 dataDir 内——backend 把 `%LOCALAPPDATA%\AgentTeamKit\runtime\session-token` 写到机器级目录（日志也打印该路径）；两个不同 dataDir 的 launcher 会互相覆盖该文件（A/B 两个实例 token 不同，文件最后等于 B）。这是 M1 的既有行为、不是内部凭据，但“temp dataDir 隔离”对浏览器凭据不成立，且 dataDir 全目录 grep 看不到它（QA6-05/OBSERVATION）。

### C. 崩溃矩阵（4 条：2 PASS、2 FAIL）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| C1 杀 supervisor 后 stop | 无孤儿、状态清理、exit 0 | 一致（子进程因 EPIPE 自行退出，stop 清状态） | PASS |
| C2 fallback（无 supervisor、子进程活） | stop 真的杀记录中的 PID | 一致：等待 15.1s 后 fallback 杀死 dummy、删状态、exit 0 | PASS |
| **C3 损坏 `launcher.json`** | 仍能停掉在跑的树 | **stop 输出 “not running”、exit 0，但整棵进程树仍活**；`readState` 把损坏文件当 null，`commandStop` 还删掉了 `runtime/launcher.pid`，之后 start 会因端口占用失败，系统变成“在跑但无法管理” | **FAIL / MINOR（QA6-01）** |
| **C4 部分死亡（backend 死 hosts 活）** | status 如实标 down | child `backend.alive=false`、health down、CLI exit 1 都正确；但 **`status --json.running === true`**（`status()` 只要 state 文件存在就报 running true，`inspect()` 才是 `aliveChildren && health`） | **FAIL / MINOR（QA6-02）** |

### D. 备份与恢复（7 条，全 PASS）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| D1 backup 不改源库 + manifest 有效 | main sha/bytes 不变、sha/bytes/schema 正确 | 一致（注：源目录会新出现 0 字节 `-wal`，见 OBS） | PASS |
| D2 篡改快照 | restore 拒绝、目标不变 | 一致（exit 1，目标保持 `KEEP/SENTINEL`） | PASS |
| D3 manifest sha/版本篡改 / 版本过高 | 拒绝 | 一致（sha 不符、schemaVersion 999 → exit 1） | PASS |
| D4 restore 到另一目录 + 启动 | 行数一致、health 200 | 一致（6==6；restored health counts.tasks=6） | PASS |
| D5 backup 到非空目录 | 无 --force 拒绝；--force 成功且保留无关文件 | 一致 | PASS |
| D6 restore 到已存在 target | 无 --force 拒绝且旧目标不丢；--force 替换 | 一致 | PASS |
| D7 **live WAL 一致性** | WAL 中未 checkpoint 的写入必须进快照 | 一致（保持 store 打开、未 checkpoint 时 backup→restore 行数相等） | PASS |

### E. 边界与文档（5 条，全 PASS）

| 项 | 期望 | 实际 | 判定 |
|---|---|---|---|
| E1 端口被占用 | start 失败可读、无半启动树 | 一致：exit 1，stderr 含 supervisor exited/backend exited，无 `launcher.json` | PASS |
| E2 --hosts 0/99 | 用法错误 exit 2，不 spawn | 一致 | PASS |
| E3 非法 dataDir（路径是文件） | 失败可读、无半写状态 | 一致：exit 1，错误可读 | PASS（只读 ACL 未能在 Windows 上无损构造，未测，见边界） |
| E4 文档/CLI 一致 | start/stop/status/logs、全部 flags、退出码 | 一致（m5-contracts §1 的 flag 集合与 CLI `parseArgs` 对齐；ops 文档含 start/stop/backup/restore） | PASS |
| E5 隐私 | 新文件无 token/本机路径 | 一致（launcher/cli/m5-smoke/两份文档） | PASS |

### F. 其他观察（非测试项）

- `backup` 会在源库旁新出现 **0 字节 `atk.db-wal`**（main 文件内容不变）——“backup 不修改源库”在文件系统层面有 sidecar 副作用；建议文档写明或备份后清理。
- backup manifest **多出 `source` 绝对路径**（契约只有 4 字段），备份被分享时会泄露本机目录；建议去掉或相对化。
- `launcher.stop()` 对每个 child 记录 `exited`，但**无论 `exited` 是否为 false 都 `removeState` 并返回 0**；理论上 SIGKILL 失败会假成功（实测 Windows 未触发）。建议 `exited:false` 时返回 code 1 且保留状态。
- fallback stop 固定等 15s（无 supervisor 时）；可用 pidfile + 更短探测改善，但不影响正确性。
- m5-smoke 的 4/4 是“门禁自证”而非独立验证；本报告的 2 个 MINOR 它都不会发现。

---

## 4. 缺陷清单

### QA6-01（MINOR）损坏的 `launcher.json` 让 `atk stop` 无法停机，留下整棵孤儿树

- 位置：`apps/launcher/src/state.mjs` `readState`（损坏文件 → `null`）；`apps/launcher/cli.mjs` `commandStop`（state 为 null → 删 `stop.request`/`runtime/launcher.pid` 后输出 “not running”）；`apps/launcher/src/launcher.mjs` `stop`（state null → `removeState` + code 0）。
- 复现（冻结树，真实进程）：`atk start` → 覆盖 `launcher.json` 为非法 JSON（模拟截断/崩溃写入）→ `atk stop`。结果：`stop` exit 0 输出 “not running”，但 backend/scheduler/host 的 PID 全部仍活；pidfile 被删；随后 `atk start` 因端口占用 exit 1，系统“在跑但不可管理”。重放：`node --test test/m5-qa-adversarial.test.mjs --test-name-pattern=C3`。
- 规范依据：m5-contracts §0.4（崩溃后 start 可恢复，残留状态文件不得阻止恢复）/§1（stop 幂等、状态可查）；状态写入虽原子，但 Windows `writeState` 的 copy+unlink fallback 与手工/磁盘损坏仍可产生坏文件。
- 归属：worker-runtime-spike（launcher）。
- 建议：`readState` 失败但 pidfile/stop.request 存在时，走 fallback 用 pidfile 的 supervisor PID + 扫描/显式报错，绝不静默 “not running”；或保留损坏文件并在 stop/status 中明确报错退出 1。

### QA6-02（MINOR）`status --json.running` 在 backend 死亡时仍为 true

- 位置：`apps/launcher/src/launcher.mjs` `status()`（state 存在 → `running: true`，code 由 `allAlive && health.ok` 决定）。
- 复现：`atk start` → 杀 backend → `atk status --json`：`children.backend.alive=false`、`health.ok=false`、CLI exit **1**，但 `running === true`。脚本若只看 `running` 会误判系统可用；`inspect()`（start 使用）语义相反。
- 规范依据：m5-contracts §0.5“状态可查：每个子进程 PID/存活/端口/健康，机器可读”；`running` 应表示“系统可用”，而不是“状态文件存在”。
- 归属：worker-runtime-spike（launcher）。
- 建议：`running = allAlive && health.ok`（与 `inspect` 一致），或新增 `statePresent` 字段区分；m5-smoke 加部分死亡断言。

### QA6-03（MINOR）m5-smoke 覆盖缺口（契约 §4 的 7 项只实现 4 项）

- 缺：4.5 重启后 Host `recover()` / Run 不是 COMPLETED（只测“杀 host → status down + stop”）；4.6 “篡改 manifest sha256 → restore 拒绝”；4.7 web build；2 的“2 hosts 并行”证据（只要求 ≥2 completed）；stop 的“所有 PID 已死”与停止顺序断言；凭据扫描只覆盖 logs + launcher.json + status（不扫 runtime/DB/整个 dataDir）。
- 影响：门禁绿 ≠ 这些契约项被验证；本报告的 QA6-01/02 均不会被 4/4 发现。
- 归属：Lead / worker-runtime-spike。
- 建议：把 §4 的 7 条逐条落成 check；加 PID 级 stop 断言与 manifest tamper check；恢复场景用确定性的 in-flight 夹具并断言 Run 为 INTERRUPTED。

### QA6-04（MINOR）凭据“不落盘”检测与 token 形状耦合

- 冻结 `m5-smoke` 用 `[A-Za-z0-9_-]{40,}` 作为 token 形状。当前 token 是 43 字符 base64url，可覆盖；但：
  - **太宽**：直接对 dataDir 全文件套用会误报 SQLite 内部字符串（实测 `atk.db-wal` 中有 44–58 字符的 `indexsqlite_autoinde…` 等），所以门禁只敢扫 logs；
  - **太窄**：若 token 改成 <40 字符或含 `+`/`=`，形状正则漏；`internal token:` 第一条能兜住 banner，但“无前缀落盘”的场景漏。
- 依据：m5-contracts §0.2/§4.3。归属：Lead / worker-runtime-spike。
- 建议：门禁扫描范围显式写成“logs/state/status”；并把 token 值的精确扫描作为可选（launcher 可在测试模式经环境注入固定 token）或改用“扫描 `internal token:` 前缀 + 已知字符集”的双规则并记录假阳性排除项。

### QA6-05（MINOR）launcher 的 dataDir 不隔离浏览器 session token

- 现象：launcher 以 `--data <tmp>` 启动时，backend 仍把 session token 写到 `%LOCALAPPDATA%\AgentTeamKit\runtime\session-token`（日志也打印该路径）；两个不同 dataDir 的实例互相覆盖（A/B token 不同，文件最后为 B）；dataDir 内没有该文件，因此“全目录 grep”看不到。
- 依据：ADR-008 的 token 文件机制是既有设计；M5 的“临时 dataDir/隔离”承诺没有覆盖浏览器凭据。影响：并行实例/QA 临时实例会污染真实用户的 token 文件；不是内部凭据泄露。
- 归属：worker-runtime-spike / Lead（契约）。建议：launcher 给 backend 传 dataDir 级的 token 文件路径（或 `ATK_SESSION_TOKEN_FILE`），并在 m5-contracts 明确 dataDir 包含哪些凭据。

### 其余 OBSERVATION

| # | 内容 |
|---|---|
| QA6-06 | fallback stop 在无 supervisor 时固定等 15s 才杀（正确但慢）；建议 pidfile 快速路径。 |
| QA6-07 | backup 在源库旁创建 0 字节 `-wal`（main 不变）；建议文档说明或清理。 |
| QA6-08 | backup manifest 带 `source` 绝对路径（契约 4 字段之外的隐私项）；建议去掉/相对化。 |
| QA6-09 | `launcher.stop` 忽略 `exited:false`，仍 removeState + exit 0（实测 Windows 未触发；理论假成功）。 |
| QA6-10 | 杀 supervisor 时子进程常因 stdout EPIPE 自行退出，导致 fallback/顺序停止的真实路径难以被 E2E 触发；建议 m5-smoke 用“无 supervisor + 人工状态文件”覆盖 fallback（本 QA C2 已做）。 |
| QA6-11 | 契约 §4.5 的 Run INTERRUPTED 未在 m5-smoke 验证；QA 尝试人工 in-flight 夹具重启后得到 COMPLETED（夹具/租约语义未吃透），**该场景本轮未独立确认**，需专门用例。 |

---

## 5. 变异测试（`git archive 910bb08` 隔离树 `atk-qa-m5-mut`）

方法：解包冻结树（`@atk/*` 指向解包树），把 QA 套件复制进去；逐个注入变异、跑对应 `test-name-pattern`、恢复。基线为冻结树 24 条（22 绿 / 2 已知 MINOR 红）。

| 变异 | 目标测试 | 结果 |
|---|---|---|
| **M1 `commandStop` 立即 `return 0`（stop 不等待/不杀）** | A3 + A4 | **CAUGHT**：2/2 变红（12–13s 后 PID 仍活） |
| **M2 backup 退化为直接 `copyFileSync(.db)`** | D7（live WAL 一致性） | **CAUGHT**：1/1 变红（快照丢 WAL 中未 checkpoint 的事务，行数不等） |
| **M3 去掉 token 过滤 + `redact()` 失效** | B1 | **CAUGHT**：1/1 变红（backend.log 出现原始 `internal token:` 行） |

**变异过程中的两个“真实防线”观察**（不是产品缺陷，但影响测试设计）：
1. 只删 `handleLine` 的 token 行过滤仍不会泄漏：`appendLog` 里的 `redact()` 会用已知 token 值把原文替换成 `[REDACTED]`。M3 必须同时打掉两层才能验证测试真能抓泄漏。
2. 只把 `launcher.stop()` 改成“立即返回”时，A3/A4 仍会绿：supervisor 退出会关闭子进程 stdout 管道，子进程因 EPIPE 自行退出。必须改 `commandStop`（CLI 层）才能让“stop 不等待”可观察。这说明 m5-smoke 的“二次 stop exit 0”尤其容易掩盖停机缺陷，门禁需要 PID 级断言。

---

## 6. 契约 / 文档一致性

| 契约项 | 验证 | 结论 |
|---|---|---|
| §0.1 一条命令（Backend+Scheduler+N Hosts） | 真实 launcher、2 hosts、work 完成、health 200 | 一致 |
| §0.2 内部凭据只经 env、不落盘/日志 | launcher.json/logs/status 无值；错误父 token 仍工作；host 无 token 拒绝 | 一致（检测口径见 QA6-04；session token 另见 QA6-05） |
| §0.3 有序停止、幂等 | 顺序代码 + 实测全 PID 死；二次 stop 0；WS 上 EPIPE 掩盖风险 | 一致（门禁未断言顺序） |
| §0.4 崩溃后 start 可恢复、绝不把 in-flight 当已完成 | 陈旧状态自动清理通过；**损坏状态文件会孤儿化**；Run INTERRUPTED 未独立验证 | 部分一致（QA6-01/QA6-11） |
| §0.5 状态可查（PID/存活/端口/健康） | 结构/字段/`--json` 一致；**backend 死时 `running:true`** | 部分一致（QA6-02） |
| §0.6 backup/restore 一致快照、版本校验、可异地启动 | 7 条 D 测试全绿（含 WAL/篡改/原子替换/force） | 一致 |
| §1 CLI 形状/退出码/数据目录布局 | 4 命令、flags、0/1/2 退出码与文档一致；dataDir = data/runtime/logs/launcher.json | 一致 |
| §2 backup/restore CLI | 参数/退出码/manifest/`--force` 一致（manifest 多了 `source`） | 一致（OBS QA6-08） |
| §3 Web Runs | 本轮不重复审 M5 web（已由产品测试 573 覆盖、无浏览器 E2E）；只做隐私/静态扫描 | 未独立 E2E |
| §4 门禁 7 项 | 实际 m5-smoke 4 条（见 §2） | 覆盖缺口（QA6-03） |

---

## 7. 结论：M5 能否标记完成

- **冻结 `910bb08`：可以标记完成。** 所有强制门禁在隔离冻结树上全绿（423/423、573/573、boundaries 9/6/0、m1 16、m2 4、m3 6、m4 9、m5 4/4）；无 BLOCKER/MAJOR。行为层面 A（启停/幂等）、B（内部凭据 env 传递）、D（备份/恢复，含 live WAL、篡改、force、异地启动）、E（边界/文档）全部真实通过。
- 发现 **2 个 MINOR**（QA6-01 损坏状态文件 → 无法停机；QA6-02 `running` 语义）与 3 个门禁/实现 MINOR/观察（QA6-03/04/05）。建议在 v1.0 收口前修复 QA6-01/02 并把 QA6-03 的 3 个缺口补进 m5-smoke；它们不影响 M5 的“一条命令能跑起来”的主承诺。
- **审查环境提醒**：当前工作区有未提交的 M6 WIP，会污染所有全量命令；M5 收口请以 910bb08 冻结树为准，不要把当前 test.mjs/workspace/smoke 的数字当作 M5 回归。

### 收口清单

1. QA6-01：stop/status 在 state 损坏但存在 pidfile/stop.request 时不要静默 no-op；保留/报错，绝不删 supervisor pidfile。
2. QA6-02：`status --json.running = allAlive && health.ok`（或增加 `statePresent`）。
3. QA6-03：m5-smoke 补 manifest tamper、Run INTERRUPTED 恢复、web build、stop 的 PID 级断言与停止顺序；凭据扫描范围写进契约。
4. QA6-04/05：明确 token 扫描规则/范围；launcher 让 session token 文件随 dataDir 隔离。
5. m5-status 更新独立 QA 结论与本报告数字；QA6-07/08/09 作为已知限制或小修复。

---

## 8. “QA PASS ≠ 生产可用”边界

1. 真实 DSH 仍不可用；M5 的“多 Agent 协作”是 MockRuntime 路径。
2. 无安装包/签名/自动更新；`atk start` 从源码目录运行。
3. 无浏览器 E2E：Web `#/runs` 实时流只由产品单测（573 workspace tests）覆盖，本轮未做真浏览器验证。
4. 仅 Windows 11 单机验证；POSIX 信号语义未测（本报告按 Windows 的 `runtime/stop.request` + SIGTERM=TerminateProcess 行为验证）。
5. 未测 Windows 只读 ACL（用“dataDir 路径是文件”替代非法目录场景）、未测 PID 复用/恶意 PID、未测多实例并发（session token 共享本身就是已知限制）。
6. 日志无轮转、无预算/限流；workspace 未接入 Host；JSON 仍是旧 CLI 事实源（M6）。
7. 恢复场景（Run INTERRUPTED）未独立确认；m5-smoke 目前也不覆盖。
8. Node < 22.5（无 `node:sqlite`）时 QA 套件整体 SKIP，不注册测试。

---

## 附录 A：对抗套件（24 条）与冻结结果

| 组 | 用例 | 冻结 |
|---|---|---|
| A（5） | 一条命令起全树 + 工作 + 长驻；双 start；杀 host + stop 清 PID/端口；stop --force；陈旧状态重启 | 5 绿 |
| B（3） | 内部凭据不落 state/logs/status；错误父 token 仍工作 + host 无 token 拒绝；status 无凭据形状 | 3 绿 |
| C（4） | 杀 supervisor 后 stop；fallback 真杀活 PID；**损坏 launcher.json**；**backend 死时 running** | C1/C2 绿，**C3/C4 红** |
| D（7） | backup 不改源 + manifest；篡改快照；manifest sha/schema；异地 restore+start；非空目录；已有 target + force；**live WAL 一致性** | 7 绿 |
| E（5） | 端口占用；--hosts 0/99；非法 dataDir；文档/CLI 一致；隐私 | 5 绿 |

## 附录 B：复跑命令（冻结树）

```bash
# 隔离解包 910bb08 后（包内 @atk/* 指向解包树；不要用当前 M6 WIP 工作区）
node scripts/test.mjs             # 423/423
node scripts/test-workspace.mjs   # 573/573（56 文件）
node scripts/check-boundaries.mjs # PASS 9/6/0
node scripts/m1-smoke.mjs         # 16/16
node scripts/m2-smoke.mjs         # 4/4
node scripts/m3-smoke.mjs         # 6/6
node scripts/m4-smoke.mjs         # 9/9
node scripts/m5-smoke.mjs         # 4/4
node --test test/m5-qa-adversarial.test.mjs   # 24 tests：22 pass / 2 fail（QA6-01/02）

# 变异（atk-qa-m5-mut）
# M1 commandStop 立即返回      -> A3/A4 红
# M2 backup 直接复制 .db       -> D7 红
# M3 redact + token 过滤失效   -> B1 红
```
