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
import { INTERNAL_TOKEN_HEADER, checkInternalToken, createInternalToken } from "./internal.mjs";
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
  const session = createSession({ now: startedAt, ttlMs: sessionTtlMs, token, csrf });

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

  function reviewFilterFrom(searchParams) {
    const filter = {};
    const taskId = queryString(searchParams, "taskId");
    if (taskId !== undefined) {
      if (taskId.trim() === "" || !ID_RE.test(taskId)) throw validationError("invalid review filter", ["taskId must be an id string"]);
      filter.taskId = taskId;
    }
    const status = queryString(searchParams, "status");
    if (status !== undefined) {
      if (!M4_REVIEW_STATUSES.has(status)) {
        throw validationError("invalid review filter", ["status must be a known review status"]);
      }
      filter.status = status;
    }
    const limit = parseIntegerParam(searchParams, "limit", { min: 1, max: 100 });
    if (limit !== undefined) filter.limit = limit;
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
        // §0.5: DONE has exactly one entrance — an APPROVED human acceptance.
        if (changes.status === "DONE") {
          throw new ApiError("TASK_VERSION_CONFLICT", "DONE can only be reached through human approval", {
            details: { taskId: params.id, reason: "human-approval-required", requestedStatus: "DONE" },
          });
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
        const filter = reviewFilterFrom(url.searchParams);
        // Filter statuses in the Backend: M4 adds CHANGES_REQUESTED/BLOCKED while
        // the store's enum filter only knows the M1 set.
        const { status, limit, ...storeFilter } = filter;
        storeFilter.limit = limit ?? 100;
        let items = store.listReviews(storeFilter);
        items = Array.isArray(items) ? items : [];
        if (status !== undefined) items = items.filter((review) => review.status === status);
        if (limit !== undefined) items = items.slice(0, limit);
        sendJson(res, 200, { items, total: items.length });
        return;
      }
      case "reviews.create": {
        const body = requireBodyObject(await requireJsonBody(req), "review");
        if (typeof body.taskId !== "string" || !ID_RE.test(body.taskId)) {
          throw validationError("invalid review", ["taskId must be an id string"]);
        }
        const actor = actorFrom(body, { required: true });
        let runId = null;
        if (body.runId !== undefined) {
          if (typeof body.runId !== "string" || !ID_RE.test(body.runId)) {
            throw validationError("invalid review", ["runId must be an id string when provided"]);
          }
          runId = body.runId;
        }
        const task = store.getTask(body.taskId); // 404 NOT_FOUND
        if (task.status !== "REVIEWING") throw taskStateConflict(task, "not-reviewing");
        if (runId !== null) {
          const run = store.getRun(runId); // 404 NOT_FOUND
          if (run.taskId !== task.id) throw validationError("invalid review", ["runId does not belong to the task"]);
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
        const review = store.createReview({ taskId: task.id, runId, actor });
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
        const actor = actorFrom(body);
        const review = getReviewOrThrow(params.id); // 404 NOT_FOUND
        if (review.status !== "PENDING") throw reviewStateConflict(review, "not-pending");
        if (review.version !== expectedVersion) throw reviewCasConflict(review, expectedVersion);
        const task = store.getTask(review.taskId); // 404 NOT_FOUND
        if (task.status !== "REVIEWING") throw taskStateConflict(task, "not-reviewing");
        assertNotSelfReview(review, task, actor);

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
          actor,
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
          if (!ID_RE.test(aggregateId)) throw validationError("invalid event filter", ["aggregateId must be an id string"]);
          filter.aggregateId = aggregateId;
        }
        if (aggregateType !== undefined) {
          if (typeof aggregateType !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(aggregateType)) {
            throw validationError("invalid event filter", ["aggregateType must be a non-empty identifier"]);
          }
          filter.aggregateType = aggregateType;
        }
        if (type !== undefined) {
          if (!EVENT_TYPES.includes(type)) {
            throw validationError("invalid event filter", ["type must be one of the known event types"]);
          }
          filter.type = type;
        }

        // Fetch one extra row to compute hasMore without a second store call.
        const fetchLimit = limit < 1000 ? limit + 1 : limit;
        const raw = store.listEvents({ ...filter, limit: fetchLimit });
        let items;
        let hasMore;
        let nextAfterSeq;
        if (Array.isArray(raw)) {
          items = raw.slice(0, limit);
          // @atk/database annotates the array with a filtered hasMore/nextAfterSeq
          // (non-enumerable), which is authoritative for filtered pages.
          if (typeof raw.hasMore === "boolean") {
            hasMore = raw.hasMore;
            if (Number.isInteger(raw.nextAfterSeq)) nextAfterSeq = raw.nextAfterSeq;
            else if (hasMore && items.length > 0) nextAfterSeq = Number(items[items.length - 1].seq);
          } else {
            hasMore = raw.length > limit;
            if (!hasMore && limit === 1000 && items.length === 1000 && typeof store.latestSeq === "function") {
              hasMore = store.latestSeq() > Number(items[items.length - 1].seq);
            }
          }
        } else if (raw && Array.isArray(raw.items)) {
          // Forward-compatible: a store may return {items, hasMore, nextAfterSeq}.
          items = raw.items.slice(0, limit);
          hasMore = typeof raw.hasMore === "boolean" ? raw.hasMore : raw.items.length > limit;
          nextAfterSeq = raw.nextAfterSeq;
        } else {
          items = [];
          hasMore = false;
        }
        if (nextAfterSeq === undefined && hasMore && items.length > 0) {
          const lastSeq = Number(items[items.length - 1].seq);
          if (Number.isInteger(lastSeq)) nextAfterSeq = lastSeq;
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
