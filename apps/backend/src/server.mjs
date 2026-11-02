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

import { EVENT_TYPES, ID_RE, ApiError, isEnumValue, validateProject, validateTask } from "@atk/contracts";

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
  isSessionExpired,
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
import {
  INTERNAL_ROLE_HEADER,
  INTERNAL_TOKEN_HEADER,
  checkInternalRole,
  checkInternalToken,
  createInternalToken,
} from "./internal.mjs";
import { createInternalRouter } from "./routes-internal.mjs";
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

// --- M4 review / rework / human acceptance ---------------------------------

/** Review verdicts accepted by the M4 submit endpoint. */
const M4_VERDICTS = new Set(["PASS", "CHANGES_REQUESTED", "BLOCKED"]);

/** Review statuses (M4 adds CHANGES_REQUESTED/BLOCKED to the M1 enum). */
const M4_REVIEW_STATUSES = new Set(["PENDING", "PASS", "CHANGES_REQUESTED", "BLOCKED", "RUNNING", "FAIL", "INVALIDATED"]);

/** m4-contracts §0.4: same Task may be reworked at most this many times. */
const MAX_REVIEW_ATTEMPTS = 3;

/** Human acceptance decisions. */
const APPROVAL_DECISIONS = new Set(["APPROVED", "REJECTED"]);

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
  { name: "reviews.create", method: "POST", regex: /^\/api\/v1\/reviews$/, keys: [] },
  { name: "reviews.submit", method: "POST", regex: /^\/api\/v1\/reviews\/([^/]+)\/submit$/, keys: ["id"] },
  { name: "reviews.rework", method: "POST", regex: /^\/api\/v1\/reviews\/([^/]+)\/rework$/, keys: ["id"] },
  { name: "approvals.list", method: "GET", regex: /^\/api\/v1\/approvals$/, keys: [] },
  { name: "approvals.create", method: "POST", regex: /^\/api\/v1\/approvals$/, keys: [] },
  { name: "approvals.decide", method: "POST", regex: /^\/api\/v1\/approvals\/([^/]+)\/decide$/, keys: ["id"] },
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
 * @param {string} [options.internalToken] fixed internal credential (tests / tooling)
 * @returns {{ listen: Function, close: Function, stats: Function, url: string|null, session: object, internalToken: string }}
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
  internalToken,
} = {}) {
  if (!store || typeof store !== "object") {
    throw new TypeError(
      "@atk/backend: createServer() requires an injected `store` (m1-contracts §1). " +
        "The server never imports @atk/database itself.",
    );
  }

  const startedAt = now();
  let session = createSession({ now: startedAt, ttlMs: sessionTtlMs, token, csrf });

  // ADR-008 §5: internal credential is a separate secret for `/internal/v1/*`.
  // It is minted per process, never persisted, never logged and never returned
  // by an HTTP response. Tests/CLI may inject a deterministic one.
  const resolvedInternalToken = internalToken ?? createInternalToken();
  if (typeof resolvedInternalToken !== "string" || resolvedInternalToken === "") {
    throw new TypeError("@atk/backend: internalToken must be a non-empty string when provided");
  }

  // A caller-provided token is deterministic tooling input; only a server-minted
  // token is persisted to the user-scoped token file unless overridden.
  const shouldPersist = typeof persistToken === "boolean" ? persistToken : token === undefined;
  const tokenPersistence = shouldPersist
    ? persistSessionToken(session.token, { tokenFile, logger })
    : { persisted: false, tokenFile: tokenFile ?? null, warning: null };

  const hub = createSseHub({ store, heartbeatMs: sseHeartbeatMs, pollMs: ssePollMs, logger, now });
  const internalRouter = createInternalRouter({ store, hub, now, logger });
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
    const payload = { ok: true, version: BACKEND_VERSION, db, uptimeMs: Math.max(0, now() - startedAt) };
    // M6: can this database be switched to SQLite right now? Older stores do
    // not implement verifySwitchReadiness: omit the field instead of failing.
    if (typeof store.verifySwitchReadiness === "function") {
      try {
        const readiness = store.verifySwitchReadiness();
        payload.switchReadiness = {
          ok: Boolean(readiness?.ok),
          blockers: Array.isArray(readiness?.blockers) ? readiness.blockers : [],
        };
      } catch (error) {
        logger?.error?.(`[atk] store.verifySwitchReadiness() failed: ${error?.message ?? error}`);
        payload.switchReadiness = {
          ok: false,
          blockers: [{ code: "switch-readiness-error", message: String(error?.message ?? error) }],
        };
      }
    }
    return payload;
  }

  function sessionPayload() {
    // A server process outlives its session TTL (8h by default). Without
    // rotation, reloading the page would hand the browser the SAME expired
    // token and every request would answer NOT_AUTHORIZED/token-expired until
    // someone restarted the backend. Mint and persist a fresh session instead.
    if (isSessionExpired(session, now())) {
      session = createSession({ now: now(), ttlMs: sessionTtlMs, actor: session.actor });
      if (shouldPersist && tokenFile) persistSessionToken(session.token, { tokenFile, logger });
      logger?.info?.(`[atk] session expired; issued a new session (ttl ${sessionTtlMs}ms)`);
    }
    // The cookie-free bootstrap: exactly the fields m1-contracts §2 publishes.
    return { token: session.token, csrf: session.csrf, actor: session.actor, expiresAt: session.expiresAt };
  }

  function validationError(message, errors) {
    return new ApiError("VALIDATION_ERROR", message, { details: { errors } });
  }

  /** Validation errors that name the offending field (m6.1 F12). */
  function fieldValidationError(field, message) {
    return new ApiError("VALIDATION_ERROR", message, { details: { field, errors: [message] } });
  }

  function requireBodyObject(body, label) {
    if (!isPlainObject(body)) throw validationError(`${label} must be a JSON object`, [`${label} must be an object`]);
    return body;
  }

  function listPayload(items) {
    return { items: Array.isArray(items) ? items : [] };
  }

  // --- m6.1 F01: generic PATCH may only touch non-execution states ----------
  const EXECUTION_TARGET_STATES = new Set(["CLAIMED", "RUNNING", "REVIEWING", "INTEGRATING", "AWAITING_ACCEPTANCE", "DONE"]);
  const GENERIC_PATCH_TARGETS = ["READY", "BLOCKED", "CANCELLED"];

  function executionStateGuardError(taskId, requestedStatus) {
    return new ApiError("TASK_VERSION_CONFLICT", `status "${requestedStatus}" can only be reached through its dedicated service`, {
      details: {
        taskId,
        requestedStatus,
        reason: "execution-state-guard",
        allowedTransitions: [...GENERIC_PATCH_TARGETS],
      },
    });
  }

  function assertGenericTaskStatusAllowed(task, requestedStatus) {
    if (requestedStatus === undefined) return;
    if (requestedStatus === task.status) return; // no-op (idempotent)
    if (EXECUTION_TARGET_STATES.has(requestedStatus)) throw executionStateGuardError(task.id, requestedStatus);
    if (requestedStatus === "READY") {
      if (!["DRAFT", "REJECTED", "BLOCKED"].includes(task.status)) throw executionStateGuardError(task.id, requestedStatus);
      return;
    }
    if (requestedStatus === "BLOCKED" || requestedStatus === "CANCELLED") {
      if (["DONE", "CANCELLED"].includes(task.status)) throw executionStateGuardError(task.id, requestedStatus);
      return;
    }
    throw executionStateGuardError(task.id, requestedStatus);
  }

  // --- M4 contract-layer helpers (never delegated to the store for codes) ---

  function requireNonEmptyString(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
      throw validationError(`invalid ${label}`, [`${label} must be a non-empty string`]);
    }
    return value;
  }

  /**
   * `actor` defaults to HUMAN for browser sessions; agents must be explicit.
   *
   * SECURITY BOUNDARY (m4-contracts §0.1): `actor` is a CLIENT-DECLARED identity,
   * not an authenticated principal. The self-review invariant below is
   * "refuse by declaration", not authentication: a malicious caller could
   * declare a different actor. It stops accidental self-approval from a
   * well-behaved client; real identity enforcement belongs to a later auth layer.
   */
  function actorFrom(body, { required = false } = {}) {
    if (body.actor === undefined) {
      if (required) throw validationError("invalid actor", ["actor is required"]);
      return "HUMAN";
    }
    const actor = requireNonEmptyString(body.actor, "actor");
    // Canonical form only: surrounding whitespace is a spoofing attempt, not an
    // id. Mixed case is accepted and compared case-insensitively below.
    if (actor !== actor.trim()) {
      throw new ApiError("VALIDATION_ERROR", "actor must be canonical (no leading/trailing whitespace)", {
        details: { reason: "actor-not-normalized", actor },
      });
    }
    return actor;
  }

  /** Case/space-insensitive identity used only for the declared self-review check. */
  function canonicalActor(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().toLowerCase();
    return trimmed === "" ? null : trimmed;
  }

  function pumpSse() {
    try {
      hub.pump();
    } catch (error) {
      logger?.error?.(`[atk] SSE pump failed: ${error?.message ?? error}`);
    }
  }

  function taskStateConflict(task, reason) {
    return new ApiError("TASK_VERSION_CONFLICT", `task "${task.id}" is in state ${task.status}`, {
      details: { taskId: task.id, status: task.status, currentVersion: task.version, reason },
    });
  }

  function reviewCasConflict(review, expectedVersion) {
    return new ApiError("VERSION_CONFLICT", `review "${review.id}" version conflict`, {
      details: { entity: "review", id: review.id, currentVersion: review.version, expectedVersion },
    });
  }

  function reviewStateConflict(review, reason) {
    return new ApiError("VERSION_CONFLICT", `review "${review.id}" cannot accept this action`, {
      details: { entity: "review", id: review.id, status: review.status, reason },
    });
  }

  function approvalStale({ approvalId, taskId, expectedTargetHash, receivedTargetHash }) {
    return new ApiError("APPROVAL_STALE", "target hash does not match the current target", {
      details: { approvalId, taskId, expectedTargetHash: expectedTargetHash ?? null, receivedTargetHash: receivedTargetHash ?? null },
    });
  }

  function reworkLimitReached({ taskId, attempt, maxAttempts }) {
    return new ApiError("REWORK_LIMIT_REACHED", `task "${taskId}" reached the rework limit`, {
      details: { taskId, attempt, maxAttempts },
    });
  }

  function getReviewOrThrow(id) {
    if (typeof store.getReview !== "function") {
      throw new ApiError("INTERNAL_ERROR", "store.getReview is unavailable");
    }
    return store.getReview(id);
  }

  /** Hard invariant §0.1: the author (Run agent or current assignee) cannot review. */
  function assertNotSelfReview(review, task, actor) {
    const authorIds = new Set();
    if (review.runId) {
      try {
        const run = store.getRun(review.runId);
        if (typeof run?.agentId === "string" && run.agentId !== "") authorIds.add(run.agentId);
      } catch {
        // A missing Run is reported by the store on submit; self-review just has
        // nothing to compare against here.
      }
    }
    if (typeof task?.assignee === "string" && task.assignee !== "") authorIds.add(task.assignee);
    const canonical = canonicalActor(actor);
    const self = [...authorIds].find((id) => canonicalActor(id) === canonical);
    if (self !== undefined) {
      throw new ApiError("SELF_REVIEW_FORBIDDEN", "the author cannot review their own work", {
        details: { actor, authorAgentId: self },
      });
    }
  }

  /** Hard invariant §0.2: a PASS must carry a manifest hash and a full green test run. */
  function assertPassEvidence(manifestHash, evidence) {
    const missing = [];
    if (typeof manifestHash !== "string" || manifestHash.trim() === "") missing.push("manifestHash");
    const tests = isPlainObject(evidence?.tests) ? evidence.tests : null;
    if (!tests) {
      missing.push("evidence.tests");
    } else {
      if (!Number.isInteger(tests.passed) || tests.passed < 0) missing.push("evidence.tests.passed");
      if (!Number.isInteger(tests.total) || tests.total < 1) missing.push("evidence.tests.total");
      if (!missing.includes("evidence.tests.passed") && !missing.includes("evidence.tests.total") && tests.passed !== tests.total) {
        missing.push("evidence.tests.passed===total");
      }
    }
    if (missing.length > 0) {
      throw new ApiError("EVIDENCE_MISSING", "PASS requires manifestHash and evidence.tests.passed === evidence.tests.total > 0", {
        details: {
          missing,
          verdict: "PASS",
          manifestHashProvided: typeof manifestHash === "string" && manifestHash.trim() !== "",
          testsPresent: Boolean(tests),
        },
      });
    }
  }

  function encodeReviewCursor(review) {
    return Buffer.from(`${review.createdAt ?? ""}|${review.id}`, "utf8").toString("base64url");
  }

  function decodeReviewCursor(cursor) {
    if (typeof cursor !== "string" || cursor.trim() === "") return null;
    let raw;
    try {
      raw = Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
      return null;
    }
    const at = raw.indexOf("|");
    if (at < 0) return null;
    const createdAt = raw.slice(0, at);
    const id = raw.slice(at + 1);
    if (id === "" || Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  }

  function compareReviewsDesc(a, b) {
    const at = String(a.createdAt ?? "");
    const bt = String(b.createdAt ?? "");
    if (at !== bt) return at < bt ? 1 : -1;
    return String(a.id) < String(b.id) ? 1 : -1;
  }

  function isAfterReviewCursor(review, cursor) {
    const createdAt = String(review.createdAt ?? "");
    if (createdAt !== cursor.createdAt) return createdAt < cursor.createdAt;
    return String(review.id) < cursor.id;
  }

  function reviewFilterFrom(searchParams) {
    const filter = {};
    const taskId = queryString(searchParams, "taskId");
    if (taskId !== undefined) {
      if (taskId.trim() === "" || !ID_RE.test(taskId)) {
        throw fieldValidationError("taskId", "taskId must be an id string");
      }
      filter.taskId = taskId;
    }
    const status = queryString(searchParams, "status");
    if (status !== undefined) {
      if (!M4_REVIEW_STATUSES.has(status)) throw fieldValidationError("status", "status must be a known review status");
      filter.status = status;
    }
    const limit = parseIntegerParam(searchParams, "limit", { min: 1, max: 100, fallback: 50 });
    filter.limit = limit;
    const cursor = queryString(searchParams, "cursor");
    if (cursor !== undefined) {
      const decoded = decodeReviewCursor(cursor);
      if (decoded === null) throw fieldValidationError("cursor", "cursor is not a valid review cursor");
      filter.cursor = cursor;
      filter.cursorValue = decoded;
    }
    filter.withTotal = queryString(searchParams, "withTotal") === "1";
    return filter;
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
        const currentTask = store.getTask(params.id); // 404 NOT_FOUND
        // m6.1 F01: generic PATCH cannot advance execution states; those have
        // dedicated services (claim / runtime events / review / integration /
        // approval). Same-status is an idempotent no-op.
        assertGenericTaskStatusAllowed(currentTask, changes.status);
        if (changes.status === currentTask.status && Object.keys(changes).length === 1) {
          if (currentTask.version !== body.expectedVersion) {
            throw new ApiError("VERSION_CONFLICT", `task "${currentTask.id}" version conflict`, {
              details: { entity: "task", id: currentTask.id, currentVersion: currentTask.version, expectedVersion: body.expectedVersion },
            });
          }
          sendJson(res, 200, currentTask);
          return;
        }
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
        // m6.1 §6: filter FIRST, then keyset-paginate. The store owns the page
        // when it exposes listReviewsPage; the fallback keeps the same shape for
        // older stores/tests (never truncate before filtering).
        const filter = reviewFilterFrom(url.searchParams);
        let items;
        let hasMore;
        let nextCursor;
        let total;
        if (typeof store.listReviewsPage === "function") {
          const page = store.listReviewsPage({
            taskId: filter.taskId,
            status: filter.status,
            limit: filter.limit,
            cursor: filter.cursor,
          });
          items = page && Array.isArray(page.items) ? page.items : [];
          hasMore = Boolean(page?.hasMore);
          nextCursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
          if (Number.isInteger(page?.total)) total = page.total;
          // Store pages do not carry a count; withTotal=1 walks the filter only
          // when the caller explicitly accepts that cost.
          if (filter.withTotal && !Number.isInteger(total)) {
            let count = 0;
            let scanCursor;
            for (let guard = 0; guard < 10_000; guard += 1) {
              const scanned = store.listReviewsPage({
                taskId: filter.taskId,
                status: filter.status,
                limit: 100,
                cursor: scanCursor,
              });
              const scannedItems = Array.isArray(scanned?.items) ? scanned.items : [];
              count += scannedItems.length;
              if (!scanned?.hasMore || typeof scanned.nextCursor !== "string" || scannedItems.length === 0) break;
              scanCursor = scanned.nextCursor;
            }
            total = count;
          }
        } else {
          let rows = store.listReviews(filter.taskId ? { taskId: filter.taskId } : {});
          rows = Array.isArray(rows) ? rows : [];
          if (filter.status !== undefined) rows = rows.filter((review) => review.status === filter.status);
          rows.sort(compareReviewsDesc);
          const filteredTotal = rows.length;
          if (filter.cursorValue !== undefined) rows = rows.filter((review) => isAfterReviewCursor(review, filter.cursorValue));
          hasMore = rows.length > filter.limit;
          items = rows.slice(0, filter.limit);
          if (hasMore && items.length > 0) nextCursor = encodeReviewCursor(items[items.length - 1]);
          total = filteredTotal;
        }
        const body = { items, hasMore };
        if (nextCursor !== undefined) body.nextCursor = nextCursor;
        if (filter.withTotal && Number.isInteger(total)) body.total = total;
        sendJson(res, 200, body);
        return;
      }
      case "reviews.create": {
        const body = requireBodyObject(await requireJsonBody(req), "review");
        if (typeof body.taskId !== "string" || !ID_RE.test(body.taskId)) {
          throw fieldValidationError("taskId", "taskId must be an id string");
        }
        // m6.1 §2: body.actor is ignored. Reviewer identity is an explicit
        // assignment created by a trusted human/scheduler action.
        const assignedTo = body.assignedTo === undefined ? "HUMAN" : body.assignedTo;
        if (assignedTo !== "AGENT" && assignedTo !== "HUMAN") {
          throw fieldValidationError("assignedTo", 'assignedTo must be "AGENT" or "HUMAN"');
        }
        let reviewerAgentId = null;
        if (body.reviewerAgentId !== undefined) {
          if (typeof body.reviewerAgentId !== "string" || !ID_RE.test(body.reviewerAgentId)) {
            throw fieldValidationError("reviewerAgentId", "reviewerAgentId must be an agent id string");
          }
          reviewerAgentId = body.reviewerAgentId;
        }
        if (assignedTo === "AGENT" && reviewerAgentId === null) {
          throw fieldValidationError("reviewerAgentId", "an AGENT review requires reviewerAgentId");
        }
        let runId = null;
        if (body.runId !== undefined) {
          if (typeof body.runId !== "string" || !ID_RE.test(body.runId)) {
            throw fieldValidationError("runId", "runId must be an id string when provided");
          }
          runId = body.runId;
        }
        const task = store.getTask(body.taskId); // 404 NOT_FOUND
        if (runId !== null) {
          const run = store.getRun(runId); // 404 NOT_FOUND
          if (run.taskId !== task.id) throw fieldValidationError("runId", "runId does not belong to the task");
        }
        // §1: one active Review per Task (contract-layer, not store-dependent).
        const active = (store.listReviews({ taskId: task.id }) ?? []).find(
          (review) => review.status === "PENDING" && (review.verdict === null || review.verdict === undefined),
        );
        if (active) {
          throw new ApiError("VERSION_CONFLICT", `task "${task.id}" already has an active review`, {
            details: { entity: "review", taskId: task.id, activeReviewId: active.id, currentVersion: active.version ?? 0 },
          });
        }
        // The M6.1 store method binds the assignment + COMPLETED-Run precondition
        // + REVIEWING transition in one transaction. Older stores cannot do that:
        // refuse a trusted assignment instead of silently creating an unbound one.
        const trustedAssignments = typeof store.listReviewsPage === "function" || typeof store.createReviewWithTransition === "function";
        let review;
        if (trustedAssignments) {
          const runs = Array.isArray(store.listRuns({ taskId: task.id })) ? store.listRuns({ taskId: task.id }) : [];
          const completed = runId !== null
            ? runs.some((run) => run.id === runId && run.status === "COMPLETED") || store.getRun(runId)?.status === "COMPLETED"
            : runs.some((run) => run.status === "COMPLETED");
          if (!completed) {
            throw new ApiError("TASK_VERSION_CONFLICT", `task "${task.id}" has no COMPLETED Run to review`, {
              details: { taskId: task.id, reason: "completed-run-required", runId },
            });
          }
          const payload = {
            taskId: task.id,
            runId,
            reviewerAgentId,
            assignedTo,
            createdByRole: "user-action",
            actor: assignedTo === "AGENT" ? reviewerAgentId : "HUMAN",
          };
          review = typeof store.createReviewWithTransition === "function"
            ? store.createReviewWithTransition(payload)
            : store.createReview(payload);
        } else {
          // Legacy store: preserve the M4 contract (task already REVIEWING).
          if (task.status !== "REVIEWING") throw taskStateConflict(task, "not-reviewing");
          if (assignedTo === "AGENT" || reviewerAgentId !== null) {
            throw new ApiError("INTERNAL_ERROR", "this store build cannot bind trusted review assignments yet", {
              details: { reason: "review-assignment-unsupported" },
            });
          }
          review = store.createReview({ taskId: task.id, runId, actor: "HUMAN" });
        }
        pumpSse();
        sendJson(res, 201, review);
        return;
      }
      case "reviews.submit": {
        const body = requireBodyObject(await requireJsonBody(req), "review submission");
        const expectedVersion = body.expectedVersion;
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
          throw validationError("invalid review submission", ["expectedVersion must be a non-negative integer"]);
        }
        if (!M4_VERDICTS.has(body.verdict)) {
          throw validationError("invalid review submission", ["verdict must be PASS, CHANGES_REQUESTED or BLOCKED"]);
        }
        const review = getReviewOrThrow(params.id); // 404 NOT_FOUND
        if (review.status !== "PENDING") throw reviewStateConflict(review, "not-pending");
        if (review.version !== expectedVersion) throw reviewCasConflict(review, expectedVersion);
        const task = store.getTask(review.taskId); // 404 NOT_FOUND
        if (task.status !== "REVIEWING") throw taskStateConflict(task, "not-reviewing");

        // m6.1 §2 F06: the caller identity is trusted, the body.actor is NOT.
        // - browser session → only HUMAN assignments (actor is server-filled);
        // - internal credential → only runtime-host, only AGENT assignments;
        // - reviewer identity comes from the review assignment, never the body.
        const principal = req.atkPrincipal ?? { kind: "session", role: "user-action" };
        const assignedTo = review.assignedTo === "AGENT" ? "AGENT" : "HUMAN";
        const reviewerAgentId = typeof review.reviewerAgentId === "string" && review.reviewerAgentId !== "" ? review.reviewerAgentId : null;
        let submitActor = "HUMAN";
        if (assignedTo === "AGENT") {
          if (principal.kind !== "internal") {
            throw new ApiError("NOT_AUTHORIZED", "agent reviews must be submitted with the runtime-host internal credential", {
              details: { reason: "review-requires-runtime-host", reviewId: review.id, assignedTo },
            });
          }
          if (reviewerAgentId === null) {
            throw new ApiError("NOT_AUTHORIZED", "review has no trusted reviewer assignment", {
              details: { reason: "review-assignment-required", reviewId: review.id, taskId: review.taskId },
            });
          }
          // The trusted execution subject proves itself with its own Run: the
          // optional body.runId must belong to this Task AND be run by the
          // assigned reviewer. A forged/missing Run is a self-review attempt.
          const presentedRunId = typeof body.runId === "string" && ID_RE.test(body.runId) ? body.runId : null;
          let reviewerRun = null;
          if (presentedRunId !== null) {
            try {
              reviewerRun = store.getRun(presentedRunId);
            } catch {
              reviewerRun = null;
            }
          }
          if (
            reviewerRun === null ||
            reviewerRun.taskId !== review.taskId ||
            canonicalActor(reviewerRun.agentId) !== canonicalActor(reviewerAgentId)
          ) {
            throw new ApiError("SELF_REVIEW_FORBIDDEN", "the review submission is not backed by the assigned reviewer's Run", {
              details: {
                reviewerAgentId,
                authorAgentId: reviewerRun?.agentId ?? null,
                runId: presentedRunId,
              },
            });
          }
          let authorAgentId = null;
          try {
            if (review.runId) {
              authorAgentId = store.getRun(review.runId)?.agentId ?? null;
            } else {
              const runs = Array.isArray(store.listRuns({ taskId: review.taskId })) ? store.listRuns({ taskId: review.taskId }) : [];
              const completed = runs.filter((run) => run.status === "COMPLETED");
              authorAgentId = completed[0]?.agentId ?? null;
            }
          } catch {
            authorAgentId = null;
          }
          // The assignment must exist and must not be the author of the reviewed Run.
          if (authorAgentId !== null && canonicalActor(authorAgentId) === canonicalActor(reviewerAgentId)) {
            throw new ApiError("SELF_REVIEW_FORBIDDEN", "the author cannot review their own work", {
              details: { reviewerAgentId, authorAgentId, reviewId: review.id, taskId: review.taskId },
            });
          }
          submitActor = reviewerAgentId;
        } else if (principal.kind === "internal") {
          throw new ApiError("NOT_AUTHORIZED", "human review assignments cannot be submitted with the runtime-host credential", {
            details: { reason: "review-assignment-required", reviewId: review.id, assignedTo },
          });
        }

        let findings;
        if (body.findings !== undefined) {
          if (!Array.isArray(body.findings) || body.findings.some((finding) => !isPlainObject(finding) || typeof finding.code !== "string" || finding.code === "")) {
            throw validationError("invalid review submission", ["findings must be an array of objects with a non-empty code"]);
          }
          findings = body.findings;
        }
        if (body.commitSha !== undefined) {
          if (typeof body.commitSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(body.commitSha)) {
            throw validationError("invalid review submission", ["commitSha must be a git sha"]);
          }
        }
        if (body.evidence !== undefined && body.evidence !== null && !isPlainObject(body.evidence)) {
          throw validationError("invalid review submission", ["evidence must be an object"]);
        }
        if (body.verdict === "PASS") assertPassEvidence(body.manifestHash, body.evidence);
        if (body.verdict === "CHANGES_REQUESTED" && (!Array.isArray(findings) || findings.length === 0)) {
          throw validationError("invalid review submission", ["CHANGES_REQUESTED requires at least one finding"]);
        }

        // findings is only required for CHANGES_REQUESTED. PASS/BLOCKED must not
        // send an empty array: the store rejects any explicitly empty findings
        // list, so normalise "empty" to "absent".
        const storeFindings = Array.isArray(findings) && findings.length > 0 ? findings : undefined;

        const result = store.submitReview({
          id: review.id,
          expectedVersion,
          verdict: body.verdict,
          manifestHash: body.manifestHash ?? null,
          commitSha: body.commitSha ?? null,
          findings: storeFindings,
          evidence: body.evidence ?? null,
          actor: submitActor,
          ...(assignedTo === "AGENT" ? { reviewerAgentId } : {}),
        });
        if (!isPlainObject(result) || !result.review || !result.task) {
          throw new ApiError("INTERNAL_ERROR", "review submission returned an incomplete result");
        }
        // "Looks successful but did nothing" guard: the returned facts must match.
        const expectedTaskStatus = body.verdict === "PASS" ? "INTEGRATING" : body.verdict === "CHANGES_REQUESTED" ? "REJECTED" : "BLOCKED";
        if (result.review.verdict !== body.verdict || result.review.status === "PENDING" || result.task.status !== expectedTaskStatus) {
          logger?.error?.(
            `[atk] review submit did not persist expected facts: verdict=${result.review.verdict} reviewStatus=${result.review.status} taskStatus=${result.task.status}`,
          );
          throw new ApiError("INTERNAL_ERROR", "review submission did not persist the expected state");
        }
        pumpSse();
        sendJson(res, 200, result);
        return;
      }
      case "reviews.rework": {
        const body = requireBodyObject(await requireJsonBody(req), "review rework");
        const reason = requireNonEmptyString(body.reason, "reason");
        const actor = actorFrom(body);
        const review = getReviewOrThrow(params.id); // 404 NOT_FOUND
        if (review.status !== "CHANGES_REQUESTED") throw reviewStateConflict(review, "not-changes-requested");
        const task = store.getTask(review.taskId); // 404 NOT_FOUND
        // §0.4: reaching maxAttempts must BLOCK the Task and raise
        // REWORK_LIMIT_REACHED atomically — the store owns that transition, the
        // Backend normalises the error so the code/details are contract-stable.
        let result;
        try {
          result = store.reworkTask({ taskId: task.id, reviewId: review.id, reason, actor });
        } catch (error) {
          if (error?.code === "REWORK_LIMIT_REACHED") {
            throw reworkLimitReached({
              taskId: task.id,
              attempt: error.details?.attempt ?? review.attempt,
              maxAttempts: error.details?.maxAttempts ?? MAX_REVIEW_ATTEMPTS,
            });
          }
          throw error;
        }
        if (!isPlainObject(result) || !result.review || !result.task) {
          throw new ApiError("INTERNAL_ERROR", "review rework returned an incomplete result");
        }
        if (result.task.status !== "READY") {
          logger?.error?.(`[atk] rework did not move the task to READY (status=${result.task.status})`);
          throw new ApiError("INTERNAL_ERROR", "review rework did not persist the expected state");
        }
        pumpSse();
        sendJson(res, 200, result);
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
        const status = queryString(url.searchParams, "status");
        if (status !== undefined) {
          if (!isEnumValue("acceptance", status)) {
            throw validationError("invalid approval filter", ["status must be one of the acceptance enum values"]);
          }
          filter.status = status;
        }
        const limit = parseIntegerParam(url.searchParams, "limit", { min: 1, max: 100 });
        if (limit !== undefined) filter.limit = limit;
        sendJson(res, 200, listPayload(store.listApprovals(filter)));
        return;
      }
      case "approvals.create": {
        const body = requireBodyObject(await requireJsonBody(req), "approval");
        if (typeof body.taskId !== "string" || !ID_RE.test(body.taskId)) {
          throw validationError("invalid approval", ["taskId must be an id string"]);
        }
        requireNonEmptyString(body.scope, "scope");
        requireNonEmptyString(body.targetHash, "targetHash");
        const task = store.getTask(body.taskId); // 404 NOT_FOUND
        if (task.status !== "AWAITING_ACCEPTANCE") throw taskStateConflict(task, "not-awaiting-acceptance");
        // §0.3 binding: the acceptance must reference the Task's real candidate
        // hash (written by submitReview(PASS)). A caller-supplied hash is never
        // trusted on its own.
        const taskTargetHash = typeof task.targetHash === "string" ? task.targetHash : "";
        if (taskTargetHash.trim() === "") {
          throw new ApiError("TASK_VERSION_CONFLICT", `task "${task.id}" has no candidate target hash; complete a PASS review first`, {
            details: { taskId: task.id, status: task.status, reason: "target-hash-missing" },
          });
        }
        if (body.targetHash !== taskTargetHash) {
          throw new ApiError("APPROVAL_STALE", "target hash does not match the task's candidate hash", {
            details: {
              taskId: task.id,
              expectedTargetHash: taskTargetHash,
              receivedTargetHash: body.targetHash,
            },
          });
        }
        const approval = store.createApproval({
          taskId: task.id,
          scope: body.scope,
          targetHash: body.targetHash,
          actor: "HUMAN",
          status: "PENDING",
        });
        pumpSse();
        sendJson(res, 201, approval);
        return;
      }
      case "approvals.decide": {
        const body = requireBodyObject(await requireJsonBody(req), "approval decision");
        if (!APPROVAL_DECISIONS.has(body.decision)) {
          throw validationError("invalid approval decision", ['decision must be "APPROVED" or "REJECTED"']);
        }
        const targetHash = requireNonEmptyString(body.targetHash, "targetHash");
        const approvals = Array.isArray(store.listApprovals({})) ? store.listApprovals({}) : [];
        const approval = approvals.find((candidate) => candidate.id === params.id);
        if (!approval) throw new ApiError("NOT_FOUND", `approval "${params.id}" not found`, { details: { entity: "approval", id: params.id } });
        if (approval.status !== "PENDING") {
          throw new ApiError("VERSION_CONFLICT", `approval "${approval.id}" is not pending`, {
            details: { entity: "approval", id: approval.id, status: approval.status, reason: "not-pending" },
          });
        }
        const task = store.getTask(approval.taskId); // 404 NOT_FOUND
        // §0.3: the acceptance is bound to the hash it was created for AND to the
        // Task's current target hash (if the Task carries one).
        if (approval.targetHash !== targetHash) {
          throw approvalStale({
            approvalId: approval.id,
            taskId: task.id,
            expectedTargetHash: approval.targetHash,
            receivedTargetHash: targetHash,
          });
        }
        if (typeof task.targetHash === "string" && task.targetHash !== "" && task.targetHash !== targetHash) {
          throw approvalStale({
            approvalId: approval.id,
            taskId: task.id,
            expectedTargetHash: task.targetHash,
            receivedTargetHash: targetHash,
          });
        }
        if (task.status !== "AWAITING_ACCEPTANCE") throw taskStateConflict(task, "not-awaiting-acceptance");
        const result = store.decideApproval({ id: approval.id, decision: body.decision, actor: "HUMAN", targetHash });
        if (!isPlainObject(result) || !result.approval || !result.task) {
          throw new ApiError("INTERNAL_ERROR", "approval decision returned an incomplete result");
        }
        const expectedTaskStatus = body.decision === "APPROVED" ? "DONE" : "READY";
        if (result.approval.status !== body.decision || result.task.status !== expectedTaskStatus) {
          logger?.error?.(`[atk] approval decide did not persist expected facts: approval=${result.approval.status} task=${result.task.status}`);
          throw new ApiError("INTERNAL_ERROR", "approval decision did not persist the expected state");
        }
        pumpSse();
        sendJson(res, 200, result);
        return;
      }
      case "events.list": {
        // M6: server-side aggregate filters, so a Run timeline does not have to
        // page the whole log and filter client-side (which truncates).
        const afterSeq = parseIntegerParam(url.searchParams, "afterSeq", { min: 0, max: Number.MAX_SAFE_INTEGER });
        const limit = parseIntegerParam(url.searchParams, "limit", { min: 1, max: 1000, fallback: 100 });
        const aggregateId = queryString(url.searchParams, "aggregateId");
        const aggregateType = queryString(url.searchParams, "aggregateType");
        const type = queryString(url.searchParams, "type");
        const filter = {};
        if (afterSeq !== undefined) filter.afterSeq = afterSeq;
        if (aggregateId !== undefined) {
          if (!ID_RE.test(aggregateId)) throw fieldValidationError("aggregateId", "aggregateId must be an id string");
          filter.aggregateId = aggregateId;
        }
        if (aggregateType !== undefined) {
          if (typeof aggregateType !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(aggregateType)) {
            throw fieldValidationError("aggregateType", "aggregateType must be a non-empty identifier");
          }
          filter.aggregateType = aggregateType;
        }
        if (type !== undefined) {
          if (!EVENT_TYPES.includes(type)) {
            throw fieldValidationError("type", "type must be one of the known event types");
          }
          filter.type = type;
        }

        // Pagination must be computed for the REQUESTED limit. Never reuse a
        // store page's hasMore/nextAfterSeq when that page was fetched with
        // limit+1 (it thinks the page is complete and drops the next cursor).
        let items;
        let hasMore;
        let nextAfterSeq;
        if (typeof store.listEventsPage === "function") {
          const page = store.listEventsPage({ ...filter, limit });
          items = page && Array.isArray(page.items) ? page.items.slice(0, limit) : [];
          hasMore = Boolean(page?.hasMore);
          if (hasMore && items.length > 0) {
            nextAfterSeq = Number.isInteger(page?.nextAfterSeq) ? page.nextAfterSeq : Number(items[items.length - 1].seq);
          }
        } else {
          const raw = store.listEvents({ ...filter, limit: Math.min(limit + 1, 10_000) });
          const rows = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items) ? raw.items : [];
          items = rows.slice(0, limit);
          hasMore = rows.length > limit;
          // limit=1000 cannot fetch one extra row from the store's hard cap;
          // fall back to seq monotonicity (conservative: never lose events).
          if (!hasMore && limit === 1000 && items.length === 1000 && typeof store.latestSeq === "function") {
            hasMore = store.latestSeq() > Number(items[items.length - 1].seq);
          }
          if (hasMore && items.length > 0) nextAfterSeq = Number(items[items.length - 1].seq);
        }
        const body = { items, hasMore };
        if (nextAfterSeq !== undefined) body.nextAfterSeq = nextAfterSeq;
        sendJson(res, 200, body);
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

      // ADR-008 §5 / ADR-010 §2: `/internal/v1/*` is a separate credential
      // plane. It never accepts the browser session token, and the browser API
      // above never accepts `x-atk-internal`.
      const isInternal = pathname === "/internal" || pathname.startsWith("/internal/");
      if (isInternal) {
        const internalCheck = checkInternalToken(resolvedInternalToken, req.headers[INTERNAL_TOKEN_HEADER]);
        if (!internalCheck.ok) {
          throw new ApiError("NOT_AUTHORIZED", "missing or invalid internal credential", {
            details: { reason: internalCheck.reason },
          });
        }
        await internalRouter.handle({ req, res, method, pathname, url });
        return;
      }

      const isApi = pathname === "/api" || pathname.startsWith("/api/");

      if (!isApi) {
        await staticHandler.handle(req, res, pathname, method);
        return;
      }

      // m6.1 §2: review submission is the one browser-route endpoint that also
      // accepts the internal credential, but only as runtime-host.
      const isReviewSubmit = method === "POST" && /^\/api\/v1\/reviews\/[^/]+\/submit$/.test(pathname);
      if (isReviewSubmit && req.headers[INTERNAL_TOKEN_HEADER] !== undefined) {
        const internalCheck = checkInternalToken(resolvedInternalToken, req.headers[INTERNAL_TOKEN_HEADER]);
        if (!internalCheck.ok) {
          throw new ApiError("NOT_AUTHORIZED", "missing or invalid internal credential", {
            details: { reason: internalCheck.reason },
          });
        }
        const roleCheck = checkInternalRole(req.headers[INTERNAL_ROLE_HEADER], ["runtime-host"]);
        if (!roleCheck.ok) {
          throw new ApiError("NOT_AUTHORIZED", "internal role is not allowed for review submission", {
            details: {
              reason: roleCheck.reason,
              role: roleCheck.role ?? null,
              allowedRoles: ["runtime-host"],
            },
          });
        }
        req.atkPrincipal = { kind: "internal", role: roleCheck.role };
        await dispatch({ req, res, method, pathname, url });
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
      return {
        listening,
        port: boundPort,
        url: baseUrl,
        sseClients: hub.size(),
        schedulerHeartbeat: internalRouter.lastHeartbeat(),
      };
    },
    tokenFile: tokenPersistence.tokenFile,
    tokenPersisted: tokenPersistence.persisted,
    tokenWarning: tokenPersistence.warning,
    /** Internal credential for in-process callers (CLI prints it once; never in HTTP). */
    get internalToken() {
      return resolvedInternalToken;
    },
    httpServer,
  };
}
