// HTTP client for the ATK backend (docs/architecture/m1-contracts.md §2).
//
// - `GET /api/v1/session` bootstraps `{ token, csrf }`; every later request
//   carries `x-atk-token`, writes additionally carry `x-atk-csrf` (missing either
//   header is a 403, so the UI shows a readable "not authorised" state).
// - Errors always become an `ApiError`; the contract envelope
//   `{ error: { code, message, requestId, details? } }` is normalised, and a
//   transport failure becomes the synthetic `NETWORK_UNREACHABLE` code — that is
//   how "backend is not running" stays a readable state instead of a white screen.
// - Pure helpers (`normaliseErrorBody`, `parseSessionBody`, `buildQuery`,
//   `streamHeaders`) are exported for `node:test`.
import { ERROR_CODES, isErrorCode } from "@atk/contracts";
import { INVALID_RESPONSE_CODE, NETWORK_ERROR_CODE, type ApiFailure } from "../domain/errors.ts";
import type { Session } from "./types.ts";

export const API_BASE = "/api/v1";
export const EVENT_STREAM_PATH = "/events/stream";

export class ApiError extends Error implements ApiFailure {
  readonly code: string;
  readonly requestId: string | null;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(failure: ApiFailure) {
    super(failure.message || failure.code);
    this.name = "ApiError";
    this.code = failure.code;
    this.requestId = failure.requestId;
    this.httpStatus = failure.httpStatus;
    this.retryable = failure.retryable;
    this.details = failure.details;
  }

  toFailure(): ApiFailure {
    return {
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** Normalise anything thrown by the data layer into the display contract. */
export function toFailure(error: unknown): ApiFailure {
  if (error instanceof ApiError) return error.toFailure();
  return {
    code: INVALID_RESPONSE_CODE,
    message: error instanceof Error ? error.message : String(error ?? "unknown error"),
    requestId: null,
    httpStatus: 0,
    retryable: true,
  };
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Map an HTTP status + response body onto `ApiFailure`. Malformed bodies never
 * throw: they degrade to `INVALID_RESPONSE` so the UI can still render.
 */
export function normaliseErrorBody(httpStatus: number, body: unknown, fallbackCode: string = INVALID_RESPONSE_CODE): ApiFailure {
  const envelope = isPlainObject(body) && isPlainObject(body.error) ? body.error : null;
  const rawCode = envelope && typeof envelope.code === "string" ? envelope.code : "";
  const code = rawCode || fallbackCode;
  const message = envelope && typeof envelope.message === "string" ? envelope.message : "";
  const requestId = envelope && typeof envelope.requestId === "string" ? envelope.requestId : null;
  const known = isErrorCode(code);
  return {
    code,
    message,
    requestId,
    httpStatus,
    retryable: known ? ERROR_CODES[code].retryable : httpStatus >= 500,
    details: envelope?.details,
  };
}

/**
 * Classify a non-2xx response. A 5xx without the contract envelope is a
 * transport/infrastructure failure (dev proxy target down, server crash), so it
 * is reported as "cannot reach the backend" instead of a generic API error —
 * that keeps the offline experience honest and actionable.
 */
export function classifyHttpFailure(httpStatus: number, body: unknown): ApiFailure {
  if (isPlainObject(body) && isPlainObject(body.error)) return normaliseErrorBody(httpStatus, body);
  if (httpStatus >= 500) {
    return {
      code: NETWORK_ERROR_CODE,
      message: `HTTP ${httpStatus} without a contract error envelope`,
      requestId: null,
      httpStatus,
      retryable: true,
    };
  }
  return normaliseErrorBody(httpStatus, body);
}

/** `GET /session` payload. `token` is mandatory; `csrf` must exist for writes. */
export function parseSessionBody(body: unknown): Session | null {  if (!isPlainObject(body)) return null;
  const token = body.token;
  if (typeof token !== "string" || token.length === 0) return null;
  return {
    token,
    csrf: typeof body.csrf === "string" ? body.csrf : "",
    actor: typeof body.actor === "string" ? body.actor : "HUMAN",
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  };
}

/** `{ a: 1, b: undefined, c: "" }` -> `"?a=1"`; order follows insertion order. */
export function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** Parse a JSON body without throwing; empty/non-JSON bodies become `null`. */
export function parseJsonBody(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function authHeaders(session: Session, method: string, withBody = false): Record<string, string> {
  const verb = method.toUpperCase();
  const headers: Record<string, string> = { accept: "application/json", "x-atk-token": session.token };
  if (verb !== "GET" && verb !== "HEAD") headers["x-atk-csrf"] = session.csrf;
  if (withBody) headers["content-type"] = "application/json";
  return headers;
}

/**
 * SSE headers. The token cannot go into the URL (ADR-008) and `EventSource`
 * cannot set headers, which is why the stream is read with `fetch` +
 * `ReadableStream`; `Last-Event-ID` is only sent once a seq has been seen.
 */
export function streamHeaders(session: Session, lastSeq: number | null): Record<string, string> {
  const headers: Record<string, string> = { accept: "text/event-stream", "x-atk-token": session.token };
  if (typeof lastSeq === "number" && Number.isFinite(lastSeq)) headers["Last-Event-ID"] = String(lastSeq);
  return headers;
}

let cachedSession: Session | null = null;
let sessionRequest: Promise<Session> | null = null;

/** Drop the cached token (403 / `NOT_AUTHORIZED`); the next call re-bootstraps. */
export function resetSession(): void {
  cachedSession = null;
  sessionRequest = null;
}

export async function getSession(): Promise<Session> {
  if (cachedSession) return cachedSession;
  if (!sessionRequest) {
    sessionRequest = requestJson<unknown>("/session", { method: "GET", anonymous: true })
      .then((body) => {
        const session = parseSessionBody(body);
        if (!session) {
          throw new ApiError({
            code: INVALID_RESPONSE_CODE,
            message: "GET /session did not return a token",
            requestId: null,
            httpStatus: 200,
            retryable: true,
          });
        }
        cachedSession = session;
        return session;
      })
      .finally(() => {
        sessionRequest = null;
      });
  }
  return sessionRequest;
}

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestOptions = {
  method?: RequestMethod;
  body?: unknown;
  signal?: AbortSignal;
  anonymous?: boolean;
};

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const anonymous = options.anonymous === true;
  const session = anonymous ? null : await getSession();
  const headers = session ? authHeaders(session, method, options.body !== undefined) : { accept: "application/json" };
  const hasBody = options.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError({
      code: NETWORK_ERROR_CODE,
      message: error instanceof Error ? error.message : "network request failed",
      requestId: null,
      httpStatus: 0,
      retryable: true,
    });
  }

  const raw = await response.text().catch(() => "");
  const body = parseJsonBody(raw);

  if (!response.ok) {
    const failure = classifyHttpFailure(response.status, body);
    if (failure.code === "NOT_AUTHORIZED") resetSession();
    throw new ApiError(failure);
  }
  if (raw.trim() !== "" && body === null) {
    throw new ApiError(normaliseErrorBody(response.status, null));
  }
  return body as T;
}

/** GET with one transparent retry after the session token was rejected. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  try {
    return await requestJson<T>(path, { method: "GET", signal });
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_AUTHORIZED") {
      resetSession();
      return requestJson<T>(path, { method: "GET", signal });
    }
    throw error;
  }
}

/**
 * Write helpers: they add `x-atk-token` + `x-atk-csrf` through `authHeaders`.
 * M1's UI is read-only, but the client keeps the contract capability (and the
 * headers are covered by tests) so the next milestone does not re-plumb auth.
 */
export function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(path, { method: "POST", body, signal });
}

export function apiPatch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(path, { method: "PATCH", body, signal });
}

/** Response for the SSE stream; the caller owns the abort signal and the reader. */
export async function openEventStream(options: { lastSeq: number | null; signal: AbortSignal }): Promise<Response> {
  const session = await getSession();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${EVENT_STREAM_PATH}`, {
      headers: streamHeaders(session, options.lastSeq),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError({
      code: NETWORK_ERROR_CODE,
      message: error instanceof Error ? error.message : "event stream request failed",
      requestId: null,
      httpStatus: 0,
      retryable: true,
    });
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const failure = classifyHttpFailure(response.status, parseJsonBody(raw));
    if (failure.code === "NOT_AUTHORIZED") resetSession();
    throw new ApiError(failure);
  }
  return response;
}
