// Self-host safety tooling: baseline snapshots, recovery, isolated candidate
// worktrees and integrity checks.
//
// Deliberately independent of lib/: when a change breaks the toolkit itself,
// `node scripts/selfhost.mjs status|guard|restore` must still run so the repo can
// be recovered without a working `atk`.
//
//   status                     print git state, workflow health and backups
//   guard                      exit 1 when the toolkit cannot run or state is broken
//   snapshot [--label <name>]  copy bin/ lib/ scripts/ test/ + config + flow to
//                              .agent-flow/.backup/<stamp>-<label>/
//   restore <latest|stamp> [--apply] [--code-only|--workflow-only]
//                              dry-run by default; --apply restores the snapshot
//   tag <name>                 create an annotated git tag on HEAD
//   prepare <ticket> [--base <ref>]
//                              create an isolated external git worktree under
//                              ../agent-team-kit-candidates/
//   remove <ticket|path>       remove that worktree
//   verify [--full]            run the toolkit integrity checks
//
// No third-party dependencies: node built-ins only.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const ATK = path.join(ROOT, "bin", "atk.mjs");
const BACKUP_ROOT = path.join(ROOT, ".agent-flow", ".backup");
const CANDIDATES_ROOT = path.resolve(ROOT, "..", "agent-team-kit-candidates");
const CONFIG_FILE = path.join(ROOT, "agent-flow.config.json");
const SCHEMA_FILE = path.join(ROOT, "agent-flow.config.schema.json");
const CODE_DIRS = ["bin", "lib", "scripts", "test"];
const CODE_FILES = ["package.json"];
const WORKFLOW_FILES = ["agent-flow.config.json", "agent-flow.config.schema.json"];
const WORKFLOW_SKIP = new Set([".backup", "board.html"]);

const USAGE = [
  "Usage: node scripts/selfhost.mjs <command> [options]",
  "",
  "Commands:",
  "  status                                  git state, workflow health, backups",
  "  guard                                   exit 1 when the toolkit is broken",
  "  snapshot [--label <name>]               snapshot code + workflow into .agent-flow/.backup/",
  "  restore <latest|stamp> [--apply] [--code-only|--workflow-only]",
  "  tag <name>                              annotated baseline tag on HEAD",
  "  prepare <ticket> [--base <ref>]         isolated candidate worktree (outside the repo)",
  "  remove <ticket|path>                    remove a candidate worktree",
  "  verify [--full]                         toolkit integrity checks",
  "",
  "Recovery: node scripts/selfhost.mjs restore latest --apply",
].join("\n");

function parseFlags(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--apply" || token === "--full" || token === "--code-only" || token === "--workflow-only") {
      flags[token.slice(2)] = true;
    } else if (token === "--label" || token === "--base") {
      flags[token.slice(2)] = String(argv[index + 1] ?? "");
      index += 1;
    } else if (token.startsWith("--label=")) {
      flags.label = token.slice("--label=".length);
    } else if (token.startsWith("--base=")) {
      flags.base = token.slice("--base=".length);
    } else {
      flags._.push(token);
    }
  }
  return flags;
}

function runNode(args, { capture = true } = {}) {
  const result = spawnSync(NODE, args, { cwd: ROOT, encoding: "utf8", stdio: capture ? "pipe" : "inherit", windowsHide: true });
  return { code: result.status ?? (result.error ? -1 : 0), stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function runGit(args, { capture = true } = {}) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: capture ? "pipe" : "inherit", windowsHide: true });
  return { code: result.status ?? (result.error ? -1 : 0), stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

function safeName(value) {
  return String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "candidate";
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (WORKFLOW_SKIP.has(entry.name) || entry.name.includes(".tmp-")) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

async function removeDir(target) {
  const had = await exists(target);
  if (had) await fs.rm(target, { recursive: true, force: true });
  return had;
}

async function workflowHealth() {
  const config = await readJson(CONFIG_FILE);
  const flowDir = config?.layout?.flowDir ?? ".agent-flow";
  const statePath = path.join(ROOT, config?.paths?.state ?? path.join(flowDir, "state.json"));
  const ownershipPath = path.join(ROOT, config?.paths?.ownership ?? path.join(flowDir, "ownership.json"));
  const runtimePath = path.join(ROOT, config?.paths?.runtime ?? path.join(flowDir, "runtime.json"));
  const state = await readJson(statePath);
  const ownership = await readJson(ownershipPath);
  const runtime = await readJson(runtimePath);
  const artifactDir = path.resolve(ROOT, config?.layout?.artifactDir ?? "artifacts/agent-flow");
  const gateReport = await readJson(path.join(artifactDir, "ci-fast-latest.json"));
  const version = runNode([ATK, "--version"]);
  const stateCheck = runNode([ATK, "state", "check", "--json"]);
  let stateOk = false;
  try {
    stateOk = JSON.parse(stateCheck.stdout).ok === true;
  } catch {
    stateOk = false;
  }
  return {
    config,
    configOk: Boolean(config),
    state,
    stateOk: Boolean(state) && stateOk,
    ownershipOk: Boolean(ownership),
    runtimeOk: Boolean(runtime),
    atkOk: version.code === 0,
    version: version.stdout.trim(),
    versionError: version.stderr.trim(),
    stateCheckCode: stateCheck.code,
    artifactDir,
    gateReport,
    configPath: CONFIG_FILE,
    statePath,
  };
}

function gitInfo() {
  const head = runGit(["rev-parse", "--short", "HEAD"]);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = runGit(["status", "--porcelain"]);
  const tags = runGit(["tag", "--list", "selfhost-baseline-*"]);
  const worktrees = runGit(["worktree", "list", "--porcelain"]);
  const dirty = status.stdout.split(/\r?\n/).filter(Boolean);
  const candidates = worktrees.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((dir) => path.resolve(dir).startsWith(CANDIDATES_ROOT));
  return {
    head: head.stdout.trim() || "(no commits)",
    branch: branch.stdout.trim() || "(unknown)",
    dirty,
    tags: tags.stdout.split(/\r?\n/).filter(Boolean),
    candidates,
  };
}

async function listSnapshots() {
  let entries = [];
  try {
    entries = await fs.readdir(BACKUP_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(BACKUP_ROOT, entry.name);
    const meta = await readJson(path.join(dir, "meta.json"));
    snapshots.push({
      name: entry.name,
      dir,
      at: meta?.at ?? null,
      label: meta?.label ?? "",
      gitHead: meta?.git?.head ?? null,
      dirty: Array.isArray(meta?.git?.dirty) ? meta.git.dirty.length : null,
    });
  }
  return snapshots.sort((a, b) => a.name.localeCompare(b.name));
}

async function printStatus() {
  const health = await workflowHealth();
  const git = gitInfo();
  const snapshots = await listSnapshots();
  process.stdout.write(`repo       ${ROOT}\n`);
  process.stdout.write(`branch     ${git.branch} @ ${git.head}\n`);
  process.stdout.write(`dirty      ${git.dirty.length} file(s)\n`);
  process.stdout.write(`tags       ${git.tags.length ? git.tags.join(", ") : "(none)"}\n`);
  process.stdout.write(`candidates ${git.candidates.length ? git.candidates.length : 0} worktree(s)\n`);
  process.stdout.write(`config     ${health.configOk ? "OK" : "MISSING/INVALID"}\n`);
  process.stdout.write(`state      ${health.stateOk ? "OK" : "MISSING/INVALID"}\n`);
  process.stdout.write(`ownership  ${health.ownershipOk ? "OK" : "MISSING/INVALID"}\n`);
  process.stdout.write(`runtime    ${health.runtimeOk ? "OK" : "MISSING/INVALID"}\n`);
  process.stdout.write(`atk        ${health.atkOk ? health.version : "BROKEN"}${health.atkOk ? "" : ` (${health.versionError || "no output"})`}\n`);
  process.stdout.write(
    `gate       ${health.gateReport ? `${health.gateReport.ok === true ? "green" : "RED"} ${health.gateReport.gate ?? "fast"} @ ${health.gateReport.finishedAt ?? "?"}` : "no report (run `atk gate fast`)"}\n`,
  );
  process.stdout.write(`backups    ${snapshots.length ? `${snapshots.length}, latest ${snapshots.at(-1).name}` : "none"}\n`);
  if (git.dirty.length) {
    for (const line of git.dirty.slice(0, 12)) process.stdout.write(`  ${line}\n`);
    if (git.dirty.length > 12) process.stdout.write(`  ... (+${git.dirty.length - 12} more)\n`);
  }
  return health;
}

async function cmdStatus() {
  await printStatus();
  return 0;
}

async function cmdGuard() {
  const health = await printStatus();
  const problems = [];
  if (!health.configOk) problems.push("agent-flow.config.json is missing or invalid");
  if (!health.stateOk) problems.push("state.json is missing or invalid, or `atk state check` fails");
  if (!health.atkOk) problems.push("bin/atk.mjs cannot run");
  if (!health.ownershipOk) problems.push("ownership.json is missing or invalid");
  if (problems.length) {
    process.stderr.write(`\nSELFHOST GUARD FAILED:\n${problems.map((line) => `  - ${line}`).join("\n")}\n`);
    process.stderr.write("\nRecover with: node scripts/selfhost.mjs restore latest --apply\n");
    return 1;
  }
  process.stdout.write("\nSELFHOST GUARD OK\n");
  return 0;
}

async function cmdSnapshot(flags) {
  const label = safeName(flags.label ?? "manual");
  const name = `${stamp()}-${label}`;
  const target = path.join(BACKUP_ROOT, name);
  await fs.mkdir(target, { recursive: true });
  const copied = [];
  for (const dir of CODE_DIRS) {
    const source = path.join(ROOT, dir);
    if (!(await exists(source))) continue;
    await copyDir(source, path.join(target, dir));
    copied.push(`${dir}/`);
  }
  for (const file of [...CODE_FILES, ...WORKFLOW_FILES]) {
    const source = path.join(ROOT, file);
    if (!(await exists(source))) continue;
    await fs.copyFile(source, path.join(target, file));
    copied.push(file);
  }
  const flowDir = path.join(ROOT, ".agent-flow");
  if (await exists(flowDir)) {
    await copyDir(flowDir, path.join(target, ".agent-flow"));
    copied.push(".agent-flow/");
  }
  const git = gitInfo();
  await fs.writeFile(
    path.join(target, "meta.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        at: new Date().toISOString(),
        label,
        node: process.version,
        platform: process.platform,
        targets: copied,
        git: { head: git.head, branch: git.branch, dirty: git.dirty },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.stdout.write(`snapshot ${name}\n  ${target}\n  restored with: node scripts/selfhost.mjs restore ${name} --apply\n`);
  return 0;
}

async function resolveSnapshot(selector) {
  const snapshots = await listSnapshots();
  if (!snapshots.length) return undefined;
  if (!selector || selector === "latest") return snapshots.at(-1);
  return snapshots.find((snapshot) => snapshot.name === selector || snapshot.name.endsWith(`-${selector}`));
}

async function copyWorkflow(snapshotDir) {
  const flowSource = path.join(snapshotDir, ".agent-flow");
  const flowTarget = path.join(ROOT, ".agent-flow");
  if (await exists(flowSource)) {
    await fs.mkdir(flowTarget, { recursive: true });
    for (const entry of await fs.readdir(flowSource, { withFileTypes: true })) {
      if (WORKFLOW_SKIP.has(entry.name) || entry.name.includes(".tmp-")) continue;
      const from = path.join(flowSource, entry.name);
      const to = path.join(flowTarget, entry.name);
      if (entry.isDirectory()) {
        await removeDir(to);
        await copyDir(from, to);
      } else if (entry.isFile()) {
        await fs.copyFile(from, to);
      }
    }
  }
  for (const file of WORKFLOW_FILES) {
    const from = path.join(snapshotDir, file);
    if (await exists(from)) await fs.copyFile(from, path.join(ROOT, file));
  }
}

async function restoreCode(snapshotDir) {
  for (const dir of CODE_DIRS) {
    const from = path.join(snapshotDir, dir);
    if (!(await exists(from))) continue;
    await removeDir(path.join(ROOT, dir));
    await copyDir(from, path.join(ROOT, dir));
  }
  for (const file of CODE_FILES) {
    const from = path.join(snapshotDir, file);
    if (await exists(from)) await fs.copyFile(from, path.join(ROOT, file));
  }
}

async function cmdRestore(flags) {
  const selector = flags._[0];
  if (!selector) {
    process.stderr.write("restore: pass <latest|snapshot-name>. Run `node scripts/selfhost.mjs status` to list backups.\n");
    return 2;
  }
  const snapshot = await resolveSnapshot(selector);
  if (!snapshot) {
    process.stderr.write(`restore: no snapshot matches "${selector}"\n`);
    return 2;
  }
  const code = flags["code-only"] === true || flags["workflow-only"] !== true;
  const workflow = flags["workflow-only"] === true || flags["code-only"] !== true;
  process.stdout.write(`snapshot ${snapshot.name} (${snapshot.at ?? "unknown time"})\n`);
  process.stdout.write(`  code:     ${code ? "bin/ lib/ scripts/ test/ package.json" : "(skipped)"}\n`);
  process.stdout.write(`  workflow: ${workflow ? ".agent-flow/ + agent-flow.config.json + schema" : "(skipped)"}\n`);
  if (flags.apply !== true) {
    process.stdout.write("\ndry-run: nothing written. Re-run with --apply.\n");
    return 0;
  }
  if (code) await restoreCode(snapshot.dir);
  if (workflow) await copyWorkflow(snapshot.dir);
  process.stdout.write("\nrestored. running the guard...\n");
  return cmdGuard();
}

async function cmdTag(flags) {
  const name = flags._[0];
  if (!name) {
    process.stderr.write("tag: pass a name, e.g. selfhost-baseline-2026-11-02\n");
    return 2;
  }
  const result = runGit(["tag", "-a", name, "-m", `self-host baseline ${new Date().toISOString()}`]);
  if (result.code !== 0) {
    process.stderr.write(`tag failed: ${result.stderr.trim() || result.error?.message || "unknown error"}\n`);
    return 1;
  }
  process.stdout.write(`tagged ${name} at ${gitInfo().head}\n`);
  return 0;
}

async function cmdPrepare(flags) {
  const ticket = safeName(flags._[0]);
  const base = flags.base || "HEAD";
  const git = gitInfo();
  if (git.dirty.length) {
    process.stdout.write(`warning: the main checkout is dirty (${git.dirty.length} file(s)); the candidate starts from ${base}, not from uncommitted changes.\n`);
  }
  await fs.mkdir(CANDIDATES_ROOT, { recursive: true });
  const dir = path.join(CANDIDATES_ROOT, `${ticket}-${stamp()}`);
  const result = runGit(["worktree", "add", "--detach", dir, base]);
  if (result.code !== 0) {
    process.stderr.write(`prepare failed: ${result.stderr.trim() || result.error?.message || "git worktree add failed"}\n`);
    return 1;
  }
  process.stdout.write(
    [
      `candidate ${dir}`,
      "",
      "The candidate is outside the original tree, so `workspace-isolated` is satisfied.",
      "Work there, run its gates/tests, then freeze from the main checkout:",
      `  cd "${dir}"`,
      `  node bin/atk.mjs state check`,
      `  node scripts/selftest.mjs`,
      "back in the main checkout:",
      `  node bin/atk.mjs batch manifest --candidate "${dir}" --paths <changed> --agent <id>`,
      `  node scripts/selfhost.mjs remove ${ticket}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function cmdRemove(flags) {
  const query = flags._[0];
  if (!query) {
    process.stderr.write("remove: pass a ticket name or candidate path\n");
    return 2;
  }
  const candidates = gitInfo().candidates;
  const match = path.isAbsolute(query)
    ? query
    : candidates.find((dir) => path.basename(dir).startsWith(`${safeName(query)}-`)) ?? candidates.find((dir) => path.basename(dir) === query);
  if (!match || !(await exists(match))) {
    process.stderr.write(`remove: no candidate worktree matches "${query}"\n`);
    return 2;
  }
  const result = runGit(["worktree", "remove", "--force", match]);
  runGit(["worktree", "prune"]);
  if (result.code !== 0) {
    process.stderr.write(`remove failed: ${result.stderr.trim() || result.error?.message || "git worktree remove failed"}\n`);
    return 1;
  }
  process.stdout.write(`removed ${match}\n`);
  return 0;
}

async function cmdVerify(flags) {
  const checks = [];
  const record = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}\n`);
  };
  const version = runNode([ATK, "--version"]);
  record("bin/atk.mjs runs", version.code === 0, version.stdout.trim());
  const state = runNode([ATK, "state", "check", "--json"]);
  let stateOk = false;
  try {
    stateOk = JSON.parse(state.stdout).ok === true;
  } catch {
    stateOk = false;
  }
  record("state check", state.code === 0 && stateOk);
  const ownership = runNode([ATK, "ownership", "verify-config"]);
  let ownershipOk = false;
  try {
    ownershipOk = JSON.parse(ownership.stdout).ok === true;
  } catch {
    ownershipOk = false;
  }
  record("ownership verify-config", ownership.code === 0 && ownershipOk);
  const matrix = runNode([ATK, "permit", "matrix", "--json"]);
  let matrixOk = false;
  try {
    const payload = JSON.parse(matrix.stdout);
    matrixOk = Array.isArray(payload.groups) && payload.stats?.operations === 75;
  } catch {
    matrixOk = false;
  }
  record("permission registry", matrix.code === 0 && matrixOk);
  if (flags.full === true) {
    process.stdout.write("=== full suite ===\n");
    const suite = runNode([path.join(ROOT, "scripts", "selftest.mjs")], { capture: false });
    record("selftest suite", suite.code === 0, `exit ${suite.code}`);
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    process.stderr.write(`\nverify: ${failed.length} check(s) failed. Recover with: node scripts/selfhost.mjs restore latest --apply\n`);
    return 1;
  }
  process.stdout.write(`\nverify: ${checks.length} check(s) passed\n`);
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  const flags = parseFlags(rest);
  switch (command) {
    case "status":
      return cmdStatus();
    case "guard":
      return cmdGuard();
    case "snapshot":
      return cmdSnapshot(flags);
    case "restore":
      return cmdRestore(flags);
    case "tag":
      return cmdTag(flags);
    case "prepare":
      return cmdPrepare(flags);
    case "remove":
      return cmdRemove(flags);
    case "verify":
      return cmdVerify(flags);
    default:
      process.stderr.write(`selfhost: unknown command "${command}"\n\n${USAGE}\n`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
