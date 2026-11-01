// Tests for the entity permission layer: registry shape, deny-by-default,
// reason codes, condition evaluation, the append-only audit and the
// `atk permit` command.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
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
  await writeFile(path.join(gated.root, "artifacts", "agent-flow", "ci-fast-latest.json"), JSON.stringify({ ok: true }), "utf8");
  const green = await evaluatePermission(gatedCtx, {
    operation: "integration.merge.development",
    subject: "SYSTEM",
    qaPassed: true,
    noDrift: true,
  });
  assert.equal(green.allowed, true, green.detail);
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
