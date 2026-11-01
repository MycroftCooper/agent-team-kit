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
export const SCHEMA_VERSION = 1;
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
]);

export function mergeTask(current, changes, { now } = {}) {
  ensurePlainObject(changes, "changes");
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
    } else if (key === "acceptance" || key === "planId") {
      if (value === null || value === undefined) delete merged[key];
      else merged[key] = value;
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
