// Strict-mode ownership tests: the fail-closed variant used by execution and
// integration gates. Loose mode must stay byte-compatible with the historical
// behaviour, so every strict assertion lives here and the existing
// test/ownership.test.mjs file is never edited.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { runCli } from "../lib/dispatch.mjs";
import { checkFiles, resolveCheckRole, resolveMode, run as runOwnership } from "../lib/ownership.mjs";
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

function resetLogger(logger) {
  logger.lines.out.length = 0;
  logger.lines.err.length = 0;
  logger.lines.json.length = 0;
}

/** Run without an inherited AGENT_ROLE and restore it afterwards. */
function clearRoleEnv(t) {
  const previous = process.env.AGENT_ROLE;
  delete process.env.AGENT_ROLE;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_ROLE;
    else process.env.AGENT_ROLE = previous;
  });
}

test("resolveMode defaults to loose and rejects unknown configured modes", () => {
  assert.equal(resolveMode({ config: {} }, {}), "loose");
  assert.equal(resolveMode({ config: { ownership: { mode: "strict" } } }, {}), "strict");
  assert.equal(resolveMode({ config: { ownership: { mode: "strict" } } }, { strict: false }), "loose");
  assert.equal(resolveMode({ config: {} }, { strict: true }), "strict");
  assert.throws(() => resolveMode({ config: { ownership: { mode: "paranoid" } } }, {}), /ownership\.mode/);
});

test("resolveCheckRole prefers --role over AGENT_ROLE", () => {
  assert.equal(resolveCheckRole({ role: "dev" }, { AGENT_ROLE: "qa" }), "DEV");
  assert.equal(resolveCheckRole({}, { AGENT_ROLE: "qa" }), "QA");
  assert.equal(resolveCheckRole({}, {}), null);
  assert.equal(resolveCheckRole({ role: true }, {}), null, "a bare --role flag is not a role");
});

test("checkFiles only treats unmapped paths as violations in strict mode", () => {
  const config = minimalOwnership();
  const loose = checkFiles(config, ["src/a.ts", "loose.txt"], "DEV");
  assert.deepEqual(loose.violations, []);
  assert.deepEqual(loose.unmapped, ["loose.txt"]);
  const strict = checkFiles(config, ["src/a.ts", "loose.txt"], "DEV", { strict: true });
  assert.deepEqual(strict.violations, [{ file: "loose.txt", owner: null, expected: "DEV", rule: "unmapped" }]);
  assert.deepEqual(strict.unmapped, ["loose.txt"]);
});

test("strict check without a role is a usage error (exit 2, not a violation)", async (t) => {
  clearRoleEnv(t);
  const { run, logger } = await setup(t);
  assert.equal(await run(["check", "--strict", "--files", "src/a.ts"]), 2);
  assert.match(logger.errorText(), /requires a role/);
  assert.match(logger.errorText(), /--role/);
  assert.match(logger.errorText(), /AGENT_ROLE/);
  assert.doesNotMatch(logger.text(), /PASS/, "a usage error must never print PASS");
  assert.equal(logger.lines.json.length, 0);
});

test("strict check rejects a role that ownership.json does not define (exit 2)", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["check", "--strict", "--role", "OPS", "--files", "src/a.ts"]), 2);
  assert.match(logger.errorText(), /role "OPS" is not a known role/);
  assert.match(logger.errorText(), /LEAD, DEV, QA/);
  assert.doesNotMatch(logger.text(), /PASS/);
});

test("strict check blocks unmapped paths and lists them as violations", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["check", "--strict", "--role", "DEV", "--files", "src/a.ts,notes/todo.txt", "--json"]), 1);
  const report = jsonReport(logger);
  assert.equal(report.status, "FAIL");
  assert.equal(report.mode, "strict");
  assert.equal(report.ok, false);
  assert.equal(report.role, "DEV");
  assert.equal(report.checked, 2);
  assert.deepEqual(report.unmapped, ["notes/todo.txt"]);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].file, "notes/todo.txt");
  assert.equal(report.violations[0].rule, "unmapped");
  assert.equal(report.violations[0].owner, null);

  resetLogger(logger);
  assert.equal(await run(["check", "--strict", "--role", "DEV", "--files", "src/a.ts,notes/todo.txt"]), 1);
  assert.match(logger.errorText(), /notes\/todo\.txt is not mapped to any role/);
  assert.match(logger.text(), /FAIL ownership check: 1 violation/);
});

test("strict check fails on cross-role writes", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["check", "--strict", "--role", "DEV", "--files", "src/a.ts,tests/a.test.ts", "--json"]), 1);
  const report = jsonReport(logger);
  assert.equal(report.status, "FAIL");
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].owner, "QA");
  assert.equal(report.violations[0].expected, "DEV");
});

test("strict check passes only when every file is inside the role's scope", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["check", "--strict", "--role", "DEV", "--files", "src/a.ts,src/b/c.ts", "--json"]), 0);
  const report = jsonReport(logger);
  assert.equal(report.status, "PASS");
  assert.equal(report.ok, true);
  assert.equal(report.mode, "strict");
  assert.equal(report.checked, 2);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.unmapped, []);

  resetLogger(logger);
  assert.equal(await run(["check", "--strict", "--role", "DEV", "--files", "src/a.ts,src/b/c.ts"]), 0);
  assert.match(logger.text(), /PASS ownership check \(DEV, strict\): 2 changed file\(s\) in scope/);
});

test("strict check with no files is SKIPPED, never PASS", async (t) => {
  const { run, logger } = await setup(t);
  // A throwaway project is not a git repository, so the changed-file list is empty.
  assert.equal(await run(["check", "--strict", "--role", "DEV", "--json"]), 0);
  const report = jsonReport(logger);
  assert.equal(report.status, "SKIPPED");
  assert.equal(report.ok, false, "SKIPPED must not satisfy a gate");
  assert.equal(report.checked, 0);
  assert.deepEqual(report.violations, []);

  resetLogger(logger);
  assert.equal(await run(["check", "--strict", "--role", "DEV"]), 0);
  assert.match(logger.text(), /SKIPPED ownership check/);
  assert.match(logger.text(), /no files to check/);
  assert.match(logger.text(), /not a pass/);
  assert.doesNotMatch(logger.text(), /PASS/);
});

test("loose check keeps unmapped paths non-blocking and the legacy report shape", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["check", "--files", "src/a.ts,tests/a.test.ts"]), 0, "a role-less loose check still passes");
  assert.match(logger.text(), /PASS ownership check: 2 changed file\(s\) in scope/);

  resetLogger(logger);
  assert.equal(await run(["check", "--role", "DEV", "--files", "src/a.ts,notes/todo.txt", "--json"]), 0);
  const report = jsonReport(logger);
  assert.equal(report.ok, true);
  assert.equal(report.role, "DEV");
  assert.equal(report.checked, 2);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.unmapped, ["notes/todo.txt"]);
  assert.equal("status" in report, false, "loose reports keep the legacy shape");
  assert.equal("mode" in report, false);

  assert.equal(await run(["check", "--role", "DEV", "--files", "src/a.ts,notes/todo.txt"]), 0);
  assert.match(logger.errorText(), /hint: 1 unmapped path\(s\) \(not blocking\)/);
});

test("ownership.mode=strict in the project config enforces the same rules as --strict", async (t) => {
  clearRoleEnv(t);
  const { run, logger } = await setup(t, { config: { ownership: { mode: "strict" } } });
  assert.equal(await run(["check", "--files", "src/a.ts"]), 2, "config strict also requires a role");
  assert.match(logger.errorText(), /requires a role/);

  resetLogger(logger);
  assert.equal(await run(["check", "--role", "DEV", "--files", "src/a.ts,tests/a.test.ts", "--json"]), 1);
  const report = jsonReport(logger);
  assert.equal(report.mode, "strict");
  assert.equal(report.status, "FAIL");
  assert.equal(report.violations[0].owner, "QA");
});

test("--strict overrides a configured loose mode", async (t) => {
  const { run, logger } = await setup(t, { config: { ownership: { mode: "loose" } } });
  assert.equal(await run(["check", "--strict", "--role", "DEV", "--files", "src/a.ts,notes/todo.txt", "--json"]), 1);
  assert.equal(jsonReport(logger).mode, "strict");
  assert.equal(jsonReport(logger).status, "FAIL");
});

test("strict check accepts AGENT_ROLE as the role source", async (t) => {
  const previous = process.env.AGENT_ROLE;
  process.env.AGENT_ROLE = "dev";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_ROLE;
    else process.env.AGENT_ROLE = previous;
  });
  const { run, logger } = await setup(t);
  assert.equal(await run(["check", "--strict", "--files", "src/a.ts", "--json"]), 0);
  const report = jsonReport(logger);
  assert.equal(report.role, "DEV");
  assert.equal(report.status, "PASS");
});

test("an unknown ownership.mode is a config error (exit 2)", async (t) => {
  // `loadConfig` rejects the value before the command runs: usage/config error.
  const project = await createProject({
    files: { "flow/ownership.json": minimalOwnership() },
    config: { ownership: { mode: "paranoid" } },
  });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  clearRoleEnv(t);
  const cliLogger = memoryLogger();
  const code = await runCli(
    ["ownership", "check", "--strict", "--role", "DEV", "--files", "src/a.ts", "--cwd", project.root],
    { logger: cliLogger },
  );
  assert.equal(code, 2);
  assert.match(cliLogger.errorText(), /ownership\.mode must be "loose" or "strict"/);
  assert.doesNotMatch(cliLogger.text(), /PASS/);

  // Even if a caller bypasses config validation, the check still fails closed.
  const { run, ctx, logger } = await setup(t);
  ctx.config.ownership = { mode: "paranoid" };
  assert.equal(await run(["check", "--role", "DEV", "--files", "src/a.ts", "--json"]), 2);
  assert.equal(jsonReport(logger).status, "ERROR");
});
