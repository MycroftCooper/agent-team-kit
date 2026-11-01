// ATK-004: a self-reported `passed: true` is never a QA fact.
//
// These tests pin the single canonical qa-approval definition exported by
// lib/evidence.mjs (spec 1.2 risks 4/5, 10.1/10.2) and the evidence derivation
// that consumes it: structure, identity, hash/run binding, gate binding and the
// explicit legacy escape hatch (`batch.legacyReceipts` / `--legacy-receipts`).
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import {
  QA_APPROVAL_SCHEMA,
  qaPassVerdict,
  run as runEvidence,
  validateQaApproval,
} from "../lib/evidence.mjs";
import { writeJson } from "../lib/util.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

const SHA = "A".repeat(64);
const OTHER_SHA = "B".repeat(64);

function manifestFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: "BATCH-01",
    manifestSha256: SHA,
    files: [{ path: "src/app.ts" }],
    run: {
      id: "run-producer-1",
      agent: "agent-dev-01",
      role: "DEV",
      function: "WORKER",
      startedAt: "2026-01-01T00:00:00+00:00",
    },
    ...overrides,
  };
}

/** A signed approval that satisfies every condition in the canonical schema. */
function approvalFixture(overrides = {}) {
  const base = {
    schemaVersion: QA_APPROVAL_SCHEMA.schemaVersion,
    kind: QA_APPROVAL_SCHEMA.kind,
    manifestSha256: SHA,
    verdict: "PASS",
    reviewer: { run: "run-qa-1", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
    targetRunId: "run-producer-1",
    gates: [{ name: "quick", status: "PASS", reportSha256: "C".repeat(64) }],
  };
  return { ...base, ...overrides, reviewer: { ...base.reviewer, ...(overrides.reviewer ?? {}) } };
}

function validate(payload, options = {}) {
  return validateQaApproval(payload, { manifest: manifestFixture(), ...options });
}

function reasonsOf(result) {
  return result.rejected.map((entry) => entry.reason);
}

test("the canonical qa-approval schema is one exported definition that validates a signed receipt", () => {
  assert.equal(QA_APPROVAL_SCHEMA.schemaVersion, 1);
  assert.equal(QA_APPROVAL_SCHEMA.kind, "qa-approval");
  assert.ok(QA_APPROVAL_SCHEMA.required.includes("kind"));
  assert.ok(QA_APPROVAL_SCHEMA.required.includes("manifestSha256"));
  assert.ok(QA_APPROVAL_SCHEMA.required.includes("verdict"));
  assert.ok(QA_APPROVAL_SCHEMA.required.includes("reviewer.function"));

  const result = validate(approvalFixture());
  assert.equal(result.ok, true);
  assert.equal(result.legacy, false);
  assert.deepEqual(result.rejected, []);
});

test("a legacy passed:true receipt is not a QA fact unless the escape hatch is explicit", () => {
  const legacy = { passed: true, manifestSha256: SHA, batchId: "S1" };

  const refused = validate(legacy);
  assert.equal(refused.ok, false);
  assert.equal(refused.legacy, true);
  assert.deepEqual(reasonsOf(refused), ["legacy-receipt"]);
  assert.match(refused.rejected[0].detail, /missing kind:qa-approval/);
  assert.match(refused.rejected[0].detail, /batch\.legacyReceipts=true or --legacy-receipts/);

  const escaped = validate(legacy, { legacyReceipts: true });
  assert.equal(escaped.ok, true);
  assert.equal(escaped.legacy, true);

  const notPassed = validate({ noninteractiveQA: "failed", manifestSha256: SHA }, { legacyReceipts: true });
  assert.equal(notPassed.ok, false);
  assert.deepEqual(reasonsOf(notPassed), ["verdict-not-pass"]);

  const noHash = validate({ passed: true }, { legacyReceipts: true });
  assert.equal(noHash.ok, false);
  assert.deepEqual(reasonsOf(noHash), ["missing-manifest-sha256"]);
});

test("every structural rejection names the broken condition", () => {
  const cases = [
    ["unsupported-schema-version", approvalFixture({ schemaVersion: 2 })],
    ["verdict-not-pass", approvalFixture({ verdict: "FAIL" })],
    ["missing-manifest-sha256", approvalFixture({ manifestSha256: "" })],
    ["manifest-sha-mismatch", approvalFixture({ manifestSha256: OTHER_SHA })],
    ["reviewer-not-reviewer", approvalFixture({ reviewer: { function: "WORKER" } })],
    ["missing-reviewer-run", approvalFixture({ reviewer: { run: "" } })],
    ["missing-reviewer-agent", approvalFixture({ reviewer: { agent: "" } })],
    ["target-run-mismatch", approvalFixture({ targetRunId: "run-someone-else" })],
    ["gate-not-pass", approvalFixture({ gates: [{ name: "quick", status: "FAIL" }] })],
  ];
  for (const [expected, payload] of cases) {
    const result = validate(payload);
    assert.equal(result.ok, false, `${expected} must be refused`);
    assert.ok(reasonsOf(result).includes(expected), `${expected} not in ${JSON.stringify(reasonsOf(result))}`);
  }

  const noReviewer = approvalFixture();
  delete noReviewer.reviewer;
  assert.deepEqual(reasonsOf(validate(noReviewer)), ["missing-reviewer"]);

  const noGates = validate(approvalFixture({ gates: [] }), { requireGates: true });
  assert.equal(noGates.ok, false);
  assert.deepEqual(reasonsOf(noGates), ["missing-gates"]);
  assert.equal(validate(approvalFixture({ gates: [] })).ok, true, "gates are only mandatory in controlled integration");
});

test("self-review is refused for the producer and for a listed contributor", () => {
  const produced = validate(
    approvalFixture({ reviewer: { run: "run-dev-1", agent: "agent-dev-01", role: "DEV", function: "REVIEWER" } }),
  );
  assert.equal(produced.ok, false);
  assert.deepEqual(reasonsOf(produced), ["self-review"]);
  assert.match(produced.rejected[0].detail, /produced manifest/);

  const contributed = validateQaApproval(approvalFixture(), {
    manifest: manifestFixture({ run: { ...manifestFixture().run, contributors: ["agent-qa-01"] } }),
  });
  assert.equal(contributed.ok, false);
  assert.deepEqual(reasonsOf(contributed), ["self-review"]);
  assert.match(contributed.rejected[0].detail, /contributor/);
});

test("qaPassVerdict is the shared minimum: a bare verdict string is not a claim", () => {
  assert.equal(qaPassVerdict({ verdict: "PASS" }), false, "a bare verdict has no reviewer and no manifest hash");
  assert.equal(qaPassVerdict({ verdict: "PASS", manifestSha256: SHA }), false, "still no reviewer");
  assert.equal(qaPassVerdict({ verdict: "PASS", manifestSha256: SHA, reviewer: { function: "WORKER" } }), false);
  assert.equal(qaPassVerdict({ verdict: "PASS", manifestSha256: SHA, reviewer: { function: "REVIEWER" } }), true);
  assert.equal(qaPassVerdict({ passed: true }), true, "legacy branch stays available to the permission layer");
  assert.equal(qaPassVerdict({ noninteractiveQA: "passed" }), true);
  assert.equal(qaPassVerdict(undefined), false);
  assert.equal(qaPassVerdict([]), false);
});

// ---------------------------------------------------------------------------
// atk evidence: rejected receipts are reported, never silently ignored.
// ---------------------------------------------------------------------------

function stateWithSlices() {
  return {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00+00:00",
    batch: {
      id: "BATCH-01",
      goal: "derive facts from receipts",
      stopCondition: "all slices accepted",
      slices: [
        { id: "S1", label: "one", status: "in_progress", qaPassed: null, applied: null, owner: "DEV" },
        { id: "S2", label: "two", status: "in_progress", qaPassed: null, applied: null, owner: "DEV" },
      ],
    },
    packages: [{ id: "PKG-01", type: "feature", evidence: ["src/app.ts"], verification: {}, stage: "implemented" }],
    subitems: [],
  };
}

async function evidenceSetup(t, options = {}) {
  const project = await createProject({
    config: {
      layout: { flowDir: "flow", tempPrefix: "atk-evidence-binding" },
      ...(options.config ?? {}),
    },
    files: {
      "flow/state.json": options.state ?? stateWithSlices(),
      ...(options.receipts ?? {}),
    },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  return {
    ...project,
    ctx,
    logger,
    statePath: path.join(project.root, "flow", "state.json"),
    run: (argv) => runEvidence(argv, ctx),
  };
}

async function loadState(env) {
  return JSON.parse(await readFile(env.statePath, "utf8"));
}

test("atk evidence rejects a legacy receipt with a readable reason and never advances state", async (t) => {
  const env = await evidenceSetup(t, {
    receipts: {
      "artifacts/evidence/BATCH-01/manifest.json": {
        batchId: "BATCH-01",
        manifestSha256: SHA,
        files: [{ path: "src/app.ts" }],
      },
      "artifacts/evidence/BATCH-01/qa-legacy.json": {
        passed: true,
        manifestSha256: SHA,
        batchId: "S1",
        packages: ["PKG-01"],
      },
    },
  });

  assert.equal(await env.run(["--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.qaApprovals, 0, "a self-reported flag is not a QA fact");
  assert.equal(report.rejected.length, 1);
  assert.equal(report.rejected[0].reason, "legacy-receipt");
  assert.equal(report.changes.length, 0);
  assert.match(env.logger.errorText(), /refused qa-approval .*legacy-receipt/);

  const state = await loadState(env);
  assert.equal(state.batch.slices.find((slice) => slice.id === "S1").qaPassed, null);
  assert.equal(state.packages.find((pkg) => pkg.id === "PKG-01").verification.qaPassed, undefined);
});

test("atk evidence accepts legacy receipts only through the escape hatch (config or flag)", async (t) => {
  const env = await evidenceSetup(t, {
    receipts: {
      "artifacts/evidence/BATCH-01/manifest.json": {
        batchId: "BATCH-01",
        manifestSha256: SHA,
        files: [{ path: "src/app.ts" }],
      },
      "artifacts/evidence/BATCH-01/qa-legacy.json": {
        passed: true,
        manifestSha256: SHA,
        batchId: "S1",
        packages: ["PKG-01"],
      },
    },
  });

  assert.equal(await env.run(["--legacy-receipts", "--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.legacyReceipts, true);
  assert.equal(report.qaApprovals, 1);
  assert.deepEqual(report.rejected, []);
  const state = await loadState(env);
  assert.equal(state.batch.slices.find((slice) => slice.id === "S1").qaPassed, true);

  const configured = await evidenceSetup(t, {
    config: { batch: { legacyReceipts: true } },
    receipts: {
      // Q-02: the escape hatch still requires the named hash to bind a manifest.
      "artifacts/evidence/BATCH-01/manifest.json": {
        batchId: "BATCH-01",
        manifestSha256: SHA,
        files: [{ path: "src/app.ts" }],
      },
      "artifacts/evidence/BATCH-01/qa-legacy.json": {
        passed: true,
        manifestSha256: SHA,
        batchId: "S1",
        packages: ["PKG-01"],
      },
    },
  });
  assert.equal(await configured.run(["--json"]), 0);
  assert.equal(configured.logger.lines.json.at(-1).qaApprovals, 1);
});

test("atk evidence accepts a signed receipt and refuses a failing gate or a broken run binding", async (t) => {
  const env = await evidenceSetup(t, {
    receipts: {
      "artifacts/evidence/BATCH-01/manifest.json": manifestFixture(),
      "artifacts/evidence/BATCH-01/qa-ok.json": approvalFixture({
        batchId: "S1",
        packages: ["PKG-01"],
      }),
      "artifacts/evidence/BATCH-01/qa-bad-gate.json": approvalFixture({
        manifestSha256: SHA,
        gates: [{ name: "quick", status: "FAIL" }],
        batchId: "S2",
      }),
      "artifacts/evidence/BATCH-01/qa-stale.json": approvalFixture({
        manifestSha256: SHA,
        targetRunId: "run-gone",
        batchId: "S2",
      }),
    },
  });

  assert.equal(await env.run(["--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.qaApprovals, 1, "only the signed, bound, all-gates-PASS receipt counts");
  const reasons = report.rejected.map((entry) => entry.reason);
  assert.ok(reasons.includes("gate-not-pass"), `expected gate-not-pass, got ${JSON.stringify(reasons)}`);
  assert.ok(reasons.includes("target-run-mismatch"), `expected target-run-mismatch, got ${JSON.stringify(reasons)}`);

  const state = await loadState(env);
  assert.equal(state.batch.slices.find((slice) => slice.id === "S1").qaPassed, true);
  assert.equal(state.batch.slices.find((slice) => slice.id === "S2").qaPassed, null);
  assert.equal(state.packages.find((pkg) => pkg.id === "PKG-01").verification.qaPassed, true);
});

// ---------------------------------------------------------------------------
// Q-02 / Q-04 (QA-001): fail-closed manifest binding and missing-kind reporting.
// ---------------------------------------------------------------------------

test("a QA-shaped receipt without kind is refused as missing-kind (Q-04)", () => {
  const shaped = {
    schemaVersion: 1,
    manifestSha256: SHA,
    verdict: "PASS",
    reviewer: { run: "run-qa-1", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
    gates: [{ name: "quick", status: "PASS" }],
  };
  const result = validateQaApproval(shaped, { manifest: manifestFixture() });
  assert.equal(result.ok, false);
  assert.deepEqual(reasonsOf(result), ["missing-kind"]);
  assert.match(result.rejected[0].detail, /missing kind: "qa-approval"/);
  assert.match(result.rejected[0].detail, /expected the signed structure/);

  const escaped = validateQaApproval(shaped, { manifest: manifestFixture(), legacyReceipts: true });
  assert.equal(escaped.ok, false, "the legacy escape hatch is not for QA-shaped receipts");
  assert.deepEqual(reasonsOf(escaped), ["missing-kind"]);

  const wrongKind = validateQaApproval({ ...shaped, kind: "qa" }, { manifest: manifestFixture() });
  assert.deepEqual(reasonsOf(wrongKind), ["missing-kind"]);
  assert.match(wrongKind.rejected[0].detail, /"qa"/);
});

test("atk evidence refuses a signed receipt whose hash binds no manifest (Q-02)", async (t) => {
  const env = await evidenceSetup(t, {
    receipts: {
      "artifacts/evidence/BATCH-01/qa-forged.json": approvalFixture({
        manifestSha256: "F".repeat(64),
        batchId: "S1",
        packages: ["PKG-01"],
      }),
    },
  });

  assert.equal(await env.run(["--json"]), 0, "a refused receipt is a report, not a crash");
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.qaApprovals, 0, "a hash that binds no frozen manifest is not evidence");
  assert.equal(report.changes.length, 0);
  assert.equal(report.rejected.length, 1);
  assert.equal(report.rejected[0].reason, "unbound-manifest");
  assert.match(report.rejected[0].detail, /no manifest/);
  assert.match(env.logger.errorText(), /unbound-manifest/);

  const state = await loadState(env);
  const slice = state.batch.slices.find((entry) => entry.id === "S1");
  assert.equal(slice.qaPassed, null);
  assert.equal(slice.status, "in_progress");
  assert.equal(state.packages.find((pkg) => pkg.id === "PKG-01").verification.qaPassed, undefined);
});

test("atk evidence normalises hex case when binding a manifest (Q-02)", async (t) => {
  const env = await evidenceSetup(t, {
    receipts: {
      "artifacts/evidence/BATCH-01/manifest.json": manifestFixture(),
      "artifacts/evidence/BATCH-01/qa-lowercase.json": approvalFixture({
        manifestSha256: SHA.toLowerCase(),
        batchId: "S1",
        packages: ["PKG-01"],
      }),
    },
  });

  assert.equal(await env.run(["--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.qaApprovals, 1, "a case variant of the frozen hash is the same hash");
  assert.deepEqual(report.rejected, []);

  const state = await loadState(env);
  const slice = state.batch.slices.find((entry) => entry.id === "S1");
  assert.equal(slice.qaPassed, true);
  assert.equal(slice.status, "awaiting_apply");
  assert.equal(state.packages.find((pkg) => pkg.id === "PKG-01").verification.qaPassed, true);
});

test("atk evidence reports a QA-shaped receipt without kind (Q-04)", async (t) => {
  const env = await evidenceSetup(t, {
    receipts: {
      "artifacts/evidence/BATCH-01/manifest.json": manifestFixture(),
      "artifacts/evidence/BATCH-01/qa-nokind.json": {
        schemaVersion: 1,
        manifestSha256: SHA,
        verdict: "PASS",
        reviewer: { run: "run-qa-1", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
        batchId: "S1",
        packages: ["PKG-01"],
        gates: [{ name: "quick", status: "PASS" }],
      },
    },
  });

  assert.equal(await env.run(["--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.qaApprovals, 0);
  assert.equal(report.rejected.length, 1);
  assert.equal(report.rejected[0].reason, "missing-kind");
  assert.match(env.logger.errorText(), /missing-kind/);
  const state = await loadState(env);
  assert.equal(state.batch.slices.find((entry) => entry.id === "S1").qaPassed, null);
});

test("the legacy escape hatch still requires the named hash to bind a manifest (Q-02)", async (t) => {
  const env = await evidenceSetup(t, {
    config: { batch: { legacyReceipts: true } },
    receipts: {
      "artifacts/evidence/BATCH-01/qa-legacy.json": {
        passed: true,
        manifestSha256: "F".repeat(64),
        batchId: "S1",
        packages: ["PKG-01"],
      },
    },
  });

  assert.equal(await env.run(["--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.legacyReceipts, true);
  assert.equal(report.qaApprovals, 0, "the escape hatch is not a binding escape hatch");
  assert.equal(report.rejected[0].reason, "unbound-manifest");
  const state = await loadState(env);
  assert.equal(state.batch.slices.find((entry) => entry.id === "S1").qaPassed, null);
});
