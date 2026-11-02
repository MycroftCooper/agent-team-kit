// Local type surface for the workspace package `@atk/contracts`.
//
// The contracts package ships plain `.mjs` files with no `.d.ts` (it is shared
// with the backend and the legacy suite, which are both JavaScript). The SPA is
// the only TypeScript consumer, so it mirrors the contract *shape* here instead
// of asking the package to grow a build step. Values are declared as literal
// unions so that lookup tables (status -> label/tone) can be checked for
// completeness by `tsc`: `Record<TaskStatus, X>` fails to compile when a new
// enum value lands in packages/contracts/src/enums.mjs and is not handled here.
//
// Keep in sync with: packages/contracts/src/{enums,errors,events,version}.mjs
declare module "@atk/contracts" {
  export type FunctionKind = "ORCHESTRATOR" | "WORKER" | "REVIEWER";
  export const FUNCTIONS: readonly FunctionKind[];

  export type TaskStatus =
    | "DRAFT"
    | "READY"
    | "CLAIMED"
    | "RUNNING"
    | "REVIEWING"
    | "INTEGRATING"
    | "AWAITING_ACCEPTANCE"
    | "DONE"
    | "BLOCKED"
    | "CANCELLED"
    | "REJECTED";
  export const TASK_STATUSES: readonly TaskStatus[];
  export const TASK_BRANCH_STATUSES: readonly ("BLOCKED" | "CANCELLED")[];

  export type RunStatus = "QUEUED" | "STARTING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  export const RUN_STATUSES: readonly RunStatus[];

  export type AgentStatus = "OFFLINE" | "STARTING" | "IDLE" | "BUSY" | "WAITING_APPROVAL" | "DISCONNECTED" | "ERROR";
  export const AGENT_STATUSES: readonly AgentStatus[];

  export type ReviewStatus = "PENDING" | "RUNNING" | "PASS" | "FAIL" | "INVALIDATED" | "CHANGES_REQUESTED" | "BLOCKED";
  export const REVIEW_STATUSES: readonly ReviewStatus[];

  export type IntegrationStatus = "PENDING" | "VERIFYING" | "APPLIED" | "CONFLICT" | "FAILED";
  export const INTEGRATION_STATUSES: readonly IntegrationStatus[];

  export type AcceptanceStatus = "PENDING" | "APPROVED" | "REJECTED";
  export const ACCEPTANCE_STATUSES: readonly AcceptanceStatus[];

  export type GateStatus = "PASS" | "FAIL" | "SKIPPED" | "UNCONFIGURED" | "ERROR";
  export const GATE_STATUSES: readonly GateStatus[];
  export const PASSING_GATE_STATUS: GateStatus;

  export type ReviewVerdict = "PASS" | "FAIL" | "CHANGES_REQUESTED" | "BLOCKED";
  export const REVIEW_VERDICTS: readonly ReviewVerdict[];

  export type DispatchCommandStatus = "PENDING" | "CLAIMED" | "DONE" | "FAILED" | "EXPIRED";
  export const DISPATCH_COMMAND_STATUSES: readonly DispatchCommandStatus[];

  export const PRIORITY: {
    readonly URGENT: 0;
    readonly HIGH: 1;
    readonly NORMAL: 2;
    readonly LOW: 3;
  };

  export type ErrorCode =
    | "VALIDATION_ERROR"
    | "NOT_AUTHORIZED"
    | "NOT_FOUND"
    | "TASK_VERSION_CONFLICT"
    | "TASK_DEPENDENCY_BLOCKED"
    | "VERSION_CONFLICT"
    | "STALE_GENERATION"
    | "CAPABILITY_UNAVAILABLE"
    | "REVIEW_INVALIDATED"
    | "SELF_REVIEW_FORBIDDEN"
    | "REVIEW_RUN_NOT_REVIEWER"
    | "WORKSPACE_REQUIRED"
    | "EVIDENCE_MISSING"
    | "APPROVAL_STALE"
    | "REWORK_LIMIT_REACHED"
    | "RUNTIME_UNAVAILABLE"
    | "GATE_NOT_PASSED"
    | "INTERNAL_ERROR";
  export const ERROR_CODES: Readonly<Record<ErrorCode, { readonly http: number; readonly retryable: boolean }>>;
  export const ERROR_CODE_LIST: readonly ErrorCode[];
  export function isErrorCode(code: unknown): code is ErrorCode;
  export function httpStatusOf(code: string): number;

  export type EventType =
    | "project.created"
    | "requirement.created"
    | "plan.proposed"
    | "plan.approved"
    | "task.created"
    | "task.updated"
    | "task.blocked"
    | "run.created"
    | "run.updated"
    | "run.log"
    | "review.requested"
    | "review.updated"
    | "integration.updated"
    | "approval.recorded"
    | "agent.updated"
    | "system.resync-required";
  export const EVENT_TYPES: readonly EventType[];
  export const EVENT_SCHEMA_VERSION: number;
  export function isEventType(type: unknown): type is EventType;
  export function isPublicEventType(type: unknown): boolean;

  export const CONTRACT_VERSION: string;
  export const API_MAJOR: number;
  export function isEnumValue(group: string, value: unknown): boolean;
  export function enumGroups(): Record<string, readonly string[]>;
}
