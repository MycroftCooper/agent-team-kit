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
  STALE_GENERATION: "error.code.STALE_GENERATION",
  CAPABILITY_UNAVAILABLE: "error.code.CAPABILITY_UNAVAILABLE",
  REVIEW_INVALIDATED: "error.code.REVIEW_INVALIDATED",
  SELF_REVIEW_FORBIDDEN: "error.code.SELF_REVIEW_FORBIDDEN",
  REVIEW_RUN_NOT_REVIEWER: "error.code.REVIEW_RUN_NOT_REVIEWER",
  WORKSPACE_REQUIRED: "error.code.WORKSPACE_REQUIRED",
  EVIDENCE_MISSING: "error.code.EVIDENCE_MISSING",
  APPROVAL_STALE: "error.code.APPROVAL_STALE",
  REWORK_LIMIT_REACHED: "error.code.REWORK_LIMIT_REACHED",
  RUNTIME_UNAVAILABLE: "error.code.RUNTIME_UNAVAILABLE",
  GATE_NOT_PASSED: "error.code.GATE_NOT_PASSED",
  INTERNAL_ERROR: "error.code.INTERNAL_ERROR",
};

/**
 * M4 review/acception error codes get their own titles so the workbench can tell
 * "you may not review this" apart from "your evidence is incomplete" and
 * "the target changed under you" at a glance.
 */
const ERROR_TITLE_KEYS: Record<string, MessageKey> = {
  NOT_AUTHORIZED: "error.title.unauthorized",
  TASK_VERSION_CONFLICT: "error.title.conflict",
  VERSION_CONFLICT: "error.title.conflict",
  SELF_REVIEW_FORBIDDEN: "error.title.selfReview",
  REVIEW_RUN_NOT_REVIEWER: "error.title.REVIEW_RUN_NOT_REVIEWER",
  WORKSPACE_REQUIRED: "error.title.WORKSPACE_REQUIRED",
  EVIDENCE_MISSING: "error.title.evidence",
  APPROVAL_STALE: "error.title.stale",
  REWORK_LIMIT_REACHED: "error.title.reworkLimit",
};

export function errorTitleKey(code: string): MessageKey {
  return ERROR_TITLE_KEYS[code] ?? "error.title";
}

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
  const titleKey = errorTitleKey(code);

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

/**
 * Everything a write-failure panel must show: the localized title/message, the
 * *verbatim* server `message`, the raw `details` and the code. The UI never
 * replaces the server's words with a local guess — it translates the code and
 * keeps the server payload visible underneath.
 */
export type ActionErrorView = ErrorDescriptor & {
  serverMessage: string | null;
  details: unknown;
  hasDetails: boolean;
};

export function actionErrorView(failure: Partial<ApiFailure> | null | undefined): ActionErrorView {
  const descriptor = describeError(failure);
  const serverMessage = typeof failure?.message === "string" && failure.message.trim() !== "" ? failure.message : null;
  const details = failure?.details;
  return {
    ...descriptor,
    serverMessage,
    details,
    hasDetails: details !== undefined && details !== null,
  };
}
