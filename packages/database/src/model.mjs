// Canonical entity model shared by the SQLite store and the in-memory store.
//
// Everything that decides *what an entity means* lives here: DTO validation
// (contracts), defaults, patch whitelists, version bumps, sorting and the
// overview projection. The two stores only differ in persistence, so this is
// how "memory must behave like SQLite" is kept true instead of hoped for.
import {
  ACCEPTANCE_STATUSES,
  AGENT_STATUSES,
  EVENT_SCHEMA_VERSION,
  FUNCTIONS,
  ID_RE,
  REVIEW_STATUSES,
  REVIEW_VERDICTS,
  RUN_STATUSES,
  TASK_STATUSES,
  createEvent,
  validateApproval,
  validateProject,
  validateRequirement,
  validateTask,
} from "@atk/contracts";
import { fail } from "./errors.mjs";

/** Schema version written by the latest migration file. */
export const SCHEMA_VERSION = 4;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 10000;
export const MAX_EVENT_LIMIT = 10000;
export const MAX_OVERVIEW_EVENTS = 20;

const ROLE_RE = /^[A-Z][A-Z0-9_]*$/;
const TASK_ID_RE = ID_RE;
let idCounter = 0;

export function generateId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${idCounter.toString(36).toUpperCase()}`;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nowIso(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("VALIDATION_ERROR", "now must be an ISO-8601 timestamp", { now: value ?? null });
  }
  return value;
}

export function isoOrNull(value) {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function ensurePlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail("VALIDATION_ERROR", `${label} must be an object`, { entity: label });
  }
  return value;
}

export function assertValid(validator, dto, label) {
  const result = validator(dto);
  if (!result.ok) {
    fail("VALIDATION_ERROR", `${label} is invalid: ${result.errors.join("; ")}`, {
      entity: label,
      errors: result.errors,
    });
  }
  return dto;
}

export function requireId(value, label) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    fail("VALIDATION_ERROR", `${label} must be an id string`, { entity: label, value: value ?? null });
  }
  return value;
}

export function normalizeLimit(value, { fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    fail("VALIDATION_ERROR", "limit must be a positive integer", { limit: value });
  }
  return Math.min(value, max);
}

/** Deduplicate id arrays while preserving first-seen order. */
export function dedupeIds(ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Serialise optional metadata; `undefined`/non-JSON values are rejected early. */
export function safeJson(value, label) {
  if (value === undefined) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    fail("VALIDATION_ERROR", `${label} must be JSON-serializable`, { entity: label, reason: error.message });
  }
  return text === undefined ? null : text;
}

export function parseJsonColumn(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function validateTaskStatus(status) {
  if (!TASK_STATUSES.includes(status)) {
    fail("VALIDATION_ERROR", `task.status must be one of the task enum values`, {
      status,
      allowed: TASK_STATUSES,
    });
  }
  return status;
}

// ---------------------------------------------------------------------------
// Task lifecycle state machine (implementation spec §5.2)
// ---------------------------------------------------------------------------
//
// This is a *pure* description of the legal task transitions, shared by the
// SQLite and the in-memory store: there is exactly one table in this package.
// See docs/architecture/m1-contracts.md §1 ("spec §5.2 状态机").
//
// Main chain (forward only):
//   DRAFT → READY → CLAIMED → RUNNING → REVIEWING → INTEGRATING
//         → AWAITING_ACCEPTANCE → DONE
//
// Branches:
//   * every non-terminal state may become BLOCKED;
//   * BLOCKED may re-enter the main chain at READY (the scheduler re-dispatches
//     from READY; there is no previous-state memory in schema v1);
//   * every non-DONE state may become CANCELLED (including BLOCKED);
//   * DONE and CANCELLED are terminal: nothing transitions out of them.
//
// `from === to` is always allowed and is handled as an idempotent success by
// `patchTask` (it is not listed in the transition table, which only says what a
// *change* to another state may be).
//
// Deliberately NOT allowed in M1 (no edges):
//   * skipping a main-chain step (READY → DONE, READY → REVIEWING, ...);
//   * going backwards (DONE → READY, REVIEWING → RUNNING, BLOCKED → RUNNING);
//   * DONE → CANCELLED (a finished task is not cancellable);
//   * any state → DRAFT (DRAFT is the initial state only).
// Rework loops (REVIEWING → RUNNING, INTEGRATING → RUNNING) need run/session
// knowledge and belong to the scheduler (M3); adding them here without that
// context would let a client re-open reviewed work.
export const TASK_MAIN_CHAIN = Object.freeze([
  "DRAFT",
  "READY",
  "CLAIMED",
  "RUNNING",
  "REVIEWING",
  "INTEGRATING",
  "AWAITING_ACCEPTANCE",
  "DONE",
]);

export const TASK_TERMINAL_STATUSES = Object.freeze(["DONE", "CANCELLED"]);

const TASK_STATUS_ORDER = new Map(TASK_STATUSES.map((status, index) => [status, index]));

const TASK_TRANSITIONS = Object.freeze(
  (() => {
    /** @type {Record<string, string[]>} */
    const table = Object.fromEntries(TASK_STATUSES.map((status) => [status, []]));
    const add = (from, to) => {
      if (from === to) return;
      if (!table[from].includes(to)) table[from].push(to);
    };
    for (let index = 0; index < TASK_MAIN_CHAIN.length - 1; index += 1) {
      add(TASK_MAIN_CHAIN[index], TASK_MAIN_CHAIN[index + 1]);
    }
    for (const status of TASK_STATUSES) {
      if (TASK_TERMINAL_STATUSES.includes(status)) continue;
      add(status, "BLOCKED");
      add(status, "CANCELLED");
    }
    add("BLOCKED", "READY");
    // M4 rework loop (ADR-005, m4-contracts §1). REJECTED is the "changes were
    // requested" waiting room, deliberately NOT on the main chain: it can only
    // be entered from REVIEWING / AWAITING_ACCEPTANCE and can only leave toward
    // READY (re-queue) or the generic BLOCKED/CANCELLED branches. There is no
    // REJECTED -> DONE edge: acceptance is the only DONE entrance.
    add("REVIEWING", "REJECTED");
    add("AWAITING_ACCEPTANCE", "REJECTED");
    add("REJECTED", "READY");
    // A human acceptance rejection is not a review-requested-changes state: the
    // Review is already PASS, so parking the Task in REJECTED would leave it
    // with no legal exit (only reworkTask, which requires CHANGES_REQUESTED,
    // could move it). The acceptance workflow therefore re-queues directly:
    // AWAITING_ACCEPTANCE -> READY (Lead ruling, m4-contracts §1 line 50).
    add("AWAITING_ACCEPTANCE", "READY");
    for (const status of TASK_STATUSES) {
      table[status].sort((a, b) => TASK_STATUS_ORDER.get(a) - TASK_STATUS_ORDER.get(b));
      Object.freeze(table[status]);
    }
    return Object.freeze(table);
  })(),
);

/**
 * Pure predicate: may a task move from `from` to `to`?
 * Same-state (`from === to`) is allowed (idempotent/no-op change); unknown
 * values return `false` instead of throwing, so callers can probe safely.
 */
export function canTransition(from, to) {
  if (!TASK_STATUSES.includes(from) || !TASK_STATUSES.includes(to)) return false;
  if (from === to) return true;
  return TASK_TRANSITIONS[from].includes(to);
}

/** The transitions out of `from` to a *different* state, in enum order. */
export function allowedTransitionsFrom(from) {
  if (!TASK_STATUSES.includes(from)) return [];
  return [...TASK_TRANSITIONS[from]];
}

/** Throw the contract error for an illegal transition (never a version clash). */
export function assertTaskTransition(from, to) {
  if (canTransition(from, to)) return true;
  fail("VALIDATION_ERROR", `task.status cannot transition from ${from} to ${to}`, {
    from,
    to,
    allowed: allowedTransitionsFrom(from),
  });
}

/** Named, frozen view of the machine (pure functions only, no state). */
export const taskStatusMachine = Object.freeze({
  mainChain: TASK_MAIN_CHAIN,
  terminal: TASK_TERMINAL_STATUSES,
  transitions: TASK_TRANSITIONS,
  canTransition,
  allowedTransitions: allowedTransitionsFrom,
});

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export function normalizeProject(dto, { now } = {}) {
  assertValid(validateProject, dto, "project");
  const at = nowIso(now);
  return {
    id: dto.id,
    name: dto.name,
    repoPath: dto.repoPath,
    defaultBranch: dto.defaultBranch,
    policyVersion: Number.isInteger(dto.policyVersion) ? dto.policyVersion : 0,
    version: 0,
    createdAt: isoOrNull(dto.createdAt) ?? at,
    updatedAt: isoOrNull(dto.updatedAt) ?? at,
  };
}

export const PROJECT_PATCH_KEYS = Object.freeze(["name", "repoPath", "defaultBranch", "policyVersion"]);

export function mergeProject(current, changes, { now } = {}) {
  ensurePlainObject(changes, "changes");
  for (const key of Object.keys(changes)) {
    if (!PROJECT_PATCH_KEYS.includes(key)) {
      fail("VALIDATION_ERROR", `project.changes.${key} is not patchable`, {
        entity: "project",
        field: key,
        allowed: PROJECT_PATCH_KEYS,
      });
    }
  }
  const merged = { ...current, ...changes };
  assertValid(validateProject, merged, "project");
  return {
    ...merged,
    id: current.id,
    version: current.version + 1,
    createdAt: current.createdAt,
    updatedAt: nowIso(now),
  };
}

// ---------------------------------------------------------------------------
// Requirement
// ---------------------------------------------------------------------------

export function normalizeRequirement(dto, { now } = {}) {
  assertValid(validateRequirement, dto, "requirement");
  const at = nowIso(now);
  const requirement = {
    id: dto.id,
    projectId: dto.projectId,
    description: dto.description,
    version: 0,
    createdAt: at,
    updatedAt: at,
  };
  if (dto.acceptance !== undefined && dto.acceptance !== null) requirement.acceptance = dto.acceptance;
  return requirement;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/**
 * `status` is never taken from the caller: `createTask` always starts at READY
 * (contracts §1: "客户端不得直接设 status"), every later transition goes
 * through `patchTask`. `dto.createdAt`/`dto.updatedAt` are internal migration
 * metadata and are ignored for API callers that do not send them.
 */
export function normalizeTask(dto, { now, status = "READY", version = 0 } = {}) {
  assertValid(validateTask, dto, "task");
  if (dto.id !== undefined) {
    if (typeof dto.id !== "string" || !TASK_ID_RE.test(dto.id)) {
      fail("VALIDATION_ERROR", "task.id must be an id string", { entity: "task", value: dto.id });
    }
  }
  validateTaskStatus(status);
  const at = nowIso(now);
  const task = {
    id: dto.id ?? generateId("TASK"),
    projectId: dto.projectId,
    title: dto.title,
    description: dto.description,
    functionRequired: dto.functionRequired,
    roleRequired: dto.roleRequired,
    priority: dto.priority,
    deps: dedupeIds(dto.deps),
    status,
    version,
    createdAt: isoOrNull(dto.createdAt) ?? at,
    updatedAt: isoOrNull(dto.updatedAt) ?? at,
  };
  if (dto.acceptance !== undefined && dto.acceptance !== null) task.acceptance = dto.acceptance;
  if (dto.planId !== undefined && dto.planId !== null) task.planId = dto.planId;
  // M3 write scope (optional). An empty list is stored as "no files", not as [].
  const taskFiles = validateFiles(dto.files, "task.files");
  if (taskFiles.length > 0) task.files = taskFiles;
  // M4: current candidate hash used by human acceptance (optional).
  if (dto.targetHash !== undefined && dto.targetHash !== null) {
    task.targetHash = validateTargetHash(dto.targetHash, "task.targetHash");
  }
  return task;
}

export const TASK_PATCH_KEYS = Object.freeze([
  "title",
  "description",
  "functionRequired",
  "roleRequired",
  "priority",
  "acceptance",
  "planId",
  "status",
  "deps",
  "files",
  "targetHash",
]);

export function mergeTask(current, changes, { now } = {}) {
  ensurePlainObject(changes, "changes");
  // Hard invariant (M4): human acceptance is the ONLY way into DONE. The store
  // must enforce it too, not just the Backend route, so internal callers and
  // future endpoints cannot bypass the approval gate.
  if (changes.status === "DONE" && current.status !== "DONE") {
    fail("TASK_VERSION_CONFLICT", "task DONE requires an APPROVED human approval", {
      taskId: current.id,
      reason: "human-approval-required",
      requestedStatus: "DONE",
    });
  }
  for (const key of Object.keys(changes)) {
    if (!TASK_PATCH_KEYS.includes(key)) {
      fail("VALIDATION_ERROR", `task.changes.${key} is not patchable`, {
        entity: "task",
        field: key,
        allowed: TASK_PATCH_KEYS,
      });
    }
  }
  const merged = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (key === "deps") {
      if (!Array.isArray(value)) {
        fail("VALIDATION_ERROR", "task.changes.deps must be an array of task ids", {
          entity: "task",
          field: "deps",
        });
      }
      merged.deps = dedupeIds(value);
    } else if (key === "files") {
      const files = validateFiles(value, "task.changes.files");
      if (files.length === 0) delete merged.files;
      else merged.files = files;
    } else if (key === "acceptance" || key === "planId") {
      if (value === null || value === undefined) delete merged[key];
      else merged[key] = value;
    } else if (key === "targetHash") {
      if (value === null || value === undefined) delete merged.targetHash;
      else merged.targetHash = validateTargetHash(value, "task.changes.targetHash");
    } else merged[key] = value;
  }
  validateTaskStatus(merged.status);
  // spec §5.2: transitions are validated by the pure state machine above, so a
  // client cannot jump READY → DONE / CANCELLED or reopen a terminal task.
  // Both store implementations call mergeTask, so they share this one judgement.
  assertTaskTransition(current.status, merged.status);
  assertValid(validateTask, merged, "task");
  return {
    ...merged,
    id: current.id,
    projectId: current.projectId,
    version: current.version + 1,
    createdAt: current.createdAt,
    updatedAt: nowIso(now),
  };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function validateAgentDto(dto) {
  const errors = [];
  if (!isPlainObject(dto)) return { ok: false, errors: ["agent must be an object"] };
  if (typeof dto.id !== "string" || !ID_RE.test(dto.id)) errors.push("agent.id must be an id string");
  if (typeof dto.role !== "string" || !ROLE_RE.test(dto.role)) {
    errors.push("agent.role must be an upper-case role identifier");
  }
  if (!Array.isArray(dto.capabilities) || dto.capabilities.length === 0) {
    errors.push("agent.capabilities must be a non-empty array of Functions");
  } else {
    for (const [index, capability] of dto.capabilities.entries()) {
      if (!FUNCTIONS.includes(capability)) errors.push(`agent.capabilities[${index}] must be a Function`);
    }
  }
  if (dto.status !== undefined && !AGENT_STATUSES.includes(dto.status)) {
    errors.push("agent.status must be one of the agent enum values");
  }
  if (dto.task !== undefined && dto.task !== null && typeof dto.task !== "string") {
    errors.push("agent.task must be a string");
  }
  if (dto.detail !== undefined && dto.detail !== null && typeof dto.detail !== "string") {
    errors.push("agent.detail must be a string");
  }
  if (dto.since !== undefined && dto.since !== null && (typeof dto.since !== "string" || Number.isNaN(Date.parse(dto.since)))) {
    errors.push("agent.since must be an ISO-8601 timestamp");
  }
  return { ok: errors.length === 0, errors };
}

function assertValidAgent(dto) {
  const result = validateAgentDto(dto);
  if (!result.ok) {
    fail("VALIDATION_ERROR", `agent is invalid: ${result.errors.join("; ")}`, {
      entity: "agent",
      errors: result.errors,
    });
  }
}

export function normalizeAgent(dto, { now, version = 0, createdAt } = {}) {
  assertValidAgent(dto);
  const at = nowIso(now);
  const agent = {
    id: dto.id,
    role: dto.role,
    capabilities: [...new Set(dto.capabilities)],
    status: dto.status ?? "OFFLINE",
    version,
    createdAt: createdAt ?? at,
    updatedAt: at,
  };
  if (dto.task !== undefined && dto.task !== null) agent.task = dto.task;
  if (dto.detail !== undefined && dto.detail !== null) agent.detail = dto.detail;
  if (dto.since !== undefined && dto.since !== null) agent.since = dto.since;
  return agent;
}

export function mergeAgent(current, dto, { now } = {}) {
  const merged = { ...current };
  for (const key of Object.keys(dto)) {
    if (dto[key] !== undefined) merged[key] = dto[key];
  }
  assertValidAgent(merged);
  return {
    ...merged,
    id: current.id,
    capabilities: [...new Set(merged.capabilities)],
    version: current.version + 1,
    createdAt: current.createdAt,
    updatedAt: nowIso(now),
  };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export function normalizeApproval(dto, { now, id } = {}) {
  const result = validateApproval(dto);
  if (!result.ok) {
    fail("VALIDATION_ERROR", `approval is invalid: ${result.errors.join("; ")}`, {
      entity: "approval",
      errors: result.errors,
    });
  }
  if (dto.projectId !== undefined && dto.projectId !== null) requireId(dto.projectId, "approval.projectId");
  if (dto.taskId !== undefined && dto.taskId !== null) requireId(dto.taskId, "approval.taskId");
  const at = nowIso(now);
  const approval = {
    id: id ?? generateId("APR"),
    scope: dto.scope,
    targetHash: dto.targetHash,
    actor: "HUMAN",
    status: dto.status,
    at: dto.at ?? at,
    createdAt: at,
  };
  if (dto.projectId !== undefined && dto.projectId !== null) approval.projectId = dto.projectId;
  if (dto.taskId !== undefined && dto.taskId !== null) approval.taskId = dto.taskId;
  return approval;
}

// ---------------------------------------------------------------------------
// Review / rework / approval (M4, m4-contracts §1, ADR-005)
// ---------------------------------------------------------------------------
//
// Review state is the verdict itself: PENDING -> PASS | CHANGES_REQUESTED |
// BLOCKED. `FAIL` stays in contracts for QA receipts but is never written by
// this store as a review status (a failed review run is a BLOCKED outcome).
export const REVIEW_M4_STATUSES = Object.freeze(["PENDING", "PASS", "CHANGES_REQUESTED", "BLOCKED"]);
export const REVIEW_M4_VERDICTS = Object.freeze(["PASS", "CHANGES_REQUESTED", "BLOCKED"]);
export const DEFAULT_MAX_REVIEW_ATTEMPTS = 3;
/** Sanity bound for test evidence counters (QA-005): prevents absurd integers. */
export const MAX_REVIEW_TEST_TOTAL = 1_000_000;

/** A non-empty, bounded token (hashes, commit shas). */
export function validateToken(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 256 ||
    /[\u0000-\u001f]/.test(value)
  ) {
    fail("VALIDATION_ERROR", `${label} must be a non-empty string`, { entity: label, value: value ?? null });
  }
  return value;
}

export function validateTargetHash(value, label = "targetHash") {
  return validateToken(value, label);
}

/**
 * Canonical form used *only* for identity comparison (self-review): trim and
 * casefold. Stored/displayed values keep the caller's exact spelling.
 */
export function canonicalAgentId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Actors must already be in normalised form: the string must equal its own
 * trim(), otherwise a PASS could smuggle " agent-dev " past an exact-match
 * self-review check (QA-005 MAJOR). Case is folded separately for comparison.
 */
export function validateActor(value, label = "actor") {
  validateToken(value, label);
  if (value !== value.trim()) {
    fail("VALIDATION_ERROR", `${label} must not have leading or trailing whitespace`, {
      entity: label,
      value,
      reason: "actor-not-normalized",
    });
  }
  return value;
}

export function validateReviewStatus(status) {
  if (!REVIEW_M4_STATUSES.includes(status)) {
    fail("VALIDATION_ERROR", "review.status must be a review status", {
      status,
      allowed: REVIEW_M4_STATUSES,
    });
  }
  return status;
}

export function validateReviewVerdict(verdict) {
  if (!REVIEW_M4_VERDICTS.includes(verdict)) {
    fail("VALIDATION_ERROR", "review.verdict must be PASS, CHANGES_REQUESTED or BLOCKED", {
      verdict,
      allowed: REVIEW_M4_VERDICTS,
    });
  }
  return verdict;
}

/** Validate the test evidence block a PASS must carry (m4-contracts §1). */
export function validateReviewEvidence(evidence) {
  if (!isPlainObject(evidence)) {
    fail("VALIDATION_ERROR", "review.evidence must be an object", { evidence: evidence ?? null });
  }
  const tests = evidence.tests;
  if (!isPlainObject(tests)) {
    fail("VALIDATION_ERROR", "review.evidence.tests must be an object", { evidence });
  }
  if (
    !Number.isInteger(tests.passed) ||
    !Number.isInteger(tests.total) ||
    tests.passed < 0 ||
    tests.total <= 0 ||
    tests.passed > tests.total
  ) {
    fail("VALIDATION_ERROR", "review.evidence.tests needs integer passed/total with 0 <= passed <= total", {
      tests,
    });
  }
  if (tests.total > MAX_REVIEW_TEST_TOTAL) {
    fail("EVIDENCE_MISSING", "review.evidence.tests.total is out of range", {
      reason: "evidence-out-of-range",
      tests,
      maxTotal: MAX_REVIEW_TEST_TOTAL,
    });
  }
  return evidence;
}

/**
 * Hard invariant: a PASS without a manifest hash and full passing test evidence
 * is not a review. Errors use EVIDENCE_MISSING so the public API can map to 400.
 */
export function assertPassEvidence({ manifestHash, evidence, taskId, reviewId } = {}) {
  const missing = [];
  if (typeof manifestHash !== "string" || manifestHash.trim() === "") missing.push("manifestHash");
  if (!isPlainObject(evidence) || !isPlainObject(evidence.tests)) {
    missing.push("evidence.tests");
  } else {
    const { passed, total } = evidence.tests;
    if (!Number.isInteger(passed) || !Number.isInteger(total) || total <= 0) {
      missing.push("evidence.tests");
    } else if (passed !== total) {
      missing.push("passed===total");
    }
  }
  if (missing.length > 0) {
    fail("EVIDENCE_MISSING", "a PASS review requires a manifest hash and passing test evidence", {
      taskId: taskId ?? null,
      reviewId: reviewId ?? null,
      missing,
    });
  }
  const { passed, total } = evidence.tests;
  if (total > MAX_REVIEW_TEST_TOTAL || passed < 0 || passed > total) {
    fail("EVIDENCE_MISSING", "a PASS review has out-of-range test counters", {
      taskId: taskId ?? null,
      reviewId: reviewId ?? null,
      reason: "evidence-out-of-range",
      tests: evidence.tests,
      maxTotal: MAX_REVIEW_TEST_TOTAL,
    });
  }
  return { manifestHash, evidence };
}

function validateFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    fail("VALIDATION_ERROR", "review.findings must be a non-empty array", {
      findings: findings ?? null,
    });
  }
  findings.forEach((finding, index) => {
    if (!isPlainObject(finding)) {
      fail("VALIDATION_ERROR", `review.findings[${index}] must be an object`, { index });
    }
  });
  return findings;
}

/** Build a new PENDING review; store checks Task/Run facts separately. */
export function normalizeReview(dto, { now, attempt = 1, id } = {}) {
  ensurePlainObject(dto, "review");
  requireId(dto.taskId, "review.taskId");
  if (dto.runId !== undefined && dto.runId !== null) requireId(dto.runId, "review.runId");
  const actor = validateActor(dto.actor, "review.actor");
  const at = nowIso(now);
  const review = {
    id: id ?? generateId("REV"),
    taskId: dto.taskId,
    status: "PENDING",
    attempt: Number.isInteger(dto.attempt) && dto.attempt >= 1 ? dto.attempt : attempt,
    version: 0,
    createdAt: at,
    updatedAt: at,
  };
  if (dto.runId !== undefined && dto.runId !== null) review.runId = dto.runId;
  return { review, actor };
}

/**
 * Apply a verdict to a PENDING review. Returns the next review object; the
 * caller is responsible for the Task transition and the audit/event writes, so
 * failures here happen before any mutation (zero-write guarantee).
 */
export function applyReviewVerdict(current, dto, { now } = {}) {
  const verdict = validateReviewVerdict(dto.verdict);
  const actor = validateActor(dto.actor, "review.actor");
  const at = nowIso(now);
  const next = {
    ...current,
    status: verdict,
    verdict,
    reviewer: actor,
    submittedAt: at,
    updatedAt: at,
    version: current.version + 1,
  };
  if (dto.manifestHash !== undefined && dto.manifestHash !== null) {
    next.manifestHash = validateTargetHash(dto.manifestHash, "review.manifestHash");
  }
  if (dto.commitSha !== undefined && dto.commitSha !== null) {
    next.commitSha = validateToken(dto.commitSha, "review.commitSha");
  }
  if (dto.findings !== undefined && dto.findings !== null) {
    if (verdict === "CHANGES_REQUESTED") {
      next.findings = validateFindings(dto.findings);
    } else {
      // PASS/BLOCKED may carry findings, but they are optional: an empty array
      // (the Backend default) is valid and must not reject a legal verdict.
      if (!Array.isArray(dto.findings)) {
        fail("VALIDATION_ERROR", "review.findings must be an array", { findings: dto.findings });
      }
      dto.findings.forEach((finding, index) => {
        if (!isPlainObject(finding)) {
          fail("VALIDATION_ERROR", `review.findings[${index}] must be an object`, { index });
        }
      });
      next.findings = dto.findings;
    }
  }
  if (verdict === "PASS") {
    // PASS evidence is checked by the hard-invariant validator first so every
    // missing piece is reported as EVIDENCE_MISSING (not a generic schema error).
    assertPassEvidence({
      manifestHash: dto.manifestHash,
      evidence: dto.evidence,
      taskId: current.taskId,
      reviewId: current.id,
    });
    if (dto.evidence !== undefined && dto.evidence !== null) next.evidence = dto.evidence;
  } else if (dto.evidence !== undefined && dto.evidence !== null) {
    next.evidence = validateReviewEvidence(dto.evidence);
  }
  if (verdict === "CHANGES_REQUESTED") {
    if (dto.findings === undefined || dto.findings === null) {
      fail("VALIDATION_ERROR", "CHANGES_REQUESTED requires findings", {
        taskId: current.taskId,
        reviewId: current.id,
      });
    }
    validateFindings(dto.findings);
  }
  return next;
}

export function validateApprovalDecision(decision) {
  if (decision !== "APPROVED" && decision !== "REJECTED") {
    fail("VALIDATION_ERROR", "approval.decision must be APPROVED or REJECTED", {
      decision: decision ?? null,
      allowed: ["APPROVED", "REJECTED"],
    });
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Build an Event through contracts.createEvent() (the single definition of the
 * envelope) and let the store assign `seq`. Only the fields the contract names
 * exist here — no ad-hoc additions.
 */
export function makeEvent({ projectId = null, aggregateType, aggregateId, type, payload, now } = {}) {
  if (projectId !== null && (typeof projectId !== "string" || projectId.trim() === "")) {
    fail("VALIDATION_ERROR", "event.projectId must be a non-empty string or null", { projectId });
  }
  if (typeof aggregateType !== "string" || aggregateType.trim() === "") {
    fail("VALIDATION_ERROR", "event.aggregateType is required", { aggregateType: aggregateType ?? null });
  }
  if (typeof aggregateId !== "string" || aggregateId.trim() === "") {
    fail("VALIDATION_ERROR", "event.aggregateId is required", { aggregateId: aggregateId ?? null });
  }
  if (payload !== undefined && payload !== null && !isPlainObject(payload)) {
    fail("VALIDATION_ERROR", "event.payload must be an object", { payloadType: typeof payload });
  }
  let event;
  try {
    event = createEvent({
      projectId,
      aggregateType,
      aggregateId,
      type,
      payload: payload ?? {},
      happenedAt: nowIso(now),
    });
  } catch (error) {
    fail("VALIDATION_ERROR", error.message, { type: type ?? null });
  }
  return event;
}

export { EVENT_SCHEMA_VERSION };

// ---------------------------------------------------------------------------
// Run lifecycle state machine (m2-contracts §2)
// ---------------------------------------------------------------------------
//
//   QUEUED → STARTING → RUNNING → COMPLETED | FAILED | CANCELLED | INTERRUPTED
//
//   * STARTING may go to RUNNING | FAILED | INTERRUPTED: a session that never
//     started cannot "complete"; it failed/interrupted on the way up.
//   * RUNNING may go to any terminal state.
//   * COMPLETED/FAILED/CANCELLED/INTERRUPTED are terminal: nothing transitions
//     out of them (a finished run is history, not a branch).
//   * Same-state (`from === to`) is an idempotent no-op handled by
//     updateRunStatus (returns the current row, never a second event).
//
// The table lives here, next to the Task machine, and is used by both stores.
export const RUN_TERMINAL_STATUSES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]);

/** Runs that still occupy an agent/task slot ("active" for scheduling). */
export const ACTIVE_RUN_STATUSES = Object.freeze(["QUEUED", "STARTING", "RUNNING"]);

const RUN_TRANSITIONS = Object.freeze({
  QUEUED: Object.freeze(["STARTING"]),
  STARTING: Object.freeze(["RUNNING", "FAILED", "INTERRUPTED"]),
  RUNNING: Object.freeze(["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  INTERRUPTED: Object.freeze([]),
});

const RUN_STATUS_ORDER = new Map(RUN_STATUSES.map((status, index) => [status, index]));

export function canTransitionRun(from, to) {
  if (!RUN_STATUSES.includes(from) || !RUN_STATUSES.includes(to)) return false;
  if (from === to) return true;
  return RUN_TRANSITIONS[from].includes(to);
}

export function allowedRunTransitionsFrom(from) {
  if (!RUN_STATUSES.includes(from)) return [];
  return [...RUN_TRANSITIONS[from]];
}

/** Illegal Run transition → VALIDATION_ERROR + details {from,to,allowed}. */
export function assertRunTransition(from, to) {
  if (canTransitionRun(from, to)) return true;
  fail("VALIDATION_ERROR", `run.status cannot transition from ${from} to ${to}`, {
    from,
    to,
    allowed: allowedRunTransitionsFrom(from),
  });
}

export const runStatusMachine = Object.freeze({
  terminal: RUN_TERMINAL_STATUSES,
  transitions: RUN_TRANSITIONS,
  canTransition: canTransitionRun,
  allowedTransitions: allowedRunTransitionsFrom,
  statusOrder: RUN_STATUS_ORDER,
});

// ---------------------------------------------------------------------------
// Run / dispatch / lease DTO helpers (m2-contracts §3)
// ---------------------------------------------------------------------------

export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LEASE_MS = 30_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

function requireNonEmptyString(value, label, { maxLength = 256 } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("VALIDATION_ERROR", `${label} must be a non-empty string`, { entity: label, value: value ?? null });
  }
  if (value.length > maxLength) {
    fail("VALIDATION_ERROR", `${label} must be at most ${maxLength} characters`, {
      entity: label,
      length: value.length,
    });
  }
  if (/[\u0000-\u001f]/.test(value)) {
    fail("VALIDATION_ERROR", `${label} must not contain control characters`, { entity: label });
  }
  return value;
}

/** Runtime host identity; also used as the lease holder. */
export function validateOwnerId(value) {
  return requireNonEmptyString(value, "ownerId", { maxLength: 128 });
}

export function validateLeaseMs(value, { fallback = undefined } = {}) {
  const leaseMs = value === undefined || value === null ? fallback : value;
  if (leaseMs === undefined) {
    fail("VALIDATION_ERROR", "leaseMs is required", { leaseMs: value ?? null });
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    fail("VALIDATION_ERROR", `leaseMs must be an integer between 1 and ${MAX_LEASE_MS}`, { leaseMs });
  }
  return leaseMs;
}

export function validateIdempotencyKey(value) {
  return requireNonEmptyString(value, "idempotencyKey", { maxLength: MAX_IDEMPOTENCY_KEY_LENGTH });
}

export function validateCommandType(value) {
  return requireNonEmptyString(value, "commandType", { maxLength: 64 });
}

export function validateCommandPayload(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    fail("VALIDATION_ERROR", "command.payload must be an object", { payloadType: typeof value });
  }
  return value;
}

// ---------------------------------------------------------------------------
// M3 scheduling metadata: write scope (files) + per-project policy
// ---------------------------------------------------------------------------

/**
 * Write scope is a list of repo-relative paths. Kept small and safe: no absolute
 * paths, no `..` segments, no NUL, deduplicated, at most 1000 entries. `undefined`
 * means "no declared write scope" and normalises to [].
 */
export function validateFiles(value, label = "files") {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail("VALIDATION_ERROR", `${label} must be an array of paths`, { entity: label, value: value ?? null });
  }
  if (value.length > 1000) {
    fail("VALIDATION_ERROR", `${label} accepts at most 1000 paths`, { entity: label, length: value.length });
  }
  const files = [];
  const seen = new Set();
  for (const [index, file] of value.entries()) {
    if (typeof file !== "string" || file.trim() === "") {
      fail("VALIDATION_ERROR", `${label}[${index}] must be a non-empty string`, { entity: label, index });
    }
    if (file.length > 512) {
      fail("VALIDATION_ERROR", `${label}[${index}] must be at most 512 characters`, { entity: label, index });
    }
    // Canonicalise once at the boundary (same semantics as scheduler-core:
    // backslashes -> '/', remove './', resolve '..' lexically, reject escapes)
    // so stored scopes can never alias each other.
    const normalised = normalizeRepoPath(file, `${label}[${index}]`);
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    files.push(normalised);
  }
  return files;
}

/**
 * Repo-relative path canonicalisation shared by validation and write-scope
 * comparison. Rejects absolute paths, NUL bytes and `..` escapes; resolves
 * harmless `.`/`..` segments lexically ("a/../b" -> "b", "./src/a.js" ->
 * "src/a.js", "src\\a.js" -> "src/a.js").
 */
export function normalizeRepoPath(value, label = "path") {
  if (typeof value !== "string" || value.trim() === "") {
    fail("VALIDATION_ERROR", `${label} must be a non-empty string`, { entity: label, value: value ?? null });
  }
  const slashed = value.replace(/\\/g, "/");
  if (slashed.includes("\0")) {
    fail("VALIDATION_ERROR", `${label} must not contain NUL bytes`, { entity: label });
  }
  if (/^[A-Za-z]:/.test(slashed) || slashed.startsWith("/")) {
    fail("VALIDATION_ERROR", `${label} must be a repo-relative path`, { entity: label, path: value });
  }
  const segments = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        fail("VALIDATION_ERROR", `${label} must stay inside the repository`, { entity: label, path: value });
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalised = segments.join("/");
  if (normalised === "") {
    fail("VALIDATION_ERROR", `${label} must point at a file inside the repository`, {
      entity: label,
      path: value,
    });
  }
  return normalised;
}

/** `projects.policy_json` payload; NULL/missing → {}. */
export function normalizeProjectPolicy(value, label = "project.policy") {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    fail("VALIDATION_ERROR", `${label} must be an object`, { entity: label, value: value ?? null });
  }
  return value;
}

const SCHEDULING_LIMIT_KEYS = Object.freeze(["maxConcurrentPerProject", "maxPerAgent"]);

/**
 * Capacity limits travel with each claim (Backend env/config → claimTask). An
 * omitted limit means "no capacity check"; a provided one must be a
 * non-negative integer (0 blocks all new claims for that scope).
 */
export function validateSchedulingPolicies(policies) {
  if (policies === undefined || policies === null) return {};
  if (!isPlainObject(policies)) {
    fail("VALIDATION_ERROR", "policies must be an object", { value: policies ?? null });
  }
  const effective = {};
  for (const key of SCHEDULING_LIMIT_KEYS) {
    const value = policies[key];
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0) {
      fail("VALIDATION_ERROR", `${key} must be a non-negative integer`, { field: key, value });
    }
    effective[key] = value;
  }
  return effective;
}

/** Sorted intersection of two write scopes (used by the claim conflict check). */
/**
 * Write-scope overlap, segment-aware (QA4-03): two canonical repo-relative paths
 * conflict when they are equal OR one is a path-segment prefix of the other
 * ("src" ⊂ "src/a.js"). A plain string prefix is NOT enough: "src2/a.js" must
 * not conflict with "src/a.js". Comparison is case-sensitive on every platform
 * (the repository paths are canonical POSIX-style strings, and Windows checkouts
 * keep the declared case), so "Src/a.js" and "src/a.js" are different files.
 *
 * Returns the sorted union of the conflicting canonical paths from both sides.
 */
export function filesIntersection(left, right) {
  const normalize = (file) => {
    try {
      return normalizeRepoPath(file);
    } catch {
      return file;
    }
  };
  const leftFiles = [...new Set(left.map(normalize))];
  const rightFiles = [...new Set(right.map(normalize))];
  const conflicts = new Set();
  for (const leftFile of leftFiles) {
    for (const rightFile of rightFiles) {
      if (
        leftFile === rightFile ||
        leftFile.startsWith(`${rightFile}/`) ||
        rightFile.startsWith(`${leftFile}/`)
      ) {
        conflicts.add(leftFile);
        conflicts.add(rightFile);
      }
    }
  }
  return [...conflicts].sort((a, b) => a.localeCompare(b));
}

export function leaseExpiryAfter(now, leaseMs) {
  return new Date(Date.parse(now) + leaseMs).toISOString();
}

/**
 * Build a new Run in STARTING (m2-contracts §3 / §2). `attempt` is resolved by
 * the store (same task, N-th run) and passed in; `dto.attempt` is validated but
 * the store's counter wins so two clients cannot collide on the same attempt.
 */
export function normalizeRun(dto, { now, attempt, id } = {}) {
  ensurePlainObject(dto, "run");
  const errors = [];
  if (typeof dto.taskId !== "string" || !ID_RE.test(dto.taskId)) errors.push("run.taskId must be an id string");
  if (typeof dto.agentId !== "string" || !ID_RE.test(dto.agentId)) errors.push("run.agentId must be an id string");
  if (!FUNCTIONS.includes(dto.function)) errors.push("run.function must be one of the Function enum values");
  if (typeof dto.role !== "string" || !ROLE_RE.test(dto.role)) {
    errors.push("run.role must be an upper-case role identifier");
  }
  if (dto.id !== undefined) {
    if (typeof dto.id !== "string" || !ID_RE.test(dto.id)) errors.push("run.id must be an id string");
  }
  if (dto.attempt !== undefined && (!Number.isInteger(dto.attempt) || dto.attempt < 1)) {
    errors.push("run.attempt must be a positive integer");
  }
  if (dto.workspaceId !== undefined && dto.workspaceId !== null) {
    if (typeof dto.workspaceId !== "string" || dto.workspaceId.trim() === "" || dto.workspaceId.length > 512) {
      errors.push("run.workspaceId must be a non-empty string");
    }
  }
  if (!Number.isInteger(attempt) || attempt < 1) errors.push("run.attempt could not be resolved");
  const runFiles = validateFiles(dto.files, "run.files");
  if (errors.length > 0) {
    fail("VALIDATION_ERROR", `run is invalid: ${errors.join("; ")}`, { entity: "run", errors });
  }
  const at = nowIso(now);
  const run = {
    id: id ?? dto.id ?? generateId("RUN"),
    taskId: dto.taskId,
    agentId: dto.agentId,
    function: dto.function,
    role: dto.role,
    status: "STARTING",
    attempt,
    version: 0,
    createdAt: at,
    updatedAt: at,
  };
  if (dto.workspaceId !== undefined && dto.workspaceId !== null) run.workspaceId = dto.workspaceId;
  if (runFiles.length > 0) run.files = runFiles;
  return run;
}

/**
 * Validate one Run status transition. Returns `{ updated: false, run }` for a
 * same-state call (idempotent success, no version bump, no duplicate event) or
 * `{ updated: true, run }` with version+1 timestamps applied.
 */
export function mergeRunStatus(current, changes, { now } = {}) {
  ensurePlainObject(changes, "run status changes");
  const { status, exitCode, endedAt } = changes;
  if (typeof status !== "string" || !RUN_STATUSES.includes(status)) {
    fail("VALIDATION_ERROR", "run.status must be one of the run enum values", {
      status: status ?? null,
      allowed: RUN_STATUSES,
    });
  }
  // Transition first: an illegal jump is the primary error even if the caller
  // also sent a nonsensical exitCode/endedAt.
  assertRunTransition(current.status, status);
  if (exitCode !== undefined && exitCode !== null && !Number.isInteger(exitCode)) {
    fail("VALIDATION_ERROR", "run.exitCode must be an integer or null", { exitCode });
  }
  if (endedAt !== undefined && endedAt !== null) {
    if (typeof endedAt !== "string" || Number.isNaN(Date.parse(endedAt))) {
      fail("VALIDATION_ERROR", "run.endedAt must be an ISO-8601 timestamp or null", { endedAt });
    }
    if (!RUN_TERMINAL_STATUSES.includes(status)) {
      fail("VALIDATION_ERROR", "run.endedAt is only valid for a terminal run status", { status });
    }
  }
  if (current.status === status) return { updated: false, run: current };

  const at = nowIso(now);
  const run = { ...current, status, version: current.version + 1, updatedAt: at };
  if (status === "RUNNING" && run.startedAt === undefined) run.startedAt = at;
  if (RUN_TERMINAL_STATUSES.includes(status)) {
    run.endedAt = endedAt ?? at;
  } else if (endedAt !== undefined) {
    run.endedAt = endedAt;
  }
  if (exitCode !== undefined) {
    if (exitCode === null) delete run.exitCode;
    else run.exitCode = exitCode;
  }
  return { updated: true, run };
}

/** Sort helper for listRuns (newest first, then id for stable output). */
export function compareRunsNewestFirst(a, b) {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

// ---------------------------------------------------------------------------
// Ordering and projections
// ---------------------------------------------------------------------------

/** Task order everywhere: urgent first, then oldest, then id. */
export function compareTasks(a, b) {
  return (
    a.priority - b.priority ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

export function compareEventsAsc(a, b) {
  return a.seq - b.seq;
}

/** Shared overview projection so SQLite and memory cannot drift (contracts §1). */
export function buildOverview({ project, tasks, recentEvents, runsRunning, runsTotal }) {
  const tasksByStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  for (const task of tasks) tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
  const blocked = tasks.filter((task) => task.status === "BLOCKED").sort(compareTasks);
  const awaitingAcceptance = tasks.filter((task) => task.status === "AWAITING_ACCEPTANCE").sort(compareTasks);
  return {
    project,
    counts: {
      tasksByStatus,
      runsRunning,
      runsTotal,
      awaitingAcceptance: awaitingAcceptance.length,
    },
    blocked,
    awaitingAcceptance,
    recentEvents,
  };
}

/** Enum guards re-exported for the stores. */
export const FILTER_STATUSES = {
  task: TASK_STATUSES,
  run: RUN_STATUSES,
  review: REVIEW_STATUSES,
  acceptance: ACCEPTANCE_STATUSES,
  agent: AGENT_STATUSES,
};

export function assertEnumFilter(group, value) {
  if (value === undefined || value === null) return undefined;
  const allowed = FILTER_STATUSES[group];
  if (!allowed || !allowed.includes(value)) {
    fail("VALIDATION_ERROR", `${group} filter must be one of the ${group} enum values`, {
      group,
      value,
      allowed: allowed ?? [],
    });
  }
  return value;
}
