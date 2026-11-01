import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { runCli } from "../lib/dispatch.mjs";
import { computeManifestSha, run as runBatch } from "../lib/batch.mjs";
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
      "src/keep.ts": "export const keep = 1;\n",
      "flow/runtime.json": {
        schemaVersion: 3,
        updatedAt: "2026-01-01T00:00:00+00:00",
        agents: AGENTS,
        events: [],
      },
    },
  });
  const candidateRoot = await mkdtemp(path.join(os.tmpdir(), "atk-candidate-"));
  await writeText(path.join(candidateRoot, "src", "app.ts"), CANDIDATE_APP);
  await writeText(path.join(candidateRoot, "src", "new.ts"), "export const created = true;\n");
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  t.after(() => rm(candidateRoot, { recursive: true, force: true }));
  const manifestPath = path.join(project.root, "artifacts", "agent-flow", "BATCH-01-manifest.json");
  return {
    ...project,
    ctx,
    logger,
    candidateRoot,
    manifestPath,
    evidenceDir: path.join(project.root, "artifacts", "evidence"),
    run: (argv) => runBatch(argv, ctx),
  };
}

async function freeze(env, extra = []) {
  const code = await env.run([
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
  return code;
}

async function readManifest(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Build a signed qa-approval receipt (lib/evidence.mjs `QA_APPROVAL_SCHEMA`).
 * A bare `passed: true` is no longer a QA fact; tests must issue the real shape.
 */
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

async function receiptNames(dir) {
  return readdir(dir).catch(() => []);
}

test("batch manifest freezes hashes in the legacy-compatible format and copies to evidence", async (t) => {
  const env = await setup(t);
  assert.equal(await freeze(env), 0);
  assert.match(env.logger.text(), /manifest: .*batch=BATCH-01.*files 2/);

  const manifest = await readManifest(env.manifestPath);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.batchId, "BATCH-01");
  assert.equal(manifest.manifestTag, "demo-manifest-v1");
  assert.deepEqual(manifest.packages, ["PKG-01"]);
  assert.equal(manifest.originalRoot, env.root);
  assert.equal(manifest.candidateRoot, env.candidateRoot);
  assert.match(manifest.manifestSha256, /^[0-9A-F]{64}$/);
  assert.equal(manifest.manifestSha256, computeManifestSha(manifest, "demo-manifest-v1"));

  const app = manifest.files.find((file) => file.path === "src/app.ts");
  const created = manifest.files.find((file) => file.path === "src/new.ts");
  assert.equal(app.kind, "modify");
  assert.match(app.sourceSha256, /^[0-9A-F]{64}$/);
  assert.equal(app.sha256, app.sourceSha256, "brief-compatible sha256 alias is kept");
  assert.ok(app.size > 0);
  assert.match(app.expectedOriginalSha256, /^[0-9A-F]{64}$/);
  assert.equal(created.kind, "create");
  assert.equal(created.expectedOriginalSha256, undefined);

  const copies = await receiptNames(path.join(env.evidenceDir, "BATCH-01"));
  assert.ok(copies.some((name) => name.startsWith("manifest-")), "manifest is copied into the evidence dir");
});

test("batch verify without --qa is a diagnostic SKIPPED run and fails after candidate tampering", async (t) => {
  const env = await setup(t);
  await freeze(env);
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 0);
  // Diagnostic mode must never read as an approval (spec 1.2 / 10.1).
  assert.match(env.logger.text(), /SKIPPED BATCH-01/);
  assert.doesNotMatch(env.logger.text(), /PASS/);

  const names = await receiptNames(path.join(env.evidenceDir, "BATCH-01"));
  assert.ok(names.some((name) => name.startsWith("verify-")), "verify writes a receipt");

  await writeText(path.join(env.candidateRoot, "src", "app.ts"), "export const app = 999;\n");
  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 1);
  assert.match(env.logger.text(), /SKIPPED BATCH-01/);
  assert.doesNotMatch(env.logger.text(), /PASS/);
  assert.match(env.logger.text(), /candidate:src\/app\.ts/);

  await writeText(path.join(env.candidateRoot, "src", "app.ts"), CANDIDATE_APP);
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 0);
});

test("batch verify reports original-tree drift", async (t) => {
  const env = await setup(t);
  await freeze(env);
  await writeText(path.join(env.root, "src", "app.ts"), "export const app = 42;\n");
  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 1);
  assert.match(env.logger.text(), /drift:src\/app\.ts/);
  await writeText(path.join(env.root, "src", "app.ts"), ORIGINAL_APP);
});

test("batch verify binds a signed qa-approval.json to the manifest sha", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  assert.equal(manifest.run.agent, "agent-dev-01", "the manifest records the producing Agent Instance");
  assert.equal(manifest.run.role, "DEV");
  assert.equal(manifest.run.function, "WORKER");
  const qaPath = path.join(env.root, "qa-approval.json");
  const approval = qaApproval(manifest);

  await writeJson(qaPath, approval);
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 0);
  assert.match(env.logger.text(), /PASS BATCH-01/);

  await writeJson(qaPath, { ...approval, manifestSha256: "0".repeat(64) });
  env.logger.lines.err.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.errorText(), /manifest-sha-mismatch/);

  await writeJson(qaPath, { ...approval, noninteractiveQA: "passed", originalApplied: true });
  env.logger.lines.err.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1, "a used approval cannot be replayed");
});

test("batch verify refuses a reviewer that produced the manifest", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");

  await writeJson(
    qaPath,
    qaApproval(manifest, { reviewer: { run: "run-dev-01", agent: "agent-dev-01", role: "DEV", function: "WORKER" } }),
  );
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.text(), /self-review/);

  // A self-review is refused even when the approval claims a REVIEWER Function:
  // the instance's registered capabilities decide what it may do.
  await writeJson(
    qaPath,
    qaApproval(manifest, { reviewer: { run: "run-dev-01", agent: "agent-dev-01", role: "DEV", function: "REVIEWER" } }),
  );
  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.text(), /self-review/);
});

test("batch verify refuses a reviewer listed as a contributor", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01", "--contributors", "agent-qa-01"]);
  const manifest = await readManifest(env.manifestPath);
  assert.deepEqual(manifest.run.contributors, ["agent-qa-01"]);
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, qaApproval(manifest));
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.text(), /self-review/);
  assert.match(env.logger.text(), /contributor/);
});

test("batch verify refuses a review without identities", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");

  const anonymous = qaApproval(manifest);
  delete anonymous.reviewer;
  await writeJson(qaPath, anonymous);
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.text(), /missing-reviewer/);

  await writeJson(qaPath, qaApproval(manifest, { reviewer: { run: "run-ghost", agent: "agent-ghost-01" } }));
  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.text(), /reviewer-registered/);
});

test("batch verify refuses a manifest with no producing run once a reviewer is claimed", async (t) => {
  const env = await setup(t);
  await freeze(env);
  const manifest = await readManifest(env.manifestPath);
  assert.equal(manifest.run, undefined, "no --agent means no producing run");
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, qaApproval(manifest));
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.text(), /producer-identity/);
  assert.match(env.logger.errorText(), /no --agent given/);
});

test("batch manifest records --agent and validates the Agent Instance", async (t) => {
  const env = await setup(t);
  const argv = (agent, extra = []) => [
    "manifest",
    "--candidate",
    env.candidateRoot,
    "--paths",
    "src/app.ts",
    "--batch",
    "BATCH-02",
    "--agent",
    agent,
    ...extra,
  ];

  assert.equal(await env.run(argv("agent-ghost-01")), 2);
  assert.match(env.logger.errorText(), /unknown Agent Instance/);

  assert.equal(await env.run(argv("agent-qa-01")), 2);
  assert.match(env.logger.errorText(), /cannot perform WORKER/);

  assert.equal(await env.run(argv("agent-dev-01", ["--run", "run-fixed"])), 0);
  const manifest = await readManifest(path.join(env.root, "artifacts", "agent-flow", "BATCH-02-manifest.json"));
  assert.equal(manifest.run.id, "run-fixed");
  assert.equal(manifest.run.agent, "agent-dev-01");
  assert.equal(manifest.run.role, "DEV");
  assert.equal(manifest.run.function, "WORKER");
});

test("functions.enforceNoSelfReview=false keeps identity-less approvals working only through the legacy escape hatch", async (t) => {
  const env = await setup(t, { functions: { enforceNoSelfReview: false } });
  await freeze(env);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, { passed: true, manifestSha256: manifest.manifestSha256, originalApplied: false });

  // Even with identity checks switched off, a bare passed:true is not a QA fact
  // unless the operator explicitly opts into legacy receipts.
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);
  assert.match(env.logger.errorText(), /legacy-receipt/);

  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath, "--legacy-receipts"]), 0);
  assert.match(env.logger.text(), /PASS BATCH-01/);
});

test("batch verify accepts a legacy manifest without the extra convenience fields", async (t) => {
  const env = await setup(t);
  await freeze(env);
  const manifest = await readManifest(env.manifestPath);
  const legacy = {
    schemaVersion: 1,
    batchId: manifest.batchId,
    packages: manifest.packages,
    createdAt: manifest.createdAt,
    candidateRoot: manifest.candidateRoot,
    originalRoot: manifest.originalRoot,
    files: manifest.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      sourceSha256: file.sourceSha256,
      expectedOriginalSha256: file.expectedOriginalSha256,
    })),
    manifestSha256: undefined,
  };
  legacy.manifestSha256 = computeManifestSha(legacy, "demo-manifest-v1");
  assert.equal(legacy.manifestSha256, manifest.manifestSha256);
  const legacyPath = path.join(env.root, "legacy-manifest.json");
  await writeJson(legacyPath, legacy);
  assert.equal(await env.run(["verify", "--manifest", legacyPath]), 0);
});

test("batch apply defaults to dry-run and never writes the original tree", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, qaApproval(manifest));

  // Controlled integration: the dry-run itself needs a valid QA receipt.
  env.logger.lines.json.length = 0;
  assert.equal(await env.run(["apply", "--manifest", env.manifestPath]), 1);
  const refused = env.logger.lines.json.at(-1);
  assert.equal(refused.status, "FAIL");
  assert.equal(refused.dryRun, true);
  assert.ok(refused.rejected.some((entry) => entry.reason === "missing-qa-approval"));
  assert.match(env.logger.errorText(), /missing-qa-approval/);

  assert.equal(await env.run(["apply", "--manifest", env.manifestPath, "--qa", qaPath]), 0);
  const plan = env.logger.lines.json.at(-1);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.verify, true);
  assert.equal(plan.status, "PASS");
  assert.deepEqual(plan.rejected, []);
  assert.deepEqual(plan.modifies, ["src/app.ts"]);
  assert.deepEqual(plan.creates, ["src/new.ts"]);
  assert.match(env.logger.errorText(), /dry-run/);

  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), ORIGINAL_APP);
  const newFile = path.join(env.root, "src", "new.ts");
  await assert.rejects(stat(newFile), /ENOENT/, "dry-run must not create candidate files");
  const names = await receiptNames(path.join(env.evidenceDir, "BATCH-01"));
  assert.ok(names.some((name) => name.startsWith("apply-plan-")));
});

test("batch apply refuses without confirmation, and exit 3 on original-tree drift", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, qaApproval(manifest));
  assert.equal(await env.run(["apply", "--manifest", env.manifestPath, "--apply"]), 2);

  await writeText(path.join(env.root, "src", "app.ts"), "export const app = 123;\n");
  assert.equal(
    await env.run(["apply", "--manifest", env.manifestPath, "--qa", qaPath, "--apply", "--confirm-dev-closed"]),
    3,
    "drift is a concurrency refusal (exit 3)",
  );
  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), "export const app = 123;\n");
});

test("batch apply with confirmation writes the tree, backs up, and records receipts", async (t) => {
  const env = await setup(t);
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  await writeJson(qaPath, qaApproval(manifest));
  const backupDir = path.join(env.root, "artifacts", "test-backup");

  // Controlled integration: a real write needs a valid QA receipt first.
  env.logger.lines.err.length = 0;
  assert.equal(
    await env.run(["apply", "--manifest", env.manifestPath, "--apply", "--confirm-dev-closed", "--backup", backupDir]),
    1,
    "a write without QA evidence is refused",
  );
  assert.match(env.logger.errorText(), /missing-qa-approval/);

  assert.equal(
    await env.run(["apply", "--manifest", env.manifestPath, "--qa", qaPath, "--apply", "--confirm-dev-closed", "--backup", backupDir]),
    0,
  );
  const payload = env.logger.lines.json.at(-1);
  assert.equal(payload.originalApplied, true);
  assert.match(payload.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.mismatches.length, 0);

  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), CANDIDATE_APP);
  assert.equal(await readFile(path.join(env.root, "src", "new.ts"), "utf8"), "export const created = true;\n");
  assert.equal(await readFile(path.join(backupDir, "src", "app.ts"), "utf8"), ORIGINAL_APP);

  const names = await receiptNames(path.join(env.evidenceDir, "BATCH-01"));
  assert.ok(names.some((name) => name.startsWith("apply-2")), "apply receipt is durable");
  assert.ok(names.some((name) => name.startsWith("post-apply-verify-")));

  const audit = await readFile(path.join(env.root, "artifacts", "agent-flow", "permission-audit.jsonl"), "utf8");
  assert.match(audit, /integration\.merge\.development/);
});

test("integration permission requires a green gate report when quick/local gates are configured", async (t) => {
  const env = await setup(t, { gates: { quick: { command: ["node", "--version"] } } });
  await freeze(env, ["--agent", "agent-dev-01"]);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");
  // The receipt declares its gates PASS; the integration permission still reads
  // the real gate report, because a self-declared gate is not a gate run.
  await writeJson(qaPath, qaApproval(manifest, { gates: [{ name: "quick", status: "PASS" }] }));
  const apply = (extra = []) => env.run(["apply", "--manifest", env.manifestPath, "--qa", qaPath, "--apply", "--confirm-dev-closed", ...extra]);

  env.logger.lines.err.length = 0;
  assert.equal(await apply(), 1, "no gate report means no integration");
  assert.match(env.logger.errorText(), /ATTRIBUTE_MISSING|GATE_NOT_GREEN/);

  // Q-03: only an explicit five-value PASS report satisfies the integration
  // gate; a legacy `{ ok: true }` report without `status` must not integrate.
  await writeJson(path.join(env.root, "artifacts", "agent-flow", "ci-fast-latest.json"), {
    schemaVersion: 1,
    status: "PASS",
    ok: true,
    finishedAt: "2026-01-01T00:00:00+00:00",
  });
  env.logger.lines.err.length = 0;
  assert.equal(await apply(), 0);
});

test("batch manifest enforces allowed prefixes, traversal and absolute paths", async (t) => {
  const env = await setup(t);
  assert.equal(await env.run(["manifest", "--candidate", env.candidateRoot, "--paths", "secret/x.ts"]), 2);
  assert.match(env.logger.errorText(), /outside batch.allowedPrefixes/);
  assert.equal(await env.run(["manifest", "--candidate", env.candidateRoot, "--paths", "../escape.ts"]), 2);
  assert.match(env.logger.errorText(), /outside the project/);
  assert.equal(
    await env.run(["manifest", "--candidate", env.candidateRoot, "--paths", "D:/absolute/file.ts"]),
    2,
  );
  assert.match(env.logger.errorText(), /absolute path/);
});

test("batch manifest refuses root files unless batch.allowRootFiles is on", async (t) => {
  const env = await setup(t);
  await writeText(path.join(env.candidateRoot, "package.json"), '{"name":"demo"}\n');
  const rootArgs = (target) => ["manifest", "--candidate", target.candidateRoot, "--paths", "package.json", "--batch", "ROOT-01"];

  assert.equal(await env.run(rootArgs(env)), 2);
  assert.match(env.logger.errorText(), /outside batch\.allowedPrefixes/);

  const enabled = await setup(t, { batch: { allowedPrefixes: ["src", "docs"], manifestTag: "demo-manifest-v1", allowRootFiles: true } });
  await writeText(path.join(enabled.candidateRoot, "package.json"), '{"name":"demo"}\n');
  assert.equal(await enabled.run(rootArgs(enabled)), 0);
  const manifest = await readManifest(path.join(enabled.root, "artifacts", "agent-flow", "ROOT-01-manifest.json"));
  assert.deepEqual(manifest.paths, ["package.json"]);
  assert.equal(manifest.files[0].kind, "create");
});

test("batch manifest runs through the CLI dispatcher", async (t) => {
  const env = await setup(t);
  const logger = memoryLogger();
  const code = await runCli(
    ["batch", "manifest", "--candidate", env.candidateRoot, "--paths", "src/app.ts", "--batch", "CLI-01", "--cwd", env.root],
    { logger },
  );
  assert.equal(code, 0);
  assert.match(logger.text(), /batch=CLI-01/);
  const manifest = await readManifest(path.join(env.root, "artifacts", "agent-flow", "CLI-01-manifest.json"));
  assert.equal(manifest.files.length, 1);
});

test("batch without a sub-command prints usage and exits 2", async (t) => {
  const env = await setup(t);
  assert.equal(await env.run([]), 2);
  assert.match(env.logger.text(), /Usage: atk batch/);
  assert.equal(await env.run(["nope"]), 2);
});
