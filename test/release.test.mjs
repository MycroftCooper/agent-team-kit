import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { run as runRelease } from "../lib/release.mjs";
import { memoryLogger } from "./helpers.mjs";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "agent-flow.config.json"),
    `${JSON.stringify({ schemaVersion: 1, language: "en", layout: { flowDir: ".agent-flow" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(root, ".gitignore"), "artifacts/\n", "utf8");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "demo", version: "0.2.0" }, null, 2)}\n`, "utf8");
  git(root, "init", "-b", "dev");
  git(root, "config", "user.email", "release-test@example.com");
  git(root, "config", "user.name", "Release Test");
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial");
  git(root, "branch", "master");
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: root, logger });
  return { root, ctx, logger };
}

async function writeGreenGate(root) {
  const dir = path.join(root, "artifacts", "agent-flow");
  await rm(dir, { recursive: true, force: true });
  execFileSync("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(dir)},{recursive:true})`], { cwd: root });
  await writeFile(path.join(dir, "ci-fast-latest.json"), `${JSON.stringify({ schemaVersion: 1, gate: "fast", ok: true })}\n`, "utf8");
}

test("init-style config carries dev/master branch defaults", async (t) => {
  const { ctx } = await setup(t);
  assert.equal(ctx.config.branch.development, "dev");
  assert.equal(ctx.config.branch.release, "master");
  assert.equal(ctx.config.branch.tagPrefix, "v");
});

test("release defaults to a dry-run plan and never moves branches", async (t) => {
  const { root, ctx, logger } = await setup(t);
  await writeGreenGate(root);
  assert.equal(await runRelease(["--version", "0.2.0"], ctx), 0);
  const plan = logger.lines.json.at(-1);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.from, "dev");
  assert.equal(plan.to, "master");
  assert.equal(plan.tag, "v0.2.0");
  assert.equal(git(root, "tag", "-l", "v0.2.0"), "");
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
});

test("release refuses a version mismatch and a wrong branch", async (t) => {
  const { root, ctx, logger } = await setup(t);
  await writeGreenGate(root);
  assert.equal(await runRelease(["--version", "9.9.9"], ctx), 1);
  assert.match(logger.errorText(), /version mismatch/i);

  git(root, "checkout", "master");
  assert.equal(await runRelease(["--version", "0.2.0"], ctx), 1);
  assert.match(logger.errorText(), /development branch/i);
});

test("release refuses a red gate report", async (t) => {
  const { root, ctx, logger } = await setup(t);
  await writeGreenGate(root);
  const gateFile = path.join(root, "artifacts", "agent-flow", "ci-fast-latest.json");
  await writeFile(gateFile, `${JSON.stringify({ ok: false })}\n`, "utf8");
  assert.equal(await runRelease(["--version", "0.2.0"], ctx), 1);
  assert.match(logger.errorText(), /not green/i);
});

test("release --apply merges into master, tags and switches back to dev", async (t) => {
  const { root, ctx } = await setup(t);
  await writeFile(path.join(root, "feature.txt"), "feature\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-m", "feature on dev");
  await writeGreenGate(root);
  assert.equal(await runRelease(["--version", "0.2.0", "--apply"], ctx), 0);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
  assert.match(git(root, "tag", "-l", "v0.2.0"), /^v0\.2\.0$/);
  const masterLog = git(root, "log", "--oneline", "-1", "master");
  assert.match(masterLog, /chore\(release\): v0\.2\.0/);
  const merged = await readFile(path.join(root, "package.json"), "utf8");
  assert.match(merged, /"version": "0\.2\.0"/);
});
