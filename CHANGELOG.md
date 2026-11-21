# Changelog

## 0.0.1

### 中文

Agent Team Kit 首个 GitHub Release 版本 —— 面向多项目、人类审批计划与外部主动领取 Agent 的本机协同工作台。

- **核心工作台与协议**：支持多项目登记（Git 可选）、版本化 PM 计划与人工审批、可选独立评审、人工任务、基于 `VERIFIED` 的依赖推进、交付漂移校验与整份计划验收；提供外部 Agent HTTP / CLI 协议（`atk`、`atk-agent`）、协作式文件锁与租约 Fencing、持久化回执与完整备份/恢复；提供中英双语界面、SSE 实时同步、主题切换及 Windows `start.bat` / `stop.bat` 启动器。
- **团队协作、资源、缺陷与自动化**：支持项目级 Agent 身份与隔离凭据、协作实时视图与右侧任务抽屉、内置/全局/项目级团队资源（Agent 模板、Skill、MCP、CLI）、独立缺陷（Bugs）流程、带确认面板的任务看板拖拽、任务取消/归档与只读历史、以及基于 `.atk/automations/` 的项目自动化与定时调度。
- **外部缺陷执行器与桌面开发壳**：新增 `atk-agent run --task <bugId> --check '<cmd>'`（支持 Codex CLI 与 DSH CLI，含进程树托管、文件范围审计与租约续期）以及 Windows Electron 桌面开发壳（`dev.bat`）。
- **Windows 桌面版**：新增可双击安装的 `Agent-Team-Kit-Setup-<版本号>.exe`（NSIS，中英向导、自选目录、桌面与开始菜单快捷方式，免管理员按用户安装），自带配套卸载程序；应用内「设置与运维 → 运行信息与更新」可直接检查并一键安装 GitHub Release 新版本（SHA-256 校验通过后静默原地升级并重启）。
- **GitHub Releases 与自动更新**：`SHA256SUMS.txt` 与 `release-manifest.json` 同时覆盖桌面安装包与 CLI 包；发布产物在本地构建与校验，发布动作亦在本地执行。
- **本地 CI 与发版规范**：不再使用 GitHub 运行日常 CI，改为本地 `pnpm run ci:smoke`（冒烟）与 `pnpm run ci:release`（发版，含 `.exe` 构建与真机启动冒烟）；更新日志强制中英双语且中文在前。

### English

Initial GitHub Release of Agent Team Kit — a local web workspace for human-approved plans and external pull-based agents across multiple projects.

- **Core workspace & protocol**: Multi-project registration (Git optional), versioned PM planning, human plan approval, optional independent review, human tasks, `VERIFIED` dependency progression, and final acceptance with output drift checks; external pull-based HTTP & CLI agent protocol (`atk`, `atk-agent`) with cooperative file/directory leases, generation fencing, durable receipts, and backup/restore; bilingual (Chinese/English) Linear-style web UI with SSE invalidation, theme support, and Windows `start.bat` / `stop.bat` launchers.
- **Collaboration, resources, bugs & automations**: Project-owned agent identities with isolated credentials, live Collaboration view and collapsible task drawer, built-in/global/project team resources (agent templates, skills, MCP configs, CLI scripts), dedicated Bugs workflow, guarded task board drag-and-drop, cancellation/archive with read-only history, and `.atk/automations/` CI automations with scheduling.
- **External bug runner & desktop development shell**: Added `atk-agent run --task <bugId> --check '<cmd>'` supporting local Codex CLI and DSH CLI (`--engine dsh`) with process-tree supervision, file-scope auditing, and lease renewal, plus the Windows x64 Electron desktop development workspace (`dev.bat`).
- **Windows desktop app**: Added the double-click `Agent-Team-Kit-Setup-<version>.exe` installer (NSIS, Chinese/English wizard, choosable directory, desktop and Start-menu shortcuts, per-user install without admin rights) with a companion uninstaller; the in-app **Settings & operations → Application & updates** panel checks GitHub Releases, verifies SHA-256, upgrades in place silently, and relaunches the new version.
- **GitHub Releases & auto-update**: `SHA256SUMS.txt` and `release-manifest.json` cover both the desktop installer and the CLI archive; release artifacts are built, verified, and published locally.
- **Local CI & release policy**: GitHub runners no longer run routine CI; use local `pnpm run ci:smoke` (smoke) and `pnpm run ci:release` (release, including the `.exe` build and packaged-app smoke). Release notes are mandatory bilingual with Chinese first.
