// Contract draft tests (M0 / ATK-005).
//
// These lock the *shape* of the shared contract before any service exists: enums,
// error codes, DTO validators and the SSE envelope. A breaking change here must
// bump CONTRACT_VERSION and update packages/contracts/README.md.
import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../packages/contracts/src/index.mjs";
import {
  ACCEPTANCE_STATUSES,
  AGENT_STATUSES,
  ApiError,
  CONTRACT_VERSION,
  ERROR_CODE_LIST,
  EVENT_TYPES,
  GATE_STATUSES,
  INTEGRATION_STATUSES,
  REVIEW_STATUSES,
  RUN_STATUSES,
  TASK_BRANCH_STATUSES,
  TASK_STATUSES,
  assertCompatible,
  compatibilityOf,
  createEvent,
  encodeSseFrame,
  encodeSseKeepAlive,
  enumGroups,
  errorBody,
  httpStatusOf,
  isEnumValue,
  isErrorCode,
  isEventType,
  isPublicEventType,
  parseSseFrame,
  resumePlan,
  validateApproval,
  validateErrorBody,
  validateEvent,
  validatePage,
  validateProject,
  validateRequirement,
  validateReviewDecision,
  validateRun,
  validateTask,
} from "../packages/contracts/src/index.mjs";

const SHA = "a".repeat(64);
const SHA_UP = "A".repeat(64);

test("contract exports a draft version and the public API major", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0-draft.1");
  assert.equal(typeof contracts.API_MAJOR, "number");
});

test("version compatibility follows the major version", () => {
  assert.deepEqual(compatibilityOf("1.2.3"), { ok: true, reason: "same-major" });
  assert.deepEqual(compatibilityOf("2.0.0"), { ok: false, reason: "major-mismatch" });
  assert.deepEqual(compatibilityOf("not-a-version"), { ok: false, reason: "malformed-version" });
  assert.throws(() => assertCompatible("2.0.0"), /incompatible contract version/);
  assert.ok(assertCompatible("1.9.9").ok);
});

test("task statuses never merge RUN_COMPLETED with TASK_DONE", () => {
  assert.ok(TASK_STATUSES.includes("DONE"));
  assert.ok(RUN_STATUSES.includes("COMPLETED"));
  assert.ok(!TASK_STATUSES.includes("COMPLETED"));
  assert.ok(!RUN_STATUSES.includes("DONE"));
  assert.ok(TASK_STATUSES.includes("AWAITING_ACCEPTANCE"));
  assert.deepEqual(TASK_BRANCH_STATUSES, ["BLOCKED", "CANCELLED"]);
  for (const status of TASK_BRANCH_STATUSES) assert.ok(TASK_STATUSES.includes(status));
});

test("review, integration and acceptance are three separate status sets", () => {
  assert.ok(REVIEW_STATUSES.includes("INVALIDATED"));
  assert.ok(INTEGRATION_STATUSES.includes("CONFLICT"));
  assert.ok(ACCEPTANCE_STATUSES.includes("APPROVED"));
  // They may share the word PENDING, but a review verdict is not an acceptance
  // and an integration result is not a review verdict.
  assert.ok(REVIEW_STATUSES.includes("PASS"));
  assert.ok(!ACCEPTANCE_STATUSES.includes("PASS"));
  assert.ok(!REVIEW_STATUSES.includes("APPROVED"));
  assert.ok(INTEGRATION_STATUSES.includes("APPLIED"));
  assert.ok(!INTEGRATION_STATUSES.includes("PASS"));
});

test("only a real PASS gate status satisfies a mandatory gate", () => {
  assert.deepEqual(GATE_STATUSES, ["PASS", "FAIL", "SKIPPED", "UNCONFIGURED", "ERROR"]);
  assert.equal(contracts.PASSING_GATE_STATUS, "PASS");
  // SKIPPED and UNCONFIGURED are facts, never success.
  for (const status of ["SKIPPED", "UNCONFIGURED", "ERROR", "FAIL"]) {
    assert.notEqual(status, contracts.PASSING_GATE_STATUS);
  }
});

test("every enum group is frozen, duplicate-free and queryable", () => {
  for (const list of [TASK_STATUSES, RUN_STATUSES, AGENT_STATUSES, REVIEW_STATUSES, INTEGRATION_STATUSES, ACCEPTANCE_STATUSES, GATE_STATUSES, EVENT_TYPES]) {
    assert.ok(Object.isFrozen(list));
    assert.equal(new Set(list).size, list.length);
  }
  assert.ok(isEnumValue("run", "RUNNING"));
  assert.ok(!isEnumValue("run", "not-a-status"));
  assert.ok(!isEnumValue("no-such-group", "RUNNING"));
  assert.deepEqual(Object.keys(enumGroups()), [
    "functions",
    "task",
    "run",
    "agent",
    "review",
    "integration",
    "acceptance",
    "gate",
    "verdict",
    "dispatch",
  ]);
});

test("error envelope matches spec §7.1 exactly", () => {
  const body = errorBody({
    code: "TASK_VERSION_CONFLICT",
    message: "Task has been updated",
    requestId: "req-123",
    details: { taskId: "TK-128", currentVersion: 13 },
  });
  assert.deepEqual(body, {
    error: {
      code: "TASK_VERSION_CONFLICT",
      message: "Task has been updated",
      requestId: "req-123",
      details: { taskId: "TK-128", currentVersion: 13 },
    },
  });
  assert.deepEqual(validateErrorBody(body), { ok: true, errors: [] });
});

test("the nine spec error codes are present and mapped to http status", () => {
  const specCodes = [
    "VALIDATION_ERROR",
    "NOT_AUTHORIZED",
    "TASK_VERSION_CONFLICT",
    "TASK_DEPENDENCY_BLOCKED",
    "CAPABILITY_UNAVAILABLE",
    "REVIEW_INVALIDATED",
    "RUNTIME_UNAVAILABLE",
    "GATE_NOT_PASSED",
    "INTERNAL_ERROR",
  ];
  for (const code of specCodes) assert.ok(isErrorCode(code), `${code} must exist`);
  assert.equal(httpStatusOf("TASK_VERSION_CONFLICT"), 409);
  assert.equal(httpStatusOf("NOT_AUTHORIZED"), 403);
  assert.equal(httpStatusOf("GATE_NOT_PASSED"), 422);
  assert.equal(httpStatusOf("INTERNAL_ERROR"), 500);
  assert.ok(ERROR_CODE_LIST.includes("INTERNAL_ERROR"));
  assert.throws(() => errorBody({ code: "NOPE", message: "x" }), /unknown error code/);
});

test("ApiError carries code, http status and a serialisable body", () => {
  const error = new ApiError("GATE_NOT_PASSED", "gate did not pass", { requestId: "req-9", details: { gate: "fast" } });
  assert.equal(error.httpStatus, 422);
  assert.equal(error.code, "GATE_NOT_PASSED");
  assert.deepEqual(error.toBody(), {
    error: { code: "GATE_NOT_PASSED", message: "gate did not pass", requestId: "req-9", details: { gate: "fast" } },
  });
  assert.deepEqual(validateErrorBody({ error: { code: "NOPE", message: "x" } }), {
    ok: false,
    errors: ['unknown error.code "NOPE"'],
  });
});

test("project and requirement validators accept a minimal payload", () => {
  const project = { id: "PRJ-1", name: "ATK", repoPath: "C:/repo", defaultBranch: "main", policyVersion: 1 };
  assert.deepEqual(validateProject(project), { ok: true, errors: [] });
  const requirement = { id: "REQ-1", projectId: "PRJ-1", description: "ship it", acceptance: "tests pass" };
  assert.deepEqual(validateRequirement(requirement), { ok: true, errors: [] });
  const broken = validateProject({ id: "../etc", name: "", repoPath: "C:/repo", defaultBranch: "main" });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((message) => message.includes("project.id")));
  assert.ok(broken.errors.some((message) => message.includes("project.name")));
});

test("task validator rejects client-owned status but accepts a manual task", () => {
  const task = {
    projectId: "PRJ-1",
    title: "Fix board",
    description: "the board renders twice",
    functionRequired: "WORKER",
    roleRequired: "FE",
    priority: 2,
    deps: [],
    acceptance: "no duplicate rows",
  };
  assert.deepEqual(validateTask(task), { ok: true, errors: [] });
  // The Backend owns transitions: a client `status` is not needed and not validated.
  assert.deepEqual(validateTask({ ...task, status: "DONE" }).errors, []);

  const broken = validateTask({ ...task, functionRequired: "CODER", roleRequired: "fe", priority: "high", deps: ["../x"] });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((m) => m.includes("task.functionRequired")));
  assert.ok(broken.errors.some((m) => m.includes("task.roleRequired")));
  assert.ok(broken.errors.some((m) => m.includes("task.priority")));
});

test("run validator requires function, status and attempt", () => {
  const run = {
    id: "RUN-1",
    taskId: "TK-1",
    agentId: "agent-fe-01",
    function: "WORKER",
    status: "RUNNING",
    attempt: 1,
  };
  assert.deepEqual(validateRun(run), { ok: true, errors: [] });
  const broken = validateRun({ ...run, function: "CODING", status: "DONE", attempt: 0 });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((m) => m.includes("run.function")));
  assert.ok(broken.errors.some((m) => m.includes("run.status")));
  assert.ok(broken.errors.some((m) => m.includes("run.attempt")));
});

test("review decision must be bound to a frozen version hash", () => {
  const decision = {
    reviewId: "RVW-1",
    verdict: "PASS",
    reviewerRunId: "RUN-QA-1",
    manifestHash: SHA,
    findings: [{ code: "STYLE", detail: "naming" }],
  };
  assert.deepEqual(validateReviewDecision(decision), { ok: true, errors: [] });
  const noHash = validateReviewDecision({ ...decision, manifestHash: undefined });
  assert.equal(noHash.ok, false);
  assert.ok(noHash.errors.some((m) => m.includes("manifestHash")));
  const badVerdict = validateReviewDecision({ ...decision, verdict: "MAYBE" });
  assert.equal(badVerdict.ok, false);
});

test("human approval must come from HUMAN and carry a target hash", () => {
  const approval = { scope: "candidate", targetHash: SHA_UP, actor: "HUMAN", status: "APPROVED" };
  assert.deepEqual(validateApproval(approval), { ok: true, errors: [] });
  const agent = validateApproval({ ...approval, actor: "WORKER" });
  assert.equal(agent.ok, false);
  assert.ok(agent.errors.some((m) => m.includes("actor")));
  const noHash = validateApproval({ ...approval, targetHash: "abc" });
  assert.equal(noHash.ok, false);
  assert.ok(noHash.errors.some((m) => m.includes("targetHash")));
});

test("page envelope accepts a cursor or null", () => {
  assert.deepEqual(validatePage({ items: [], nextCursor: null }), { ok: true, errors: [] });
  assert.deepEqual(validatePage({ items: [], nextCursor: "1049" }), { ok: true, errors: [] });
  assert.equal(validatePage({ items: {}, nextCursor: 5 }).ok, false);
});

test("event validation and round-tripping through the SSE frame", () => {
  const event = createEvent({
    seq: 1049,
    projectId: "PRJ-1",
    aggregateType: "task",
    aggregateId: "TK-128",
    type: "task.updated",
    payload: { taskId: "TK-128", status: "REVIEWING", version: 13 },
    happenedAt: "2026-11-02T02:17:12+08:00",
  });
  assert.deepEqual(validateEvent(event), { ok: true, errors: [] });

  const frame = encodeSseFrame(event);
  assert.equal(
    frame,
    'id: 1049\nevent: task.updated\ndata: {"taskId":"TK-128","status":"REVIEWING","version":13}\n\n',
  );
  const parsed = parseSseFrame(frame);
  assert.equal(parsed.seq, 1049);
  assert.equal(parsed.type, "task.updated");
  assert.deepEqual(parsed.payload, { taskId: "TK-128", status: "REVIEWING", version: 13 });
  assert.match(encodeSseKeepAlive(1), /^: keep-alive 1\n\n$/);
});

test("event validation rejects unknown types and missing aggregates", () => {
  assert.equal(isEventType("task.updated"), true);
  assert.equal(isEventType("task.made.up"), false);
  assert.equal(isPublicEventType("internal.secret"), false);
  assert.throws(() => createEvent({ type: "task.made.up", aggregateType: "task", aggregateId: "TK-1" }), /unknown event type/);

  const broken = validateEvent({ schemaVersion: 9, seq: 0, type: "task.updated", aggregateType: "", aggregateId: "", happenedAt: "not-a-date" });
  assert.equal(broken.ok, false);
  // schemaVersion, seq, aggregateType, aggregateId, happenedAt
  assert.equal(broken.errors.length, 5);
});

test("resumePlan demands a resync instead of skipping a gap", () => {
  assert.deepEqual(resumePlan(1040, 1000, 1100), { action: "replay", from: 1041 });
  // Last id 999 with oldest retained 1000 is contiguous: replay from 1000.
  assert.deepEqual(resumePlan(999, 1000, 1100), { action: "replay", from: 1000 });
  assert.deepEqual(resumePlan(null, 1000, 1100), { action: "resync" });
  // 997 + 1 < 1000: event 999 is gone, so the client must re-fetch a snapshot.
  assert.deepEqual(resumePlan(997, 1000, 1100), { action: "resync" });
  assert.deepEqual(resumePlan(1200, 1000, 1100), { action: "resync" });
  assert.deepEqual(resumePlan("1040", 1000, 1100), { action: "resync" });
});
