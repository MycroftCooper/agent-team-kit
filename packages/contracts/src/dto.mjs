// DTO validators for the public API.
//
// Every validator returns `{ ok: boolean, errors: string[] }` and never throws:
// Backend routes, Web forms and tests use the same judgement, and a malformed
// payload must produce `VALIDATION_ERROR`, not an exception.
import { isEnumValue } from "./enums.mjs";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_RE = /^[A-Fa-f0-9]{64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushId(errors, label, value) {
  if (typeof value !== "string" || !ID_RE.test(value)) errors.push(`${label} must be an id string`);
}

function pushString(errors, label, value) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a non-empty string`);
}

function pushEnum(errors, group, label, value) {
  if (!isEnumValue(group, value)) errors.push(`${label} must be one of the ${group} enum values`);
}

function pushIso(errors, label, value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) errors.push(`${label} must be an ISO-8601 timestamp`);
}

function pushSha(errors, label, value) {
  if (typeof value !== "string" || !SHA_RE.test(value)) errors.push(`${label} must be a 64-char hex sha256`);
}

/** Project registration. */
export function validateProject(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["project must be an object"] };
  pushId(errors, "project.id", value.id);
  pushString(errors, "project.name", value.name);
  pushString(errors, "project.repoPath", value.repoPath);
  pushString(errors, "project.defaultBranch", value.defaultBranch);
  if (value.policyVersion !== undefined && !Number.isInteger(value.policyVersion)) {
    errors.push("project.policyVersion must be an integer");
  }
  return { ok: errors.length === 0, errors };
}

/** Requirement: the raw ask, before any plan exists. */
export function validateRequirement(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["requirement must be an object"] };
  pushId(errors, "requirement.id", value.id);
  pushId(errors, "requirement.projectId", value.projectId);
  pushString(errors, "requirement.description", value.description);
  if (value.acceptance !== undefined && typeof value.acceptance !== "string") {
    errors.push("requirement.acceptance must be a string");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Task creation. `status` is intentionally NOT accepted from the client for
 * normal creation: a task starts READY (manual) or DRAFT (from a plan) and the
 * Backend owns every transition.
 */
export function validateTask(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["task must be an object"] };
  pushId(errors, "task.projectId", value.projectId);
  pushString(errors, "task.title", value.title);
  pushString(errors, "task.description", value.description);
  pushEnum(errors, "functions", "task.functionRequired", value.functionRequired);
  if (typeof value.roleRequired !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value.roleRequired)) {
    errors.push("task.roleRequired must be an upper-case role identifier");
  }
  if (!Number.isInteger(value.priority)) errors.push("task.priority must be an integer");
  if (!Array.isArray(value.deps)) errors.push("task.deps must be an array of task ids");
  else for (const [index, dep] of value.deps.entries()) pushId(errors, `task.deps[${index}]`, dep);
  if (value.acceptance !== undefined && typeof value.acceptance !== "string") {
    errors.push("task.acceptance must be a string");
  }
  if (value.planId !== undefined) pushId(errors, "task.planId", value.planId);
  return { ok: errors.length === 0, errors };
}

/** Run is server-created; the client only reads it (or asks for a retry). */
export function validateRun(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["run must be an object"] };
  pushId(errors, "run.id", value.id);
  pushId(errors, "run.taskId", value.taskId);
  pushId(errors, "run.agentId", value.agentId);
  pushEnum(errors, "functions", "run.function", value.function);
  pushEnum(errors, "run", "run.status", value.status);
  if (!Number.isInteger(value.attempt) || value.attempt < 1) errors.push("run.attempt must be a positive integer");
  if (value.startedAt != null) pushIso(errors, "run.startedAt", value.startedAt);
  if (value.endedAt != null) pushIso(errors, "run.endedAt", value.endedAt);
  return { ok: errors.length === 0, errors };
}

/**
 * Reviewer decision. The reviewer must be a RUN in the REVIEWER function and the
 * decision is bound to a frozen version: verdict alone is not enough (ADR-005).
 */
export function validateReviewDecision(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["review decision must be an object"] };
  pushId(errors, "reviewDecision.reviewId", value.reviewId);
  pushEnum(errors, "verdict", "reviewDecision.verdict", value.verdict);
  pushId(errors, "reviewDecision.reviewerRunId", value.reviewerRunId);
  pushSha(errors, "reviewDecision.manifestHash", value.manifestHash);
  if (value.commitSha !== undefined) {
    if (typeof value.commitSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(value.commitSha)) {
      errors.push("reviewDecision.commitSha must be a git sha");
    }
  }
  if (Array.isArray(value.findings)) {
    for (const [index, finding] of value.findings.entries()) {
      if (!isPlainObject(finding)) errors.push(`reviewDecision.findings[${index}] must be an object`);
      else if (typeof finding.code !== "string" || !finding.code) {
        errors.push(`reviewDecision.findings[${index}].code must be a non-empty string`);
      }
    }
  } else if (value.findings !== undefined) {
    errors.push("reviewDecision.findings must be an array");
  }
  return { ok: errors.length === 0, errors };
}

/** Human approval bound to a target hash; a new version invalidates it. */
export function validateApproval(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["approval must be an object"] };
  pushString(errors, "approval.scope", value.scope);
  pushSha(errors, "approval.targetHash", value.targetHash);
  if (value.actor !== "HUMAN") errors.push('approval.actor must be "HUMAN"');
  pushEnum(errors, "acceptance", "approval.status", value.status);
  if (value.at !== undefined) pushIso(errors, "approval.at", value.at);
  return { ok: errors.length === 0, errors };
}

/** Cursor pagination envelope used by list endpoints and log pages. */
export function validatePage(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["page must be an object"] };
  if (!Array.isArray(value.items)) errors.push("page.items must be an array");
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    errors.push("page.nextCursor must be a string or null");
  }
  return { ok: errors.length === 0, errors };
}

/** Shared identifier + sha predicates for adapters and tests. */
export { ID_RE, SHA_RE };
