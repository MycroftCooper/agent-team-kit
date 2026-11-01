// ATK-003: the five-value gate status model (PASS / FAIL / SKIPPED /
// UNCONFIGURED / ERROR) and the delivery gate that accepts only an explicit PASS.
//
// Regression coverage for spec 1.2 "gate may exit 0 with no applicable steps or
// empty config" and spec 10.1 "only a real PASS satisfies a mandatory gate".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { gateReportVerdict as gateVerdict, run as runGate } from "../lib/gate.mjs";
import { evaluatePermission } from "../lib/permissions.mjs";
import { gateReportVerdict, run as runRelease } from "../lib/release.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

const ARTIFACT_DIR = "artifacts/gates";
const REPORT_REL = `${ARTIFACT_DIR}/ci-fast-latest.json`;

function baseConfig(gates) {
  return { layout: { flowDir: "flow", artifactDir: ARTIFACT_DIR }, gates };
}

async function setup(t, gates, files = {}) {
  const { root } = await createProject({ config: baseConfig(gates), files });
  t.after(() => rm(root, { recursive: true, force: true }));
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: root, logger });
  return { root, ctx, logger };
}

const reportPath = (root) => path.join(root, ARTIFACT_DIR, "ci-fast-latest.json");

async function readReport(root) {
  return JSON.parse(await readFile(reportPath(root), "utf8"));
}

async function writeGateReport(root, report) {
  await mkdir(path.dirname(reportPath(root)), { recursive: true });
  await writeFile(reportPath(root), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function lastJson(logger) {
  assert.ok(logger.lines.json.length > 0, "expected a JSON report on stdout");
  return logger.lines.json.at(-1);
}

const passingStep = (overrides = {}) => ({
  name: "lint",
  phase: "main",
  command: ["node", "-e", "process.exit(0)"],
  when: { group: "code" },
  ...overrides,
});

// --- fast gate: UNCONFIGURED -------------------------------------------------

test("gate fast with gates.fast null is UNCONFIGURED and exits 2", async (t) => {
  const { root, ctx, logger } = await setup(t, { fast: null, quick: null, local: null });

  assert.equal(await runGate(["fast", "--files", "src/a.js"], ctx), 2);

  const report = await readReport(root);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "UNCONFIGURED");
  assert.equal(report.ok, false);
  assert.match(report.note, /not a pass/i);
  assert.equal(lastJson(logger).status, "UNCONFIGURED");
  assert.match(logger.errorText(), /UNCONFIGURED/);
  assert.match(logger.errorText(), /not a pass/i);
});

test("gate fast with empty gates.fast.steps is UNCONFIGURED and exits 2", async (t) => {
  const { root, ctx, logger } = await setup(t, {
    fast: { parallel: true, groups: { code: ["src/**/*.js"] }, steps: [] },
    quick: null,
    local: null,
  });

  assert.equal(await runGate(["fast", "--files", "src/a.js"], ctx), 2);

  const report = await readReport(root);
  assert.equal(report.status, "UNCONFIGURED");
  assert.equal(report.ok, false);
  assert.deepEqual(report.steps, []);
  assert.match(logger.errorText(), /UNCONFIGURED/);
});

// --- fast gate: SKIPPED ------------------------------------------------------

test("gate fast with no applicable step is SKIPPED, exits 0 and says it is not a pass", async (t) => {
  const { root, ctx, logger } = await setup(t, {
    fast: { parallel: true, groups: { code: ["src/**/*.js"] }, steps: [passingStep()] },
    quick: null,
    local: null,
  });

  assert.equal(await runGate(["fast", "--files", "docs/readme.md"], ctx), 0);

  const report = await readReport(root);
  assert.equal(report.status, "SKIPPED");
  assert.equal(report.ok, false);
  assert.deepEqual(report.steps, []);
  assert.match(report.note, /not a pass/i);
  assert.match(logger.errorText(), /SKIPPED/);
  assert.match(logger.errorText(), /not a pass/i);
  assert.equal(lastJson(logger).status, "SKIPPED");
});

test("a SKIPPED fast gate overwrites a stale PASS report", async (t) => {
  const { root, ctx } = await setup(t, {
    fast: { parallel: true, groups: { code: ["src/**/*.js"] }, steps: [passingStep({ when: { group: "code" } })] },
    quick: null,
    local: null,
  });
  await writeGateReport(root, { schemaVersion: 1, status: "PASS", ok: true });

  assert.equal(await runGate(["fast", "--files", "docs/readme.md"], ctx), 0);

  const report = await readReport(root);
  assert.equal(report.status, "SKIPPED");
  assert.equal(report.ok, false);
});

// --- fast gate: PASS / FAIL --------------------------------------------------

test("gate fast that really ran its steps is PASS with ok true", async (t) => {
  const { root, ctx, logger } = await setup(t, {
    fast: { parallel: true, groups: { code: ["src/**/*.js"] }, steps: [passingStep()] },
    quick: null,
    local: null,
  });

  assert.equal(await runGate(["fast", "--files", "src/a.js", "--role", "dev"], ctx), 0);

  const report = await readReport(root);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "PASS");
  assert.equal(report.ok, true);
  assert.equal(report.role, "DEV");
  assert.equal(report.scope.total, 1);
  assert.equal(typeof report.durationMs, "number");
  assert.match(report.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].status, "passed");
  assert.equal(report.steps[0].exitCode, 0);
  assert.equal(lastJson(logger).status, "PASS");
});

test("gate fast with a non-zero step is FAIL and exits 1", async (t) => {
  const { root, ctx, logger } = await setup(t, {
    fast: {
      parallel: true,
      groups: { code: ["src/**/*.js"] },
      steps: [passingStep({ name: "boom", command: ["node", "-e", "process.exit(3)"] })],
    },
    quick: null,
    local: null,
  });

  assert.equal(await runGate(["fast", "--files", "src/a.js"], ctx), 1);

  const report = await readReport(root);
  assert.equal(report.status, "FAIL");
  assert.equal(report.ok, false);
  assert.equal(report.steps[0].status, "failed");
  assert.equal(report.steps[0].exitCode, 3);
  assert.match(report.note, /FAIL is not a pass/i);
  assert.match(logger.errorText(), /FAIL/);
});

// --- fast gate: ERROR --------------------------------------------------------

test("gate fast with an executable that does not exist is ERROR and exits 2", async (t) => {
  const { root, ctx, logger } = await setup(t, {
    fast: {
      parallel: true,
      groups: {},
      steps: [
        {
          name: "missing-tool",
          phase: "main",
          command: ["atk-definitely-missing-command-xyz", "--version"],
          when: { changed: true },
        },
      ],
    },
    quick: null,
    local: null,
  });

  assert.equal(await runGate(["fast", "--files", "src/a.js"], ctx), 2);

  const report = await readReport(root);
  assert.equal(report.status, "ERROR");
  assert.equal(report.ok, false);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].status, "error");
  assert.equal(report.steps[0].exitCode, null);
  assert.match(report.steps[0].error, /could not be started|not found/i);
  assert.match(report.note, /ERROR is not a pass/i);
  assert.match(logger.errorText(), /ERROR/);
  assert.equal(lastJson(logger).status, "ERROR");
});

// --- quick / local: UNCONFIGURED and PASS/FAIL -------------------------------

test("gate quick/local with no configured command is UNCONFIGURED and exits 2", async (t) => {
  const quickProject = await setup(t, { fast: null, quick: null, local: null });
  assert.equal(await runGate(["quick"], quickProject.ctx), 2);
  const quickReport = await readReport(quickProject.root);
  assert.equal(quickReport.gate, "quick");
  assert.equal(quickReport.status, "UNCONFIGURED");
  assert.equal(quickReport.ok, false);

  const localProject = await setup(t, { fast: null, quick: null, local: null });
  assert.equal(await runGate(["local"], localProject.ctx), 2);
  const localReport = await readReport(localProject.root);
  assert.equal(localReport.gate, "local");
  assert.equal(localReport.status, "UNCONFIGURED");
  assert.equal(localReport.ok, false);
});

test("an unconfigured quick gate overwrites a stale PASS report instead of passing silently", async (t) => {
  const { root, ctx } = await setup(t, { fast: null, quick: null, local: null });
  await writeGateReport(root, { schemaVersion: 1, status: "PASS", ok: true });

  assert.equal(await runGate(["quick"], ctx), 2);

  const report = await readReport(root);
  assert.equal(report.gate, "quick");
  assert.equal(report.status, "UNCONFIGURED");
  assert.equal(report.ok, false);
});

test("gate quick reports PASS and FAIL in the published report", async (t) => {
  const passing = await setup(t, {
    fast: null,
    quick: { command: ["node", "-e", "process.exit(0)"] },
    local: null,
  });
  assert.equal(await runGate(["quick"], passing.ctx), 0);
  let report = await readReport(passing.root);
  assert.equal(report.status, "PASS");
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);

  const failing = await setup(t, {
    fast: null,
    quick: { command: ["node", "-e", "process.exit(1)"] },
    local: null,
  });
  assert.equal(await runGate(["quick"], failing.ctx), 1);
  report = await readReport(failing.root);
  assert.equal(report.status, "FAIL");
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
});

test("gate quick with a command that does not exist is ERROR and exits 2", async (t) => {
  const { root, ctx } = await setup(t, {
    fast: null,
    quick: { command: ["atk-definitely-missing-command-xyz"] },
    local: null,
  });
  assert.equal(await runGate(["quick"], ctx), 2);
  const report = await readReport(root);
  assert.equal(report.status, "ERROR");
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, null);
});

// --- --plan stays parseable and runs nothing ---------------------------------

test("gate fast --plan still prints the parseable plan and writes no report", async (t) => {
  const { root, ctx, logger } = await setup(t, {
    fast: { parallel: true, groups: { code: ["src/**/*.js"] }, steps: [passingStep()] },
    quick: null,
    local: null,
  });

  assert.equal(await runGate(["fast", "--files", "src/a.js", "--plan"], ctx), 0);

  const plan = lastJson(logger);
  assert.equal(plan.planOnly, true);
  assert.equal(plan.schemaVersion, 1);
  assert.deepEqual(
    plan.steps.map((step) => step.name),
    ["lint"],
  );
  await assert.rejects(stat(reportPath(root)));
});

// --- release: only an explicit PASS is green ---------------------------------

test("gateReportVerdict requires status PASS and a consistent ok flag", () => {
  assert.equal(gateReportVerdict, gateVerdict, "release must re-export the single lib/gate.mjs implementation");
  assert.deepEqual(gateReportVerdict({ status: "PASS", ok: true }), { ok: true, status: "PASS", reason: null });
  assert.equal(gateReportVerdict({ status: "PASS", ok: false }).ok, false);
  assert.match(gateReportVerdict({ status: "PASS", ok: false }).reason, /inconsistent/i);
  assert.match(gateReportVerdict({ ok: true }).reason, /no status field/i);
  assert.match(gateReportVerdict({ status: "SKIPPED", ok: false }).reason, /SKIPPED/);
  assert.match(gateReportVerdict({ status: "FAIL", ok: false }).reason, /FAIL/);
  assert.match(gateReportVerdict({ status: "UNCONFIGURED", ok: false }).reason, /UNCONFIGURED/);
  assert.match(gateReportVerdict({ status: "ERROR", ok: false }).reason, /ERROR/);
  assert.match(gateReportVerdict(null).reason, /not a readable object/i);
});

async function setupRepo(t, gates = { fast: null, quick: null, local: null }) {
  const { root } = await createProject({
    config: baseConfig(gates),
    files: {
      ".gitignore": "artifacts/\n",
      "package.json": `${JSON.stringify({ name: "gate-status-fixture", version: "0.2.0" }, null, 2)}\n`,
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "dev");
  git("config", "user.email", "gate-status@example.com");
  git("config", "user.name", "Gate Status Test");
  git("add", "-A");
  git("commit", "-m", "initial");
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: root, logger });
  return { root, ctx, logger };
}

test("release rejects every gate report whose status is not an explicit PASS", async (t) => {
  const { root, ctx, logger } = await setupRepo(t);

  const rejected = [
    { report: { schemaVersion: 1, gate: "fast", ok: true }, pattern: /no status field/i },
    { report: { schemaVersion: 1, status: "SKIPPED", ok: false }, pattern: /SKIPPED/ },
    { report: { schemaVersion: 1, status: "FAIL", ok: false }, pattern: /FAIL/ },
    { report: { schemaVersion: 1, status: "UNCONFIGURED", ok: false }, pattern: /UNCONFIGURED/ },
    { report: { schemaVersion: 1, status: "ERROR", ok: false }, pattern: /ERROR/ },
    { report: { schemaVersion: 1, status: "PASS", ok: false }, pattern: /inconsistent/i },
  ];
  for (const item of rejected) {
    await writeGateReport(root, item.report);
    logger.lines.err.length = 0;
    assert.equal(await runRelease(["--version", "0.2.0"], ctx), 1, JSON.stringify(item.report));
    assert.match(logger.errorText(), /not green/i, JSON.stringify(item.report));
    assert.match(logger.errorText(), item.pattern, JSON.stringify(item.report));
  }

  await writeGateReport(root, { schemaVersion: 1, gate: "fast", status: "PASS", ok: true });
  logger.lines.err.length = 0;
  assert.equal(await runRelease(["--version", "0.2.0"], ctx), 0);
});

test("a real PASS gate run is accepted by release end to end", async (t) => {
  const { root, ctx } = await setupRepo(t, {
    fast: { parallel: true, groups: { code: ["src/**/*.js"] }, steps: [passingStep()] },
    quick: null,
    local: null,
  });

  assert.equal(await runGate(["fast", "--files", "src/a.js"], ctx), 0);
  const report = await readReport(root);
  assert.deepEqual(gateReportVerdict(report), { ok: true, status: "PASS", reason: null });
  assert.equal(await runRelease(["--version", "0.2.0"], ctx), 0);
});

test("release and the permission gate-green reach the same verdict on every report", async (t) => {
  const { root, ctx } = await setupRepo(t, {
    fast: null,
    quick: { command: ["node", "-e", "process.exit(0)"] },
    local: null,
  });
  // One parameterised fixture set feeds both consumers: release (delivery gate)
  // and the permission layer's gate-green (batch apply integration gate). They
  // must never drift apart again (Q-03).
  const fixtures = [
    { report: { schemaVersion: 1, gate: "quick", ok: true }, green: false },
    { report: { schemaVersion: 1, status: "FAIL", ok: true }, green: false },
    { report: { schemaVersion: 1, status: "SKIPPED", ok: false }, green: false },
    { report: { schemaVersion: 1, status: "UNCONFIGURED", ok: false }, green: false },
    { report: { schemaVersion: 1, status: "ERROR", ok: false }, green: false },
    { report: { schemaVersion: 1, status: "PASS", ok: false }, green: false },
    { report: { schemaVersion: 1, status: "PASS", ok: true }, green: true },
  ];
  for (const item of fixtures) {
    await writeGateReport(root, item.report);
    const releaseCode = await runRelease(["--version", "0.2.0"], ctx);
    const decision = await evaluatePermission(ctx, {
      operation: "integration.merge.development",
      subject: "SYSTEM",
      qaPassed: true,
      noDrift: true,
    });
    assert.equal(releaseCode === 0, item.green, `release on ${JSON.stringify(item.report)}`);
    assert.equal(decision.allowed, item.green, `gate-green on ${JSON.stringify(item.report)}: ${decision.detail}`);
    assert.equal(
      releaseCode === 0,
      decision.allowed,
      `release and gate-green drifted on ${JSON.stringify(item.report)}`,
    );
  }
});
