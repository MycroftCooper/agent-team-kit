import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { createService } from "./service.mjs";
import { acquireInstance } from "./instance-lock.mjs";
import { backup, restore } from "./operations.mjs";
import {
  createSession,
  isSessionExpired,
  isAllowedHost,
  isLoopbackRemote,
  safeEqual,
} from "./auth.mjs";
import {
  ensureBrowserAccess,
  browserUrl,
} from "../../../packages/platform/src/index.mjs";
import {
  AppError,
  requireThat,
  requiredString,
  VERSION,
} from "../../../packages/contracts/src/index.mjs";
import { normalizeDueDate, normalizeTaskTag } from "../../../packages/domain/src/index.mjs";
const DEFAULT_WEB = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
function number(value, fallback, min = 0, max = 500) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  requireThat(
    Number.isInteger(n) && n >= min && n <= max,
    "VALIDATION_ERROR",
    `Expected integer ${min}..${max}`,
  );
  return n;
}
function taskViewFilters(params) {
  const mode = params.get("due"), tag = params.get("tag");
  let deadline;
  if (mode === "none") deadline = { missing: true };
  else if (mode) {
    requireThat(["overdue", "today", "week", "on"].includes(mode),
      "VALIDATION_ERROR", "Unknown deadline filter");
    const day = normalizeDueDate(params.get("day") ?? undefined);
    if (mode === "overdue") deadline = { before: day, openOnly: true };
    else if (mode === "week") {
      const through = new Date(day + "T00:00:00Z");
      through.setUTCDate(through.getUTCDate() + 6);
      deadline = { from: day, through: through.getUTCFullYear() > 9999 ? "9999-12-31" : through.toISOString().slice(0, 10) };
    } else deadline = { from: day, through: day };
  }
  return {
    status: params.get("status") || undefined,
    owner: params.get("owner") || undefined,
    search: params.get("q")?.trim().slice(0, 200),
    hideChildren: params.get("children") === "0",
    sort: params.get("sort"),
    direction: params.get("direction"),
    deadline,
    tag: tag ? normalizeTaskTag(tag) : undefined,
  };
}
async function readBody(req) {
  let bytes = 0,
    chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    requireThat(
      bytes <= 512 * 1024,
      "BODY_TOO_LARGE",
      "Body exceeds 512 KiB",
      413,
    );
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requireThat(
      b && typeof b === "object" && !Array.isArray(b),
      "VALIDATION_ERROR",
      "JSON object required",
    );
    return b;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("INVALID_JSON", "Invalid JSON");
  }
}
export function createServer({
  dataDir,
  webDist = DEFAULT_WEB,
  service,
  now,
  logger = console,
} = {}) {
  const instanceId = crypto.randomUUID(),
    ownership = acquireInstance(dataDir ?? service?.dataDir, instanceId),
    streams = new Set();
  let app, browserAccess;
  try {
    browserAccess = ensureBrowserAccess(dataDir ?? service?.dataDir);
    app = service ?? createService({ dataDir, now });
  } catch (error) {
    ownership.release();
    throw error;
  }
  let session = createSession(),
    maintenance,
    automationTimer,
    streamTimer;
  let port = 0;
  let shutdownHandler, closing;
  function requireServing() {
    requireThat(!closing, "SERVICE_RESTARTING", "The service is restarting; retry shortly", 503);
  }
  const json = (res, status, value) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  function originAllowed(req) {
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    if (!req.headers.origin) return true;
    try {
      const u = new URL(req.headers.origin);
      return (
        u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
        u.host === req.headers.host
      );
    } catch {
      return false;
    }
  }
  function pump() {
    for (const client of streams) {
      const events = app.store.events({
        after: client.seq,
        limit: 200,
        projectId: client.projectId,
        includeGlobal: true,
      });
      for (const e of events) {
        client.res.write(
          `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
        );
        client.seq = e.seq;
      }
      if (client.res.writableLength > 1024 * 1024) {
        client.res.destroy();
        streams.delete(client);
      }
    }
  }
  app.signals.on("change", pump);
  app.signals.on("restore", () => {
    for (const c of streams) {
      c.res.write("event: system.resync-required\ndata: {}\n\n");
      c.seq = 0;
    }
  });
  async function waitClaim(agentId, body, req) {
    const deadline = Date.now() + number(body.waitMs, 0, 0, 30000);
    let result;
    do {
      requireServing();
      result = app.claim(agentId, body);
      if (result.run || Date.now() >= deadline || req.aborted) return result;
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(1000, deadline - Date.now()));
        function done() {
          clearTimeout(timer);
          app.signals.off("change", done);
          resolve();
        }
        app.signals.once("change", done);
      });
    } while (!req.aborted);
    return result;
  }
  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    let url;
    try {
      requireServing();
      requireThat(req.url.length < 8192, "URL_TOO_LONG", "URL too long", 414);
      requireThat(
        isLoopbackRemote(req.socket.remoteAddress) &&
          isAllowedHost(req.headers.host),
        "ACCESS_DENIED",
        "Loopback access only",
        403,
      );
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-frame-options", "DENY");
      url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = req.method;
      if (pathname === "/api/v1/system/health" && method === "GET")
        return json(res, 200, {
          ok: true,
          version: VERSION,
          format: "atk-next-1",
          instanceId,
        });
      if (pathname === "/api/v1/session" && method === "GET") {
        requireThat(
          originAllowed(req),
          "ORIGIN_FORBIDDEN",
          "Cross-origin session bootstrap refused",
          403,
        );
        requireThat(
          safeEqual(req.headers["x-atk-access"], browserAccess),
          "UI_LOCKED",
          "Open the private browser URL from atk start, or enter its access code",
          401,
        );
        if (isSessionExpired(session)) session = createSession();
        return json(res, 200, {
          token: session.token,
          csrf: session.csrf,
          expiresAt: session.expiresAt,
        });
      }
      const isAgent = pathname.startsWith("/api/agent/v1/");
      let agent;
      if (isAgent) {
        requireThat(
          !req.headers.origin,
          "AGENT_BROWSER_FORBIDDEN",
          "Use the browser API for human actions",
          403,
        );
        agent = app.authenticate(
          req.headers.authorization?.replace(/^Bearer /, ""),
        );
      } else if (pathname.startsWith("/api/")) {
        requireThat(
          !isSessionExpired(session) &&
            safeEqual(req.headers["x-atk-token"], session.token),
          "UNAUTHENTICATED",
          "Browser session required",
          401,
        );
        requireThat(
          originAllowed(req),
          "ORIGIN_FORBIDDEN",
          "Cross-origin request refused",
          403,
        );
        if (!["GET", "HEAD"].includes(method))
          requireThat(
            safeEqual(req.headers["x-atk-csrf"], session.csrf),
            "CSRF_REQUIRED",
            "CSRF token required",
            403,
          );
      }
      const body = ["POST", "PATCH", "PUT"].includes(method)
        ? await readBody(req)
        : {};
      requireServing();
      const segments = pathname.split("/").filter(Boolean);
      let route = isAgent ? segments.slice(3) : segments.slice(2);
      const projectId = url.searchParams.get("projectId") ?? undefined;
      let resourceOptions = { scope: url.searchParams.get("scope") ?? undefined, projectId };
      if (route[0] === "project-resources") {
        requireThat(route[1] && (projectId === undefined || projectId === route[1]) &&
          (resourceOptions.scope === undefined || resourceOptions.scope === "project"),
          "INVALID_RESOURCE_SCOPE", "Project resource path and scope must agree");
        resourceOptions = { scope: "project", projectId: route[1] };
        route = ["resources", ...route.slice(2)];
      }
      const [resource, id, action] = route;
      if (isAgent) {
        let result;
        if (method === "POST" && resource === "connect")
          result = app.connect(agent.id);
        else if (method === "GET" && resource === "identity" && !id)
          result = app.get("agents", agent.id);
        else if (method === "POST" && resource === "heartbeat")
          result = app.heartbeat(agent.id, null, body);
        else if (method === "POST" && resource === "claims")
          result = await waitClaim(agent.id, body, req);
        else if (method === "GET" && resource === "resources" && route.length === 1)
          result = app.resourceLibrary(resourceOptions, agent.id).list(url.searchParams.get("kind") ?? undefined);
        else if (method === "GET" && resource === "resources" && route.length === 3)
          result = app.resourceLibrary(resourceOptions, agent.id).read(id, action);
        else if (method === "GET" && resource === "plans" && id) {
          const plan = app.get("plans", id);
          app.authorizeAgentProject(agent.id, plan.projectId, { planId: id });
          result = plan;
        } else if (resource === "runs" && id) {
          const run = app.get("runs", id);
          app.authorizeAgentProject(agent.id, run.projectId, { runId: id });
          if (method === "GET" && action === "artifact")
            result = app.artifact(id);
          else {
            requireThat(
              run.agentId === agent.id,
              "RUN_FORBIDDEN",
              "Run belongs to another identity",
              403,
            );
            if (method === "GET" && !action) result = app.runStatus(id);
            else if (method === "POST" && action === "heartbeat")
              result = app.heartbeat(agent.id, id, body);
            else if (method === "POST" && action === "events")
              result = app.runEvents(agent.id, id, body);
            else if (method === "POST" && action === "plan")
              result = app.submitPlan(agent.id, id, body);
            else if (method === "POST" && action === "result")
              result = app.finishRun(agent.id, id, body);
            else if (method === "POST" && action === "review")
              result = app.submitReview(agent.id, id, body);
            else if (method === "POST" && action === "stopped")
              result = app.acknowledgeStop(agent.id, id, body);
          }
        }
        requireThat(
          result !== undefined,
          "NOT_FOUND",
          "Unknown agent route",
          404,
        );
        return json(res, 200, result);
      }
      if (pathname.startsWith("/api/v1/")) {
        if (method === "GET" && resource === "events" && id === "stream") {
          const latest = app.store.latestSeq(),
            requested =
              req.headers["last-event-id"] ?? url.searchParams.get("after");
          let seq =
            requested === null || requested === undefined
              ? latest
              : Number(requested);
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          if (!Number.isInteger(seq) || seq < 0 || seq > latest) {
            res.write("event: system.resync-required\ndata: {}\n\n");
            seq = 0;
          }
          const client = { res, seq, projectId };
          streams.add(client);
          res.on("close", () => streams.delete(client));
          pump();
          return;
        }
        let result;
        const listables = [
          "projects",
          "roles",
          "teams",
          "agents",
          "tasks",
          "plans",
          "runs",
          "locks",
          "acceptances",
          "materializations",
        ];
        if (resource === "tasks" && id && projectId && ["human-start", "human-complete", "retry"].includes(action))
          requireThat(app.store.get("tasks", id)?.projectId === projectId, "NOT_FOUND", "Task not found in this project", 404);
        if (method === "GET" && resource === "overview")
          result = app.overview(projectId);
        else if (method === "GET" && resource === "agent-migrations")
          result = { items: app.agentMigrations() };
        else if (method === "GET" && resource === "collaboration")
          result = app.collaboration(projectId, url.searchParams.get("planId") ?? undefined);
        else if (method === "POST" && resource === "agents" && id && action === "bind")
          result = app.bindAgent(id, body);
        else if (resource === "automations" && !id && method === "GET")
          result = app.automations.list(projectId, number(url.searchParams.get("cursor"), 0, 0, 1_000_000));
        else if (resource === "automations" && !id && method === "POST")
          result = await app.automations.configure(projectId, null, body);
        else if (resource === "automations" && id && !action && method === "PATCH")
          result = await app.automations.configure(projectId, id, body);
        else if (resource === "automations" && id && !action && method === "DELETE")
          result = app.automations.remove(projectId, id, Number(url.searchParams.get("version")));
        else if (resource === "automations" && id && action === "run" && method === "POST")
          result = app.automations.start(projectId, id, body);
        else if (resource === "automation-runs" && id && !action && method === "GET")
          result = app.automations.detail(projectId, id);
        else if (resource === "automation-runs" && id && action === "stop" && method === "POST")
          result = app.automations.stop(projectId, id);
        else if (method === "GET" && resource === "resources" && route.length <= 2)
          result = app.resourceLibrary(resourceOptions).list(id);
        else if (method === "GET" && resource === "resources" && route.length === 3)
          result = app.resourceLibrary(resourceOptions).read(id, action, { parseConfig: false });
        else if (method === "POST" && resource === "resources" && route.length === 2)
          result = app.resourceLibrary(resourceOptions).create(id, body);
        else if (method === "PATCH" && resource === "resources" && route.length === 3)
          result = app.resourceLibrary(resourceOptions).update(id, action, body);
        else if (method === "DELETE" && resource === "resources" && route.length === 3)
          result = app.resourceLibrary(resourceOptions).remove(id, action, url.searchParams.get("revision"));
        else if (method === "GET" && resource === "inbox")
          result = app.inbox(projectId);
        else if (resource === "bugs" && !id && method === "GET")
          result = app.listBugs(projectId, {
            status: url.searchParams.get("status") ?? undefined,
            limit: number(url.searchParams.get("limit"), 30, 1, 100),
            offset: number(url.searchParams.get("cursor"), 0, 0, 1_000_000),
          });
        else if (resource === "bugs" && !id && method === "POST")
          result = app.createBug(body);
        else if (resource === "bugs" && id && action === "review" && method === "POST" && route.length === 3)
          result = app.reviewBug(id, body, projectId);
        else if (method === "GET" && resource === "tasks" && id === "tags" && !action)
          result = app.taskTags(projectId);
        else if (method === "GET" && resource === "tasks" && id === "board" && !action)
          result = app.taskBoard(projectId, {
            ...taskViewFilters(url.searchParams),
            group: url.searchParams.get("group"),
            hidden: url.searchParams.get("hidden")?.split(",") ?? [],
            progress: url.searchParams.get("progress") === "1",
            offsets: Object.fromEntries(
              [...url.searchParams.entries()]
                .filter(([key]) => key.startsWith("cursor."))
                .map(([key, value]) => [key.slice(7), number(value, 0, 0, 1_000_000)]),
            ),
          });
        else if (method === "GET" && resource === "events")
          result = {
            items: app.store.events({
              projectId,
              entityId: url.searchParams.get("entityId") ?? undefined,
              newest: url.searchParams.get("order") === "newest",
              after: number(
                url.searchParams.get("after"),
                0,
                0,
                Number.MAX_SAFE_INTEGER,
              ),
              limit: number(url.searchParams.get("limit"), 100, 1, 500),
            }),
            latestSeq: app.store.latestSeq(),
          };
        else if (method === "GET" && listables.includes(resource)) {
          if (resource === "agents") {
            requiredString(projectId, "projectId");
            if (id) requireThat(app.store.get("agents", id)?.projectId === projectId, "NOT_FOUND", "Agent not found in this project", 404);
          }
          if (id) {
            if (projectId && ["tasks", "runs"].includes(resource))
              requireThat(
                app.store.get(resource, id)?.projectId === projectId,
                "NOT_FOUND", "Item not found in this project", 404,
              );
            result =
              action === "dispatch" && resource === "tasks"
                ? app.taskDispatch(id)
                : action === "assignment" && resource === "tasks"
                  ? app.taskAssignment(id)
                : action === "artifact" && resource === "runs"
                ? app.artifact(id)
                : resource === "runs" && url.searchParams.get("summary") === "1"
                  ? app.runStatus(id)
                  : app.get(resource, id);
          } else
            result = app.list(resource, {
              projectId,
              status: url.searchParams.get("status") ?? undefined,
              ...(resource === "tasks" ? taskViewFilters(url.searchParams) : {}),
              parentId: url.searchParams.get("parentId") ?? undefined,
              planId: ["tasks", "acceptances"].includes(resource) ? url.searchParams.get("planId") ?? undefined : undefined,
              newest: url.searchParams.get("order") === "newest",
              summary: url.searchParams.get("summary") === "1",
              limit: number(url.searchParams.get("limit"), 100, 1, 500),
              offset: number(url.searchParams.get("cursor"), 0, 0, 1_000_000),
            });
        } else if (method === "POST" && resource === "projects" && !id)
          result = app.createProject(body);
        else if (method === "PATCH" && resource === "projects" && id)
          result = app.updateProject(id, body);
        else if (
          method === "POST" &&
          resource === "projects" &&
          action === "retry-documents"
        )
          result = app.retryDocuments(id);
        else if (method === "POST" && resource === "roles" && !id)
          result = app.createRole(body);
        else if (method === "PATCH" && resource === "roles" && id)
          result = app.updateRole(id, body);
        else if (method === "POST" && resource === "teams" && !id)
          result = app.createTeam(body);
        else if (method === "PATCH" && resource === "teams" && id)
          result = app.updateTeam(id, body);
        else if (method === "POST" && resource === "agents" && !id)
          result = app.createAgent(body);
        else if (method === "PATCH" && resource === "agents" && id)
          {
            requireThat(projectId && app.store.get("agents", id)?.projectId === projectId, "NOT_FOUND", "Agent not found in this project", 404);
            result = app.updateAgent(id, body);
          }
        else if (
          method === "POST" &&
          resource === "agents" &&
          action === "revoke"
        )
          {
            requireThat(projectId && app.store.get("agents", id)?.projectId === projectId, "NOT_FOUND", "Agent not found in this project", 404);
            result = app.revokeAgent(id);
          }
        else if (method === "POST" && resource === "tasks" && !id)
          result = app.createDraft(body);
        else if (method === "PATCH" && resource === "tasks" && id && ["assignment", "metadata"].includes(action)) {
          if (projectId)
            requireThat(app.store.get(resource, id)?.projectId === projectId, "NOT_FOUND", "Item not found in this project", 404);
          result = action === "assignment" ? app.assignTask(id, body) : app.updateTaskMetadata(id, body);
        }
        else if (
          method === "POST" &&
          resource === "plans" &&
          action === "approve"
        )
          result = app.approvePlan(id, body);
        else if (
          method === "POST" &&
          resource === "plans" &&
          action === "revise"
        )
          result = app.requestPlanRevision(id, body);
        else if (method === "POST" && resource === "runs" && action === "stop")
          result = app.requestStop(id);
        else if (
          method === "POST" &&
          resource === "runs" &&
          action === "confirm-stopped"
        )
          result = app.confirmStopped(id, body);
        else if (
          method === "POST" &&
          resource === "tasks" &&
          action === "retry"
        )
          result = app.retryTask(id, body);
        else if (
          method === "POST" &&
          resource === "tasks" &&
          action === "human-start"
        )
          result = app.startHuman(id, body);
        else if (
          method === "POST" &&
          resource === "tasks" &&
          action === "human-complete"
        )
          result = app.finishHuman(id, body);
        else if (
          method === "POST" &&
          resource === "tasks" &&
          action === "human-heartbeat"
        )
          result = app.heartbeatHuman(id);
        else if (
          method === "POST" &&
          resource === "acceptances" &&
          action === "approve"
        )
          result = app.accept(id, body);
        else if (
          method === "POST" &&
          resource === "acceptances" &&
          action === "revalidate"
        )
          result = app.revalidateAcceptance(id);
        else if (
          method === "POST" &&
          resource === "operations" &&
          id === "shutdown"
        ) {
          result = { stopping: true };
          setTimeout(() => shutdownHandler?.(), 100);
        } else if (
          method === "POST" &&
          resource === "operations" &&
          id === "backup"
        )
          result = backup(app, body.destination);
        else if (
          method === "POST" &&
          resource === "operations" &&
          id === "restore"
        )
          result = restore(app, body.source);
        requireThat(
          result !== undefined,
          "NOT_FOUND",
          "Unknown browser route",
          404,
        );
        return json(res, 200, result);
      }
      requireThat(
        webDist && ["GET", "HEAD"].includes(method),
        "NOT_FOUND",
        "Unknown route",
        404,
      );
      const target = path.resolve(webDist, "." + pathname);
      requireThat(
        target === path.resolve(webDist) ||
          target.startsWith(path.resolve(webDist) + path.sep),
        "NOT_FOUND",
        "Invalid path",
        404,
      );
      let file = target;
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
        file = path.join(webDist, "index.html");
      requireThat(
        fs.existsSync(file),
        "WEB_NOT_BUILT",
        "Build the web application first",
        503,
      );
      requireThat(
        fs.realpathSync(file).startsWith(fs.realpathSync(webDist) + path.sep),
        "NOT_FOUND",
        "Invalid static path",
        404,
      );
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": file.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=3600",
      });
      if (method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = e instanceof AppError ? e.status : 500;
      const message =
        e instanceof AppError ? e.message : "Unexpected server error";
      if (status === 500) logger.error?.(e.stack ?? e.message);
      json(res, status, {
        error: {
          code: e.code ?? "INTERNAL_ERROR",
          message,
          details: e.details ?? {},
        },
      });
    } finally {
      const ms = performance.now() - started;
      if (ms > 500 && url?.pathname !== "/api/agent/v1/claims")
        logger.warn?.(
          `Slow request ${req.method} ${url?.pathname}: ${Math.round(ms)}ms`,
        );
    }
  });
  function close() {
    if (closing) return closing;
    // Set the guard before aborting connections so an in-flight claim cannot
    // dispatch new work after the reload's idle check.
    closing = Promise.resolve().then(async () => {
      clearInterval(maintenance);
      clearInterval(automationTimer);
      clearInterval(streamTimer);
      const stopAutomations = app.automations.shutdown();
      for (const c of streams) c.res.end();
      streams.clear();
      app.signals.off("change", pump);
      try {
        const stopHttp = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await Promise.all([stopHttp, stopAutomations]);
      } finally {
        try { app.close(); } finally { ownership.release(); }
      }
    });
    return closing;
  }
  return {
    app,
    server,
    instanceId,
    set onShutdown(fn) {
      shutdownHandler = fn;
    },
    async listen({ port: desired = 1421 } = {}) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(desired, "127.0.0.1", resolve);
      }).catch((error) => {
        ownership.release();
        app.close();
        throw error;
      });
      port = server.address().port;
      ownership.update({ url: `http://127.0.0.1:${port}` });
      maintenance = setInterval(() => {
        try {
          app.maintenance();
        } catch (e) {
          logger.error?.(e.message);
        }
      }, 1000);
      maintenance.unref();
      const pollAutomations = () => void app.automations.poll().catch((error) => logger.error?.(error.message));
      pollAutomations();
      automationTimer = setInterval(pollAutomations, 2000);
      automationTimer.unref();
      streamTimer = setInterval(() => {
        for (const c of streams) c.res.write(": heartbeat\n\n");
      }, 15000);
      streamTimer.unref();
      const url = `http://127.0.0.1:${port}`;
      return { url, browserUrl: browserUrl(url, browserAccess), port };
    },
    close,
    closeWhenIdle() {
      if (closing) return closing;
      if (app.store.activeRuns().length || app.automations.busy()) return null;
      return close();
    },
  };
}
