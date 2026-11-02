// Internal API client for the Scheduler (internal credential only; ADR-008 §5).
export class SchedulerApiError extends Error {
  constructor(status, code, details, message) {
    super(message ?? `${status} ${code}`);
    this.name = "SchedulerApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createSchedulerClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!baseUrl) throw new Error("createSchedulerClient: baseUrl is required");
  if (!token) throw new Error("createSchedulerClient: internal token is required");

  async function call(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "x-atk-internal": token,
          // m6.1-contracts §2: a role assertion, not a credential — the token above
          // is still the credential itself; the Scheduler is always "scheduler".
          "x-atk-internal-role": "scheduler",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = payload?.error ?? {};
      // m6.3 P0-2: the server binds the token to a role; the header is only an
      // assertion. Surface the `details.reason` (`internal-role-forbidden`,
      // `internal-token-invalid`, ...) so an operator sees WHY a round failed
      // instead of a bare `403 NOT_AUTHORIZED`.
      const reason = typeof error.details?.reason === "string" && error.details.reason !== "" ? ` ${error.details.reason}` : "";
      throw new SchedulerApiError(
        response.status,
        error.code ?? "HTTP_ERROR",
        error.details,
        `${response.status} ${error.code ?? ""}${reason}`.trim(),
      );
    }
    return payload;
  }

  return {
    snapshot() {
      return call("GET", "/internal/v1/scheduling/snapshot");
    },
    claim(taskId, proposal) {
      return call("POST", `/internal/v1/tasks/${encodeURIComponent(taskId)}/claim`, proposal);
    },
    heartbeat({ ownerId, status, details }) {
      return call("POST", "/internal/v1/scheduler/heartbeat", { ownerId, status, details });
    },
  };
}
