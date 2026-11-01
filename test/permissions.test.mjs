// Tests for the entity permission layer: registry shape, deny-by-default,
// reason codes, condition evaluation, the append-only audit and the
// `atk permit` command.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run as runBatch } from "../lib/batch.mjs";
import { createContext } from "../lib/context.mjs";
import { runCli } from "../lib/dispatch.mjs";
import { checkPermission, evaluatePermission, readAudit } from "../lib/permissions.mjs";
import {
  PERMISSION_GROUPS,
  PERMISSION_OPERATIONS,
  REASON,
  actionFor,
  getOperation,
  permissionStats,
} from "../lib/permission-registry.mjs";
import { createProject, memoryLogger, minimalOwnership, minimalState } from "./helpers.mjs";

const SINCE = "2026-01-01T00:00:00+00:00";
const SHA = "A".repeat(64);

function runtimeWith(extra = []) {
  return {
    schemaVersion: 3,
    updatedAt: SINCE,
    agents: [
      { id: "agent-lead-01", role: "LEAD", capabilities: ["ORCHESTRATOR"], status: "idle", task: "", detail: "", since: SINCE },
      { id: "agent-dev-01", role: "DEV", capabilities: ["WORKER"], status: "idle", task: "", detail: "", since: SINCE },
      { id: "agent-qa-01", role: "QA", capabilities: ["REVIEWER"], status: "idle", task: "", detail: "", since: SINCE },
      ...extra,
    ],
    events: [],
  };
}

function manifestFixture(producer = "agent-dev-01", role = "DEV") {
  return {
    schemaVersion: 1,
    batchId: "BATCH-01",
    packages: ["PKG-01"],
    manifestTag: "demo-manifest-v1",
    files: [{ path: "src/a.ts", kind: "modify", sourceSha256: SHA }],
    manifestSha256: SHA,
    run: { id: "run-1", agent: producer, role, function: "WORKER", startedAt: SINCE },
  };
}

function approvalFixture(reviewer = "agent-qa-01", role = "QA", sha = SHA) {
  return {
    passed: true,
    manifestSha256: sha,
    originalApplied: false,
    reviewer: { agent: reviewer, role, function: "REVIEWER" },
  };
}

async function setup(t, { config = {}, runtime = runtimeWith(), files = {} } = {}) {
  const project = await createProject({
    config,
    files: {
      "flow/state.json": minimalState(),
      "flow/ownership.json": minimalOwnership(),
      "flow/runtime.json": runtime,
      ...files,
    },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  return { ...project, ctx, logger };
}

function contextFor(base, request) {
  return {
    operation: request.operation,
    subject: request.subject,
    role: request.role,
    agent: request.agent,
    taskId: request.taskId,
    files: request.files ?? [],
    candidate: request.candidate,
    manifestObject: request.manifest,
    approvalObject: request.approval,
    approved: request.approved,
    recorded: request.recorded,
    controlled: request.controlled,
    noDrift: request.noDrift,
    qaPassed: request.qaPassed,
    budgetOk: request.budgetOk,
    runtimeAvailable: request.runtimeAvailable,
    concurrencyOk: request.concurrencyOk,
    policyOk: request.policyOk,
    dispatchAuthorized: request.dispatchAuthorized,
    protectedBranch: request.protectedBranch,
    runOwner: request.runOwner,
  };
}

// --- Q-03: one shared PASS verdict for release and the permission gate ------

const GATE_REPORT_REL = path.join("artifacts", "agent-flow", "ci-fast-latest.json");
const APP_ORIGINAL = "export const app = 1;\n";
const APP_CANDIDATE = "export const app = 2;\n";

async function writeGateReport(root, report) {
  const file = path.join(root, GATE_REPORT_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report)}\n`, "utf8");
}

function qaApprovalFor(manifest) {
  return {
    schemaVersion: 1,
    kind: "qa-approval",
    manifestSha256: manifest.manifestSha256,
    verdict: "PASS",
    reviewer: { run: "run-qa-01", agent: "agent-qa-01", role: "QA", function: "REVIEWER" },
    targetRunId: manifest.run?.id,
    gates: [{ name: "quick", status: "PASS" }],
    originalApplied: false,
  };
}

/** Batch-apply fixture whose gate report is rewritten per case (Q-03). */
async function applyFixture(t) {
  const project = await setup(t, {
    config: {
      layout: { flowDir: "flow", artifactDir: "artifacts/agent-flow", evidenceDir: "artifacts/evidence" },
      batch: { allowedPrefixes: ["src/"], manifestTag: "agent-flow-manifest-v1" },
      gates: { fast: null, quick: { command: ["node", "-e", "process.exit(0)"] }, local: null },
    },
    files: { "src/app.mjs": APP_ORIGINAL },
  });
  const candidateRoot = await mkdtemp(path.join(os.tmpdir(), "atk-q03-candidate-"));
  await mkdir(path.join(candidateRoot, "src"), { recursive: true });
  await writeFile(path.join(candidateRoot, "src", "app.mjs"), APP_CANDIDATE, "utf8");
  t.after(() => rm(candidateRoot, { recursive: true, force: true }));

  const freeze = await runBatch(
    ["manifest", "--candidate", candidateRoot, "--paths", "src/app.mjs", "--batch", "BATCH-01", "--agent", "agent-dev-01", "--json"],
    project.ctx,
  );
  assert.equal(freeze, 0, project.logger.errorText());
  const manifestPath = path.join(project.root, "artifacts", "agent-flow", "BATCH-01-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const qaPath = path.join(project.root, "qa-approval.json");
  await writeFile(qaPath, `${JSON.stringify(qaApprovalFor(manifest))}\n`, "utf8");
  return {
    ...project,
    appPath: path.join(project.root, "src", "app.mjs"),
    apply: async (report) => {
      await writeGateReport(project.root, report);
      project.logger.lines.err.length = 0;
      project.logger.lines.json.length = 0;
      return runBatch(
        ["apply", "--manifest", manifestPath, "--qa", qaPath, "--apply", "--confirm-dev-closed", "--json"],
        project.ctx,
      );
    },
  };
}

test("the registry covers the whole matrix and every row uses A/C/N", () => {
  const stats = permissionStats();
  assert.equal(stats.operations, 75);
  assert.equal(stats.groups, 7);
  assert.equal(PERMISSION_OPERATIONS.length, PERMISSION_GROUPS.reduce((sum, group) => sum + group.operations.length, 0));
  const ids = new Set();
  for (const operation of PERMISSION_OPERATIONS) {
    assert.match(operation.actions, /^[ACN]{5}$/, operation.id);
    assert.ok(!ids.has(operation.id), `duplicate ${operation.id}`);
    ids.add(operation.id);
  }
});

test("matrix spot checks match the documented design", () => {
  const expected = {
    "project.view": "AAAAA",
    "project.security.edit": "ANNNC",
    "task.review.create": "AANCC",
    "task.claim": "CCCCA",
    "agent.model.edit": "ANNNC",
    "code.modify": "CNCNN",
    "code.other.workspace.modify": "NNNNN",
    "qa.review.other": "ANNAC",
    "qa.review.self": "CNNNN",
    "qa.result.submit": "CNNCC",
    "qa.candidate.modify": "NNNNN",
    "integration.merge.development": "CNNNC",
    "integration.accept": "ANNNN",
    "audit.modify": "NNNNN",
  };
  for (const [id, actions] of Object.entries(expected)) {
    const operation = getOperation(id);
    assert.ok(operation, `expected ${id} in the registry`);
    assert.equal(operation.actions, actions, id);
  }
  assert.equal(actionFor(getOperation("code.modify"), "WORKER"), "C");
  assert.equal(actionFor(getOperation("code.modify"), "REVIEWER"), "N");
});

test("deny-by-default: unknown operations and unknown subjects never allow", async (t) => {
  const { ctx } = await setup(t);
  const unknownOperation = await evaluatePermission(ctx, { operation: "project.teleport", subject: "HUMAN" });
  assert.equal(unknownOperation.allowed, false);
  assert.equal(unknownOperation.reason, REASON.OPERATION_NOT_REGISTERED);

  const unknownSubject = await evaluatePermission(ctx, { operation: "project.view", subject: "ROBOT" });
  assert.equal(unknownSubject.allowed, false);
  assert.equal(unknownSubject.reason, REASON.SUBJECT_UNKNOWN);
});

test("matrix denial and role range produce ROLE_DENIED", async (t) => {
  const { ctx } = await setup(t);
  const denied = await evaluatePermission(ctx, { operation: "agent.model.edit", subject: "WORKER", role: "DEV" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, REASON.ROLE_DENIED);

  const wrongRole = await evaluatePermission(ctx, { operation: "project.view", subject: "REVIEWER", role: "DEV" });
  assert.equal(wrongRole.allowed, false);
  assert.equal(wrongRole.reason, REASON.ROLE_DENIED);
});

test("write scope, ownership and missing attributes are enforced", async (t) => {
  const { ctx } = await setup(t);

  const allowed = await evaluatePermission(
    ctx,
    contextFor(ctx, { operation: "code.modify", subject: "WORKER", role: "DEV", agent: "agent-dev-01", taskId: "PKG-01", files: ["src/a.ts"] }),
  );
  assert.equal(allowed.allowed, true, allowed.detail);
  assert.deepEqual(allowed.checks.map((check) => check.name), ["task-claimed", "write-scope"]);

  const outside = await evaluatePermission(
    ctx,
    contextFor(ctx, { operation: "code.modify", subject: "WORKER", role: "DEV", agent: "agent-dev-01", taskId: "PKG-01", files: ["docs/x.md"] }),
  );
  assert.equal(outside.allowed, false);
  assert.equal(outside.reason, REASON.WRITE_SCOPE_VIOLATION);

  const otherTask = await evaluatePermission(
    ctx,
    contextFor(ctx, { operation: "code.modify", subject: "WORKER", role: "DEV", agent: "agent-dev-01", taskId: "PKG-02", files: ["src/a.ts"] }),
  );
  assert.equal(otherTask.allowed, false);
  assert.equal(otherTask.reason, REASON.OWNERSHIP_DENIED);

  const noTask = await evaluatePermission(
    ctx,
    contextFor(ctx, { operation: "code.modify", subject: "WORKER", role: "DEV", agent: "agent-dev-01", files: ["src/a.ts"] }),
  );
  assert.equal(noTask.allowed, false);
  assert.equal(noTask.reason, REASON.ATTRIBUTE_MISSING);
});

test("review submission needs an independent author and valid evidence", async (t) => {
  const hybrid = {
    schemaVersion: 3,
    updatedAt: SINCE,
    agents: [
      { id: "agent-lead-01", role: "LEAD", capabilities: ["ORCHESTRATOR"], status: "idle", task: "", detail: "", since: SINCE },
      { id: "agent-hybrid-01", role: "QA", capabilities: ["WORKER", "REVIEWER"], status: "idle", task: "", detail: "", since: SINCE },
    ],
    events: [],
  };
  const { ctx } = await setup(t, { runtime: hybrid });
  const manifest = manifestFixture("agent-hybrid-01", "QA");

  const selfReview = await evaluatePermission(
    ctx,
    contextFor(ctx, {
      operation: "qa.result.submit",
      subject: "REVIEWER",
      role: "QA",
      agent: "agent-hybrid-01",
      manifest,
      approval: approvalFixture("agent-hybrid-01", "QA"),
      qaPassed: true,
    }),
  );
  assert.equal(selfReview.allowed, false);
  assert.equal(selfReview.reason, REASON.SELF_REVIEW_DENIED);

  const independent = await evaluatePermission(
    ctx,
    contextFor(ctx, {
      operation: "qa.result.submit",
      subject: "REVIEWER",
      role: "QA",
      agent: "agent-qa-01",
      manifest,
      approval: approvalFixture("agent-qa-01", "QA"),
      qaPassed: true,
    }),
  );
  // agent-qa-01 is not in this fixture's runtime: resolution is the CLI's job;
  // the evaluator only sees the declared subject here.
  assert.equal(independent.allowed, true, independent.detail);

  const wrongBinding = await evaluatePermission(
    ctx,
    contextFor(ctx, {
      operation: "qa.result.submit",
      subject: "REVIEWER",
      role: "QA",
      agent: "agent-qa-01",
      manifest,
      approval: approvalFixture("agent-qa-01", "QA", "B".repeat(64)),
      qaPassed: true,
    }),
  );
  assert.equal(wrongBinding.allowed, false);
  assert.equal(wrongBinding.reason, REASON.REVIEW_EVIDENCE_INVALID);
});

test("human approval and gate proof are required where the matrix says so", async (t) => {
  const { ctx } = await setup(t);
  const noApproval = await evaluatePermission(ctx, { operation: "project.create", subject: "SYSTEM" });
  assert.equal(noApproval.allowed, false);
  assert.equal(noApproval.reason, REASON.APPROVAL_REQUIRED);

  const approved = await evaluatePermission(ctx, { operation: "project.create", subject: "SYSTEM", approved: true });
  assert.equal(approved.allowed, true, approved.detail);

  const noProof = await evaluatePermission(ctx, { operation: "integration.merge.development", subject: "SYSTEM", qaPassed: true });
  assert.equal(noProof.allowed, false);
  assert.equal(noProof.reason, REASON.ATTRIBUTE_MISSING);

  // With quick/local gates configured the gate report is part of the proof.
  const gated = await setup(t, { config: { gates: { quick: { command: ["node", "--version"] } } } });
  const gatedCtx = gated.ctx;
  const noReport = await evaluatePermission(gatedCtx, {
    operation: "integration.merge.development",
    subject: "SYSTEM",
    qaPassed: true,
    noDrift: true,
  });
  assert.equal(noReport.allowed, false);
  assert.equal(noReport.reason, REASON.ATTRIBUTE_MISSING);

  await mkdir(path.join(gated.root, "artifacts", "agent-flow"), { recursive: true });
  await writeFile(
    path.join(gated.root, "artifacts", "agent-flow", "ci-fast-latest.json"),
    JSON.stringify({ schemaVersion: 1, status: "PASS", ok: true }),
    "utf8",
  );
  const green = await evaluatePermission(gatedCtx, {
    operation: "integration.merge.development",
    subject: "SYSTEM",
    qaPassed: true,
    noDrift: true,
  });
  assert.equal(green.allowed, true, green.detail);
});

test("gate-green accepts only an explicit, self-consistent PASS report", async (t) => {
  const gated = await setup(t, { config: { gates: { quick: { command: ["node", "--version"] } } } });
  const fixtures = [
    { name: "legacy ok-only", report: { schemaVersion: 1, gate: "quick", ok: true }, green: false, pattern: /no status field/i },
    { name: "status FAIL with ok true", report: { schemaVersion: 1, status: "FAIL", ok: true }, green: false, pattern: /not PASS/i },
    { name: "status PASS with ok false", report: { schemaVersion: 1, status: "PASS", ok: false }, green: false, pattern: /inconsistent/i },
    { name: "SKIPPED", report: { schemaVersion: 1, status: "SKIPPED", ok: false }, green: false, pattern: /SKIPPED/ },
    { name: "UNCONFIGURED", report: { schemaVersion: 1, status: "UNCONFIGURED", ok: false }, green: false, pattern: /UNCONFIGURED/ },
    { name: "explicit PASS", report: { schemaVersion: 1, status: "PASS", ok: true }, green: true },
  ];
  for (const item of fixtures) {
    await writeGateReport(gated.root, item.report);
    const decision = await evaluatePermission(gated.ctx, {
      operation: "integration.merge.development",
      subject: "SYSTEM",
      qaPassed: true,
      noDrift: true,
    });
    assert.equal(decision.allowed, item.green, `${item.name}: ${decision.detail}`);
    const check = decision.checks.find((entry) => entry.name === "gate-green");
    assert.equal(check.ok, item.green, item.name);
    if (!item.green) {
      assert.equal(decision.reason, REASON.GATE_NOT_GREEN, item.name);
      assert.match(decision.detail, item.pattern, item.name);
    }
  }
});

test("gate-green reports the no-delivery-gate exemption as not applicable, never as a green report", async (t) => {
  // Documented contract (docs/PERMISSIONS.md, docs/WORKFLOW.md): the delivery
  // gate report is required only "when gates.quick / gates.local are
  // configured". Without one, nothing is verified here and nothing claims green.
  const { ctx } = await setup(t);
  const decision = await evaluatePermission(ctx, {
    operation: "integration.merge.development",
    subject: "SYSTEM",
    qaPassed: true,
    noDrift: true,
  });
  assert.equal(decision.allowed, true);
  const check = decision.checks.find((entry) => entry.name === "gate-green");
  assert.equal(check.ok, true);
  assert.match(check.detail, /no quick\/local gate configured; gate-green does not apply/);
  assert.doesNotMatch(check.detail, /explicit PASS|says status|ok is not true/);
});

test("gate-green distinguishes a missing gate report from an unreadable one", async (t) => {
  const gated = await setup(t, { config: { gates: { quick: { command: ["node", "--version"] } } } });
  const request = {
    operation: "integration.merge.development",
    subject: "SYSTEM",
    qaPassed: true,
    noDrift: true,
  };
  const missing = await evaluatePermission(gated.ctx, request);
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, REASON.ATTRIBUTE_MISSING);

  const file = path.join(gated.root, GATE_REPORT_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{ not valid json\n", "utf8");
  const unreadable = await evaluatePermission(gated.ctx, request);
  assert.equal(unreadable.allowed, false);
  assert.equal(unreadable.reason, REASON.GATE_NOT_GREEN);
  assert.match(unreadable.detail, /unreadable/i);
});

test("batch apply refuses every non-explicit-PASS gate report before writing the tree", async (t) => {
  const env = await applyFixture(t);
  const rejected = [
    { name: "legacy ok-only", report: { schemaVersion: 1, gate: "quick", ok: true }, pattern: /no status field/i },
    { name: "status FAIL with ok true", report: { schemaVersion: 1, status: "FAIL", ok: true }, pattern: /not PASS/i },
    { name: "status PASS with ok false", report: { schemaVersion: 1, status: "PASS", ok: false }, pattern: /inconsistent/i },
    { name: "SKIPPED", report: { schemaVersion: 1, status: "SKIPPED", ok: false }, pattern: /SKIPPED/ },
  ];
  for (const item of rejected) {
    assert.equal(await env.apply(item.report), 1, item.name);
    assert.match(env.logger.errorText(), /GATE_NOT_GREEN/, item.name);
    assert.match(env.logger.errorText(), item.pattern, item.name);
    const plan = env.logger.lines.json.at(-1);
    assert.ok(plan, `${item.name}: apply must publish a machine-readable plan`);
    assert.equal(plan.error, "permission-denied", item.name);
    assert.equal(plan.reason, REASON.GATE_NOT_GREEN, item.name);
    assert.match(String(plan.detail), item.pattern, item.name);
    assert.equal(await readFile(env.appPath, "utf8"), APP_ORIGINAL, `${item.name}: nothing may be written`);
  }

  assert.equal(await env.apply({ schemaVersion: 1, status: "PASS", ok: true }), 0);
  assert.equal(await readFile(env.appPath, "utf8"), APP_CANDIDATE, "an explicit PASS still integrates");
});

test("the audit trail is append-only and readable", async (t) => {
  const { ctx } = await setup(t);
  const first = await checkPermission(ctx, { operation: "project.view", subject: "HUMAN" });
  assert.equal(first.allowed, true);
  const file = path.join(ctx.paths.artifactDir, "permission-audit.jsonl");
  const firstLine = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean)[0];
  assert.match(firstLine, /"operation":"project\.view"/);

  const second = await checkPermission(ctx, { operation: "code.modify", subject: "REVIEWER", role: "QA" });
  assert.equal(second.allowed, false);
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], firstLine, "an earlier audit event is never rewritten");
  assert.match(lines[1], /"reason":"ROLE_DENIED"/);

  const audit = await readAudit(ctx, { tail: 1 });
  assert.equal(audit.count, 2);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].allowed, false);
});

test("atk permit matrix/check/explain/audit work through the CLI", async (t) => {
  const { root } = await setup(t);
  const matrixLog = memoryLogger();
  assert.equal(await runCli(["permit", "matrix", "--json", "--cwd", root], { logger: matrixLog }), 0);
  const matrix = matrixLog.lines.json.at(-1);
  assert.equal(matrix.stats.operations, 75);
  assert.equal(matrix.groups.length, 7);

  const markdownLog = memoryLogger();
  assert.equal(await runCli(["permit", "matrix", "--cwd", root], { logger: markdownLog }), 0);
  assert.match(markdownLog.text(), /Code and workspaces/);
  assert.match(markdownLog.text(), /A = allowed, C = conditional/);
  assert.match(markdownLog.text(), /`code\.modify` \| C \| N \| C \| N \| N \|/);

  const allowLog = memoryLogger();
  assert.equal(await runCli(["permit", "check", "project.view", "--subject", "HUMAN", "--cwd", root], { logger: allowLog }), 0);
  assert.match(allowLog.text(), /ALLOWED project\.view/);

  const denyLog = memoryLogger();
  assert.equal(
    await runCli(["permit", "check", "code.other.workspace.modify", "--subject", "WORKER", "--role", "DEV", "--cwd", root], { logger: denyLog }),
    1,
  );
  assert.match(denyLog.errorText(), new RegExp(REASON.ROLE_DENIED));

  const scopeLog = memoryLogger();
  assert.equal(
    await runCli(
      [
        "permit",
        "check",
        "code.modify",
        "--agent",
        "agent-dev-01",
        "--task",
        "PKG-01",
        "--files",
        "src/a.ts",
        "--cwd",
        root,
      ],
      { logger: scopeLog },
    ),
    0,
  );
  assert.match(scopeLog.text(), /ALLOWED code\.modify as WORKER \(DEV\)/);

  const explainLog = memoryLogger();
  assert.equal(await runCli(["permit", "explain", "qa.result.submit", "--json", "--cwd", root], { logger: explainLog }), 0);
  const explanation = explainLog.lines.json.at(-1);
  assert.ok(explanation.operation.id === "qa.result.submit");
  assert.ok(explanation.reasonCodes.includes(REASON.SELF_REVIEW_DENIED));

  const auditLog = memoryLogger();
  assert.equal(await runCli(["permit", "audit", "--json", "--cwd", root], { logger: auditLog }), 0);
  const audit = auditLog.lines.json.at(-1);
  assert.ok(audit.count >= 2);
  assert.ok(audit.entries.some((entry) => entry.operation === "code.modify"));
});

test("permit check validates subject input", async (t) => {
  const { root } = await setup(t);
  const noSubject = memoryLogger();
  assert.equal(await runCli(["permit", "check", "project.view", "--cwd", root], { logger: noSubject }), 2);
  assert.match(noSubject.errorText(), /--subject/);

  const unknownOperation = memoryLogger();
  assert.equal(await runCli(["permit", "check", "nope", "--subject", "HUMAN", "--cwd", root], { logger: unknownOperation }), 1);
  assert.match(unknownOperation.errorText(), /OPERATION_NOT_REGISTERED/);

  const unknownAgent = memoryLogger();
  assert.equal(
    await runCli(["permit", "check", "project.view", "--agent", "agent-ghost-01", "--cwd", root], { logger: unknownAgent }),
    1,
  );
  assert.match(unknownAgent.errorText(), /SUBJECT_UNKNOWN/);
});

test("permit check evaluates evidence identity through the CLI", async (t) => {
  const { root } = await setup(t, {
    files: {
      "manifest.json": manifestFixture(),
      "qa.json": approvalFixture(),
    },
  });
  const allowed = memoryLogger();
  assert.equal(
    await runCli(
      [
        "permit",
        "check",
        "qa.result.submit",
        "--agent",
        "agent-qa-01",
        "--manifest",
        "manifest.json",
        "--qa",
        "qa.json",
        "--cwd",
        root,
      ],
      { logger: allowed },
    ),
    0,
  );
  assert.match(allowed.text(), /ALLOWED qa\.result\.submit as REVIEWER \(QA\)/);

  const denied = memoryLogger();
  assert.equal(
    await runCli(
      [
        "permit",
        "check",
        "qa.result.submit",
        "--agent",
        "agent-dev-01",
        "--manifest",
        "manifest.json",
        "--qa",
        "qa.json",
        "--cwd",
        root,
      ],
      { logger: denied },
    ),
    1,
  );
  // agent-dev-01 is a WORKER instance: the matrix denies QA submission outright.
  assert.match(denied.errorText(), /ROLE_DENIED/);
});

test("production access needs both human approval and a controlled process", async (t) => {
  const { root } = await setup(t);
  const oneStep = memoryLogger();
  assert.equal(
    await runCli(["permit", "check", "production.trade.access", "--subject", "HUMAN", "--approved", "--cwd", root], { logger: oneStep }),
    1,
  );
  assert.match(oneStep.errorText(), /APPROVAL_REQUIRED/);

  const controlled = memoryLogger();
  assert.equal(
    await runCli(
      ["permit", "check", "production.trade.access", "--subject", "HUMAN", "--approved", "--controlled", "--cwd", root],
      { logger: controlled },
    ),
    0,
  );
  assert.match(controlled.text(), /ALLOWED production\.trade\.access/);
});

test("permit explain reports unknown operations", async (t) => {
  const { root } = await setup(t);
  const log = memoryLogger();
  assert.equal(await runCli(["permit", "explain", "nope", "--cwd", root], { logger: log }), 1);
  assert.match(log.errorText(), /unknown operation/);
});
