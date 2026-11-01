// QA-001: independent adversarial battery for the M0 frozen commit a4b54b7.
//
// Every case here asserts a behaviour the 2.0 specification requires, not the
// behaviour the implementation happens to have:
//   - spec §1.2  P0 risks 1-4 (ownership strict, gate five-value model,
//     controlled QA integration, evidence must verify Run/Hash/target version)
//   - spec §10.1 only a real PASS satisfies a mandatory quality gate
//   - spec §10.2 no self-review, spec §16 DoD (regression coverage)
//
// Cases Q-01/Q-02/Q-03 were red on the frozen commit on purpose: they encode
// defects found by this review (see docs/architecture/qa-review-m0.md). They are
// green after the M0 fix and stay here as regression guards. They must never be
// weakened to match the implementation; fix the code if one turns red.
// All cases run in throwaway projects under the OS temp dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/dispatch.mjs";
import { GATE_STATUS, GATE_STATUS_EXIT_CODES } from "../lib/gate.mjs";
import { resolveCheckRole } from "../lib/ownership.mjs";
import { writeJson, writeText } from "../lib/util.mjs";
import { createProject, memoryLogger, minimalOwnership } from "./helpers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(REPO, "docs");
const ARTIFACTS = "artifacts/gates";
const REPORT_REL = `${ARTIFACTS}/ci-fast-latest.json`;

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Run the real CLI in `root`; returns the exit code, logger and last JSON. */
async function cli(root, argv) {
  const logger = memoryLogger();
  const code = await runCli([...argv, "--cwd", root], { logger });
  return { code, logger, report: logger.lines.json.at(-1) };
}

async function writeProject(t, options = {}) {
  const project = await createProject(options);
  t.after(() => rm(project.root, { recursive: true, force: true }));
  return project;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function initGitRepo(root, files = {}) {
  for (const [relative, content] of Object.entries(files)) {
    await writeText(path.join(root, relative), content);
  }
  git(root, "init", "-b", "dev");
  git(root, "config", "user.email", "qa-m0@example.com");
  git(root, "config", "user.name", "QA M0");
  git(root, "add", "-A");
  git(root, "commit", "-m", "fixture");
}

function readReport(root) {
  return readFile(path.join(root, REPORT_REL), "utf8").then((text) => JSON.parse(text));
}

const AGENTS = [
  { id: "agent-dev-01", role: "DEV", capabilities: ["WORKER"], status: "working", task: "BATCH-01", detail: "", since: "2026-01-01T00:00:00+00:00" },
  { id: "agent-qa-01", role: "QA", capabilities: ["REVIEWER"], status: "waiting", task: "", detail: "", since: "2026-01-01T00:00:00+00:00" },
];

function batchState() {
  return {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00+00:00",
    batch: {
      id: "BATCH-01",
      goal: "adversarial QA battery",
      stopCondition: "accepted",
      slices: [{ id: "S1", label: "one", status: "in_progress", qaPassed: null, applied: null, owner: "DEV", exit: "gates", evidence: "", note: "" }],
    },
    counts: { total: 0 },
    packages: [],
    subitems: [],
  };
}

/** Throwaway project + external candidate + a frozen manifest (the real CLI flow). */
async function batchFixture(t, configOverride = {}) {
  const project = await writeProject(t, {
    config: {
      layout: { flowDir: "flow", artifactDir: "artifacts/agent-flow", evidenceDir: "artifacts/evidence" },
      batch: { allowedPrefixes: ["src/"], allowRootFiles: false, manifestTag: "agent-flow-manifest-v1" },
      gates: { fast: null, quick: null, local: null },
      ...configOverride,
    },
    files: {
      "flow/runtime.json": { schemaVersion: 3, agents: AGENTS, events: [] },
      "flow/state.json": batchState(),
      "src/app.mjs": "export const app = 1;\n",
    },
  });
  const candidate = await mkdtemp(path.join(os.tmpdir(), "atk-qa-candidate-"));
  await writeText(path.join(candidate, "src", "app.mjs"), "export const app = 2;\n");
  t.after(() => rm(candidate, { recursive: true, force: true }));

  const frozen = await cli(project.root, [
    "batch", "manifest", "--candidate", candidate, "--paths", "src/app.mjs",
    "--batch", "BATCH-01", "--agent", "agent-dev-01", "--json",
  ]);
  assert.equal(frozen.code, 0, `manifest freeze failed: ${frozen.logger.errorText()}`);
  return {
    root: project.root,
    candidate,
    manifest: frozen.report,
    manifestPath: path.join(project.root, "artifacts", "agent-flow", "BATCH-01-manifest.json"),
    qaPath: path.join(project.root, "qa-approval.json"),
  };
}

function approvalFor(manifest, overrides = {}) {
  const base = {
    schemaVersion: 1,
    kind: "qa-approval",
    manifestSha256: manifest.manifestSha256,
    verdict: "PASS",
    reviewer: { run: "run-qa-01", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
    targetRunId: manifest.run?.id,
    gates: [{ name: "quick", status: "PASS" }],
    originalApplied: false,
  };
  return { ...base, ...overrides, reviewer: { ...base.reviewer, ...(overrides.reviewer ?? {}) } };
}

async function writeApproval(file, value) {
  await writeJson(file, value);
}

// ---------------------------------------------------------------------------
// A. ownership strict mode cannot be talked into a pass
// ---------------------------------------------------------------------------

test("A1: strict check rejects an absolute changed path instead of inventing an owner", async (t) => {
  const project = await writeProject(t, {
    files: { "flow/ownership.json": minimalOwnership() },
  });
  const absolute = path.join(project.root, "src", "a.ts");
  const { code, report } = await cli(project.root, ["ownership", "check", "--strict", "--role", "DEV", "--files", absolute, "--json"]);
  assert.equal(code, 1, "an absolute path cannot be attributed to a project-relative ownership prefix");
  assert.equal(report.status, "FAIL");
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((entry) => entry.rule === "unmapped"), JSON.stringify(report.violations));
});

test("A2: strict canonicalises dot-dot segments before matching ownership prefixes (Q-01 regression guard)", async (t) => {
  const project = await writeProject(t, {
    files: { "flow/ownership.json": minimalOwnership() },
  });
  // `src/../lib/x.ts` resolves to lib/x.ts, which minimalOwnership does not
  // assign to DEV. String-prefix matching must not let the actor pick "src/"
  // as a free pass for another role's file (spec §1.2 P0-1: a strict execution
  // gate must reject anything outside the role's scope).
  const { code, report } = await cli(project.root, [
    "ownership", "check", "--strict", "--role", "DEV", "--files", "src/../lib/x.ts", "--json",
  ]);
  assert.equal(code, 1, "a dot-dot path must not be attributed to the prefix before the ..");
  assert.equal(report.status, "FAIL");
  assert.equal(report.ok, false);
});

test("A3: strict check needs a real role - an empty AGENT_ROLE is missing, not a wildcard", async (t) => {
  const project = await writeProject(t, {
    files: { "flow/ownership.json": minimalOwnership() },
  });
  const previous = process.env.AGENT_ROLE;
  process.env.AGENT_ROLE = "";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_ROLE;
    else process.env.AGENT_ROLE = previous;
  });
  const { code, report, logger } = await cli(project.root, ["ownership", "check", "--strict", "--files", "src/a.ts", "--json"]);
  assert.equal(code, 2, "a missing role is a usage/config error, not a violation");
  assert.equal(report.status, "ERROR");
  assert.equal(report.ok, false);
  assert.doesNotMatch(logger.text(), /PASS/);
  assert.equal(resolveCheckRole({}, { AGENT_ROLE: "" }), null);
  assert.equal(resolveCheckRole({ role: "" }, { AGENT_ROLE: "DEV" }), null, "an explicit empty --role must not fall back to the env");
});

test("A5: strict unmapped-path report keeps exit code, status and ok consistent", async (t) => {
  const project = await writeProject(t, {
    files: { "flow/ownership.json": minimalOwnership() },
  });
  const { code, report } = await cli(project.root, [
    "ownership", "check", "--strict", "--role", "DEV", "--files", "src/a.ts,notes/todo.txt", "--json",
  ]);
  assert.equal(code, 1);
  assert.equal(report.status, "FAIL");
  assert.equal(report.ok, false);
  assert.deepEqual(report.unmapped, ["notes/todo.txt"]);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].file, "notes/todo.txt");
  assert.equal(report.violations[0].rule, "unmapped");
  assert.equal(report.violations[0].owner, null);
});

test("A6: an empty --files list is SKIPPED (never PASS) instead of silently passing", async (t) => {
  const project = await writeProject(t, {
    files: { "flow/ownership.json": minimalOwnership() },
  });
  // Not a git repository, so an absent/explicitly empty list means "nothing to check".
  const json = await cli(project.root, ["ownership", "check", "--strict", "--role", "DEV", "--files", ",", "--json"]);
  assert.equal(json.code, 0);
  assert.equal(json.report.status, "SKIPPED");
  assert.equal(json.report.ok, false, "SKIPPED must not satisfy a gate");
  const human = await cli(project.root, ["ownership", "check", "--strict", "--role", "DEV"]);
  assert.equal(human.code, 0);
  assert.match(human.logger.text(), /SKIPPED/);
  assert.match(human.logger.text(), /not a pass/i);
  assert.doesNotMatch(human.logger.text(), /PASS/);
});

// ---------------------------------------------------------------------------
// B. gate reports cannot be faked into a green delivery
// ---------------------------------------------------------------------------

test("B1: a failing fast gate overwrites a pre-existing PASS report", async (t) => {
  const project = await writeProject(t, {
    config: {
      layout: { flowDir: "flow", artifactDir: ARTIFACTS },
      gates: {
        fast: { parallel: true, groups: { code: ["src/**"] }, steps: [{ name: "boom", command: ["node", "-e", "process.exit(3)"], when: { group: "code" } }] },
        quick: null,
        local: null,
      },
    },
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  await writeJson(path.join(project.root, REPORT_REL), { schemaVersion: 1, status: "PASS", ok: true });
  const { code } = await cli(project.root, ["gate", "fast", "--files", "src/a.mjs", "--json"]);
  assert.equal(code, 1);
  const report = await readReport(project.root);
  assert.equal(report.status, "FAIL", "a stale PASS must never survive a non-passing run");
  assert.equal(report.ok, false);
});

test("B2: gate fast --plan writes no report and cannot refresh a green one", async (t) => {
  const project = await writeProject(t, {
    config: {
      layout: { flowDir: "flow", artifactDir: ARTIFACTS },
      gates: {
        fast: { parallel: true, groups: { code: ["src/**"] }, steps: [{ name: "lint", command: ["node", "-e", "process.exit(0)"], when: { group: "code" } }] },
        quick: null,
        local: null,
      },
    },
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const stale = { schemaVersion: 1, status: "FAIL", ok: false, note: "stale" };
  await writeJson(path.join(project.root, REPORT_REL), stale);
  const { code, report } = await cli(project.root, ["gate", "fast", "--files", "src/a.mjs", "--plan"]);
  assert.equal(code, 0);
  assert.equal(report.planOnly, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(project.root, REPORT_REL), "utf8")), stale, "--plan must not publish a report");
});

test("B3: release accepts only an explicit, self-consistent PASS report", async (t) => {
  const project = await writeProject(t, {
    config: {
      layout: { flowDir: "flow", artifactDir: ARTIFACTS },
      branch: { development: "dev", release: "main" },
      gates: { fast: null, quick: null, local: null },
    },
    files: {
      ".gitignore": "artifacts/\n",
      "package.json": `${JSON.stringify({ name: "qa-release-fixture", version: "0.2.0" }, null, 2)}\n`,
    },
  });
  await initGitRepo(project.root);
  const cases = [
    { report: { schemaVersion: 1, status: "PASS" }, pattern: /inconsistent|no status/i },
    { report: { schemaVersion: 1, status: "PASS", ok: false }, pattern: /inconsistent/i },
    { report: { schemaVersion: 1, status: "pass", ok: true }, pattern: /not PASS/i },
    { report: { schemaVersion: 1, ok: true }, pattern: /no status field/i },
    { report: { schemaVersion: 1, status: "SKIPPED", ok: false }, pattern: /SKIPPED/ },
  ];
  for (const item of cases) {
    await writeJson(path.join(project.root, REPORT_REL), item.report);
    const { code, logger } = await cli(project.root, ["release", "--version", "0.2.0"]);
    assert.equal(code, 1, `release must refuse ${JSON.stringify(item.report)}`);
    assert.match(logger.errorText(), /not green/i);
    assert.match(logger.errorText(), item.pattern, JSON.stringify(item.report));
  }
  await writeJson(path.join(project.root, REPORT_REL), { schemaVersion: 1, status: "PASS", ok: true });
  assert.equal((await cli(project.root, ["release", "--version", "0.2.0"])).code, 0);
});

test("B4: a parallel gate with a failing and an unrunnable step is never PASS", async (t) => {
  const project = await writeProject(t, {
    config: {
      layout: { flowDir: "flow", artifactDir: ARTIFACTS },
      gates: {
        fast: {
          parallel: true,
          groups: { code: ["src/**"] },
          steps: [
            { name: "fail-step", command: ["node", "-e", "process.exit(3)"], when: { group: "code" } },
            { name: "missing-step", command: ["atk-qa-definitely-missing-command"], when: { group: "code" } },
          ],
        },
        quick: null,
        local: null,
      },
    },
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const { code } = await cli(project.root, ["gate", "fast", "--files", "src/a.mjs", "--json"]);
  const report = await readReport(project.root);
  assert.notEqual(code, 0, "FAIL/ERROR must never exit 0");
  assert.notEqual(report.status, "PASS");
  assert.equal(report.ok, false);
  assert.ok(Number.isInteger(GATE_STATUS_EXIT_CODES[report.status]), `unknown status ${report.status}`);
  const byName = Object.fromEntries(report.steps.map((step) => [step.name, step]));
  assert.equal(byName["fail-step"].status, "failed");
  assert.equal(byName["missing-step"].status, "error");
  assert.equal(byName["missing-step"].exitCode, null);
});

test("B5: a dynamic role value is passed as one argv token, never re-read by the shell", async (t) => {
  const project = await writeProject(t, {
    config: {
      layout: { flowDir: "flow", artifactDir: ARTIFACTS },
      gates: {
        fast: {
          parallel: true,
          groups: { code: ["src/**"] },
          steps: [{ name: "role-step", command: ["node", "probe.mjs"], roleFlag: true, when: { group: "code" } }],
        },
        quick: null,
        local: null,
      },
    },
    files: { "src/a.mjs": "export const a = 1;\n", "probe.mjs": "process.exit(0);\n" },
  });
  // The role value is not trusted input for the shell; `& exit 7 &` must reach
  // node as one argument (a quoting failure would run `exit 7` instead).
  const { code } = await cli(project.root, ["gate", "fast", "--files", "src/a.mjs", "--role", "DEV & exit 7 &", "--json"]);
  assert.equal(code, 0, "shell metacharacters in a dynamic role must not execute");
  const report = await readReport(project.root);
  assert.equal(report.status, "PASS");
});

// ---------------------------------------------------------------------------
// C. QA receipts and evidence binding
// ---------------------------------------------------------------------------

test("C1: a reviewer listed in manifest.run.contributors is refused as self-review", async (t) => {
  const env = await batchFixture(t);
  const refreeze = await cli(env.root, [
    "batch", "manifest", "--candidate", env.candidate, "--paths", "src/app.mjs",
    "--batch", "BATCH-01", "--agent", "agent-dev-01", "--contributors", "agent-qa-01", "--json",
  ]);
  assert.equal(refreeze.code, 0, refreeze.logger.errorText());
  await writeApproval(env.qaPath, approvalFor(refreeze.report));
  const { code, report } = await cli(env.root, ["batch", "verify", "--manifest", env.manifestPath, "--qa", env.qaPath, "--json"]);
  assert.equal(code, 1);
  assert.equal(report.status, "FAIL");
  assert.ok(report.rejected.some((entry) => entry.reason === "self-review"), JSON.stringify(report.rejected));
});

test("C2: a declared gate that is SKIPPED voids the approval", async (t) => {
  const env = await batchFixture(t);
  await writeApproval(env.qaPath, approvalFor(env.manifest, { gates: [{ name: "quick", status: "SKIPPED" }] }));
  const { code, report } = await cli(env.root, ["batch", "verify", "--manifest", env.manifestPath, "--qa", env.qaPath, "--json"]);
  assert.equal(code, 1);
  assert.ok(report.rejected.some((entry) => entry.reason === "gate-not-pass"), JSON.stringify(report.rejected));
});

test("C3: targetRunId binds only when both sides carry it (spec §ATK-004 item 1)", async (t) => {
  const env = await batchFixture(t);
  const approval = approvalFor(env.manifest);
  delete approval.targetRunId;
  await writeApproval(env.qaPath, approval);
  const { code, report } = await cli(env.root, [
    "batch", "verify", "--manifest", env.manifestPath, "--qa", env.qaPath, "--require-qa", "--json",
  ]);
  assert.equal(code, 0, "the spec makes the run binding conditional, not mandatory");
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.rejected, []);
});

test("C4: config batch.legacyReceipts:false still refuses a self-reported passed:true receipt", async (t) => {
  const env = await batchFixture(t, { batch: { allowedPrefixes: ["src/"], manifestTag: "agent-flow-manifest-v1", legacyReceipts: false } });
  await writeApproval(env.qaPath, {
    passed: true,
    manifestSha256: env.manifest.manifestSha256,
    targetRunId: env.manifest.run?.id,
  });
  const { code, report } = await cli(env.root, ["batch", "verify", "--manifest", env.manifestPath, "--qa", env.qaPath, "--json"]);
  assert.equal(code, 1);
  assert.equal(report.status, "FAIL");
  assert.ok(report.rejected.some((entry) => entry.reason === "legacy-receipt"), JSON.stringify(report.rejected));
});

test("C5: a lowercase manifestSha256 is a different hash and is refused", async (t) => {
  const env = await batchFixture(t);
  await writeApproval(env.qaPath, approvalFor(env.manifest, { manifestSha256: env.manifest.manifestSha256.toLowerCase() }));
  const { code, report } = await cli(env.root, ["batch", "verify", "--manifest", env.manifestPath, "--qa", env.qaPath, "--json"]);
  assert.equal(code, 1);
  assert.ok(report.rejected.some((entry) => entry.reason === "manifest-sha-mismatch"), JSON.stringify(report.rejected));
});

test("C6: a QA-shaped receipt without kind:qa-approval is not counted as a QA fact", async (t) => {
  const project = await writeProject(t, {
    files: {
      "flow/state.json": batchState(),
      "artifacts/evidence/BATCH-01/manifest.json": { batchId: "BATCH-01", manifestSha256: "A".repeat(64), files: [{ path: "src/app.mjs" }] },
      "artifacts/evidence/BATCH-01/qa-nokind.json": {
        schemaVersion: 1,
        manifestSha256: "A".repeat(64),
        verdict: "PASS",
        reviewer: { run: "run-qa-01", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
        batchId: "S1",
        gates: [{ name: "quick", status: "PASS" }],
      },
    },
  });
  const { code, report } = await cli(project.root, ["evidence", "--json"]);
  assert.equal(code, 0);
  assert.equal(report.qaApprovals, 0, "only the signed kind:qa-approval structure is a QA fact");
  assert.equal(report.changes.length, 0);
  const state = JSON.parse(await readFile(path.join(project.root, "flow", "state.json"), "utf8"));
  assert.equal(state.batch.slices[0].qaPassed, null);
  assert.equal(state.batch.slices[0].status, "in_progress");
});

test("C7: evidence must refuse a QA approval whose hash binds no frozen manifest (Q-02 regression guard)", async (t) => {
  // Spec §1.2: evidence may not trust a receipt without verifying the issuing
  // Run, the target version and the Hash. A hash that matches no frozen
  // manifest was never bound to a candidate, so it cannot be a QA fact.
  const project = await writeProject(t, {
    files: {
      "flow/state.json": batchState(),
      "artifacts/evidence/BATCH-01/qa-unbound.json": {
        schemaVersion: 1,
        kind: "qa-approval",
        manifestSha256: "F".repeat(64),
        verdict: "PASS",
        reviewer: { run: "run-qa-01", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
        batchId: "S1",
        gates: [{ name: "quick", status: "PASS" }],
      },
    },
  });
  const { code, report } = await cli(project.root, ["evidence", "--json"]);
  assert.equal(code, 0);
  assert.equal(report.qaApprovals, 0, "an unbound hash is not evidence");
  assert.ok(report.rejected.length > 0, "a refused receipt must be reported, never silently accepted");
  const state = JSON.parse(await readFile(path.join(project.root, "flow", "state.json"), "utf8"));
  assert.equal(state.batch.slices[0].qaPassed, null);
  assert.equal(state.batch.slices[0].status, "in_progress");
});

test("C8: batch apply must not integrate on a legacy ok-only gate report (Q-03 regression guard)", async (t) => {
  const env = await batchFixture(t, { gates: { fast: null, quick: { command: ["node", "-e", "process.exit(0)"] }, local: null } });
  await writeApproval(env.qaPath, approvalFor(env.manifest));
  // A pre-M0 report has ok:true and no five-value status. §10.1: only a real
  // PASS satisfies a mandatory quality gate, exactly as `release` already enforces.
  await writeJson(path.join(env.root, "artifacts", "agent-flow", "ci-fast-latest.json"), { schemaVersion: 1, gate: "quick", ok: true });
  const { code, report, logger } = await cli(env.root, [
    "batch", "apply", "--manifest", env.manifestPath, "--qa", env.qaPath, "--apply", "--confirm-dev-closed", "--json",
  ]);
  // Spec-required outcome (unchanged): refuse the write with exit 1 and a
  // GATE_NOT_GREEN reason; nothing is written. The machine-readable envelope is
  // the integrator's contract: every failing `batch apply` prints one JSON plan
  // with `error` in {"verify-failed","permission-denied"} — a non-green gate is
  // a permission denial, not a verify failure (the verify itself passed).
  assert.equal(code, 1, "integration must refuse a gate report that is not an explicit PASS");
  assert.match(logger.errorText(), /GATE_NOT_GREEN/);
  assert.equal(report?.error, "permission-denied");
  assert.equal(report?.reason, "GATE_NOT_GREEN");
  assert.equal(await readFile(path.join(env.root, "src", "app.mjs"), "utf8"), "export const app = 1;\n", "nothing may be written");
});

test("C9: batch apply without a QA receipt refuses and leaves the tree untouched", async (t) => {
  const env = await batchFixture(t);
  const { code, report } = await cli(env.root, ["batch", "apply", "--manifest", env.manifestPath, "--json"]);
  assert.equal(code, 1);
  assert.equal(report.status, "FAIL");
  assert.ok(report.rejected.some((entry) => entry.reason === "missing-qa-approval"), JSON.stringify(report.rejected));
  assert.equal(await readFile(path.join(env.root, "src", "app.mjs"), "utf8"), "export const app = 1;\n");
});

// ---------------------------------------------------------------------------
// D. documentation matches the shipped behaviour
// ---------------------------------------------------------------------------

test("D1: PERMISSIONS.md documents the review-evidence legacy gap as an open limitation", async () => {
  const en = await readFile(path.join(DOCS, "PERMISSIONS.md"), "utf8");
  assert.match(en, /Known limitation \(M0, planned for M4\)/i);
  assert.match(en, /still\s+accepts a legacy `passed: true` receipt/i);
  assert.match(en, /not a fixed behavior/i);
  assert.match(en, /authoritative QA validation is `atk batch verify`/i);
  assert.doesNotMatch(en, /already fixed|has been fixed/i);
  const zh = await readFile(path.join(DOCS, "PERMISSIONS.zh-CN.md"), "utf8");
  assert.match(zh, /已知限制（M0，计划 M4 收紧）/);
  assert.match(zh, /仍接受 legacy `passed: true` 回执/);
  assert.match(zh, /不是已修复项/);
});

test("D2: the strict ownership JSON sample in INTERNALS.md matches the real report", async (t) => {
  const internals = await readFile(path.join(DOCS, "INTERNALS.md"), "utf8");
  assert.match(internals, /"status": "PASS", "mode": "strict", "ok": true, "role": "DEV"/);
  assert.match(internals, /"checked": 1, "violations": \[\], "unmapped": \[\], "ignored": 0/);
  const project = await writeProject(t, {
    files: { "flow/ownership.json": minimalOwnership() },
  });
  const { report } = await cli(project.root, ["ownership", "check", "--strict", "--role", "DEV", "--files", "src/a.ts", "--json"]);
  assert.deepEqual(
    Object.keys(report).sort(),
    ["checked", "ignored", "mode", "ok", "role", "status", "unmapped", "violations"],
    "the documented strict report keys are the real ones",
  );
});

test("D3: WORKFLOW.md five-value table matches the exported status/exit-code model", async () => {
  const workflow = await readFile(path.join(DOCS, "WORKFLOW.md"), "utf8");
  assert.equal(GATE_STATUS.PASS, "PASS");
  for (const [name, code] of Object.entries(GATE_STATUS_EXIT_CODES)) {
    const row = workflow.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``));
    assert.ok(row, `WORKFLOW.md is missing the ${name} gate row`);
    assert.ok(row.includes(`\`${code}\``), `WORKFLOW.md row for ${name} must document exit ${code}: ${row}`);
  }
  assert.match(workflow, /`ok` field is\s+always exactly `status === "PASS"`/);
  assert.match(workflow, /a legacy\s+report\s+with only `\{ "ok": true \}` and no `status` is rejected/i);
});

test("D4: the batch verify diagnostic line in WORKFLOW.md is the real output", async (t) => {
  const env = await batchFixture(t);
  const { code, logger } = await cli(env.root, ["batch", "verify", "--manifest", env.manifestPath]);
  assert.equal(code, 0);
  assert.match(
    logger.text(),
    /^SKIPPED BATCH-01: diagnostic-only, no qa-approval supplied; QA was not evaluated; 3 structural check\(s\) ok \| receipt artifacts\/evidence\/BATCH-01\/verify-.*\.json$/m,
  );
  assert.doesNotMatch(logger.text(), /PASS/);
});

// ---------------------------------------------------------------------------
// E. privacy and package boundaries
// ---------------------------------------------------------------------------

async function* walkFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

test("E1: committed docs/evidence contain no local username, real user home or secret material", async () => {
  const localUser = /\u51AF\u5B89\u8499/;
  const realUserHome = /[A-Za-z]:\\+Users\\+(?![\\<])/;
  const secretish = /\bsk-[A-Za-z0-9]{24,}\b|Bearer\s+[A-Za-z0-9._-]{20,}/;
  const findings = [];
  for await (const file of walkFiles(DOCS)) {
    if (!/\.(md|json|txt|ndjson|ya?ml)$/i.test(file)) continue;
    const text = await readFile(file, "utf8");
    const relative = path.relative(REPO, file);
    if (localUser.test(text)) findings.push(`${relative}: local username`);
    if (realUserHome.test(text)) findings.push(`${relative}: real user-home path`);
    if (secretish.test(text)) findings.push(`${relative}: secret-like token`);
  }
  assert.deepEqual(findings, [], "sanitisation regression in committed docs/evidence");
});

test("E2: the toolkit stays dependency-free and lib/ never imports packages/", async () => {
  const rootPkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
  assert.equal(rootPkg.dependencies, undefined, "no runtime dependencies are allowed");
  assert.equal(rootPkg.devDependencies, undefined, "no dev dependencies are allowed");
  const contracts = JSON.parse(await readFile(path.join(REPO, "packages", "contracts", "package.json"), "utf8"));
  assert.equal(contracts.dependencies, undefined);
  assert.equal(contracts.devDependencies, undefined);
  assert.equal(contracts.type, "module");

  // Only real static import/export-from statements count: prose, config values
  // and error messages such as `No config found from "${cwd}"` must not look
  // like a dependency.
  const staticImport = /^\s*import(?:\s|\(|["'])[^;]*?(?:from\s+)?["']([^"']+)["']/;
  const reExport = /^\s*export\s+[^;]*?\bfrom\s+["']([^"']+)["']/;
  const offenders = [];
  const scan = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const file = path.join(dir, entry.name);
      const source = await readFile(file, "utf8");
      for (const line of source.split(/\r?\n/)) {
        const match = line.match(staticImport) ?? line.match(reExport);
        if (!match) continue;
        const target = match[1];
        if (target.startsWith(".")) {
          if (target.includes("packages/")) offenders.push(`${path.relative(REPO, file)} -> ${target}`);
          continue;
        }
        if (!target.startsWith("node:")) offenders.push(`${path.relative(REPO, file)} -> third-party ${target}`);
      }
    }
  };
  await scan(path.join(REPO, "lib"));
  await scan(path.join(REPO, "bin"));
  assert.deepEqual(offenders, [], "lib/bin may only import node: builtins and relative modules");
});
