# Publishing

This page assumes the package is `agent-team-kit` and the binary is `atk`.

## Pre-publish checklist

- [ ] `package.json` has `name`, `version`, `description`, `license`, `type:
      "module"`, `engines.node`, `bin`, `files`, `exports` and real
      `repository` / `bugs` / `homepage` URLs (this repo:
      `MycroftCooper/agent-team-kit`).
- [ ] `node --version` >= 20.11; the package has **no** `dependencies`.
- [ ] `npm test` passes (`node --test "test/*.test.mjs"`).
- [ ] `npm run selftest` passes (tests + the board plugin's two selftests).
- [ ] `npm pack --dry-run` lists only intended files.
- [ ] `CHANGELOG.md` has an entry for the version being published.
- [ ] `README.md` / `README.zh-CN.md` quickstart is still accurate.
- [ ] The schema `$id` and repository URLs point at the final GitHub location.
- [ ] No project-specific paths, secrets or local absolute paths in shipped files
      (`git grep -n "D:\\\\GitCode"` and `git grep -n "ForAIDoc"` should be
      empty; the only intended mention of another project's layout is the worked
      example in `docs/MIGRATION.md`).

## `files` field

```json
"files": [
  "bin", "lib", "templates", "presets", "skills", "docs", "plugins",
  "agent-flow.config.schema.json",
  "README.md", "README.zh-CN.md", "CHANGELOG.md", "LICENSE"
]
```

What is deliberately shipped: the CLI (`bin`, `lib`), the scaffolder content
(`templates`, `presets`), the DSH plugin (`plugins`), agent skills (`skills`),
docs and the config schema. What is deliberately excluded: `test/`,
`examples/`, `.github/` — they are development material; npm includes only the
`files` list plus `package.json`, `README*`, `LICENSE` and `CHANGELOG*` by default.
`examples/` stays in the git repository because it is a demo, not a runtime
dependency.

`exports` exposes the library surface programmatically
(`agent-team-kit/config`, `/labels`, `/util`) while the binary is the primary
interface. The DSH plugin is deliberately *not* exported: it is a templated
package (identity tokens are substituted by `atk plugin sync`), so it must be
copied into a project rather than imported from `node_modules`.

## Versioning

Follow semver. While the package is `0.x`, a minor bump may still break. Treat
these as **breaking** and bump accordingly:

- CLI command names, flags, or exit codes.
- `agent-flow.config.json` keys or `schemaVersion`.
- `state.json`, `ownership.json`, `runtime.json`, `human-todos.json` field shapes.
- The frozen batch manifest format or `qa-approval.json` schema (these are
  versioned by `batch.manifestTag` / `batch.qaSchemaVersion`).
- Template placeholders (`{{PROJECT}}`, `{{DATE}}`, `{{ROLES_TABLE}}`, `{{ROLE}}`,
  `{{FLOW_DIR}}`, `{{LANGUAGE}}`, `{{BATCH_ID}}`) and template file locations.
- `plugin` identity substitution tokens.

Additive changes (new commands, new optional config keys, new docs) are minor.

## Release steps

```bash
# 1. verify
npm test
npm run selftest
npm pack --dry-run

# 2. bump + changelog
npm version 0.1.1 --no-git-tag-version
# edit CHANGELOG.md: add the 0.1.1 section
git add package.json CHANGELOG.md
git commit -m "release 0.1.1"
git tag v0.1.1

# 3. publish (scoped packages need --access public)
npm publish --access public

# 4. verify from a clean directory
cd "$(mktemp -d)"
npx agent-team-kit@0.1.1 --version
npx agent-team-kit@0.1.1 init --dry-run --project smoke
```

For a first release the version is already `0.1.0`; use `npm publish` directly
after the checklist. If you publish from GitHub Actions, `--provenance` adds a
signed attestation (requires a public repository and `id-token: write`).

### Publishing from GitHub Actions

`.github/workflows/publish.yml` runs on any `v*` tag: it re-runs the tests, then
publishes with `--provenance`. Add the repository secret `NPM_TOKEN` (an npm
automation token with publish rights) and push the tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Without the secret the workflow stops before publishing. The local alternative is
`npm login && npm publish --access public`.

## GitHub template repository

1. Create the repository and push `main`:

   ```bash
   git init
   git add -A
   git commit -m "agent-team-kit 0.1.0"
   git branch -M main
   git remote add origin git@github.com:MycroftCooper/agent-team-kit.git
   git push -u origin main
   git tag v0.1.0 && git push origin v0.1.0
   ```

2. Repository **Settings -> General -> Template repository** to let others start
   from it.
3. Add topics: `agent`, `multi-agent`, `workflow`, `kanban`,
   `deepseek-harness`, `coding-agent`.
4. Update `repository`, `bugs`, `homepage` in `package.json` and the `$id` in
   `agent-flow.config.schema.json` to the real URL.
5. Add a CI workflow that runs `npm test` and `npm run selftest` on Node 20/22 if
   the repository is public.
6. Protect `main` and require the CI check before merging.

## Moving the folder out

The toolkit may be developed inside a larger workspace next to reference
projects. To publish it as a standalone repository:

1. Move (or copy) the directory to its own path, e.g.
   `D:\GitCode\agent-team-kit` -> a fresh standalone checkout.
2. `git init` in the new location (do not carry the parent repository's history
   unless you intend to).
3. Search for local absolute paths and references to sibling projects:

   ```bash
   git grep -n "D:\\\\GitCode"
   git grep -n "ForAIDoc"
   ```

   The only intended mention of another project's layout is the worked example in
   `docs/MIGRATION.md`.
4. Re-run `npm test` and `npm run selftest` from the new path; the tests build
   their own temp projects, so nothing should depend on the old location.
5. Re-run `npm pack --dry-run` and confirm `examples/` and `test/` are excluded.
6. Update URLs, license copyright, schema `$id`, then tag `v0.1.0` and publish.

## What must never be published

- Local absolute paths, secrets, tokens, credentials, `.env` files.
- A populated `agent-flow.config.json` from a private project (the kit repo
  itself is not a consuming project).
- Candidate snapshots, evidence receipts, or `artifacts/` from a real project.

`npm publish` is public and permanent — run `npm pack --dry-run` and inspect the
tarball before every release.
