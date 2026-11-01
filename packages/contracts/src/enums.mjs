// Canonical enums. These names are the contract: services must not invent
// synonyms (DONE vs COMPLETED) and must not merge two states that the spec keeps
// separate (`RUN_COMPLETED !== TASK_DONE`, `QA PASS !== HUMAN APPROVED`).
//
// Source of truth: docs/architecture/adr/ADR-005-review-model.md §5.2 and the
// implementation spec §5.2 / §10.1.

/** Collaboration function of a Run. NOT a model-provider category. */
export const FUNCTIONS = Object.freeze(["ORCHESTRATOR", "WORKER", "REVIEWER"]);

/** Task lifecycle. `BLOCKED` and `CANCELLED` are branch states, not steps. */
export const TASK_STATUSES = Object.freeze([
  "DRAFT",
  "READY",
  "CLAIMED",
  "RUNNING",
  "REVIEWING",
  "INTEGRATING",
  "AWAITING_ACCEPTANCE",
  "DONE",
  "BLOCKED",
  "CANCELLED",
]);

export const TASK_BRANCH_STATUSES = Object.freeze(["BLOCKED", "CANCELLED"]);

/** One execution attempt. Terminal states are COMPLETED/FAILED/CANCELLED/INTERRUPTED. */
export const RUN_STATUSES = Object.freeze(["QUEUED", "STARTING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]);

/** Observation-layer status of an Agent Instance. */
export const AGENT_STATUSES = Object.freeze([
  "OFFLINE",
  "STARTING",
  "IDLE",
  "BUSY",
  "WAITING_APPROVAL",
  "DISCONNECTED",
  "ERROR",
]);

/** Review of a frozen candidate version. */
export const REVIEW_STATUSES = Object.freeze(["PENDING", "RUNNING", "PASS", "FAIL", "INVALIDATED"]);

/** Integration of a reviewed candidate into the development branch. */
export const INTEGRATION_STATUSES = Object.freeze(["PENDING", "VERIFYING", "APPLIED", "CONFLICT", "FAILED"]);

/** Human acceptance. Only HUMAN actors may move this. */
export const ACCEPTANCE_STATUSES = Object.freeze(["PENDING", "APPROVED", "REJECTED"]);

/**
 * Gate result. Only a real `PASS` satisfies a mandatory quality gate:
 * `SKIPPED` (nothing applied) and `UNCONFIGURED` (no gate configured) must never
 * be treated as success. See ATK-003.
 */
export const GATE_STATUSES = Object.freeze(["PASS", "FAIL", "SKIPPED", "UNCONFIGURED", "ERROR"]);

/** The only gate status that counts as satisfied evidence. */
export const PASSING_GATE_STATUS = "PASS";

/** Review verdict recorded on a QA approval receipt. */
export const REVIEW_VERDICTS = Object.freeze(["PASS", "FAIL"]);

/** Command lifecycle for durable dispatch commands (ADR-003). */
export const DISPATCH_COMMAND_STATUSES = Object.freeze(["PENDING", "CLAIMED", "DONE", "FAILED", "EXPIRED"]);

/** Priority is an integer; smaller runs first. Named levels keep call sites readable. */
export const PRIORITY = Object.freeze({ URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 });

const SETS = {
  functions: new Set(FUNCTIONS),
  task: new Set(TASK_STATUSES),
  run: new Set(RUN_STATUSES),
  agent: new Set(AGENT_STATUSES),
  review: new Set(REVIEW_STATUSES),
  integration: new Set(INTEGRATION_STATUSES),
  acceptance: new Set(ACCEPTANCE_STATUSES),
  gate: new Set(GATE_STATUSES),
  verdict: new Set(REVIEW_VERDICTS),
  dispatch: new Set(DISPATCH_COMMAND_STATUSES),
};

/** Membership test against a named enum group; never throws. */
export function isEnumValue(group, value) {
  const set = SETS[group];
  if (!set) return false;
  return set.has(value);
}

/** Stable, sorted enum lists for UI filters and OpenAPI generation. */
export function enumGroups() {
  return {
    functions: FUNCTIONS,
    task: TASK_STATUSES,
    run: RUN_STATUSES,
    agent: AGENT_STATUSES,
    review: REVIEW_STATUSES,
    integration: INTEGRATION_STATUSES,
    acceptance: ACCEPTANCE_STATUSES,
    gate: GATE_STATUSES,
    verdict: REVIEW_VERDICTS,
    dispatch: DISPATCH_COMMAND_STATUSES,
  };
}
