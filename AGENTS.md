# Repository workflow

Follow [the branch, local CI, and release policy](docs/BRANCHING.md):

- Put day-to-day work on `dev`. The default branch, `main`, is reserved for new
  releases: merge verified changes from `dev` only as part of a release. There
  is no separate `release` branch.
- Run CI **locally** (do not rely on GitHub Actions for routine CI):
  - **Smoke CI**: `pnpm run ci:smoke` (`node scripts/local-ci.mjs smoke`) for
    day-to-day changes.
  - **Release CI**: `pnpm run ci:release` (`node scripts/local-ci.mjs release`)
    before every release, including building and smoke-testing the Windows
    desktop `.exe` installer.
- Publish GitHub Releases **locally** with `pnpm run release:publish`
  (`node scripts/publish-release.mjs`) from the verified `artifacts/release`
  output. GitHub Actions is a manual fallback only.
- **Mandatory bilingual release notes**: Every release entry in `CHANGELOG.md`
  and every GitHub Release MUST be written in both Chinese and English, with
  **Chinese first (`### 中文`) and English second (`### English`)**.
