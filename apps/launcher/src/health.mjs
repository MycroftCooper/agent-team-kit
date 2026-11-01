// Health helpers: the launcher considers the system started only once the Backend
// answers `GET /api/v1/system/health` with 2xx (m5-contracts §1). The endpoint is
// public by design (ADR-008: health is exempt from the session token), so this
// module never needs or touches the internal credential.
import process from "node:process";

export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
export const DEFAULT_HEALTH_INTERVAL_MS = 250;
export const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normaliseBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

/** One health probe with a bounded request time; never throws. */
export async function checkHealth({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (!baseUrl) throw new TypeError("checkHealth: baseUrl is required");
  if (typeof fetchImpl !== "function") throw new TypeError("checkHealth: fetchImpl must be a function");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`health request exceeded ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const started = now();
  try {
    const response = await fetchImpl(`${normaliseBaseUrl(baseUrl)}/api/v1/system/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      ok: Boolean(response.ok) && (body === null || body?.ok !== false),
      status: response.status,
      body,
      elapsedMs: now() - started,
    };
  } catch (error) {
    return { ok: false, status: null, body: null, error: String(error?.message ?? error), elapsedMs: now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll until the backend is healthy or `timeoutMs` elapses. Resolves with the last
 * probe (`.ok === true`); throws with the last error when the deadline passes.
 */
export async function waitForHealth({
  baseUrl,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  intervalMs = DEFAULT_HEALTH_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  if (!baseUrl) throw new TypeError("waitForHealth: baseUrl is required");
  const started = now();
  let attempts = 0;
  let last = null;
  for (;;) {
    attempts += 1;
    last = await checkHealth({ baseUrl, fetchImpl, timeoutMs: requestTimeoutMs, now });
    if (last.ok) return { ...last, attempts, elapsedMs: now() - started };
    if (now() - started >= timeoutMs) {
      throw new Error(
        `backend at ${normaliseBaseUrl(baseUrl)} did not become healthy within ${timeoutMs}ms ` +
          `(${attempts} attempt(s), last: ${last.error ?? `HTTP ${last.status}`})`,
      );
    }
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (now() - started))));
  }
}

/** `http://127.0.0.1:<port>` — loopback only (ADR-008). */
export function loopbackUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/** Default "is this PID alive" probe: signal 0 + ESRCH/EPERM semantics. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
