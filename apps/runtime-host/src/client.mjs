// Client for the backend's internal API (ADR-008 §5: internal credentials are
// separate from the browser session, and the host never touches the database).
//
// Every call carries `x-atk-internal`. A 204 from `claim` means "nothing to do".
// A 409 with STALE_GENERATION means this host has been fenced out of the run and
// must stop, not retry.

export class InternalApiError extends Error {
  constructor(status, code, details, message) {
    super(message ?? `${status} ${code}`);
    this.name = "InternalApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isStaleGeneration() {
    return this.code === "STALE_GENERATION";
  }
}

export function createInternalClient({ baseUrl, token, role = "runtime-host", fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!baseUrl) throw new Error("createInternalClient: baseUrl is required");
  if (!token) throw new Error("createInternalClient: internal token is required");
  if (typeof role !== "string" || role.trim() === "") throw new Error("createInternalClient: role is required");

  async function call(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "x-atk-internal": token,
          // m6.1-contracts §2: the credential alone is not enough; every internal
          // caller asserts the role it acts as. The Host is runtime-host.
          "x-atk-internal-role": role,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new InternalApiError(response.status, error.code ?? "HTTP_ERROR", error.details, `${response.status} ${error.code ?? ""} ${error.message ?? ""}`.trim());
    }
    return payload;
  }

  return {
    claim({ ownerId, leaseMs }) {
      const query = new URLSearchParams({ owner: ownerId, leaseMs: String(leaseMs) });
      return call("GET", `/internal/v1/dispatch/claim?${query}`);
    },
    result(commandId, { ownerId, generation, status, exitCode, summary, error, idempotencyKey }) {
      // The backend validates the result body: ownerId + generation prove the
      // holder, status is DONE|FAILED, and only exitCode/summary/error are
      // accepted as payload. A missing ownerId here used to fail with 400 and get
      // swallowed, leaving commands stuck in CLAIMED (QA-003 finding).
      return call("POST", `/internal/v1/dispatch/${encodeURIComponent(commandId)}/result`, {
        ownerId,
        generation,
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(summary === undefined ? {} : { summary }),
        ...(error === undefined ? {} : { error }),
        // F02: the same terminal fact must be replayed with the same key so the
        // backend can de-duplicate a lost response.
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
    },
    renew(runId, { ownerId, generation, leaseMs }) {
      return call("POST", `/internal/v1/runs/${encodeURIComponent(runId)}/renew`, { ownerId, generation, leaseMs });
    },
    events(runId, { generation, events }) {
      return call("POST", `/internal/v1/runs/${encodeURIComponent(runId)}/events`, { generation, events });
    },
    heartbeat({ ownerId, status, capabilities, sessions }) {
      return call("POST", "/internal/v1/runtime/heartbeat", { ownerId, status, capabilities, sessions });
    },
    reconcile(runId) {
      return call("GET", `/internal/v1/runs/${encodeURIComponent(runId)}/reconcile`);
    },
  };
}
