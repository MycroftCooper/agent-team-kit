// Status -> (dictionary key, semantic tone) mapping.
//
// The maps are `Record<EnumValue, StatusMeta>` using the literal unions declared
// in src/types/contracts.d.ts, so `tsc` refuses to compile when a status lands in
// packages/contracts/src/enums.mjs without a label and a tone. The runtime
// lookups below still tolerate unknown values (a newer backend must not crash an
// older SPA): they fall back to `status.unknown` + neutral tone.
//
// Tones express *semantics only* (success / warning / danger / info); plain
// metadata stays neutral. CSS lives in src/styles/tokens.css.
import { PRIORITY, type AcceptanceStatus, type AgentStatus, type FunctionKind, type GateStatus, type IntegrationStatus, type ReviewStatus, type RunStatus, type TaskStatus } from "@atk/contracts";
import type { MessageKey } from "../i18n/en.ts";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export type StatusMeta = { key: MessageKey; tone: Tone };

export type StatusGroup = "task" | "run" | "agent" | "review" | "integration" | "acceptance" | "gate" | "function";

const TASK_STATUS_META: Record<TaskStatus, StatusMeta> = {
  DRAFT: { key: "status.task.DRAFT", tone: "neutral" },
  READY: { key: "status.task.READY", tone: "info" },
  CLAIMED: { key: "status.task.CLAIMED", tone: "info" },
  RUNNING: { key: "status.task.RUNNING", tone: "info" },
  REVIEWING: { key: "status.task.REVIEWING", tone: "info" },
  INTEGRATING: { key: "status.task.INTEGRATING", tone: "info" },
  AWAITING_ACCEPTANCE: { key: "status.task.AWAITING_ACCEPTANCE", tone: "warning" },
  DONE: { key: "status.task.DONE", tone: "success" },
  BLOCKED: { key: "status.task.BLOCKED", tone: "danger" },
  CANCELLED: { key: "status.task.CANCELLED", tone: "neutral" },
};

const RUN_STATUS_META: Record<RunStatus, StatusMeta> = {
  QUEUED: { key: "status.run.QUEUED", tone: "neutral" },
  STARTING: { key: "status.run.STARTING", tone: "info" },
  RUNNING: { key: "status.run.RUNNING", tone: "info" },
  COMPLETED: { key: "status.run.COMPLETED", tone: "success" },
  FAILED: { key: "status.run.FAILED", tone: "danger" },
  CANCELLED: { key: "status.run.CANCELLED", tone: "neutral" },
  INTERRUPTED: { key: "status.run.INTERRUPTED", tone: "warning" },
};

const AGENT_STATUS_META: Record<AgentStatus, StatusMeta> = {
  OFFLINE: { key: "status.agent.OFFLINE", tone: "neutral" },
  STARTING: { key: "status.agent.STARTING", tone: "info" },
  IDLE: { key: "status.agent.IDLE", tone: "success" },
  BUSY: { key: "status.agent.BUSY", tone: "info" },
  WAITING_APPROVAL: { key: "status.agent.WAITING_APPROVAL", tone: "warning" },
  DISCONNECTED: { key: "status.agent.DISCONNECTED", tone: "danger" },
  ERROR: { key: "status.agent.ERROR", tone: "danger" },
};

const REVIEW_STATUS_META: Record<ReviewStatus, StatusMeta> = {
  PENDING: { key: "status.review.PENDING", tone: "neutral" },
  RUNNING: { key: "status.review.RUNNING", tone: "info" },
  PASS: { key: "status.review.PASS", tone: "success" },
  FAIL: { key: "status.review.FAIL", tone: "danger" },
  INVALIDATED: { key: "status.review.INVALIDATED", tone: "warning" },
};

const INTEGRATION_STATUS_META: Record<IntegrationStatus, StatusMeta> = {
  PENDING: { key: "status.integration.PENDING", tone: "neutral" },
  VERIFYING: { key: "status.integration.VERIFYING", tone: "info" },
  APPLIED: { key: "status.integration.APPLIED", tone: "success" },
  CONFLICT: { key: "status.integration.CONFLICT", tone: "danger" },
  FAILED: { key: "status.integration.FAILED", tone: "danger" },
};

const ACCEPTANCE_STATUS_META: Record<AcceptanceStatus, StatusMeta> = {
  PENDING: { key: "status.acceptance.PENDING", tone: "warning" },
  APPROVED: { key: "status.acceptance.APPROVED", tone: "success" },
  REJECTED: { key: "status.acceptance.REJECTED", tone: "danger" },
};

const GATE_STATUS_META: Record<GateStatus, StatusMeta> = {
  PASS: { key: "status.gate.PASS", tone: "success" },
  FAIL: { key: "status.gate.FAIL", tone: "danger" },
  // SKIPPED / UNCONFIGURED are never evidence of success (contracts GATE_STATUSES).
  SKIPPED: { key: "status.gate.SKIPPED", tone: "warning" },
  UNCONFIGURED: { key: "status.gate.UNCONFIGURED", tone: "neutral" },
  ERROR: { key: "status.gate.ERROR", tone: "danger" },
};

const FUNCTION_META: Record<FunctionKind, StatusMeta> = {
  ORCHESTRATOR: { key: "status.function.ORCHESTRATOR", tone: "neutral" },
  WORKER: { key: "status.function.WORKER", tone: "neutral" },
  REVIEWER: { key: "status.function.REVIEWER", tone: "neutral" },
};

export const STATUS_GROUP_META: Record<StatusGroup, { labelKey: MessageKey; byValue: Record<string, StatusMeta> }> = {
  task: { labelKey: "statusGroup.task", byValue: TASK_STATUS_META },
  run: { labelKey: "statusGroup.run", byValue: RUN_STATUS_META },
  agent: { labelKey: "statusGroup.agent", byValue: AGENT_STATUS_META },
  review: { labelKey: "statusGroup.review", byValue: REVIEW_STATUS_META },
  integration: { labelKey: "statusGroup.integration", byValue: INTEGRATION_STATUS_META },
  acceptance: { labelKey: "statusGroup.acceptance", byValue: ACCEPTANCE_STATUS_META },
  gate: { labelKey: "statusGroup.gate", byValue: GATE_STATUS_META },
  function: { labelKey: "statusGroup.function", byValue: FUNCTION_META },
};

export const STATUS_GROUPS = Object.keys(STATUS_GROUP_META) as StatusGroup[];

export function statusGroupLabelKey(group: StatusGroup): MessageKey {
  return STATUS_GROUP_META[group].labelKey;
}

/** Total: unknown/missing values degrade to `status.unknown` (neutral). */
export function statusMeta(group: StatusGroup, value: string | null | undefined): StatusMeta {
  const table = STATUS_GROUP_META[group]?.byValue;
  const key = String(value ?? "");
  if (!table || !Object.prototype.hasOwnProperty.call(table, key)) {
    return { key: "status.unknown", tone: "neutral" };
  }
  return table[key];
}

export type PriorityMeta = { key: MessageKey; params?: { value: string | number }; tone: Tone };

const PRIORITY_KEYS: Record<number, MessageKey> = {
  [PRIORITY.URGENT]: "task.priority.URGENT",
  [PRIORITY.HIGH]: "task.priority.HIGH",
  [PRIORITY.NORMAL]: "task.priority.NORMAL",
  [PRIORITY.LOW]: "task.priority.LOW",
};

/** Priority is an integer (smaller runs first); only urgent/high get a tone. */
export function priorityMeta(value: number | null | undefined): PriorityMeta {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { key: "task.priorityOther", params: { value: "?" }, tone: "neutral" };
  }
  const key = PRIORITY_KEYS[value];
  if (key) return { key, tone: value <= PRIORITY.HIGH ? "warning" : "neutral" };
  return { key: "task.priorityOther", params: { value }, tone: "neutral" };
}
