import fs from "node:fs";
import path from "node:path";
import { AppError } from "../../../packages/contracts/src/index.mjs";

export async function automationRoute({ app, route, method, body, agent, req, res, url, json }) {
  if (route[0] !== "projects" || !["automations", "automation-runs"].includes(route[2])) return false;
  const [, projectId, resource, id, action, extra] = route;
  const authorize = () => {
    if (!agent) return;
    const identity = app.authenticate(req.headers.authorization?.replace(/^Bearer /, ""));
    if (identity.projectId !== projectId) throw new AppError("NOT_FOUND", "Project not found", 404);
    app.authorizeAgentProject(identity.id, projectId);
  };
  authorize();
  const api = app.automations, actor = agent ? { type: "agent", agentId: agent.id } : { type: "human" };
  let result, status = 200;
  if (resource === "automations") {
    if (method === "GET" && !id) result = api.list(projectId);
    else if (method === "POST" && id === "validate" && !action) result = api.validate(projectId, body);
    else if (method === "GET" && id && !action) result = api.show(projectId, id);
    else if (method === "GET" && id && action === "schedules" && !extra) result = api.schedules(projectId, id);
    else if (method === "PUT" && id && !action) result = api.apply(projectId, id, body);
    else if (method === "DELETE" && id && !action) result = api.remove(projectId, id, url.searchParams.get("revision"));
    else if (method === "POST" && action === "runs" && !extra) { result = await api.start(projectId, id, body, actor); status = 202; }
  } else {
    const query = url.searchParams;
    if (method === "GET" && !id) {
      const limit = Number(query.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError("INVALID_PARAMETERS", "Invalid page limit", 422);
      result = api.runs(projectId, { limit, cursor: query.get("cursor"), workflowId: query.get("workflowId") });
    } else if (method === "GET" && id && !action) result = api.detail(projectId, id);
    else if (method === "GET" && action === "logs" && !extra) result = api.logs(projectId, id, { cursor: query.get("cursor"), limitBytes: Number(query.get("limitBytes") ?? 65536) });
    else if (method === "GET" && action === "events" && !extra) result = api.events(projectId, id, { afterSeq: Number(query.get("afterSeq") ?? 0), limit: Number(query.get("limit") ?? 100) });
    else if (method === "GET" && action === "events" && extra === "stream") {
      let seq = Number(req.headers["last-event-id"] ?? query.get("afterSeq") ?? 0);
      api.events(projectId, id, { afterSeq: seq });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      const pump = () => {
        try {
          authorize();
          const page = api.events(projectId, id, { afterSeq: seq });
          for (const item of page.items) { res.write(`id: ${item.seq}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`); seq = item.seq; }
          if (res.writableLength > 1024 * 1024) res.destroy();
          if (page.complete && page.items.length < 100) res.end();
        } catch { res.end(); }
      };
      const timer = setInterval(pump, 1000); timer.unref(); res.on("close", () => clearInterval(timer)); pump();
      return true;
    } else if (method === "GET" && action === "files" && route.length === 7) {
      result = api.file(projectId, id, extra, route[6], query.get("path") ?? "");
      if (result.file) {
        res.writeHead(200, { "content-type": result.mediaType, "content-length": result.bytes, "cache-control": "no-store",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(result.file))}`, "x-content-type-options": "nosniff" });
        fs.createReadStream(result.file).on("error", () => res.destroy()).pipe(res); return true;
      }
    } else if (method === "POST" && action === "stop" && !extra) result = api.stop(projectId, id, actor);
    else if (method === "POST" && action === "confirm-stopped" && !extra) {
      if (agent) throw new AppError("AUTOMATION_FORBIDDEN", "A human session must confirm recovery", 403);
      result = api.confirmStopped(projectId, id, body);
    }
  }
  if (result === undefined) throw new AppError("NOT_FOUND", "Unknown project automation route", 404);
  json(res, status, result); return true;
}
