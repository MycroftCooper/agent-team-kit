// Unified error envelope (spec §7.1).
//
//   { "error": { "code": "TASK_VERSION_CONFLICT", "message": "...",
//                "requestId": "req-123", "details": { ... } } }
//
// Codes are append-only: never reuse an existing code for a new meaning.

/** Every machine-readable error code the public API may return. */
export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: { http: 400, retryable: false },
  NOT_AUTHORIZED: { http: 403, retryable: false },
  NOT_FOUND: { http: 404, retryable: false },
  TASK_VERSION_CONFLICT: { http: 409, retryable: true },
  TASK_DEPENDENCY_BLOCKED: { http: 409, retryable: true },
  // Leases and dispatch commands are fenced by a monotonic generation: a report
  // from an older holder must never overwrite the current run (ADR-003).
  STALE_GENERATION: { http: 409, retryable: false },
  // Generic optimistic-concurrency conflict for entities that are not Tasks
  // (Project, Run, ...). Tasks keep TASK_VERSION_CONFLICT because the spec's
  // public error list names it explicitly; both are 409 and both carry
  // `details.currentVersion`.
  VERSION_CONFLICT: { http: 409, retryable: true },
  CAPABILITY_UNAVAILABLE: { http: 409, retryable: false },
  REVIEW_INVALIDATED: { http: 409, retryable: true },
  // M4: an agent must never approve its own work (spec §6.3 / §9.4).
  SELF_REVIEW_FORBIDDEN: { http: 403, retryable: false },
  // M4: a PASS verdict without a manifest hash or with failing/missing test
  // evidence is not a review, it is an assertion.
  EVIDENCE_MISSING: { http: 400, retryable: false },
  // M4: approvals are bound to a target hash; a changed target invalidates them.
  APPROVAL_STALE: { http: 409, retryable: true },
  // M4: the rework loop is bounded; exceeding it blocks the task instead of
  // looping forever.
  REWORK_LIMIT_REACHED: { http: 409, retryable: false },
  RUNTIME_UNAVAILABLE: { http: 503, retryable: true },
  GATE_NOT_PASSED: { http: 422, retryable: true },
  INTERNAL_ERROR: { http: 500, retryable: false },
});

export const ERROR_CODE_LIST = Object.freeze(Object.keys(ERROR_CODES));

export function isErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, String(code ?? ""));
}

export function httpStatusOf(code) {
  return ERROR_CODES[code]?.http ?? 500;
}

/**
 * Build the response body. `details` must already be JSON-safe and must never
 * contain credentials, file contents or prompt text.
 */
export function errorBody({ code, message, requestId, details }) {
  if (!isErrorCode(code)) {
    throw new Error(`contracts: unknown error code "${code}"`);
  }
  const body = { error: { code, message: String(message ?? ""), requestId: requestId ?? null } };
  if (details !== undefined) body.error.details = details;
  return body;
}

export class ApiError extends Error {
  constructor(code, message, { requestId, details } = {}) {
    if (!isErrorCode(code)) throw new Error(`contracts: unknown error code "${code}"`);
    super(message ?? code);
    this.name = "ApiError";
    this.code = code;
    this.requestId = requestId ?? null;
    this.details = details;
    this.httpStatus = httpStatusOf(code);
  }

  toBody() {
    return errorBody({ code: this.code, message: this.message, requestId: this.requestId, details: this.details });
  }
}

/**
 * Validate an error envelope a client received. Returns `{ok, errors}` so a
 * client can decide whether to resync instead of crashing on a malformed body.
 */
export function validateErrorBody(value) {
  const errors = [];
  const error = value?.error;
  if (!error || typeof error !== "object") {
    return { ok: false, errors: ["body.error must be an object"] };
  }
  if (!isErrorCode(error.code)) errors.push(`unknown error.code "${error.code}"`);
  if (typeof error.message !== "string") errors.push("error.message must be a string");
  if (error.requestId != null && typeof error.requestId !== "string") {
    errors.push("error.requestId must be a string or null");
  }
  return { ok: errors.length === 0, errors };
}
