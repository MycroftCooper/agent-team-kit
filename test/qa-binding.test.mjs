// ATK-004: controlled integration (`batch verify --require-qa`, every
// `batch apply`) refuses without a structurally valid QA receipt; the read-only
// diagnostic path keeps working but reports SKIPPED and never prints PASS.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { runCli } from "../lib/dispatch.mjs";
import { run as runBatch } from "../lib/batch.mjs";
import { checkPermission } from "../lib/permissions.mjs";
import { writeJson, writeText } from "../lib/util.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

const ORIGINAL_APP = "export const app = 1;\n";
const CANDIDATE_APP = "export const app = 2;\n";

const AGENTS = [
  { id: "agent-lead-01", role: "LEAD", capabilities: ["ORCHESTRATOR"], status: "working", task: "BATCH-01", detail: "", since: "2026-01-01T00:00:00+00:00" },
  { id: "agent-dev-01", role: "DEV", capabilities: ["WORKER"], status: "working", task: "BATCH-01", detail: "", since: "2026-01-01T00:00:00+00:00" },
  { id: "agent-qa-01", role: "QA", capabilities: ["REVIEWER"], status: "waiting", task: "", detail: "", since: "2026-01-01T00:00:00+00:00" },
];

async function setup(t, configOverride = {}) {
  const project = await createProject({
    config: {
      batch: { allowedPrefixes: ["src", "docs"], manifestTag: "demo-manifest-v1" },
      ...configOverride,
    },
    files: {
      "src/app.ts": ORIGINAL_APP,
      "flow/runtime.json": {
        schemaVersion: 3,
        updatedAt: "2026-01-01T00:00:00+00:00",
        agents: AGENTS,
        events: [],
      },
    },
  });
  const candidateRoot = await mkdtemp(path.join(os.tmpdir(), "atk-qa-candidate-"));
  await writeText(path.join(candidateRoot, "src", "app.ts"), CANDIDATE_APP);
  await writeText(path.join(candidateRoot, "src", "new.ts"), "export const created = true;\n");
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  t.after(() => rm(candidateRoot, { recursive: true, force: true }));
  return {
    ...project,
    ctx,
    logger,
    candidateRoot,
    manifestPath: path.join(project.root, "artifacts", "agent-flow", "BATCH-01-manifest.json"),
    evidenceDir: path.join(project.root, "artifacts", "evidence"),
    run: (argv) => runBatch(argv, ctx),
  };
}

async function freeze(env, extra = []) {
  return env.run([
    "manifest",
    "--candidate",
    env.candidateRoot,
    "--paths",
    "src/app.ts,src/new.ts",
    "--packages",
    "PKG-01",
    "--batch",
    "BATCH-01",
    ...extra,
  ]);
}

async function readManifest(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Signed qa-approval receipt (lib/evidence.mjs `QA_APPROVAL_SCHEMA`). */
function qaApproval(manifest, overrides = {}) {
  const base = {
    schemaVersion: 1,
    kind: "qa-approval",
    manifestSha256: manifest.manifestSha256,
    verdict: "PASS",
    reviewer: { run: "run-qa-01", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
    targetRunId: manifest.run?.id,
    gates: [{ name: "demo-local", status: "PASS", reportSha256: "A".repeat(64) }],
    originalApplied: false,
  };
  return { ...base, ...overrides, reviewer: { ...base.reviewer, ...(overrides.reviewer ?? {}) } };
}

async function receiptNames(env) {
  return readdir(path.join(env.evidenceDir, "BATCH-01")).catch(() => []);
}

async function latestVerifyReceipt(env) {
  const names = (await receiptNames(env)).filter((name) => name.startsWith("verify-")).sort();
  assert.ok(names.length > 0, "verify must write a receipt");
  return JSON.parse(await readFile(path.join(env.evidenceDir, "BATCH-01", names.at(-1)), "utf8"));
}

test("batch verify --qa with the signed approval returns PASS and records the status", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, qaApproval(manifest));

  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath, "--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.status, "PASS");
  assert.equal(report.ok, true);
  assert.equal(report.diagnosticOnly, false);
  assert.deepEqual(report.rejected, []);
  assert.ok(report.checks.some((check) => check.name === "qa-gate:demo-local" && check.ok));

  const receipt = await latestVerifyReceipt(env);
  assert.equal(receipt.kind, "verify");
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.diagnosticOnly, false);
  assert.deepEqual(receipt.rejected, []);
});

test("batch verify without --qa is a diagnostic SKIPPED run that never prints PASS", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);

  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.status, "SKIPPED");
  assert.equal(report.diagnosticOnly, true);
  assert.equal(report.ok, true);
  assert.deepEqual(report.rejected, []);

  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 0);
  assert.match(env.logger.text(), /SKIPPED BATCH-01/);
  assert.doesNotMatch(env.logger.text(), /PASS/);

  const receipt = await latestVerifyReceipt(env);
  assert.equal(receipt.status, "SKIPPED");
  assert.equal(receipt.diagnosticOnly, true);
});

test("batch verify --require-qa without --qa exits 1 with a readable missing-qa reason", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);

  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--require-qa", "--json"]), 1);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.status, "FAIL");
  assert.equal(report.diagnosticOnly, false);
  assert.equal(report.ok, false);
  assert.equal(report.rejected[0].reason, "missing-qa-approval");
  assert.match(env.logger.errorText(), /missing-qa-approval/);
});

test("legacy passed:true receipts are refused by default and accepted only through the escape hatch", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  const legacy = {
    passed: true,
    manifestSha256: manifest.manifestSha256,
    originalApplied: false,
    reviewer: { run: "run-qa-01", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
  };
  await writeJson(qaPath, legacy);

  env.logger.lines.err.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.errorText(), /legacy-receipt/);
  assert.match(env.logger.errorText(), /missing kind:qa-approval/);

  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath, "--legacy-receipts"]), 0);
  assert.match(env.logger.text(), /PASS BATCH-01/);

  const configured = await setup(t, { batch: { allowedPrefixes: ["src", "docs"], manifestTag: "demo-manifest-v1", legacyReceipts: true } });
  await freeze(configured, ["--agent", "agent-dev-01"]);
  const configuredManifest = await readManifest(configured.manifestPath);
  const configuredQa = path.join(configured.root, "qa-approval.json");
  await writeJson(configuredQa, {
    passed: true,
    manifestSha256: configuredManifest.manifestSha256,
    originalApplied: false,
    reviewer: { run: "run-qa-01", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
  });
  assert.equal(await configured.run(["verify", "--manifest", configured.manifestPath, "--qa", configuredQa]), 0);
  assert.match(configured.logger.text(), /PASS BATCH-01/);
});

test("controlled verify (--require-qa) treats an empty gate list as missing evidence", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");

  await writeJson(qaPath, qaApproval(manifest, { gates: [] }));
  // Plain verify accepts a declared-nothing receipt...
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 0);
  // ...controlled integration does not: no gate evidence, no integration.
  env.logger.lines.err.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath, "--require-qa"]), 1);
  assert.match(env.logger.errorText(), /missing-gates/);

  await writeJson(qaPath, qaApproval(manifest, { gates: [{ name: "quick", status: "PASS" }] }));
  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath, "--require-qa"]), 0);
  assert.match(env.logger.text(), /PASS BATCH-01/);
});

test("a signed receipt bound to the wrong run or hash is refused", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");

  await writeJson(qaPath, qaApproval(manifest, { targetRunId: "run-someone-else" }));
  env.logger.lines.err.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.errorText(), /target-run-mismatch/);

  await writeJson(qaPath, qaApproval(manifest, { manifestSha256: "0".repeat(64) }));
  env.logger.lines.err.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.errorText(), /manifest-sha-mismatch/);

  await writeJson(qaPath, qaApproval(manifest, { verdict: "FAIL" }));
  env.logger.lines.err.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.errorText(), /verdict-not-pass/);
});

test("batch apply dry-run without QA exits 1, prints status and reason, and writes nothing", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);

  assert.equal(await env.run(["apply", "--manifest", env.manifestPath]), 1);
  const plan = env.logger.lines.json.at(-1);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.status, "FAIL");
  assert.equal(plan.verify, false);
  assert.ok(plan.rejected.some((entry) => entry.reason === "missing-qa-approval"));
  assert.match(env.logger.errorText(), /missing-qa-approval/);

  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), ORIGINAL_APP);
  await assert.rejects(stat(path.join(env.root, "src", "new.ts")), /ENOENT/);
  const names = await receiptNames(env);
  assert.ok(!names.some((name) => name.startsWith("apply-plan-")), "a refused dry-run writes no plan receipt");
});

test("batch apply --apply without QA exits 1 and never touches the tree", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);

  assert.equal(
    await env.run(["apply", "--manifest", env.manifestPath, "--apply", "--confirm-dev-closed"]),
    1,
    "controlled integration without a valid QA receipt is exit 1",
  );
  assert.match(env.logger.errorText(), /missing-qa-approval/);
  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), ORIGINAL_APP);
  await assert.rejects(stat(path.join(env.root, "src", "new.ts")), /ENOENT/);
});

test("batch apply dry-run with a signed approval plans and exits 0 without writing", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, qaApproval(manifest));

  assert.equal(await env.run(["apply", "--manifest", env.manifestPath, "--qa", qaPath]), 0);
  const plan = env.logger.lines.json.at(-1);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.status, "PASS");
  assert.equal(plan.verify, true);
  assert.deepEqual(plan.rejected, []);
  assert.match(env.logger.errorText(), /dry-run/);

  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), ORIGINAL_APP);
  await assert.rejects(stat(path.join(env.root, "src", "new.ts")), /ENOENT/);
});

test("permit check qa.result.submit accepts the signed receipt and denies a bare verdict", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, qaApproval(manifest));

  const signed = await runCli(
    [
      "permit",
      "check",
      "qa.result.submit",
      "--agent",
      "agent-qa-01",
      "--manifest",
      env.manifestPath,
      "--qa",
      qaPath,
      "--dry",
      "--json",
      "--cwd",
      env.root,
    ],
    { logger: memoryLogger() },
  );
  assert.equal(signed, 0, "a structurally valid approval is allowed");

  const signedLogger = memoryLogger();
  await runCli(
    [
      "permit",
      "check",
      "qa.result.submit",
      "--agent",
      "agent-qa-01",
      "--manifest",
      env.manifestPath,
      "--qa",
      qaPath,
      "--dry",
      "--json",
      "--cwd",
      env.root,
    ],
    { logger: signedLogger },
  );
  assert.equal(signedLogger.lines.json.at(-1).allowed, true);

  // A bare verdict with no reviewer, no hash: denied outright.
  const barePath = path.join(env.root, "qa-bare.json");
  await writeJson(barePath, { verdict: "PASS" });
  const bareLogger = memoryLogger();
  const bare = await runCli(
    [
      "permit",
      "check",
      "qa.result.submit",
      "--agent",
      "agent-qa-01",
      "--manifest",
      env.manifestPath,
      "--qa",
      barePath,
      "--dry",
      "--json",
      "--cwd",
      env.root,
    ],
    { logger: bareLogger },
  );
  assert.equal(bare, 1, "a bare verdict string is not evidence");
  assert.equal(bareLogger.lines.json.at(-1).allowed, false);

  // Binding alone is not a claim either: the verdict still needs the REVIEWER
  // structure, and the standalone `permit check` path enforces that itself.
  const nearMissPath = path.join(env.root, "qa-near-miss.json");
  await writeJson(nearMissPath, {
    verdict: "PASS",
    manifestSha256: manifest.manifestSha256,
    reviewer: { agent: "agent-qa-01", role: "QA" },
  });
  const nearMissLogger = memoryLogger();
  const nearMiss = await runCli(
    [
      "permit",
      "check",
      "qa.result.submit",
      "--agent",
      "agent-qa-01",
      "--manifest",
      env.manifestPath,
      "--qa",
      nearMissPath,
      "--dry",
      "--json",
      "--cwd",
      env.root,
    ],
    { logger: nearMissLogger },
  );
  assert.equal(nearMiss, 1);
  const nearMissDecision = nearMissLogger.lines.json.at(-1);
  assert.equal(nearMissDecision.reason, "REVIEW_EVIDENCE_INVALID");
  assert.match(nearMissDecision.detail, /well-formed PASS verdict/);

  // Same minimum bar when the permission layer is called directly: SYSTEM on
  // qa.result.submit has exactly the review-evidence condition.
  const ctx = await createContext({ cwd: env.root, logger: memoryLogger() });
  const bareButBound = await checkPermission(
    ctx,
    {
      operation: "qa.result.submit",
      subject: "SYSTEM",
      manifestObject: manifest,
      approvalObject: { verdict: "PASS", manifestSha256: manifest.manifestSha256 },
      qaPassed: true,
    },
    { audit: false },
  );
  assert.equal(bareButBound.allowed, false);
  assert.equal(bareButBound.reason, "REVIEW_EVIDENCE_INVALID");
  assert.match(bareButBound.detail, /well-formed PASS verdict/);
});
