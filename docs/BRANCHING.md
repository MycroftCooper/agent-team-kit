# 分支与发布规则 / Branch and release policy

本仓库只维护两条长期分支：

- `dev`：日常开发分支。功能、修复和文档更新先进入 `dev`；需要开 PR 时，目标分支选 `dev`。
- `main`：默认分支，也是唯一的发布分支。只有准备发布新版本时，才把通过验证的 `dev` 合入 `main`。日常改动不直接提交到 `main`，也不另设 `release` 分支。

发布时，在 `dev` 准备版本号和变更记录，确认 CI 通过后，发起 `dev` → `main` 的发布 PR。
合入后，在 `main` 的发布提交上打与版本号一致的 `v<版本号>` 标签。推送该标签会触发 npm 发布；
预发布版本进入 `next`，正式版本进入 `latest`。

This repository has two long-lived branches:

- `dev` is for day-to-day development and is the target for ordinary pull requests.
- `main` is the default branch and the only release branch. Merge a verified
  `dev` into `main` only for a new release. Do not commit routine changes
  directly to `main` or create a separate `release` branch.

Prepare the version and changelog on `dev`. Once CI passes, open a release
pull request from `dev` to `main`. After merging, tag the release commit on
`main` with the matching `v<version>`. Pushing that tag triggers npm publishing
under `next` for prereleases or `latest` for stable releases.
