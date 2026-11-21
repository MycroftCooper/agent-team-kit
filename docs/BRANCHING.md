# 分支、本地 CI 与发布规范 / Branch, local CI, and release policy

## 中文规范

### 1. 分支策略
本仓库只维护两条长期分支：

- `dev`：日常开发分支。功能、修复和文档更新先进入 `dev`；需要开 PR 时，目标分支选 `dev`。
- `main`：默认分支，也是唯一的发布分支。只有准备发布新版本时，才把通过验证的 `dev` 合入 `main`。日常改动不直接提交到 `main`，也不另设 `release` 分支。

### 2. 本地 CI 规范（不使用 GitHub 跑日常 CI）
日常回归与发版验证全部在**本地**执行，GitHub Actions 不再对 `push` / `pull_request` 自动运行 CI（`ci.yml` 仅保留手动触发）。本地 CI 分为两档：

- **冒烟 CI（日常开发）**：`pnpm run ci:smoke`（或 `node scripts/local-ci.mjs smoke`）
  - 执行模块边界检查、全量单元/协议测试、前端生产构建，适用于每次功能开发与缺陷修复后的快速验证。
- **发版 CI（发版前必跑）**：`pnpm run ci:release`（或 `node scripts/local-ci.mjs release`）
  - 依次执行模块边界检查、全量单元/协议测试、前端构建、浏览器 E2E 测试、npm `.tgz` 打包安装冒烟、Windows 桌面端 NSIS `.exe` 安装包构建与真实启动冒烟、以及发布产物校验（含双语更新日志检查）。

### 3. 发版与双语更新日志规范（必须遵守）
1. **更新日志必须中英双语，且中文在前、英文在后**：
   - 每次发布在 [CHANGELOG.md](../CHANGELOG.md) 中新增 `## <版本号>` 章节时，**必须同时提供中文与英文两个版本**，结构固定为 `### 中文` 在前、`### English` 在后。
   - `scripts/prepare-release.mjs` 会在发版 CI 和打包发布阶段自动校验该格式，缺失中文、缺失英文或顺序颠倒将直接阻断发版。
2. **发布流程**：
   - 在 `dev` 上更新版本号（根目录及工作区 `package.json`、`packages/contracts/src/index.mjs`）并撰写双语更新日志。
   - 在本地运行 `pnpm run ci:release` 并确认全绿通过（含 Windows `.exe` 安装包构建与真机启动冒烟）。
   - 将 `dev` 合入 `main`，在 `main` 的发布提交上打与版本号一致的 `v<版本号>` 标签并推送。
   - 在本地执行 `pnpm run release:publish`（即 `node scripts/publish-release.mjs`），用已构建并验证过的本地产物发布 GitHub Release：
     - Windows 双击安装包 `Agent-Team-Kit-Setup-<版本号>.exe`（内置配套 Windows 卸载程序，支持应用内通过 GitHub Release 自动检查并更新）
     - 跨平台 CLI / Node.js 包 `agent-team-kit-<版本号>.tgz`
     - 统一校验文件 `SHA256SUMS.txt` 与 `release-manifest.json`
     - 中英双语（中文在前）的 Release Notes
   - 发布脚本使用 `GH_TOKEN`（或本机 `git credential`）鉴权；需要覆盖已有发布时加 `--delete-existing`，该参数会同时删除远端标签。
   - 预发布版本需显式加 `--allow-prerelease`（npm 进入 `next`），正式版本为最新正式版（npm 进入 `latest`；若配置了 `NPM_TOKEN` 则在 GitHub 手动兜底流程中同步发布至 npm）。
   - `.github/workflows/publish.yml` 仅保留 `workflow_dispatch` 手动兜底，日常发布不依赖 GitHub 运行器。

---

## English Policy

### 1. Branch Strategy
This repository maintains two long-lived branches:

- `dev`: day-to-day development branch and target for ordinary pull requests.
- `main`: default branch and the sole release branch. Merge verified changes from `dev` into `main` only for a new release. Never commit routine work directly to `main` and do not create a separate `release` branch.

### 2. Local CI Policy (No Automated GitHub CI)
All routine and pre-release CI checks run **locally** instead of on GitHub Actions (`ci.yml` is `workflow_dispatch`-only). Local CI is split into two suites:

- **Smoke CI (day-to-day)**: `pnpm run ci:smoke` (`node scripts/local-ci.mjs smoke`)
  - Runs module boundary checks, full unit/protocol tests, and web production build.
- **Release CI (mandatory before every release)**: `pnpm run ci:release` (`node scripts/local-ci.mjs release`)
  - Runs module boundary checks, full unit/protocol tests, web build, browser E2E, npm tarball smoke, Windows desktop NSIS `.exe` installer build + packaged app smoke test, and release artifact preparation (including bilingual changelog validation).

### 3. Release & Bilingual Changelog Policy (Mandatory)
1. **Bilingual Release Notes — Chinese First, English Second**:
   - Every `## <version>` section in [CHANGELOG.md](../CHANGELOG.md) and every GitHub Release **must** include both Chinese and English, with `### 中文` first and `### English` second.
   - `scripts/prepare-release.mjs` enforces this rule automatically and blocks release preparation if either language is missing or out of order.
2. **Release Flow**:
   - Bump versions and add bilingual release notes on `dev`.
   - Run `pnpm run ci:release` locally and confirm all checks pass (including the Windows `.exe` build and packaged-app smoke test).
   - Merge `dev` into `main`, tag the release commit with `v<version>`, and push the tag.
   - Run `pnpm run release:publish` (`node scripts/publish-release.mjs`) locally to publish the GitHub Release from the already-built and verified artifacts: `Agent-Team-Kit-Setup-<version>.exe` (with companion uninstaller and built-in GitHub Release auto-updater), `agent-team-kit-<version>.tgz`, `SHA256SUMS.txt`, `release-manifest.json`, and bilingual release notes (Chinese first).
   - The publisher authenticates with `GH_TOKEN` (or the local `git credential` store). Use `--delete-existing` to replace an existing release and its remote tag. Prereleases require `--allow-prerelease`.
   - `.github/workflows/publish.yml` is a `workflow_dispatch`-only fallback; routine releases do not depend on GitHub runners.
