import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { expandPath, writeText } from "../lib/util.mjs";
import { run as runCache } from "../lib/cache.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

async function fakeTarget(t, name, contents = { "build.bin": "0123456789", "nested/obj.o": "x" }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `atk-cache-${name}-`));
  for (const [relative, text] of Object.entries(contents)) {
    await writeText(path.join(dir, relative), text);
  }
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function setup(t, targetDir) {
  const relativePath = `%TEMP%/${path.basename(targetDir)}`;
  const project = await createProject({
    config: {
      cache: {
        targets: [
          { name: "cargo-target", path: relativePath, env: "CARGO_TARGET_DIR" },
          { name: "unused-target", path: path.join(os.tmpdir(), "atk-cache-does-not-exist") },
        ],
      },
    },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  return { ...project, ctx, logger, expectedPath: expandPath(relativePath), run: (argv) => runCache(argv, ctx) };
}

test("cache status reports every configured target with expanded paths and sizes", async (t) => {
  const targetDir = await fakeTarget(t, "status");
  const { run, logger, expectedPath } = await setup(t, targetDir);
  assert.equal(await run(["status"]), 0);
  const report = logger.lines.json.at(-1);
  assert.equal(report.schemaVersion, 1);
  assert.equal(path.resolve(expectedPath), path.resolve(targetDir), "%TEMP% is expanded with the live env");
  const cargo = report.targets.find((target) => target.name === "cargo-target");
  assert.equal(cargo.exists, true);
  assert.equal(cargo.files, 2);
  assert.equal(cargo.env, "CARGO_TARGET_DIR");
  assert.ok(cargo.bytes >= 11);
  assert.match(cargo.display, /B$/);
  const missing = report.targets.find((target) => target.name === "unused-target");
  assert.equal(missing.exists, false);
  assert.equal(missing.files, 0);
  assert.equal(report.baseline, null);
});

test("cache clean --dry leaves the target untouched, clean removes it", async (t) => {
  const targetDir = await fakeTarget(t, "clean");
  const { run, logger } = await setup(t, targetDir);
  assert.equal(await run(["clean", "--target", "cargo-target", "--dry"]), 0);
  assert.match(logger.text(), /\[dry\] would remove cargo-target/);
  assert.equal(await exists(targetDir), true, "dry-run must not delete anything");

  assert.equal(await run(["clean", "--target", "cargo-target"]), 0);
  assert.match(logger.text(), /removed cargo-target/);
  assert.equal(await exists(targetDir), false);
});

test("legacy --cargo alias and --all select the matching configured targets", async (t) => {
  const targetDir = await fakeTarget(t, "cargo");
  const { run, logger } = await setup(t, targetDir);
  await run(["clean", "--cargo", "--dry"]);
  assert.match(logger.text(), /cargo-target/);
  await run(["clean", "--all", "--dry"]);
  assert.match(logger.text(), /unused-target/, "--all covers every target");
  assert.equal(await exists(targetDir), true);
});

test("cache clean refuses implicit deletion and unknown targets", async (t) => {
  const targetDir = await fakeTarget(t, "refuse");
  const { run, logger } = await setup(t, targetDir);
  assert.equal(await run(["clean"]), 2);
  assert.match(logger.errorText(), /nothing selected/);
  assert.equal(await run(["clean", "--target", "nope"]), 2);
  assert.match(logger.errorText(), /unknown target "nope"/);
  assert.equal(await exists(targetDir), true);
  assert.equal(await run(["clean", "--target", "cargo-target", "--dry"]), 0);
});

test("cache without a sub-command prints usage and exits 2", async (t) => {
  const targetDir = await fakeTarget(t, "usage");
  const { run, logger } = await setup(t, targetDir);
  assert.equal(await run([]), 2);
  assert.match(logger.text(), /Usage: atk cache/);
  assert.equal(await run(["nonsense"]), 2);
});

test("cache clean --all removes every existing target directory", async (t) => {
  const targetDir = await fakeTarget(t, "all");
  const { run } = await setup(t, targetDir);
  assert.equal(await run(["clean", "--all"]), 0);
  const leftovers = await readdir(targetDir).catch(() => []);
  assert.deepEqual(leftovers, []);
});
