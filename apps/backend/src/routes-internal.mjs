// Internal API: `/internal/v1/*` (m2-contracts §2).
//
// Only Runtime Hosts may call this surface. Authentication is a separate
// credential (`x-atk-internal`, ADR-008 §5); this module never looks at
// `x-atk-token`. The Backend is the single writer: handlers translate Host
// reports into persisted events + Run transitions, then wake the SSE hub so the
// browser sees real business events instead of just keep-alives.
import { ID_RE, ApiError, createEvent, isEnumValue } from "@atk/contracts";

import { normalizeLease } from "./internal.mjs";
import { isPlainObject, parseIntegerParam, queryString, requireJsonBody, sendJson } from "./http.mjs";

/** m2-contracts §2 event mapping: session.ended reason -> terminal Run status. */
const END_REASON_TO_STATUS = Object.freeze({
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  interrupted: "INTERRUPTED",
});

const RUNTIME_EVENT_TYPES = new Set(["session.started", "output", "state", "session.ended", "log"]);

/** Run state machine (m2-contracts §2); the store enforces the same rules. */
const ALLOWED_RUN_TRANSITIONS = Object.freeze({
  QUEUED: ["STARTING", "FAILED", "CANCELLED", "INTERRUPTED"],
  STARTING: ["RUNNING", "FAILED", "INTERRUPTED"],
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
});

/** Spec §6.2: the DB keeps summaries, large logs go to files. 8 KiB cap. */
const MAX_LOG_PAYLOAD_BYTES = 8 * 1024;

/** M2 dedupe window for retried batches: (runId, sessionId, at, type). */
const DEDUPE_LIMIT = 5000;

/** A Run is "active" (occupies the Task, capacity and write scope) while non-terminal. */
const ACTIVE_RUN_STATUSES = new Set(["QUEUED", "STARTING", "RUNNING"]);

/** M3 claim idempotency cache: same key replays the original run/command. */
const CLAIM_IDEMPOTENCY_LIMIT = 1000;

const ROUTES = [
  { name: "dispatch.claim", method: "GET", regex: /^\/internal\/v1\/dispatch\/claim$/, keys: [] },
  { name: "dispatch.result", method: "POST", regex: /^\/internal\/v1\/dispatch\/([^/]+)\/result$/, keys: ["id"] },
  { name: "runs.renew", method: "POST", regex: /^\/internal\/v1\/runs\/([^/]+)\/renew$/, keys: ["id"] },
  { name: "runs.events", method: "POST", regex: /^\/internal\/v1\/runs\/([^/]+)\/events$/, keys: ["id"] },
  { name: "runtime.heartbeat", method: "POST", regex: /^\/internal\/v1\/runtime\/heartbeat$/, keys: [] },
  { name: "runs.reconcile", method: "GET", regex: /^\/internal\/v1\/runs\/([^/]+)\/reconcile$/, keys: ["id"] },
  { name: "scheduling.snapshot", method: "GET", regex: /^\/internal\/v1\/scheduling\/snapshot$/, keys: [] },
  { name: "tasks.claim", method: "POST", regex: /^\/internal\/v1\/tasks\/([^/]+)\/claim$/, keys: ["id"] },
  { name: "scheduler.heartbeat", method: "POST", regex: /^\/internal\/v1\/scheduler\/heartbeat$/, keys: [] },
];

function validationError(message, errors) {
  return new ApiError("VALIDATION_ERROR", message, { details: { errors } });
}

function staleError({ runId, expectedGeneration, receivedGeneration }) {
  return new ApiError("STALE_GENERATION", `stale generation for ${runId}`, {
    details: { runId, expectedGeneration: expectedGeneration ?? null, receivedGeneration: receivedGeneration ?? null },
  });
}

function requireObject(body, label) {
  if (!isPlainObject(body)) throw validationError(`${label} must be a JSON object`, [`${label} must be an object`]);
  return body;
}

function requireId(value, label) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw validationError(`invalid ${label}`, [`${label} must be an id string`]);
  }
  return value;
}

function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw validationError(`invalid ${label}`, [`${label} must be an integer between ${min} and ${max}`]);
  }
  return value;
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Validate one RuntimeEvent from the Host; unknown fields are ignored. */
function validateRuntimeEvent(event, index) {
  const label = `events[${index}]`;
  const errors = [];
  if (!isPlainObject(event)) return [`${label} must be an object`];
  if (!RUNTIME_EVENT_TYPES.has(event.type)) {
    errors.push(`${label}.type must be one of session.started|output|state|session.ended|log`);
  }
  if (typeof event.sessionId !== "string" || event.sessionId.trim() === "") {
    errors.push(`${label}.sessionId must be a non-empty string`);
  }
  if (!isIsoDate(event.at)) errors.push(`${label}.at must be an ISO-8601 timestamp`);
  if (event.type === "output") {
    if (!["stdout", "stderr"].includes(event.stream)) errors.push(`${label}.stream must be stdout|stderr`);
    if (typeof event.text !== "string") errors.push(`${label}.text must be a string`);
  } else if (event.type === "state") {
    if (!["running", "idle", "waiting_input"].includes(event.state)) {
      errors.push(`${label}.state must be running|idle|waiting_input`);
    }
  } else if (event.type === "session.ended") {
    if (!Object.prototype.hasOwnProperty.call(END_REASON_TO_STATUS, event.reason)) {
      errors.push(`${label}.reason must be completed|failed|cancelled|interrupted`);
    }
    if (!(event.exitCode === null || Number.isInteger(event.exitCode))) {
      errors.push(`${label}.exitCode must be an integer or null`);
    }
  } else if (event.type === "log") {
    if (!["info", "warn", "error"].includes(event.level)) errors.push(`${label}.level must be info|warn|error`);
    if (typeof event.message !== "string") errors.push(`${label}.message must be a string`);
  }
  return errors;
}

/** Truncate one string field to the 8 KiB payload budget (spec §6.2). */
function truncateField(value) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= MAX_LOG_PAYLOAD_BYTES) return { value, truncated: false, bytes };
  const clipped = Buffer.from(value, "utf8")
    .subarray(0, MAX_LOG_PAYLOAD_BYTES)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
  return { value: clipped, truncated: true, bytes };
}

function slimTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    roleRequired: task.roleRequired,
    functionRequired: task.functionRequired,
    priority: task.priority,
  };
}

function sendNoContent(res) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(204, { "cache-control": "no-store", "content-length": 0 });
  res.end();
}

/**
 * @param {object} options
 * @param {object} options.store  injected store (M1 + m2-contracts §3 methods)
 * @param {object} options.hub    SSE hub; `pump()` flushes new events immediately
 */
export function createInternalRouter({ store, hub, now = () => Date.now(), logger } = {}) {
  // In-process duplicate suppression for retried batches. M2 scope: a restart
  // may re-accept an already-recorded batch; the DB remains the source of truth.
  const seenEventKeys = new Map();

  function dedupeKey(runId, event) {
    return `${runId}|${event.sessionId}|${event.at}|${event.type}`;
  }

  function rememberEvent(runId, event) {
    const key = dedupeKey(runId, event);
    seenEventKeys.set(key, true);
    while (seenEventKeys.size > DEDUPE_LIMIT) {
      const oldest = seenEventKeys.keys().next().value;
      seenEventKeys.delete(oldest);
    }
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

  function runLogPayload(runId, event) {
    if (event.type === "output") {
      const text = truncateField(event.text);
      return {
        runId,
        sessionId: event.sessionId,
        stream: event.stream,
        text: text.value,
        ...(text.truncated ? { truncated: true, bytes: text.bytes } : {}),
      };
    }
    const message = truncateField(event.message);
    return {
      runId,
      sessionId: event.sessionId,
      stream: "log",
      level: event.level,
      message: message.value,
      ...(message.truncated ? { truncated: true, bytes: message.bytes } : {}),
    };
  }

  /**
   * Translate RuntimeEvents into what the Backend asks the store to do:
   * - status transitions (store `updateRunStatus` owns the single `run.updated`
   *   event, always within the same transaction as the status change);
   * - `run.log` events for output/log (store `appendRunEvent`, fenced batch).
   *
   * Pure function: it pre-validates the Run state machine so an illegal
   * transition is rejected before any write.
   */
  function planRunEvents(run, runId, runtimeEvents) {
    const logs = [];
    const updates = [];
    let status = run.status;

    for (const event of runtimeEvents) {
      if (event.type === "session.started" || event.type === "session.ended") {
        const targetStatus = event.type === "session.started" ? "RUNNING" : END_REASON_TO_STATUS[event.reason];
        if (status === targetStatus) continue;
        const allowed = ALLOWED_RUN_TRANSITIONS[status] ?? [];
        if (!allowed.includes(targetStatus)) {
          throw validationError("illegal run transition", [`run cannot transition ${status} -> ${targetStatus}`]);
        }
        const update = { status: targetStatus };
        if (event.type === "session.ended") {
          update.exitCode = event.exitCode ?? null;
          update.endedAt = event.at;
        }
        updates.push(update);
        status = targetStatus;
        continue;
      }
      if (event.type === "output" || event.type === "log") {
        logs.push({ type: "run.log", payload: runLogPayload(runId, event) });
      }
      // `state` is observation metadata: no Run transition, no M2 business event.
    }

    return { logs, updates };
  }

  /**
   * Fill `expectedGeneration` for a 409 after the store rejected the write. The
   * read happens only on the failure path (for reporting); it never fences.
   */
  function resolveGenerationAfterFailure(runId, details = {}) {
    if (Number.isInteger(details.currentGeneration)) return details.currentGeneration;
    if (Number.isInteger(details.expectedGeneration)) return details.expectedGeneration;
    try {
      return store.reconcileRun({ runId }).lease?.generation ?? null;
    } catch {
      return null;
    }
  }

  function staleFrom(error, fallback) {
    if (error?.code === "STALE_GENERATION") {
      const details = error.details ?? {};
      throw staleError({
        runId: details.runId ?? fallback.runId,
        expectedGeneration: resolveGenerationAfterFailure(fallback.runId, details),
        receivedGeneration: details.generation ?? details.receivedGeneration ?? fallback.receivedGeneration,
      });
    }
    throw error;
  }

  // --- M3: scheduling snapshot + atomic claim -------------------------------

  /** In-process idempotency cache: replaying a key returns the original run/command. */
  const claimIdempotency = new Map();
  let lastSchedulerHeartbeat = null;

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function isActiveRun(run) {
    return ACTIVE_RUN_STATUSES.has(run?.status);
  }

  function filesOf(record) {
    return asArray(record?.files).filter((file) => typeof file === "string" && file !== "");
  }

  function claimError(code, message, details) {
    return new ApiError(code, message, { details });
  }

  /**
   * Consistent snapshot for the Scheduler. Uses the store's atomic
   * `schedulingSnapshot()` when available; otherwise composes the same shape
   * from M1/M2 read methods and falls back to `latestSeq()` for the version
   * (documented in the task receipt: still monotonic, because claims append
   * events).
   */
  function buildSchedulingSnapshot() {
    let raw = null;
    if (typeof store.schedulingSnapshot === "function") {
      try {
        raw = store.schedulingSnapshot();
      } catch (error) {
        // Defensive: the Scheduler must keep working even if the store snapshot
        // query is unavailable/buggy — compose the same contract shape from the
        // M1/M2 read methods and record the degradation.
        logger?.error?.(`[atk] store.schedulingSnapshot() failed; using composed snapshot: ${error?.message ?? error}`);
        raw = null;
      }
    }
    if (raw === null) {
      const runs = asArray(store.listRuns({}));
      const leases = [];
      for (const run of runs) {
        if (!isActiveRun(run) || typeof store.reconcileRun !== "function") continue;
        try {
          const lease = store.reconcileRun({ runId: run.id }).lease;
          if (lease) leases.push(lease);
        } catch {
          // A run that vanished between list and reconcile is simply absent.
        }
      }
      raw = {
        version: typeof store.latestSeq === "function" ? store.latestSeq() : 0,
        projects: asArray(store.listProjects()).map((project) => ({ id: project.id, policy: project.policy ?? null })),
        tasks: asArray(store.listTasks({})),
        agents: asArray(store.listAgents()),
        runs,
        leases,
      };
    }
    const fallbackVersion = typeof store.latestSeq === "function" ? store.latestSeq() : 0;
    return {
      version: Number.isInteger(raw?.version) ? raw.version : fallbackVersion,
      generatedAt: isIsoDate(raw?.generatedAt) ? raw.generatedAt : new Date(now()).toISOString(),
      projects: asArray(raw?.projects).map((project) => ({ id: project.id, policy: project.policy ?? null })),
      tasks: asArray(raw?.tasks),
      agents: asArray(raw?.agents),
      runs: asArray(raw?.runs),
      leases: asArray(raw?.leases),
    };
  }

  function parseClaimPolicies(body) {
    const source = isPlainObject(body.policies)
      ? body.policies
      : isPlainObject(body.workspacePolicy?.policies)
        ? body.workspacePolicy.policies
        : null;
    if (!source) return null;
    const policies = {};
    for (const key of ["maxConcurrentPerProject", "maxPerAgent"]) {
      if (source[key] === undefined) continue;
      if (!Number.isInteger(source[key]) || source[key] < 1) {
        throw validationError("invalid claim policies", [`policies.${key} must be a positive integer`]);
      }
      policies[key] = source[key];
    }
    return Object.keys(policies).length > 0 ? policies : null;
  }

  function parseClaimRequest(body) {
    const agentId = requireId(body.agentId, "agentId");
    const expectedTaskVersion = requireInteger(body.expectedTaskVersion, "expectedTaskVersion", { min: 0 });
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "" || body.idempotencyKey.length > 200) {
      throw validationError("invalid task claim", ["idempotencyKey must be a non-empty string of at most 200 characters"]);
    }
    let requestedFunction;
    if (body.function !== undefined) {
      if (!isEnumValue("functions", body.function)) {
        throw validationError("invalid task claim", ["function must be one of the functions enum values"]);
      }
      requestedFunction = body.function;
    }
    let requestedRole;
    if (body.role !== undefined) {
      if (typeof body.role !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(body.role)) {
        throw validationError("invalid task claim", ["role must be an upper-case role identifier"]);
      }
      requestedRole = body.role;
    }
    let workspacePolicy = null;
    if (body.workspacePolicy !== undefined) {
      if (!isPlainObject(body.workspacePolicy)) throw validationError("invalid task claim", ["workspacePolicy must be an object"]);
      workspacePolicy = body.workspacePolicy;
    }
    return {
      agentId,
      expectedTaskVersion,
      requestedFunction,
      requestedRole,
      workspacePolicy,
      policies: parseClaimPolicies(body),
      idempotencyKey: body.idempotencyKey,
    };
  }

  /** §2 step 1: Task exists, READY and at the expected version. */
  function assertTaskClaimable(task, expectedTaskVersion) {
    if (task.status !== "READY" || task.version !== expectedTaskVersion) {
      throw claimError("TASK_VERSION_CONFLICT", `task "${task.id}" is not claimable at version ${expectedTaskVersion}`, {
        taskId: task.id,
        currentVersion: task.version,
        expectedVersion: expectedTaskVersion,
        status: task.status,
      });
    }
  }

  /** §2 step 2: every dependency has to be DONE. */
  function assertDependenciesDone(task) {
    const blockingTaskIds = [];
    for (const dependencyId of asArray(task.deps)) {
      let dependency = null;
      try {
        dependency = store.getTask(dependencyId);
      } catch {
        dependency = null;
      }
      if (!dependency || dependency.status !== "DONE") blockingTaskIds.push(dependencyId);
    }
    if (blockingTaskIds.length > 0) {
      throw claimError("TASK_DEPENDENCY_BLOCKED", `task "${task.id}" has unfinished dependencies`, {
        taskId: task.id,
        blockingTaskIds,
      });
    }
  }

  /** §2 step 3: Agent exists, IDLE and carries the required Role/Function. */
  function resolveClaimAgent(agentId, task, requestedFunction, requestedRole) {
    const requiredFunction = requestedFunction ?? task.functionRequired;
    const requiredRole = requestedRole ?? task.roleRequired;
    const agent = asArray(store.listAgents()).find((candidate) => candidate.id === agentId) ?? null;
    const unavailable = (extra) => {
      throw claimError("CAPABILITY_UNAVAILABLE", `agent "${agentId}" cannot take task "${task.id}"`, {
        reason: "capability-mismatch",
        agentId,
        taskId: task.id,
        requiredFunction,
        requiredRole,
        ...extra,
      });
    };
    if (!agent) unavailable({ agentStatus: null, agentRole: null, agentCapabilities: [] });
    if (agent.status !== "IDLE") {
      unavailable({ agentStatus: agent.status, agentRole: agent.role ?? null, agentCapabilities: asArray(agent.capabilities) });
    }
    if (agent.role !== requiredRole) {
      unavailable({ agentStatus: agent.status, agentRole: agent.role ?? null, agentCapabilities: asArray(agent.capabilities) });
    }
    if (!asArray(agent.capabilities).includes(requiredFunction)) {
      unavailable({ agentStatus: agent.status, agentRole: agent.role ?? null, agentCapabilities: asArray(agent.capabilities) });
    }
    return { function: requiredFunction, role: requiredRole };
  }

  /** §2 step 4: at most one active Run per Task. */
  function assertNoActiveRun(task) {
    const active = asArray(store.listRuns({ taskId: task.id })).filter(isActiveRun);
    if (active.length > 0) {
      throw claimError("TASK_VERSION_CONFLICT", `task "${task.id}" already has an active Run`, {
        taskId: task.id,
        currentVersion: task.version,
        activeRunId: active[0].id,
      });
    }
  }

  /** §2 step 5: per-project and per-agent capacity. Skipped when policies are absent. */
  function assertCapacity({ task, agentId, policies, activeRuns, tasksById }) {
    if (!policies) return;
    if (Number.isInteger(policies.maxConcurrentPerProject)) {
      const current = activeRuns.filter((run) => tasksById.get(run.taskId)?.projectId === task.projectId).length;
      if (current >= policies.maxConcurrentPerProject) {
        throw claimError("CAPABILITY_UNAVAILABLE", `project "${task.projectId}" is at capacity`, {
          reason: "capacity",
          scope: "project",
          taskId: task.id,
          projectId: task.projectId,
          limit: policies.maxConcurrentPerProject,
          current,
        });
      }
    }
    if (Number.isInteger(policies.maxPerAgent)) {
      const current = activeRuns.filter((run) => run.agentId === agentId).length;
      if (current >= policies.maxPerAgent) {
        throw claimError("CAPABILITY_UNAVAILABLE", `agent "${agentId}" is at capacity`, {
          reason: "capacity",
          scope: "agent",
          taskId: task.id,
          agentId,
          limit: policies.maxPerAgent,
          current,
        });
      }
    }
  }

  /** §2 step 6: declared write scope (`task.files` / `run.files`) must not overlap. */
  function assertWriteScope({ task, activeRuns, tasksById }) {
    const candidateFiles = filesOf(task);
    if (candidateFiles.length === 0) return;
    for (const run of activeRuns) {
      const files = Array.isArray(run.files) ? filesOf(run) : filesOf(tasksById.get(run.taskId));
      if (files.length === 0) continue;
      const overlap = candidateFiles.filter((file) => files.includes(file));
      if (overlap.length > 0) {
        throw claimError("CAPABILITY_UNAVAILABLE", `task "${task.id}" conflicts with active Run "${run.id}" write scope`, {
          reason: "write-scope-conflict",
          taskId: task.id,
          conflictingRunId: run.id,
          files: overlap,
        });
      }
    }
  }

  function rememberClaim(idempotencyKey, result) {
    claimIdempotency.set(idempotencyKey, result);
    while (claimIdempotency.size > CLAIM_IDEMPOTENCY_LIMIT) {
      claimIdempotency.delete(claimIdempotency.keys().next().value);
    }
  }


  async function handle({ req, res, method, pathname, url }) {
    const route = matchRoute(pathname, method);
    if (!route) throw new ApiError("NOT_FOUND", `no internal route for ${method} ${pathname}`);
    const { params } = route;

    switch (route.name) {
      case "dispatch.claim": {
        const ownerId = queryString(url.searchParams, "owner");
        requireId(ownerId, "owner");
        const leaseMs = parseIntegerParam(url.searchParams, "leaseMs", { min: 1000, max: 86_400_000, fallback: 30_000 });
        const claimed = store.claimDispatchCommand({ ownerId, leaseMs });
        if (!claimed || !claimed.command) {
          sendNoContent(res);
          return;
        }
        const command = claimed.command;
        const run = store.getRun(command.runId);
        const task = run?.taskId ? store.getTask(run.taskId) : null;
        sendJson(res, 200, { command, run, task: slimTask(task), lease: normalizeLease(claimed.lease) });
        return;
      }

      case "dispatch.result": {
        const body = requireObject(await requireJsonBody(req), "dispatch result");
        const ownerId = requireId(body.ownerId, "ownerId");
        const generation = requireInteger(body.generation, "generation", { min: 0 });
        if (body.status !== "DONE" && body.status !== "FAILED") {
          throw validationError("invalid dispatch result", ['status must be "DONE" or "FAILED"']);
        }
        const result = {};
        if (body.exitCode !== undefined) {
          if (!(body.exitCode === null || Number.isInteger(body.exitCode))) {
            throw validationError("invalid dispatch result", ["exitCode must be an integer or null"]);
          }
          result.exitCode = body.exitCode;
        }
        if (body.summary !== undefined) {
          if (typeof body.summary !== "string") throw validationError("invalid dispatch result", ["summary must be a string"]);
          result.summary = body.summary;
        }
        if (body.error !== undefined) {
          if (typeof body.error !== "string") throw validationError("invalid dispatch result", ["error must be a string"]);
          result.error = body.error;
        }
        let command;
        try {
          command = store.completeDispatchCommand({ id: params.id, ownerId, generation, status: body.status, result });
        } catch (error) {
          if (error?.code === "STALE_GENERATION") {
            const details = error.details ?? {};
            throw new ApiError("STALE_GENERATION", `stale generation for dispatch command ${params.id}`, {
              details: {
                commandId: params.id,
                expectedGeneration: details.expectedGeneration ?? null,
                receivedGeneration: details.receivedGeneration ?? generation,
              },
            });
          }
          throw error;
        }
        let run = null;
        try {
          run = store.getRun(command.runId);
        } catch {
          run = null;
        }
        sendJson(res, 200, { command, run });
        return;
      }

      case "runs.renew": {
        const body = requireObject(await requireJsonBody(req), "renew request");
        const runId = params.id;
        const ownerId = requireId(body.ownerId, "ownerId");
        const generation = requireInteger(body.generation, "generation", { min: 0 });
        const leaseMs = requireInteger(body.leaseMs, "leaseMs", { min: 1000, max: 86_400_000 });
        // The store's renewRunLease is the atomic fence; do not pre-read it.
        let lease;
        try {
          lease = store.renewRunLease({ runId, ownerId, generation, leaseMs });
        } catch (error) {
          staleFrom(error, { runId, expectedGeneration: null, receivedGeneration: generation });
        }
        sendJson(res, 200, { lease: normalizeLease(lease) });
        return;
      }

      case "runs.events": {
        const body = requireObject(await requireJsonBody(req), "runtime events");
        const runId = params.id;
        const generation = requireInteger(body.generation, "generation", { min: 0 });
        if (!Array.isArray(body.events)) {
          throw validationError("invalid runtime events", ["events must be an array of RuntimeEvent objects"]);
        }
        if (body.events.length > 1000) {
          throw validationError("invalid runtime events", ["events accepts at most 1000 RuntimeEvent objects per call"]);
        }
        const errors = [];
        for (const [index, event] of body.events.entries()) errors.push(...validateRuntimeEvent(event, index));
        if (errors.length > 0) throw validationError("invalid runtime events", errors);

        // Dedupe retried batches before planning any write.
        const uniqueEvents = [];
        let skipped = 0;
        for (const event of body.events) {
          if (seenEventKeys.has(dedupeKey(runId, event))) {
            skipped += 1;
            continue;
          }
          uniqueEvents.push(event);
        }

        const runBefore = store.getRun(runId);
        const plan = planRunEvents(runBefore, runId, uniqueEvents);

        // Status changes first: `updateRunStatus(..., { generation })` validates
        // the lease and writes status + version + the single `run.updated` event
        // in one store transaction. No read-then-act window.
        let run = runBefore;
        if (plan.updates.length > 0) {
          try {
            for (const update of plan.updates) {
              run = store.updateRunStatus(runId, { ...update, generation });
            }
          } catch (error) {
            staleFrom(error, { runId, expectedGeneration: null, receivedGeneration: generation });
          }
        }

        // Then the log events as one fenced batch (same generation).
        let appended = [];
        if (plan.logs.length > 0) {
          try {
            appended = store.appendRunEvent({ runId, generation, events: plan.logs });
          } catch (error) {
            staleFrom(error, { runId, expectedGeneration: null, receivedGeneration: generation });
          }
        }

        // Remember only successful events, so a fenced-out retry can be retried.
        for (const event of uniqueEvents) rememberEvent(runId, event);

        if (plan.updates.length > 0 || appended.length > 0) {
          try {
            hub?.pump?.();
          } catch (error) {
            logger?.error?.(`[atk] SSE pump failed after internal events: ${error?.message ?? error}`);
          }
        }
        sendJson(res, 200, { run, appended, skipped });
        return;
      }

      case "runtime.heartbeat": {
        const body = requireObject(await requireJsonBody(req), "runtime heartbeat");
        const ownerId = requireId(body.ownerId, "ownerId");
        if (body.status !== "IDLE" && body.status !== "BUSY") {
          throw validationError("invalid runtime heartbeat", ['status must be "IDLE" or "BUSY"']);
        }
        if (!isPlainObject(body.capabilities)) {
          throw validationError("invalid runtime heartbeat", ["capabilities must be an object"]);
        }
        if (!Array.isArray(body.sessions) || body.sessions.some((session) => typeof session !== "string")) {
          throw validationError("invalid runtime heartbeat", ["sessions must be an array of session ids"]);
        }
        sendJson(res, 200, {
          ok: true,
          ownerId,
          status: body.status,
          receivedAt: new Date(now()).toISOString(),
        });
        return;
      }

      case "runs.reconcile": {
        const reconciled = store.reconcileRun({ runId: params.id });
        sendJson(res, 200, {
          run: reconciled.run,
          lease: normalizeLease(reconciled.lease),
          sessions: Array.isArray(reconciled.sessions) ? reconciled.sessions : [],
        });
        return;
      }

      case "scheduling.snapshot": {
        sendJson(res, 200, buildSchedulingSnapshot());
        return;
      }

      case "tasks.claim": {
        const taskId = params.id;
        const body = requireObject(await requireJsonBody(req), "task claim");

        // Idempotency is checked first: replaying a key must return the original
        // {run, command} even though the Task version has advanced since.
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "" || body.idempotencyKey.length > 200) {
          throw validationError("invalid idempotencyKey", ["idempotencyKey must be a non-empty string of at most 200 characters"]);
        }
        const cached = claimIdempotency.get(body.idempotencyKey);
        if (cached) {
          if (cached.task?.id !== taskId) {
            throw new ApiError("VALIDATION_ERROR", "idempotencyKey was already used for another task", {
              details: { errors: ["idempotencyKey was already used for another task"], idempotencyKey: body.idempotencyKey, taskId, existingTaskId: cached.task?.id ?? null },
            });
          }
          sendJson(res, 200, cached);
          return;
        }

        const request = parseClaimRequest(body);

        // --- the 7-step contract-layer validation (never rely on store errors) ---
        const task = store.getTask(taskId); // 404 NOT_FOUND
        assertTaskClaimable(task, request.expectedTaskVersion); // step 1
        assertDependenciesDone(task); // step 2
        const effective = resolveClaimAgent(request.agentId, task, request.requestedFunction, request.requestedRole); // step 3
        assertNoActiveRun(task); // step 4

        const allTasks = asArray(store.listTasks({}));
        const tasksById = new Map(allTasks.map((candidate) => [candidate.id, candidate]));
        const allRuns = asArray(store.listRuns({}));
        const activeRuns = allRuns.filter(isActiveRun);
        assertCapacity({ task, agentId: request.agentId, policies: request.policies, activeRuns, tasksById }); // step 5
        assertWriteScope({ task, activeRuns, tasksById }); // step 6

        // Step 7: one atomic store transaction (CAS + createRun + enqueue +
        // task.updated/run.created events). Never compose this from M1 calls.
        if (typeof store.claimTask !== "function") {
          logger?.error?.("[atk] store.claimTask is unavailable; refusing a non-atomic claim");
          throw new ApiError("INTERNAL_ERROR", "atomic claim store method is unavailable");
        }
        const result = store.claimTask({
          taskId,
          agentId: request.agentId,
          expectedTaskVersion: request.expectedTaskVersion,
          function: effective.function,
          role: effective.role,
          workspacePolicy: request.workspacePolicy,
          policies: request.policies,
          idempotencyKey: request.idempotencyKey,
        });
        if (!isPlainObject(result) || !result.run || !result.command || !result.task) {
          logger?.error?.("[atk] store.claimTask returned an incomplete result");
          throw new ApiError("INTERNAL_ERROR", "atomic claim returned an incomplete result");
        }

        rememberClaim(request.idempotencyKey, result);
        try {
          hub?.pump?.();
        } catch (error) {
          logger?.error?.(`[atk] SSE pump failed after claim: ${error?.message ?? error}`);
        }
        sendJson(res, 200, result);
        return;
      }

      case "scheduler.heartbeat": {
        const body = requireObject(await requireJsonBody(req), "scheduler heartbeat");
        const ownerId = requireId(body.ownerId, "ownerId");
        if (body.status !== undefined && (typeof body.status !== "string" || body.status.trim() === "")) {
          throw validationError("invalid scheduler heartbeat", ["status must be a non-empty string when provided"]);
        }
        if (body.details !== undefined && !isPlainObject(body.details)) {
          throw validationError("invalid scheduler heartbeat", ["details must be an object when provided"]);
        }
        lastSchedulerHeartbeat = {
          ownerId,
          status: body.status ?? null,
          details: body.details ?? null,
          receivedAt: new Date(now()).toISOString(),
        };
        sendJson(res, 200, { ok: true, ownerId, receivedAt: lastSchedulerHeartbeat.receivedAt });
        return;
      }

      default: {
        throw new ApiError("NOT_FOUND", `no internal route for ${method} ${pathname}`);
      }
    }
  }

  function lastHeartbeat() {
    return lastSchedulerHeartbeat === null ? null : structuredClone(lastSchedulerHeartbeat);
  }

  return { handle, lastHeartbeat };
}
