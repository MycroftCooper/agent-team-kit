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
    probe = false,
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
        signal: AbortSignal.timeout(probe ? 5000 : 35000),
        ...(probe ? { redirect: "error" } : {}),
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
    async doctor() {
      if (u.pathname !== "/" || u.search || u.hash || u.username || u.password)
        throw Object.assign(new Error("Use the local service origin, such as http://127.0.0.1:1421"), { code: "INVALID_SERVICE_URL" });
      let health;
      try {
        const response = await fetchImpl(new URL("/api/v1/system/health", u), {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        if (response.ok) health = await response.json();
      } catch {
        throw Object.assign(new Error("Cannot reach the local ATK service; check ATK_URL and run atk status"), { code: "SERVICE_UNREACHABLE" });
      }
      if (!health?.ok || health.format !== "atk-next-1")
        throw Object.assign(new Error("ATK_URL did not return an ATK health response"), { code: "SERVICE_MISMATCH" });
      let agent;
      try {
        agent = await request("/identity", undefined, "GET", true);
      } catch (error) {
        if (error.code === "UNAUTHENTICATED")
          throw Object.assign(new Error("ATK rejected this credential; verify the token or check whether the identity was revoked"), { code: "UNAUTHENTICATED" });
        if (error.code === "NOT_FOUND")
          throw Object.assign(new Error("This ATK service does not support doctor; update it or use atk-agent connect"), { code: "DOCTOR_UNSUPPORTED" });
        throw error;
      }
      return {
        ok: true, service: u.origin, version: health.version,
        identity: { id: agent.id, name: agent.name, roleId: agent.roleId, teamId: agent.teamId, lastSeen: agent.lastSeen },
      };
    },
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
