import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export function createAgentClient({
  baseUrl = "http://127.0.0.1:1421",
  credential,
  stateDir,
  fetchImpl = fetch,
} = {}) {
  const u = new URL(baseUrl);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
  )
    throw new Error("Agent Team Kit accepts local HTTP endpoints only");
  if (!credential) throw new Error("ATK_AGENT_TOKEN is required");
  async function request(
    route,
    body,
    method = body === undefined ? "GET" : "POST",
  ) {
    const response = await fetchImpl(
      `${baseUrl.replace(/\/$/, "")}/api/agent/v1${route}`,
      {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(35000),
      },
    );
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error?.message ?? response.statusText);
      error.code = result.error?.code;
      error.details = result.error?.details;
      throw error;
    }
    return result;
  }
  async function submit(runId, action, body) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId) ||
      !["plan", "result", "review"].includes(action)
    )
      throw new Error("Invalid run ID or submission action");
    const payload = {
      ...body,
      idempotencyKey: body.idempotencyKey ?? crypto.randomUUID(),
    };
    let file;
    if (stateDir) {
      fs.mkdirSync(stateDir, { recursive: true });
      file = path.join(
        stateDir,
        `${runId}-${action}-${payload.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
      );
      const tmp = file + ".next";
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ runId, action, body: payload }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    }
    const result = await request(
      `/runs/${encodeURIComponent(runId)}/${action}`,
      payload,
    );
    if (result.persisted !== true)
      throw new Error("Result not durably acknowledged; retain receipt");
    if (file) fs.unlinkSync(file);
    return result;
  }
  return {
    request,
    connect: () => request("/connect", {}),
    claim: (body) => request("/claims", { waitMs: 30000, ...body }),
    heartbeat: (runId, generation) =>
      request(`/runs/${encodeURIComponent(runId)}/heartbeat`, { generation }),
    events: (runId, generation, events) =>
      request(`/runs/${encodeURIComponent(runId)}/events`, {
        generation,
        events,
      }),
    submit,
    async replay() {
      if (!stateDir || !fs.existsSync(stateDir)) return [];
      const results = [];
      for (const name of fs
        .readdirSync(stateDir)
        .filter((n) => n.endsWith(".json"))) {
        const file = path.join(stateDir, name),
          receipt = JSON.parse(fs.readFileSync(file, "utf8"));
        const result = await request(
          `/runs/${encodeURIComponent(receipt.runId)}/${receipt.action}`,
          receipt.body,
        );
        if (result.persisted === true) {
          fs.unlinkSync(file);
          results.push(result);
        }
      }
      return results;
    },
    watch(
      runId,
      generation,
      {
        onStop = () => {},
        onError = () => {},
        onFinished = () => {},
        intervalMs = 10000,
      } = {},
    ) {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const r = await request(
            `/runs/${encodeURIComponent(runId)}/heartbeat`,
            { generation },
          );
          if (r.finished) {
            clearInterval(timer);
            onFinished(r);
          } else if (r.stopRequired) {
            clearInterval(timer);
            onStop(r);
          }
        } catch (e) {
          clearInterval(timer);
          onError(e);
        } finally {
          busy = false;
        }
      }, intervalMs);
      return () => clearInterval(timer);
    },
  };
}
