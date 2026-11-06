export type TaskStatus =
  | "DRAFT"
  | "READY"
  | "RUNNING"
  | "REVIEWING"
  | "VERIFIED"
  | "AWAITING_ACCEPTANCE"
  | "DONE"
  | "BLOCKED"
  | "CANCELLED";
export type FunctionName = "ORCHESTRATOR" | "WORKER" | "REVIEWER";
export type Stage = "PLANNING" | "EXECUTION" | "REVIEW" | "HUMAN";
export type Row = Record<string, any>;
export interface Page<T = Row> {
  items: T[];
  nextCursor: number | null;
  total: number;
}
export interface ApiFailure {
  error: { code: string; message: string; details: Row };
}
export const VERSION: string;
export const LEASE_MS: number;
export const FUNCTIONS: readonly FunctionName[];
export const TASK_STATUSES: readonly TaskStatus[];
export const TASK_BOARD_COLUMNS: ReadonlyArray<{ key: string; statuses: readonly TaskStatus[] }>;
export const TASK_BOARD_OWNERS: readonly ["HUMAN", "AGENT", "REQUEST"];
export const TASK_TAG_LIMIT: number;
export const TASK_TAG_LENGTH: number;
