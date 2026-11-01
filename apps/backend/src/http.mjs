// Tiny HTTP plumbing: JSON responses, the unified error envelope, body reading
// and query-parameter validation. ADR-009 keeps this on node:http with no
// framework; the contract work lives in @atk/contracts.
import { ApiError, errorBody, isErrorCode } from "@atk/contracts";

export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

/** Canonical JSON response. Never sets CORS headers: this API is same-origin only. */
export function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

/** Error response using the shared envelope (`{ error: { code, message, requestId } }`). */
export function sendApiError(res, requestId, error, extraHeaders = {}) {
  const apiError = error instanceof ApiError ? error : new ApiError("INTERNAL_ERROR", "internal error");
  const body = errorBody({
    code: apiError.code,
    message: apiError.message,
    requestId: requestId ?? apiError.requestId ?? null,
    details: apiError.details,
  });
  sendJson(res, apiError.httpStatus, body, extraHeaders);
}

/** Normalise anything thrown by a route or the store into an ApiError. */
export function toApiError(error) {
  if (error instanceof ApiError) return error;
  const code = typeof error?.code === "string" && isErrorCode(error.code) ? error.code : "INTERNAL_ERROR";
  if (code === "INTERNAL_ERROR") {
    // Never echo driver/SQL messages to the client.
    const wrapped = new ApiError("INTERNAL_ERROR", "internal error");
    wrapped.cause = error;
    return wrapped;
  }
  const message =
    typeof error?.message === "string" && error.message.trim() !== "" ? error.message : code;
  const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : undefined;
  return new ApiError(code, message, { details });
}

/** Read and parse a JSON request body without throwing. */
export async function readJsonBody(req, { limitBytes = DEFAULT_BODY_LIMIT_BYTES } = {}) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limitBytes) {
        return { ok: false, error: new ApiError("VALIDATION_ERROR", `request body exceeds ${limitBytes} bytes`) };
      }
      chunks.push(chunk);
    }
  } catch (error) {
    return { ok: false, error: new ApiError("VALIDATION_ERROR", `cannot read request body: ${error?.message ?? error}`) };
  }
  if (chunks.length === 0) return { ok: true, value: undefined };
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: new ApiError("VALIDATION_ERROR", "request body must be valid JSON") };
  }
}

/** Read the JSON body or throw VALIDATION_ERROR (used by write routes). */
export async function requireJsonBody(req, options) {
  const result = await readJsonBody(req, options);
  if (!result.ok) throw result.error;
  return result.value;
}

/** `?name=` string value, or undefined when absent. */
export function queryString(searchParams, name) {
  return searchParams.has(name) ? searchParams.get(name) : undefined;
}

/**
 * Integer query parameter validation. Returns `fallback` when absent and throws
 * VALIDATION_ERROR when present but malformed, so a typo is never silently
 * ignored and a filter is never silently dropped.
 */
export function parseIntegerParam(searchParams, name, { min = 1, max = 1000, fallback = undefined } = {}) {
  if (!searchParams.has(name)) return fallback;
  const raw = searchParams.get(name);
  const invalid = () =>
    new ApiError("VALIDATION_ERROR", `${name} must be an integer between ${min} and ${max}`, {
      details: { field: name, errors: [`${name} must be an integer between ${min} and ${max}`] },
    });
  if (raw === null || raw.trim() === "") throw invalid();
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw invalid();
  return value;
}

/** True for a plain JSON object (not null, not an array). */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
