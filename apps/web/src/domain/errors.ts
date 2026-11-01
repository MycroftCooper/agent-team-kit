// Error presentation: turn the contract's `{ error: { code, message, requestId } }`
// (or a transport failure) into a title key, a message key and interpolation
// params. Pure module — no React, no fetch.
//
// The UI must be able to tell "backend unreachable" apart from "not authorised"
// and "someone else changed this task" (TASK_VERSION_CONFLICT shows the version).
import { ERROR_CODES, isErrorCode, type ErrorCode } from "@atk/contracts";
import type { MessageKey } from "../i18n/en.ts";

/** Client-side synthetic code: `fetch` itself failed (backend down, DNS, CORS...). */
export const NETWORK_ERROR_CODE = "NETWORK_UNREACHABLE";
/** Client-side synthetic code: 2xx with a body that is not the contract shape. */
export const INVALID_RESPONSE_CODE = "INVALID_RESPONSE";

export type ApiFailure = {
  code: string;
  message: string;
  requestId: string | null;
  httpStatus: number;
  retryable: boolean;
  details?: unknown;
};

export type ErrorDescriptor = {
  code: string;
  known: boolean;
  titleKey: MessageKey;
  messageKey: MessageKey;
  params: Record<string, string | number>;
  retryable: boolean;
  requestId: string | null;
};

/**
 * One dictionary key per contract error code: `Record<ErrorCode, ...>` keeps the
 * dictionaries honest at compile time, and the runtime test walks
 * `ERROR_CODE_LIST` to prove no code renders as a bare identifier.
 */
export const ERROR_MESSAGE_KEYS: Record<ErrorCode, MessageKey> = {
  VALIDATION_ERROR: "error.code.VALIDATION_ERROR",
  NOT_AUTHORIZED: "error.code.NOT_AUTHORIZED",
  NOT_FOUND: "error.code.NOT_FOUND",
  TASK_VERSION_CONFLICT: "error.code.TASK_VERSION_CONFLICT",
  TASK_DEPENDENCY_BLOCKED: "error.code.TASK_DEPENDENCY_BLOCKED",
  VERSION_CONFLICT: "error.code.VERSION_CONFLICT",
  CAPABILITY_UNAVAILABLE: "error.code.CAPABILITY_UNAVAILABLE",
  REVIEW_INVALIDATED: "error.code.REVIEW_INVALIDATED",
  RUNTIME_UNAVAILABLE: "error.code.RUNTIME_UNAVAILABLE",
  GATE_NOT_PASSED: "error.code.GATE_NOT_PASSED",
  INTERNAL_ERROR: "error.code.INTERNAL_ERROR",
};

export function isKnownErrorCode(code: unknown): boolean {
  return isErrorCode(code);
}

/** `true` only for contract codes the backend itself marks retryable. */
export function isRetryableCode(code: string): boolean {
  return isErrorCode(code) ? ERROR_CODES[code].retryable : false;
}

/**
 * TASK_VERSION_CONFLICT carries `details.currentVersion` (per the contract); we
 * also accept `version` / `expectedVersion` so a slightly different backend
 * release still renders a version number instead of `undefined`.
 */
export function versionFromDetails(details: unknown): string | number | null {
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  const raw = record.currentVersion ?? record.version ?? record.expectedVersion;
  if (typeof raw === "number" || typeof raw === "string") return raw;
  return null;
}

/** Total mapping: unknown codes and transport failures still produce readable text. */
export function describeError(failure: Partial<ApiFailure> | null | undefined): ErrorDescriptor {
  const code = typeof failure?.code === "string" && failure.code ? failure.code : INVALID_RESPONSE_CODE;
  const requestId = failure?.requestId ?? null;

  if (code === NETWORK_ERROR_CODE) {
    return {
      code,
      known: false,
      titleKey: "error.network.title",
      messageKey: "error.network.message",
      params: {},
      retryable: true,
      requestId,
    };
  }

  const known = isErrorCode(code);
  const version = versionFromDetails(failure?.details);
  const isConflict = code === "TASK_VERSION_CONFLICT" || code === "VERSION_CONFLICT";
  const titleKey: MessageKey =
    code === "NOT_AUTHORIZED" ? "error.title.unauthorized" : isConflict ? "error.title.conflict" : "error.title";

  return {
    code,
    known,
    titleKey,
    messageKey: known ? ERROR_MESSAGE_KEYS[code] : "error.unknownCode",
    params: known ? (version === null ? {} : { version }) : { code },
    retryable: known ? ERROR_CODES[code].retryable : false,
    requestId,
  };
}
