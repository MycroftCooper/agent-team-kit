// Branch release: merge the configured development branch into the release branch
// and tag it. The kit repository itself does not require this flow; every project
// scaffolded by `atk init` inherits `branch.*` defaults (dev -> master + v* tag).
//
//   atk release --version 0.2.0 [--note "release notes"]
//   atk release --version 0.2.0 --apply
//
// Safety: dry-run by default; verifies current branch, clean worktree, version
// file, and a passing/fresh gate report before touching the release branch.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs, readJson, runCommand } from "./util.mjs";

const USAGE = [
  "Usage: atk release --version <semver> [options]",
  "",
  "Merges the configured development branch into the release branch with --no-ff,",
  "then creates an annotated v<semver> tag. Prints the plan as JSON by default.",
  "",
  "Options:",
  "  --version <semver>   Release version, without the tag prefix (required)",
  "  --note <text>        Annotated tag message (default: \"release v<semver>\")",
  "  --apply              Perform checkout/merge/tag (default is dry-run)",
  "  --from <branch>      Override branch.development",
  "  --to <branch>        Override branch.release",
  "  --skip-gate          Skip the gate report check (not recommended)",
  "  --allow-dirty        Allow an unclean worktree (not recommended)",
  "",
  "Config: branch.development (dev), branch.release (master), branch.tagPrefix (v),",
  "        branch.versionFile (package.json), branch.gateReport (<artifactDir>/ci-fast-latest.json).",
  "",
  "Exit codes: 0 ok, 1 a check failed, 2 usage error.",
].join("\n");

async function git(ctx, args) {
  return runCommand({ command: "git", args, cwd: ctx.root });
}

function failure(ctx, message) {
  ctx.log.err(`release: ${message}`);
  return 1;
}

async function currentBranch(ctx) {
  const result = await git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function run(argv, ctx) {
  const args = parseArgs(argv);
  if (args.help === true || args._[0] === "help" || args._[0] === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }

  const branch = ctx.config.branch ?? {};
  const development = typeof args.from === "string" ? args.from : (branch.development ?? "dev");
  const release = typeof args.to === "string" ? args.to : (branch.release ?? "master");
  const tagPrefix = branch.tagPrefix ?? "v";
  const version = typeof args.version === "string" ? args.version.trim() : "";
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : `release ${tagPrefix}${version}`;
  const apply = args.apply === true;
  const skipGate = args["skip-gate"] === true || args.skipGate === true;
  const allowDirty = args["allow-dirty"] === true || args.allowDirty === true;

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    ctx.log.err(`release: --version must be x.y.z (got "${version}")`);
    ctx.log.out(USAGE);
    return 2;
  }

  const repoCheck = await git(ctx, ["rev-parse", "--is-inside-work-tree"]);
  if (repoCheck.code !== 0) return failure(ctx, "not a git repository (run from the project root)");

  const onBranch = await currentBranch(ctx);
  if (onBranch !== development) {
    return failure(ctx, `must run on the development branch "${development}" (currently "${onBranch}"); use --from to override`);
  }

  const dirty = await git(ctx, ["status", "--porcelain"]);
  if (dirty.stdout.trim() && branch.requireCleanTree !== false && !allowDirty) {
    const count = dirty.stdout.trim().split(/\r?\n/).length;
    return failure(ctx, `worktree is not clean (${count} path(s)); commit or stash first, or pass --allow-dirty`);
  }

  const versionFile = branch.versionFile === false ? null : (branch.versionFile ?? "package.json");
  if (versionFile) {
    const versionPath = path.resolve(ctx.root, String(versionFile));
    const pkg = await readJson(versionPath);
    if (pkg && typeof pkg.version === "string" && pkg.version !== version) {
      return failure(ctx, `version mismatch: ${versionFile} has ${pkg.version}, --version is ${version}`);
    }
  }

  if (!skipGate) {
    const gateConfigured = branch.gateReport;
    const gateFile =
      gateConfigured === false
        ? null
        : path.resolve(ctx.root, String(gateConfigured ?? path.join(ctx.paths.artifactDir, "ci-fast-latest.json")));
    if (gateFile) {
      let report;
      try {
        report = JSON.parse(await readFile(gateFile, "utf8"));
      } catch {
        return failure(ctx, `missing gate report ${path.relative(ctx.root, gateFile)}; run "atk gate fast" first, or pass --skip-gate`);
      }
      if (report.ok !== true) return failure(ctx, "latest gate report is not green; fix the gate, or pass --skip-gate");
      const head = await git(ctx, ["log", "-1", "--format=%ct"]);
      const headSeconds = Number(head.stdout.trim());
      if (Number.isFinite(headSeconds) && headSeconds > 0) {
        const gateMtime = (await stat(gateFile)).mtimeMs;
        if (gateMtime < headSeconds * 1000) {
          return failure(ctx, "gate report is older than the last commit; re-run the gate, or pass --skip-gate");
        }
      }
    }
  }

  const tag = `${tagPrefix}${version}`;
  const existingTag = await git(ctx, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
  if (existingTag.code === 0) return failure(ctx, `tag ${tag} already exists`);

  const plan = {
    dryRun: !apply,
    from: development,
    to: release,
    tag,
    version,
    note,
    steps: [
      `git checkout ${release}`,
      `git merge --no-ff ${development} -m "chore(release): ${tag}"`,
      `git tag -a ${tag} -m "${note}"`,
      `git checkout ${development}`,
    ],
  };
  ctx.log.json(plan);
  if (!apply) {
    ctx.log.out("release: dry-run only; pass --apply to perform the merge and tag.");
    return 0;
  }

  const checkout = await git(ctx, ["checkout", release]);
  if (checkout.code !== 0) return failure(ctx, `git checkout ${release} failed: ${checkout.stderr.trim()}`);
  const merge = await git(ctx, ["merge", "--no-ff", development, "-m", `chore(release): ${tag}`]);
  if (merge.code !== 0) {
    ctx.log.err(`release: merge failed, staying on ${release} for manual resolution:\n${merge.stdout}${merge.stderr}`);
    ctx.log.err(`after resolving: git checkout ${development}`);
    return 1;
  }
  const tagResult = await git(ctx, ["tag", "-a", tag, "-m", note]);
  if (tagResult.code !== 0) {
    ctx.log.err(`release: merge done but tagging failed (${tagResult.stderr.trim()}); tag manually if intended.`);
    return 1;
  }
  const back = await git(ctx, ["checkout", development]);
  if (back.code !== 0) {
    ctx.log.err(`release: tagged ${tag} but could not switch back to ${development}: ${back.stderr.trim()}`);
    return 1;
  }
  ctx.log.out(`release: ${tag} — ${development} -> ${release} (--no-ff) + annotated tag.`);
  ctx.log.out("release: no push is performed; push both branches and the tag yourself when ready.");
  return 0;
}
