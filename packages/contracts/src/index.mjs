export const VERSION = "2.0.0-alpha.1";
export const FUNCTIONS = Object.freeze(["ORCHESTRATOR", "WORKER", "REVIEWER"]);
export const TASK_STATUSES = Object.freeze([
  "DRAFT",
  "READY",
  "RUNNING",
  "REVIEWING",
  "VERIFIED",
  "AWAITING_ACCEPTANCE",
  "DONE",
  "BLOCKED",
  "CANCELLED",
]);
export const STAGES = Object.freeze([
  "PLANNING",
  "EXECUTION",
  "REVIEW",
  "HUMAN",
]);
export const TASK_BOARD_COLUMNS = Object.freeze([
  { key: "draft", statuses: ["DRAFT"] },
  { key: "queue", statuses: ["READY"] },
  { key: "running", statuses: ["RUNNING"] },
  { key: "review", statuses: ["REVIEWING"] },
  { key: "acceptance", statuses: ["VERIFIED", "AWAITING_ACCEPTANCE"] },
  { key: "blocked", statuses: ["BLOCKED"] },
  { key: "closed", statuses: ["DONE", "CANCELLED"] },
]);
export const TASK_BOARD_OWNERS = Object.freeze(["HUMAN", "AGENT", "REQUEST"]);
export const TASK_TAG_LIMIT = 12;
export const TASK_TAG_LENGTH = 40;
export const LEASE_MS = 30_000;
export const HEARTBEAT_MS = 10_000;
export const MAX_ATTEMPTS = 3;
export class AppError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export function requireThat(
  condition,
  code,
  message,
  status = 400,
  details = {},
) {
  if (!condition) throw new AppError(code, message, status, details);
}
export function requiredString(value, name, max = 65536) {
  requireThat(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    "VALIDATION_ERROR",
    `${name} must be a non-empty string (max ${max})`,
  );
  return value.trim();
}
export function object(value, name = "body") {
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    "VALIDATION_ERROR",
    `${name} must be an object`,
  );
  return value;
}
export function integer(value, fallback, min = 0, max = 1000) {
  if (value === undefined) return fallback;
  requireThat(
    Number.isInteger(value) && value >= min && value <= max,
    "VALIDATION_ERROR",
    `expected integer ${min}..${max}`,
  );
  return value;
}
