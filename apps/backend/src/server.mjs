// ATK Backend HTTP server (M1 / ATK-102, ATK-107).
//
// Design constraints:
// - ADR-009: node:http only, a hand-written route table over the small API.
// - ADR-008: loopback bind + Host allow-list + write Origin/CSRF + session token.
// - m1-contracts §1/§2/§3: the store is INJECTED. This module never imports
//   @atk/database, so tests and callers can supply any implementation and the
//   database package can be built in parallel.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ID_RE, ApiError, isEnumValue, validateProject, validateTask } from "@atk/contracts";

import {
  CLI_CLIENT_HEADER,
  DEFAULT_SESSION_TTL_MS,
  WRITE_METHODS,
  checkBootstrapOrigin,
  checkCsrf,
  checkToken,
  checkWriteOrigin,
  createSession,
  isLoopbackRemote,
  parseHostHeader,
  persistSessionToken,
} from "./auth.mjs";
import {
  isPlainObject,
  parseIntegerParam,
  queryString,
  requireJsonBody,
  sendApiError,
  sendJson,
  toApiError,
} from "./http.mjs";
import { createSseHub } from "./sse.mjs";
import { createStaticHandler } from "./static.mjs";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const BACKEND_VERSION = typeof PACKAGE.version === "string" ? PACKAGE.version : "0.0.0";

/** apps/web/dist relative to this file: apps/backend/src -> apps/web/dist. */
const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

/** Fields a PATCH /tasks/:id may change (everything else is owned by other actors). */
const PATCHABLE_TASK_FIELDS = new Set([
  "title",
  "description",
  "priority",
  "roleRequired",
  "functionRequired",
  "acceptance",
  "deps",
  "status",
]);

/**
 * `allowedActions` is UI guidance only (M1 shows it, does not execute it).
 * The state machine itself lives in the store / scheduler.
 */
const ALLOWED_ACTIONS_BY_STATUS = Object.freeze({
  DRAFT: [],
  READY: ["claim", "cancel"],
  CLAIMED: ["cancel"],
  RUNNING: ["cancel"],
  REVIEWING: ["cancel"],
  INTEGRATING: ["cancel"],
  AWAITING_ACCEPTANCE: ["accept", "reject"],
  DONE: [],
  BLOCKED: ["unblock", "cancel"],
  CANCELLED: [],
});

function allowedActionsFor(task) {
  const actions = ALLOWED_ACTIONS_BY_STATUS[task?.status];
  return Array.isArray(actions) ? [...actions] : [];
}

const ROUTES = [
  { name: "projects.list", method: "GET", regex: /^\/api\/v1\/projects$/, keys: [] },
  { name: "projects.create", method: "POST", regex: /^\/api\/v1\/projects$/, keys: [] },
  { name: "projects.overview", method: "GET", regex: /^\/api\/v1\/projects\/([^/]+)\/overview$/, keys: ["id"] },
  { name: "tasks.list", method: "GET", regex: /^\/api\/v1\/tasks$/, keys: [] },
  { name: "tasks.create", method: "POST", regex: /^\/api\/v1\/tasks$/, keys: [] },
  { name: "tasks.get", method: "GET", regex: /^\/api\/v1\/tasks\/([^/]+)$/, keys: ["id"] },
  { name: "tasks.patch", method: "PATCH", regex: /^\/api\/v1\/tasks\/([^/]+)$/, keys: ["id"] },
  { name: "runs.list", method: "GET", regex: /^\/api\/v1\/runs$/, keys: [] },
  { name: "runs.get", method: "GET", regex: /^\/api\/v1\/runs\/([^/]+)$/, keys: ["id"] },
  { name: "agents.list", method: "GET", regex: /^\/api\/v1\/agents$/, keys: [] },
  { name: "reviews.list", method: "GET", regex: /^\/api\/v1\/reviews$/, keys: [] },
  { name: "approvals.list", method: "GET", regex: /^\/api\/v1\/approvals$/, keys: [] },
  { name: "events.list", method: "GET", regex: /^\/api\/v1\/events$/, keys: [] },
  { name: "events.stream", method: "GET", regex: /^\/api\/v1\/events\/stream$/, keys: [] },
];

/**
 * Create the backend server.
 *
 * @param {object} options
 * @param {object} options.store            injected store (m1-contracts §1); required
 * @param {string|null} [options.webDist]   dist directory; defaults to apps/web/dist
 * @param {string} [options.token]          fixed session token (tests / tooling)
 * @param {string} [options.csrf]           fixed CSRF token (tests / tooling)
 * @param {string} [options.tokenFile]      override the on-disk token path
 * @param {boolean} [options.persistToken]  force/disable token persistence
 * @param {string[]} [options.allowedOrigins] extra write origins (default: none)
 * @returns {{ listen: Function, close: Function, stats: Function, url: string|null, session: object }}
 */
export function createServer({
  store,
  webDist,
  token,
  csrf,
  logger = console,
  now = () => Date.now(),
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  tokenFile,
  persistToken,
  allowedOrigins = [],
  sseHeartbeatMs = 25_000,
  ssePollMs = 300,
} = {}) {
  if (!store || typeof store !== "object") {
    throw new TypeError(
      "@atk/backend: createServer() requires an injected `store` (m1-contracts §1). " +
        "The server never imports @atk/database itself.",
    );
  }

  const startedAt = now();
  const session = createSession({ now: startedAt, ttlMs: sessionTtlMs, token, csrf });

  // A caller-provided token is deterministic tooling input; only a server-minted
  // token is persisted to the user-scoped token file unless overridden.
  const shouldPersist = typeof persistToken === "boolean" ? persistToken : token === undefined;
  const tokenPersistence = shouldPersist
    ? persistSessionToken(session.token, { tokenFile, logger })
    : { persisted: false, tokenFile: tokenFile ?? null, warning: null };

  const hub = createSseHub({ store, heartbeatMs: sseHeartbeatMs, pollMs: ssePollMs, logger, now });
  const staticHandler = createStaticHandler({
    webDist: webDist === undefined ? DEFAULT_WEB_DIST : webDist,
    logger,
  });

  const sockets = new Set();
  const httpServer = http.createServer();
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  let listening = false;
  let baseUrl = null;
  let boundPort = null;

  function healthPayload() {
    let db;
    try {
      db = store.health();
    } catch (error) {
      logger?.error?.(`[atk] store.health() failed: ${error?.message ?? error}`);
      db = { ok: false, error: "store-health-unavailable" };
    }
    return { ok: true, version: BACKEND_VERSION, db, uptimeMs: Math.max(0, now() - startedAt) };
  }

  function sessionPayload() {
    // The cookie-free bootstrap: exactly the fields m1-contracts §2 publishes.
    return { token: session.token, csrf: session.csrf, actor: session.actor, expiresAt: session.expiresAt };
  }

  function validationError(message, errors) {
    return new ApiError("VALIDATION_ERROR", message, { details: { errors } });
  }

  function requireBodyObject(body, label) {
    if (!isPlainObject(body)) throw validationError(`${label} must be a JSON object`, [`${label} must be an object`]);
    return body;
  }

  function listPayload(items) {
    return { items: Array.isArray(items) ? items : [] };
  }

  function matchRoute(pathname, method) {
    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      for (const [index, key] of route.keys.entries()) {
        try {
          params[key] = decodeURIComponent(match[index + 1]);
        } catch {
          throw validationError(`malformed path parameter "${key}"`, [`path parameter ${key} is not valid URL encoding`]);
        }
      }
      return { name: route.name, params };
    }
    return null;
  }

  function validateTaskChanges(changes) {
    const errors = [];
    if (!isPlainObject(changes)) return ["changes must be a JSON object"];
    for (const key of Object.keys(changes)) {
      if (!PATCHABLE_TASK_FIELDS.has(key)) errors.push(`task.${key} is not a patchable field`);
    }
    if ("title" in changes && (typeof changes.title !== "string" || changes.title.trim() === "")) {
      errors.push("task.title must be a non-empty string");
    }
    if ("description" in changes && (typeof changes.description !== "string" || changes.description.trim() === "")) {
      errors.push("task.description must be a non-empty string");
    }
    if ("priority" in changes && !Number.isInteger(changes.priority)) {
      errors.push("task.priority must be an integer");
    }
    if ("roleRequired" in changes && (typeof changes.roleRequired !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(changes.roleRequired))) {
      errors.push("task.roleRequired must be an upper-case role identifier");
    }
    if ("functionRequired" in changes && !isEnumValue("functions", changes.functionRequired)) {
      errors.push("task.functionRequired must be one of the functions enum values");
    }
    if ("acceptance" in changes && typeof changes.acceptance !== "string") {
      errors.push("task.acceptance must be a string");
    }
    if ("deps" in changes) {
      if (!Array.isArray(changes.deps)) errors.push("task.deps must be an array of task ids");
      else {
        for (const [index, dep] of changes.deps.entries()) {
          if (typeof dep !== "string" || !ID_RE.test(dep)) errors.push(`task.deps[${index}] must be an id string`);
        }
      }
    }
    if ("status" in changes && !isEnumValue("task", changes.status)) {
      errors.push("task.status must be one of the task enum values");
    }
    return errors;
  }

  async function dispatch({ req, res, method, pathname, url }) {
    const route = matchRoute(pathname, method);
    if (!route) throw new ApiError("NOT_FOUND", `no route for ${method} ${pathname}`);
    const { params } = route;

    switch (route.name) {
      case "projects.list": {
        sendJson(res, 200, listPayload(store.listProjects()));
        return;
      }
      case "projects.create": {
        const body = requireBodyObject(await requireJsonBody(req), "project");
        const result = validateProject(body);
        if (!result.ok) throw validationError("invalid project payload", result.errors);
        sendJson(res, 201, store.createProject(body));
        return;
      }
      case "projects.overview": {
        sendJson(res, 200, store.overview(params.id));
        return;
      }
      case "tasks.list": {
        const filter = {};
        const projectId = queryString(url.searchParams, "projectId");
        if (projectId !== undefined) {
          if (projectId.trim() === "" || !ID_RE.test(projectId)) {
            throw validationError("invalid task filter", ["projectId must be an id string"]);
          }
          filter.projectId = projectId;
        }
        const status = queryString(url.searchParams, "status");
        if (status !== undefined) {
          if (!isEnumValue("task", status)) {
            throw validationError("invalid task filter", ["status must be one of the task enum values"]);
          }
          filter.status = status;
        }
        const q = queryString(url.searchParams, "q");
        if (q !== undefined) filter.q = q;
        const limit = parseIntegerParam(url.searchParams, "limit", { min: 1, max: 500 });
        if (limit !== undefined) filter.limit = limit;
        sendJson(res, 200, listPayload(store.listTasks(filter)));
        return;
      }
      case "tasks.create": {
        const body = requireBodyObject(await requireJsonBody(req), "task");
        if (Object.prototype.hasOwnProperty.call(body, "status")) {
          throw validationError("task.status is server-owned", ["omit task.status on create; the server starts tasks as READY"]);
        }
        const result = validateTask(body);
        if (!result.ok) throw validationError("invalid task payload", result.errors);
        sendJson(res, 201, store.createTask(body));
        return;
      }
      case "tasks.get": {
        const task = store.getTask(params.id);
        sendJson(res, 200, { ...task, allowedActions: allowedActionsFor(task) });
        return;
      }
      case "tasks.patch": {
        const body = requireBodyObject(await requireJsonBody(req), "task patch");
        if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
          throw validationError("PATCH /tasks/:id requires an integer expectedVersion", [
            "expectedVersion is required for a conditional update (CAS)",
          ]);
        }
        // Accept both the contract body ({ expectedVersion, changes }) and a flat
        // body ({ expectedVersion, title: ... }) so clients cannot silently lose fields.
        const changes = isPlainObject(body.changes)
          ? body.changes
          : Object.fromEntries(Object.entries(body).filter(([key]) => key !== "expectedVersion"));
        const errors = validateTaskChanges(changes);
        if (errors.length > 0) throw validationError("invalid task changes", errors);
        sendJson(res, 200, store.patchTask(params.id, { expectedVersion: body.expectedVersion, changes }));
        return;
      }
      case "runs.list": {
        const filter = {};
        const taskId = queryString(url.searchParams, "taskId");
        if (taskId !== undefined) {
          if (taskId.trim() === "" || !ID_RE.test(taskId)) {
            throw validationError("invalid run filter", ["taskId must be an id string"]);
          }
          filter.taskId = taskId;
        }
        const limit = parseIntegerParam(url.searchParams, "limit", { min: 1, max: 200 });
        if (limit !== undefined) filter.limit = limit;
        sendJson(res, 200, listPayload(store.listRuns(filter)));
        return;
      }
      case "runs.get": {
        sendJson(res, 200, store.getRun(params.id));
        return;
      }
      case "agents.list": {
        sendJson(res, 200, listPayload(store.listAgents()));
        return;
      }
      case "reviews.list": {
        sendJson(res, 200, listPayload(store.listReviews({})));
        return;
      }
      case "approvals.list": {
        const filter = {};
        const taskId = queryString(url.searchParams, "taskId");
        if (taskId !== undefined) {
          if (taskId.trim() === "" || !ID_RE.test(taskId)) {
            throw validationError("invalid approval filter", ["taskId must be an id string"]);
          }
          filter.taskId = taskId;
        }
        sendJson(res, 200, listPayload(store.listApprovals(filter)));
        return;
      }
      case "events.list": {
        const afterSeq = parseIntegerParam(url.searchParams, "afterSeq", { min: 0, max: Number.MAX_SAFE_INTEGER });
        const limit = parseIntegerParam(url.searchParams, "limit", { min: 1, max: 1000 });
        const filter = {};
        if (afterSeq !== undefined) filter.afterSeq = afterSeq;
        if (limit !== undefined) filter.limit = limit;
        sendJson(res, 200, listPayload(store.listEvents(filter)));
        return;
      }
      case "events.stream": {
        hub.attach(req, res, { lastEventId: req.headers["last-event-id"] });
        return;
      }
      default: {
        throw new ApiError("NOT_FOUND", `no route for ${method} ${pathname}`);
      }
    }
  }

  async function handleRequest(req, res) {
    const requestId = crypto.randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("referrer-policy", "no-referrer");
    try {
      // Layer 1: peer must be the local machine (defence in depth behind the bind).
      if (!isLoopbackRemote(req.socket?.remoteAddress)) {
        throw new ApiError("NOT_AUTHORIZED", "request must originate from loopback", { details: { reason: "remote-address" } });
      }
      // Layer 2: Host allow-list (DNS-rebinding boundary).
      const hostHeader = req.headers.host;
      const host = parseHostHeader(hostHeader);
      if (!host.ok) {
        throw new ApiError("NOT_AUTHORIZED", "untrusted Host header", { details: { reason: host.reason } });
      }
      let url;
      try {
        url = new URL(req.url ?? "/", `http://${hostHeader}`);
      } catch {
        throw new ApiError("VALIDATION_ERROR", "invalid request target");
      }
      const pathname = url.pathname;
      const method = req.method ?? "GET";
      const isApi = pathname === "/api" || pathname.startsWith("/api/");

      if (!isApi) {
        await staticHandler.handle(req, res, pathname, method);
        return;
      }

      // Layer 3a: unauthenticated read-only diagnostics.
      if (pathname === "/api/v1/system/health" && method === "GET") {
        sendJson(res, 200, healthPayload());
        return;
      }
      // Layer 3b: session bootstrap (loopback + Host + same-origin if Origin present).
      if (pathname === "/api/v1/session" && method === "GET") {
        const originCheck = checkBootstrapOrigin({ origin: req.headers.origin, hostHeader, allowedOrigins });
        if (!originCheck.ok) {
          throw new ApiError("NOT_AUTHORIZED", "session bootstrap rejected by origin policy", {
            details: { reason: originCheck.reason },
          });
        }
        sendJson(res, 200, sessionPayload());
        return;
      }
      // Layer 3c: every other API call needs the session token.
      const tokenCheck = checkToken(session, req.headers["x-atk-token"], now());
      if (!tokenCheck.ok) {
        throw new ApiError("NOT_AUTHORIZED", "missing or invalid session token", { details: { reason: tokenCheck.reason } });
      }
      // Layer 4: writes additionally need Origin (or explicit CLI marker) + CSRF.
      if (WRITE_METHODS.has(method)) {
        const originCheck = checkWriteOrigin({
          origin: req.headers.origin,
          hostHeader,
          cliHeader: req.headers[CLI_CLIENT_HEADER],
          allowedOrigins,
        });
        if (!originCheck.ok) {
          throw new ApiError("NOT_AUTHORIZED", "write request rejected by origin policy", {
            details: { reason: originCheck.reason },
          });
        }
        const csrfCheck = checkCsrf(session, req.headers["x-atk-csrf"]);
        if (!csrfCheck.ok) {
          throw new ApiError("NOT_AUTHORIZED", "missing or invalid CSRF token", { details: { reason: csrfCheck.reason } });
        }
        const idempotencyKey = req.headers["idempotency-key"];
        if (typeof idempotencyKey === "string" && idempotencyKey !== "") {
          // M1 records the key for audit; dedupe arrives with the scheduler.
          logger?.info?.(`[atk] Idempotency-Key observed on ${method} ${pathname} (recorded, not enforced)`);
        }
      }

      await dispatch({ req, res, method, pathname, url });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === "INTERNAL_ERROR") {
        logger?.error?.(`[atk] ${requestId} ${req.method ?? "?"} ${req.url ?? "?"}: ${error?.stack ?? error}`);
      }
      if (res.headersSent || res.writableEnded) {
        try {
          res.end();
        } catch {
          // Connection already gone.
        }
        return;
      }
      try {
        sendApiError(res, requestId, apiError);
      } catch (sendError) {
        // The client vanished while we were writing; nothing left to tell it.
        logger?.error?.(`[atk] failed to send error response: ${sendError?.message ?? sendError}`);
        try {
          res.destroy();
        } catch {
          // already destroyed
        }
      }
    }
  }

  httpServer.on("request", (req, res) => {
    handleRequest(req, res).catch((error) => {
      // Last-resort guard: handleRequest already maps errors, this is for bugs.
      logger?.error?.(`[atk] unhandled request error: ${error?.stack ?? error}`);
      if (!res.headersSent) sendApiError(res, null, toApiError(error));
      else res.destroy();
    });
  });

  async function listen({ port = 1421, host = "127.0.0.1" } = {}) {
    if (listening) throw new Error("@atk/backend: server is already listening");
    if (host !== "127.0.0.1") {
      throw new Error(`@atk/backend: refusing to bind "${host}"; ADR-008 requires 127.0.0.1`);
    }
    const normalizedPort = Number(port);
    if (!Number.isInteger(normalizedPort) || normalizedPort < 0 || normalizedPort > 65535) {
      throw new Error(`@atk/backend: invalid port "${port}"`);
    }
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen({ port: normalizedPort, host });
    });
    listening = true;
    const address = httpServer.address();
    boundPort = typeof address === "object" && address ? address.port : normalizedPort;
    baseUrl = `http://127.0.0.1:${boundPort}`;
    return { port: boundPort, host, url: baseUrl };
  }

  async function close() {
    hub.closeAll();
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    }
    sockets.clear();
    if (!listening) return;
    listening = false;
    const closed = new Promise((resolve) => {
      try {
        httpServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
    httpServer.closeAllConnections?.();
    await closed;
  }

  return {
    listen,
    close,
    /** Session material for in-process callers (CLI prints only the token file path). */
    get session() {
      return { token: session.token, csrf: session.csrf, actor: session.actor, expiresAt: session.expiresAt };
    },
    get url() {
      return baseUrl;
    },
    /** Diagnostics for tests: proves SSE timers/connections were cleaned up. */
    stats() {
      return { listening, port: boundPort, url: baseUrl, sseClients: hub.size() };
    },
    tokenFile: tokenPersistence.tokenFile,
    tokenPersisted: tokenPersistence.persisted,
    tokenWarning: tokenPersistence.warning,
    httpServer,
  };
}
