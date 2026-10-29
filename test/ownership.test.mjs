import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { runCli } from "../lib/dispatch.mjs";
import {
  checkFiles,
  resolveOwner,
  run as runOwnership,
  verifyOwnershipConfig,
} from "../lib/ownership.mjs";
import { runCommand } from "../lib/util.mjs";
import { createProject, memoryLogger, minimalOwnership } from "./helpers.mjs";

async function setup(t, options = {}) {
  const project = await createProject({
    files: { "flow/ownership.json": options.ownership ?? minimalOwnership(), ...(options.files ?? {}) },
    config: options.config,
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  return { ...project, ctx, logger, run: (argv) => runOwnership(argv, ctx) };
}

function jsonReport(logger) {
  return logger.lines.json.at(-1);
}

test("resolveOwner: longest prefix wins, ignored prefixes and root files are handled", () => {
  const ownership = minimalOwnership({
    rules: [
      { prefix: "src/", role: "DEV", note: "product" },
      { prefix: "src/test/batch-qa/", role: "QA", note: "acceptance" },
      { prefix: "docs/", role: "LEAD", note: "docs" },
    ],
  });
  assert.equal(resolveOwner(ownership, "src/main.ts").role, "DEV");
  assert.equal(resolveOwner(ownership, "src/test/batch-qa/e2e/x.ts").role, "QA");
  assert.equal(resolveOwner(ownership, "src/main.ts").rule, "src/");
  assert.equal(resolveOwner(ownership, "artifacts/evidence/a.json").ignored, true);
  assert.equal(resolveOwner(ownership, "package.json").role, "LEAD");
  assert.equal(resolveOwner(ownership, "package.json").rule, "rootFiles");
  const unmapped = resolveOwner(ownership, "other/file.txt");
  assert.equal(unmapped.role, undefined);
  assert.equal(unmapped.rule, "unmapped");
  assert.equal(resolveOwner(ownership, "src\\win\\path.ts").role, "DEV", "backslashes are normalised");
});

test("checkFiles reports violations, ignored and unmapped files", () => {
  const ownership = minimalOwnership();
  const result = checkFiles(ownership, ["src/a.ts", "tests/a.test.ts", "artifacts/x.json", "loose.txt"], "DEV");
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, "tests/a.test.ts");
  assert.equal(result.violations[0].owner, "QA");
  assert.deepEqual(result.ignored, ["artifacts/x.json"]);
  assert.deepEqual(result.unmapped, ["loose.txt"]);
});

test("ownership map prints the owning role and exit codes", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["map", "src/app.ts"]), 0);
  assert.match(logger.text(), /src\/app\.ts -> DEV \[src\/\]/);

  logger.lines.out.length = 0;
  assert.equal(await run(["map", "artifacts/x.json"]), 0, "ignored paths are not a failure");
  assert.match(logger.text(), /\(ignored\)/);

  logger.lines.out.length = 0;
  assert.equal(await run(["map", "unknown/file.txt"]), 1, "unmapped paths exit 1");
  assert.match(logger.text(), /\(unmapped\)/);
});

test("ownership check fails on a role violation and passes in scope", async (t) => {
  const { run, logger } = await setup(t);
  const code = await run(["check", "--role", "DEV", "--files", "src/a.ts,tests/a.test.ts", "--json"]);
  assert.equal(code, 1);
  const report = jsonReport(logger);
  assert.equal(report.ok, false);
  assert.equal(report.checked, 2);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].owner, "QA");

  logger.lines.json.length = 0;
  assert.equal(await run(["check", "--role", "DEV", "--files", "src/a.ts,src/b/c.ts", "--json"]), 0);
  assert.equal(jsonReport(logger).ok, true);
});

test("ownership check treats unmapped files as a hint, not a failure", async (t) => {
  const { run, logger } = await setup(t);
  const code = await run(["check", "--role", "DEV", "--files", "src/a.ts,notes/todo.txt"]);
  assert.equal(code, 0);
  assert.match(logger.text(), /PASS/);
  assert.match(logger.errorText(), /unmapped path/);
});

test("ownership check uses git in ctx.root for the changed file list", async (t) => {
  const { ctx, run, logger } = await setup(t, { files: { "src/feature.ts": "export const x = 1;\n" } });
  const init = await runCommand({ command: "git", args: ["init", "--quiet"], cwd: ctx.root });
  if (init.code !== 0) {
    t.skip("git is not available");
    return;
  }
  const code = await run(["check", "--role", "DEV", "--json"]);
  assert.equal(code, 0);
  const report = jsonReport(logger);
  assert.ok(report.checked >= 1, "untracked src/feature.ts must be seen by the git-based check");
  assert.deepEqual(report.violations, []);
});

test("verify-config accepts a clean mapping and reports conflicts", () => {
  const clean = verifyOwnershipConfig(minimalOwnership());
  assert.equal(clean.ok, true);
  assert.equal(clean.rules, 3);

  const conflicting = minimalOwnership({
    rules: [
      { prefix: "src/", role: "DEV" },
      { prefix: "src/", role: "QA" },
      { prefix: "docs/", role: "LEAD" },
    ],
  });
  const conflict = verifyOwnershipConfig(conflicting);
  assert.equal(conflict.ok, false);
  assert.ok(conflict.problems.some((problem) => problem.includes("claimed by both")));

  const uncovered = verifyOwnershipConfig(
    minimalOwnership({ rules: [{ prefix: "src/", role: "DEV" }], rootFiles: { role: "LEAD", names: ["package.json"] } }),
  );
  assert.equal(uncovered.ok, false);
  assert.ok(uncovered.problems.some((problem) => problem.includes("QA has no write scope")));
});

test("verify-config command returns 1 on a violation and 0 on a clean config", async (t) => {
  const clean = await setup(t);
  assert.equal(await clean.run(["verify-config"]), 0);
  assert.equal(jsonReport(clean.logger).ok, true);

  const bad = await setup(t, {
    ownership: minimalOwnership({ rules: [{ prefix: "src/", role: "DEV" }, { prefix: "src/", role: "QA" }] }),
  });
  assert.equal(await bad.run(["verify-config"]), 1);
  assert.equal(jsonReport(bad.logger).ok, false);
});

test("ownership without a sub-command prints usage and exits 2", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run([]), 2);
  assert.match(logger.text(), /Usage: atk ownership/);
  logger.lines.out.length = 0;
  assert.equal(await run(["help"]), 2);
  assert.match(logger.text(), /verify-config/);
});

test("ownership map runs through the CLI dispatcher", async (t) => {
  const { root } = await setup(t);
  const logger = memoryLogger();
  assert.equal(await runCli(["ownership", "map", "src/app.ts", "--cwd", root], { logger }), 0);
  assert.match(logger.text(), /src\/app\.ts -> DEV/);
});

test("ownership fails cleanly when the ownership file is missing", async (t) => {
  const project = await createProject({});
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  assert.equal(await runOwnership(["map", "src/a.ts"], ctx), 2);
  assert.match(logger.errorText(), /cannot read/);
});
