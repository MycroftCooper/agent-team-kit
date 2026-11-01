// In-memory Store: the same interface and the same behaviour as the SQLite
// store (contracts 搂1), for backend/QA flows that must not touch a database
// file (unit tests, read-only demos, dry-run style tools).
//
// Behaviour parity is structural, not accidental: validation, defaults, CAS
// conflicts, ordering and the overview projection all come from `model.mjs`,
// the same module the SQLite store uses. The only difference is persistence.
//
// Writes validate before mutating: there is no window in which a rejected
// operation leaves a half-applied change behind (the SQLite store gets the same
// guarantee from BEGIN IMMEDIATE/ROLLBACK).
import { EVENT_SCHEMA_VERSION } from "@atk/contracts";
import { fail, notFound } from "./errors.mjs";
import { INTERNAL } from "./internal.mjs";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_REVIEW_ATTEMPTS,
  MAX_EVENT_LIMIT,
  MAX_EVENT_PAGE_LIMIT,
  MAX_OVERVIEW_EVENTS,
  ACTIVE_RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  SCHEMA_VERSION,
  applyReviewVerdict,
  assertEnumFilter,
  assertTaskTransition,
  buildOverview,
  canTransition,
  canonicalAgentId,
  compareTasks,
  ensurePlainObject,
  filesIntersection,
  generateId,
  isPlainObject,
  leaseExpiryAfter,
  makeEvent,
  mergeAgent,
  mergeProject,
  mergeRunStatus,
  mergeTask,
  normalizeAgent,
  normalizeEventFilters,
  normalizeApproval,
  normalizeLimit,
  normalizeProject,
  normalizeProjectPolicy,
  normalizeRequirement,
  normalizeReview,
  normalizeRun,
  normalizeTask,
  nowIso,
  requireId,
  safeJson,
  validateActor,
  validateApprovalDecision,
  validateTargetHash,
  validateCommandPayload,
  validateCommandType,
  validateIdempotencyKey,
  validateLeaseMs,
  validateOwnerId,
  validateSchedulingPolicies,
  validateTaskStatus,
} from "./model.mjs";
import { verifySwitchReadiness } from "./import-export.mjs";

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

/** JSON-safe deep copy for migration metadata (rejects functions/circular refs). */
function jsonClone(value, label) {
  const text = safeJson(value, label);
  return text === null ? null : JSON.parse(text);
}

export function createMemoryStore() {
  const projects = new Map();
  const requirements = new Map();
  const tasks = new Map();
  const agents = new Map();
  const reviews = new Map();
  const reviewAttempts = new Map();
  const approvals = new Map();
  const events = [];
  const projectMeta = new Map();
  const taskMeta = new Map();
  const runs = new Map();
  const runLeases = new Map();
  const dispatchCommands = new Map();
  const commandIdempotency = new Map();
  let seq = 0;

  /** Insert one already-built event and return a defensive copy. */
  function appendEventEntry(event) {
    seq += 1;
    const persisted = { ...event, seq, schemaVersion: EVENT_SCHEMA_VERSION };
    events.push(persisted);
    return clone(persisted);
  }

  function getProjectEntry(id) {
    requireId(id, "project.id");
    return projects.get(id) ?? null;
  }

  function requireProject(id) {
    const project = getProjectEntry(id);
    if (!project) notFound("project", id);
    return project;
  }

  function getTaskEntry(id) {
    requireId(id, "task.id");
    return tasks.get(id) ?? null;
  }

  function requireTaskEntry(id) {
    const task = getTaskEntry(id);
    if (!task) notFound("task", id);
    return task;
  }

  function getRunEntry(id) {
    requireId(id, "run.id");
    return runs.get(id) ?? null;
  }

  function requireRunEntry(id) {
    const run = getRunEntry(id);
    if (!run) notFound("run", id);
    return run;
  }

  function leaseOf(runId) {
    return runLeases.get(runId) ?? null;
  }

  function getReviewEntry(id) {
    requireId(id, "review.id");
    return reviews.get(id) ?? null;
  }

  function requireReviewEntry(id) {
    const review = getReviewEntry(id);
    if (!review) notFound("review", id);
    return review;
  }

  /**
   * Self-review proxy (Lead ruling, no assignee column): producer = reviewed
   * Run's agent, else the Task's latest/active Run agent.
   */
  function latestProducerAgentId(taskId) {
    const taskRuns = [...runs.values()].filter((run) => run.taskId === taskId);
    const active = taskRuns
      .filter((run) => ACTIVE_RUN_STATUSES.includes(run.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    if (active.length > 0) return active[0].agentId;
    const all = taskRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return all.length > 0 ? all[0].agentId : null;
  }

  /** Validate + apply a Task transition inside the caller's write path. */
  function transitionTaskEntry(taskId, to, { targetHash } = {}) {
    const current = requireTaskEntry(taskId);
    assertTaskTransition(current.status, to);
    const next = {
      ...current,
      status: to,
      version: current.version + 1,
      updatedAt: nowIso(),
    };
    if (targetHash !== undefined) next.targetHash = targetHash;
    tasks.set(taskId, next);
    return clone(next);
  }

  function commandEntry(id) {
    requireId(id, "dispatchCommand.id");
    return dispatchCommands.get(id) ?? null;
  }

  function assertDepsExist(deps, selfId) {
    const missing = [];
    for (const dep of deps) {
      if (dep === selfId) {
        fail("VALIDATION_ERROR", "task may not depend on itself", { taskId: selfId, dep });
      }
      if (!tasks.has(dep)) missing.push(dep);
    }
    if (missing.length > 0) {
      fail("VALIDATION_ERROR", "task.deps references unknown tasks", { missingDeps: missing });
    }
  }

  function filterTasks({ projectId, status, roleRequired, functionRequired, q, limit } = {}) {
    let list = [...tasks.values()];
    if (projectId !== undefined && projectId !== null) {
      requireId(projectId, "task.projectId");
      list = list.filter((task) => task.projectId === projectId);
    }
    if (status !== undefined && status !== null) {
      validateTaskStatus(status);
      list = list.filter((task) => task.status === status);
    }
    if (roleRequired !== undefined && roleRequired !== null) {
      if (typeof roleRequired !== "string" || roleRequired.trim() === "") {
        fail("VALIDATION_ERROR", "roleRequired must be a non-empty string", { roleRequired });
      }
      list = list.filter((task) => task.roleRequired === roleRequired);
    }
    if (functionRequired !== undefined && functionRequired !== null) {
      if (!["ORCHESTRATOR", "WORKER", "REVIEWER"].includes(functionRequired)) {
        fail("VALIDATION_ERROR", "functionRequired must be a Function", { functionRequired });
      }
      list = list.filter((task) => task.functionRequired === functionRequired);
    }
    if (q !== undefined && q !== null) {
      if (typeof q !== "string") fail("VALIDATION_ERROR", "q must be a string", { q });
      const needle = q.trim().toLowerCase();
      if (needle !== "") {
        list = list.filter(
          (task) =>
            task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle),
        );
      }
    }
    return list.sort(compareTasks).slice(0, normalizeLimit(limit));
  }

  function filterRuns({ taskId, status, limit } = {}) {
    let list = [...runs.values()];
    if (taskId !== undefined && taskId !== null) {
      requireId(taskId, "run.taskId");
      list = list.filter((run) => run.taskId === taskId);
    }
    if (status !== undefined && status !== null) {
      assertEnumFilter("run", status);
      list = list.filter((run) => run.status === status);
    }
    return list
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, normalizeLimit(limit, { fallback: 50 }));
  }

  /** Shared event pagination (M6); mirrors sqlite's buildEventPage. */
  function buildEventPage(filters = {}) {
    const normalized = normalizeEventFilters(filters);
    let list = events;
    if (normalized.projectId !== undefined) {
      list = list.filter((event) => event.projectId === normalized.projectId);
    }
    if (normalized.aggregateId !== undefined) {
      list = list.filter((event) => event.aggregateId === normalized.aggregateId);
    }
    if (normalized.aggregateType !== undefined) {
      list = list.filter((event) => event.aggregateType === normalized.aggregateType);
    }
    if (normalized.type !== undefined) {
      list = list.filter((event) => event.type === normalized.type);
    }
    if (normalized.afterSeq !== undefined) {
      list = list.filter((event) => event.seq > normalized.afterSeq);
    }
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    const hasMore = sorted.length > normalized.limit;
    const items = (hasMore ? sorted.slice(0, normalized.limit) : sorted).map(clone);
    const nextAfterSeq = hasMore ? items[items.length - 1].seq : undefined;
    return { items, hasMore, ...(nextAfterSeq === undefined ? {} : { nextAfterSeq }) };
  }

  const store = {
    close() {
      // Nothing to release; kept for interface parity.
    },

    health() {
      return {
        ok: true,
        file: null,
        schemaVersion: SCHEMA_VERSION,
        counts: {
          projects: projects.size,
          tasks: tasks.size,
          runs: runs.size,
          events: events.length,
          agents: agents.size,
        },
      };
    },

    /** JSON -> SQLite switch pre-flight (m6-contracts §1); shared with CLI. */
    verifySwitchReadiness: () => verifySwitchReadiness(store),

    // --- Projects ---------------------------------------------------------
    listProjects() {
      return [...projects.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(clone);
    },

    getProject(id) {
      return clone(requireProject(id));
    },

    createProject(dto) {
      ensurePlainObject(dto, "project");
      if (getProjectEntry(dto.id)) {
        fail("VALIDATION_ERROR", `project "${dto.id}" already exists`, { entity: "project", id: dto.id });
      }
      const project = normalizeProject(dto, { now: nowIso() });
      projects.set(project.id, project);
      projectMeta.set(project.id, {
        legacy: jsonClone(dto.legacy, "project.legacy"),
        settings: jsonClone(dto.settings, "project.settings"),
        policy: jsonClone(normalizeProjectPolicy(dto.policy, "project.policy"), "project.policy"),
      });
      return clone(project);
    },

    updateProject(id, { expectedVersion, changes } = {}) {
      requireId(id, "project.id");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        fail("VALIDATION_ERROR", "expectedVersion must be a non-negative integer", { expectedVersion });
      }
      const current = requireProject(id);
      const merged = mergeProject(current, changes, { now: nowIso() });
      if (current.version !== expectedVersion) {
        fail("VERSION_CONFLICT", `project "${id}" version conflict`, {
          entity: "project",
          id,
          expectedVersion,
          currentVersion: current.version,
        });
      }
      projects.set(id, merged);
      return clone(merged);
    },

    // --- Requirements -----------------------------------------------------
    listRequirements({ projectId } = {}) {
      let list = [...requirements.values()];
      if (projectId !== undefined && projectId !== null) {
        requireId(projectId, "requirement.projectId");
        list = list.filter((requirement) => requirement.projectId === projectId);
      }
      return list
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(clone);
    },

    createRequirement(dto) {
      ensurePlainObject(dto, "requirement");
      requireProject(dto.projectId);
      if (requirements.has(dto.id)) {
        fail("VALIDATION_ERROR", `requirement "${dto.id}" already exists`, {
          entity: "requirement",
          id: dto.id,
        });
      }
      const requirement = normalizeRequirement(dto, { now: nowIso() });
      requirements.set(requirement.id, requirement);
      return clone(requirement);
    },

    // --- Tasks ------------------------------------------------------------
    listTasks(filters = {}) {
      ensurePlainObject(filters, "listTasks filters");
      return filterTasks(filters).map(clone);
    },

    getTask(id) {
      requireId(id, "task.id");
      return clone(requireTaskEntry(id));
    },

    createTask(dto) {
      ensurePlainObject(dto, "task");
      requireProject(dto.projectId);
      const task = normalizeTask(dto, { now: nowIso(), status: "READY" });
      if (tasks.has(task.id)) {
        fail("VALIDATION_ERROR", `task "${task.id}" already exists`, { entity: "task", id: task.id });
      }
      assertDepsExist(task.deps, task.id);
      tasks.set(task.id, task);
      taskMeta.set(task.id, { legacy: jsonClone(dto.legacy, "task.legacy") });
      return clone(task);
    },

    patchTask(id, { expectedVersion, changes } = {}) {
      requireId(id, "task.id");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        fail("VALIDATION_ERROR", "expectedVersion must be a non-negative integer", { expectedVersion });
      }
      const current = requireTaskEntry(id);
      const merged = mergeTask(current, changes, { now: nowIso() });
      if (changes.deps !== undefined) assertDepsExist(merged.deps, id);
      if (current.version !== expectedVersion) {
        fail("TASK_VERSION_CONFLICT", `task "${id}" version conflict`, {
          taskId: id,
          expectedVersion,
          currentVersion: current.version,
        });
      }
      tasks.set(id, merged);
      return clone(merged);
    },

    // --- Runs / Agents / Reviews / Approvals ------------------------------
    listRuns(filters = {}) {
      ensurePlainObject(filters, "listRuns filters");
      return filterRuns(filters).map(clone);
    },

    getRun(id) {
      requireId(id, "run.id");
      const run = runs.get(id);
      if (!run) notFound("run", id);
      return clone(run);
    },

    // --- Run lifecycle (m2-contracts 搂2/搂3) -------------------------------
    createRun(dto) {
      ensurePlainObject(dto, "run");
      const task = requireTaskEntry(dto.taskId);
      const attempt = [...runs.values()].filter((run) => run.taskId === dto.taskId).length + 1;
      const at = nowIso();
      const run = normalizeRun(dto, { now: at, attempt, id: dto.id });
      if (runs.has(run.id)) {
        fail("VALIDATION_ERROR", `run "${run.id}" already exists`, { entity: "run", id: run.id });
      }
      runs.set(run.id, run);
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "run",
          aggregateId: run.id,
          type: "run.created",
          payload: {
            runId: run.id,
            taskId: run.taskId,
            agentId: run.agentId,
            function: run.function,
            role: run.role,
            status: run.status,
            attempt: run.attempt,
            version: run.version,
            ...(run.workspaceId === undefined ? {} : { workspaceId: run.workspaceId }),
          },
          now: at,
        }),
      );
      return clone(run);
    },

    updateRunStatus(id, { status, exitCode, endedAt, generation } = {}) {
      requireId(id, "run.id");
      const at = nowIso();
      if (generation !== undefined && generation !== null) {
        if (!Number.isInteger(generation) || generation < 1) {
          fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
        }
        const lease = leaseOf(id);
        if (!lease) {
          fail("STALE_GENERATION", `run "${id}" state report is fenced out`, {
            runId: id,
            generation,
            currentGeneration: null,
            reason: "lease-missing",
          });
        }
        if (lease.generation !== generation) {
          fail("STALE_GENERATION", `run "${id}" state report is fenced out`, {
            runId: id,
            generation,
            currentGeneration: lease.generation,
            reason: "generation-mismatch",
          });
        }
        // QA-003 MAJOR-1: matching but expired generation is still stale.
        if (lease.claimedUntil <= at) {
          fail("STALE_GENERATION", `run "${id}" lease has expired`, {
            runId: id,
            generation,
            currentGeneration: lease.generation,
            claimedUntil: lease.claimedUntil,
            reason: "lease-expired",
          });
        }
      }
      const current = requireRunEntry(id);
      const merge = mergeRunStatus(current, { status, exitCode, endedAt }, { now: at });
      if (!merge.updated) return clone(current);
      const next = merge.run;
      runs.set(id, next);
      const task = requireTaskEntry(next.taskId);
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "run",
          aggregateId: id,
          type: "run.updated",
          payload: {
            runId: id,
            taskId: next.taskId,
            status: next.status,
            previousStatus: current.status,
            version: next.version,
            ...(next.exitCode === undefined ? {} : { exitCode: next.exitCode }),
            ...(next.endedAt === undefined ? {} : { endedAt: next.endedAt }),
          },
          now: at,
        }),
      );
      return clone(next);
    },

    // --- Durable dispatch commands + leases (ADR-003 / m2-contracts 搂3) ---
    enqueueDispatchCommand({ runId, commandType, payload, idempotencyKey } = {}) {
      const commandTypeValue = validateCommandType(commandType);
      const key = validateIdempotencyKey(idempotencyKey);
      const payloadValue = validateCommandPayload(payload);
      const run = requireRunEntry(runId);
      const existingId = commandIdempotency.get(key);
      if (existingId !== undefined) return clone(dispatchCommands.get(existingId));
      const at = nowIso();
      const command = {
        id: generateId("CMD"),
        runId: run.id,
        taskId: run.taskId,
        commandType: commandTypeValue,
        payload: clone(payloadValue),
        status: "PENDING",
        idempotencyKey: key,
        ownerId: null,
        generation: 0,
        claimedUntil: null,
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      };
      dispatchCommands.set(command.id, command);
      commandIdempotency.set(key, command.id);
      return clone(command);
    },

    claimDispatchCommand({ ownerId, leaseMs } = {}) {
      const owner = validateOwnerId(ownerId);
      const ttl = validateLeaseMs(leaseMs, { fallback: DEFAULT_LEASE_MS });
      const now = nowIso();
      const candidate = [...dispatchCommands.values()]
        .filter((command) => {
          const run = runs.get(command.runId);
          if (!run || !["QUEUED", "STARTING", "RUNNING"].includes(run.status)) return false;
          const lease = leaseOf(command.runId);
          const leaseIsLive = lease !== null && lease.claimedUntil > now;
          // A run must never have two effective holders (ADR-003): a fresh
          // command may only be claimed when no live lease exists.
          if (command.status === "PENDING") return !leaseIsLive;
          return command.status === "CLAIMED" && command.claimedUntil !== null && command.claimedUntil <= now;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      if (!candidate) return null;
      const existingLease = leaseOf(candidate.runId);
      const generation = existingLease === null ? 1 : existingLease.generation + 1;
      const claimedUntil = leaseExpiryAfter(now, ttl);
      const command = {
        ...candidate,
        status: "CLAIMED",
        ownerId: owner,
        generation,
        claimedUntil,
        attempts: candidate.attempts + 1,
        updatedAt: now,
      };
      dispatchCommands.set(command.id, command);
      const lease = {
        runId: command.runId,
        ownerId: owner,
        generation,
        claimedUntil,
        lastHeartbeatAt: now,
        createdAt: existingLease?.createdAt ?? now,
        updatedAt: now,
      };
      runLeases.set(lease.runId, lease);
      return { command: clone(command), lease: clone(lease) };
    },

    completeDispatchCommand({ id, ownerId, generation, status, result } = {}) {
      requireId(id, "dispatchCommand.id");
      const owner = validateOwnerId(ownerId);
      if (!Number.isInteger(generation) || generation < 1) {
        fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
      }
      if (status !== "DONE" && status !== "FAILED") {
        fail("VALIDATION_ERROR", "dispatch result status must be DONE or FAILED", {
          status: status ?? null,
          allowed: ["DONE", "FAILED"],
        });
      }
      if (result !== undefined && result !== null && !isPlainObject(result)) {
        fail("VALIDATION_ERROR", "dispatch result must be an object", { resultType: typeof result });
      }
      const command = commandEntry(id);
      if (!command) notFound("dispatchCommand", id);
      const now = nowIso();
      const stale = (details) => {
        fail("STALE_GENERATION", `dispatch command "${id}" report is fenced out`, {
          commandId: id,
          runId: command.runId,
          ownerId: owner,
          generation,
          ...details,
        });
      };
      if (command.status === "DONE" || command.status === "FAILED") {
        if (command.generation === generation && command.ownerId === owner) return clone(command);
        stale({
          currentGeneration: command.generation,
          currentOwnerId: command.ownerId,
          reason: "generation-mismatch",
        });
      }
      if (command.status !== "CLAIMED") {
        stale({ currentGeneration: command.generation, reason: "command-not-claimed" });
      }
      const lease = leaseOf(command.runId);
      if (!lease) stale({ currentGeneration: null, reason: "lease-missing" });
      if (lease.generation !== generation || lease.ownerId !== owner) {
        stale({
          currentGeneration: lease.generation,
          currentOwnerId: lease.ownerId,
          reason: "generation-mismatch",
        });
      }
      // QA-003 MAJOR-1: an expired lease must not finish the command. Checked
      // before the write that expires the lease (successful call unaffected).
      if (lease.claimedUntil <= now) {
        stale({
          currentGeneration: lease.generation,
          claimedUntil: lease.claimedUntil,
          reason: "lease-expired",
        });
      }
      const done = {
        ...command,
        status,
        result: clone(result ?? {}),
        completedAt: now,
        claimedUntil: now,
        updatedAt: now,
      };
      dispatchCommands.set(id, done);
      // "Release" the lease by EXPIRING it, never by deleting it: the monotonic
      // generation must survive completion so a later claim of the same run
      // bumps past the finished holder (deleting restarts at 1 and a stale host
      // could match again). reconcileRun therefore reports this expired lease.
      runLeases.set(lease.runId, {
        ...lease,
        claimedUntil: now,
        lastHeartbeatAt: now,
        updatedAt: now,
      });
      return clone(done);
    },

    /**
     * D3 crash-window sweeper (see sqlite.mjs): a terminal Run means any of its
     * still-CLAIMED commands can be closed from the Run truth. Idempotent, no
     * lease/owner required.
     */
    sweepDispatchCommands({ now } = {}) {
      let requestedNow = null;
      if (now !== undefined && now !== null) {
        if (typeof now !== "string" || Number.isNaN(Date.parse(now))) {
          fail("VALIDATION_ERROR", "now must be an ISO-8601 timestamp", { now });
        }
        requestedNow = now;
      }
      const at = requestedNow ?? nowIso();
      const closed = [];
      for (const [id, command] of dispatchCommands) {
        if (command.status !== "CLAIMED") continue;
        const run = runs.get(command.runId);
        if (!run || !RUN_TERMINAL_STATUSES.includes(run.status)) continue;
        const status = run.status === "COMPLETED" ? "DONE" : "FAILED";
        dispatchCommands.set(id, {
          ...command,
          status,
          result: { derivedFrom: "run-terminal", runStatus: run.status },
          completedAt: at,
          claimedUntil: at,
          updatedAt: at,
        });
        const lease = runLeases.get(command.runId);
        if (lease) {
          runLeases.set(command.runId, {
            ...lease,
            claimedUntil: at,
            lastHeartbeatAt: at,
            updatedAt: at,
          });
        }
        closed.push({ commandId: id, runId: command.runId, status });
      }
      return { closed, count: closed.length };
    },

    renewRunLease({ runId, ownerId, generation, leaseMs } = {}) {
      requireId(runId, "run.id");
      const owner = validateOwnerId(ownerId);
      if (!Number.isInteger(generation) || generation < 1) {
        fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
      }
      const ttl = validateLeaseMs(leaseMs, { fallback: DEFAULT_LEASE_MS });
      const now = nowIso();
      const lease = leaseOf(runId);
      const stale = (details) => {
        fail("STALE_GENERATION", `run "${runId}" lease is fenced out`, {
          runId,
          ownerId: owner,
          generation,
          ...details,
        });
      };
      if (!lease) stale({ currentGeneration: null, reason: "lease-missing" });
      if (lease.ownerId !== owner) {
        stale({
          currentGeneration: lease.generation,
          currentHolderId: lease.ownerId,
          reason: "holder-mismatch",
        });
      }
      if (lease.generation !== generation) {
        stale({ currentGeneration: lease.generation, reason: "generation-mismatch" });
      }
      if (lease.claimedUntil <= now) {
        stale({
          currentGeneration: lease.generation,
          claimedUntil: lease.claimedUntil,
          reason: "lease-expired",
        });
      }
      const nextGeneration = generation + 1;
      const claimedUntil = leaseExpiryAfter(now, ttl);
      const renewed = {
        ...lease,
        generation: nextGeneration,
        claimedUntil,
        lastHeartbeatAt: now,
        updatedAt: now,
      };
      runLeases.set(runId, renewed);
      for (const [id, command] of dispatchCommands) {
        if (command.runId === runId && command.status === "CLAIMED") {
          dispatchCommands.set(id, {
            ...command,
            generation: nextGeneration,
            claimedUntil,
            updatedAt: now,
          });
        }
      }
      return clone(renewed);
    },

    appendRunEvent({ runId, generation, events: inputEvents } = {}) {
      requireId(runId, "run.id");
      if (!Number.isInteger(generation) || generation < 1) {
        fail("VALIDATION_ERROR", "generation must be a positive integer", { generation });
      }
      // An empty array is a valid pure-fence call (see sqlite.mjs).
      if (!Array.isArray(inputEvents)) {
        fail("VALIDATION_ERROR", "run.events must be an array", { events: inputEvents ?? null });
      }
      if (inputEvents.length > 1000) {
        fail("VALIDATION_ERROR", "run.events accepts at most 1000 events per call", {
          length: inputEvents.length,
        });
      }
      const run = requireRunEntry(runId);
      const task = requireTaskEntry(run.taskId);
      const now = nowIso();
      const lease = leaseOf(runId);
      const stale = (details) => {
        fail("STALE_GENERATION", `run "${runId}" event report is fenced out`, {
          runId,
          generation,
          ...details,
        });
      };
      if (!lease) stale({ currentGeneration: null, reason: "lease-missing" });
      if (lease.generation !== generation) {
        stale({ currentGeneration: lease.generation, reason: "generation-mismatch" });
      }
      if (lease.claimedUntil <= now) {
        stale({
          currentGeneration: lease.generation,
          claimedUntil: lease.claimedUntil,
          reason: "lease-expired",
        });
      }
      // Build/validate every event before mutating so a bad event cannot leave a
      // partial batch behind (SQLite gets the same from its transaction).
      const built = inputEvents.map((raw, index) => {
        if (!isPlainObject(raw)) {
          fail("VALIDATION_ERROR", `run.events[${index}] must be an object`, { index });
        }
        if (typeof raw.type !== "string" || raw.type.trim() === "") {
          fail("VALIDATION_ERROR", `run.events[${index}].type is required`, { index });
        }
        const payload = raw.payload ?? {};
        if (!isPlainObject(payload)) {
          fail("VALIDATION_ERROR", `run.events[${index}].payload must be an object`, { index });
        }
        return makeEvent({
          projectId: task.projectId,
          aggregateType: "run",
          aggregateId: runId,
          type: raw.type,
          payload,
          now,
        });
      });
      return built.map((event) => appendEventEntry(event));
    },

    /**
     * Reconcile facts for a restarted Host (see sqlite.mjs): a completed run's
     * lease is reported as EXPIRED with its monotonic generation retained, not
     * as null. sessions stays empty in M2.
     */
    reconcileRun({ runId } = {}) {
      requireId(runId, "run.id");
      const run = requireRunEntry(runId);
      const lease = leaseOf(runId);
      return { run: clone(run), lease: lease === null ? null : clone(lease), sessions: [] };
    },

    // --- Scheduling (m3-contracts 搂2: snapshot + atomic claim) ------------
    schedulingSnapshot({ projectId } = {}) {
      if (projectId !== undefined && projectId !== null) requireId(projectId, "project.id");
      const generatedAt = nowIso();
      const matchesProject = (project) => projectId === undefined || projectId === null || project.id === projectId;
      const projectList = [...projects.values()]
        .filter(matchesProject)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((project) => ({
          id: project.id,
          policy: clone(projectMeta.get(project.id)?.policy ?? {}),
        }));
      const taskList = [...tasks.values()]
        .filter(
          (task) =>
            projectId === undefined || projectId === null || task.projectId === projectId,
        )
        .sort(compareTasks)
        .map(clone);
      const runList = [...runs.values()]
        .filter((run) => ACTIVE_RUN_STATUSES.includes(run.status))
        .filter((run) => {
          if (projectId === undefined || projectId === null) return true;
          const task = tasks.get(run.taskId);
          return task !== undefined && task.projectId === projectId;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(clone);
      const leaseList = [...runLeases.values()]
        .filter((lease) => {
          if (projectId === undefined || projectId === null) return true;
          const run = runs.get(lease.runId);
          const task = run === undefined ? undefined : tasks.get(run.taskId);
          return task !== undefined && task.projectId === projectId;
        })
        .sort((a, b) => a.runId.localeCompare(b.runId))
        .map(clone);
      return {
        generatedAt,
        version: seq,
        projects: projectList,
        tasks: taskList,
        agents: [...agents.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone),
        runs: runList,
        leases: leaseList,
      };
    },

    claimTask({ taskId, agentId, expectedTaskVersion, policies, idempotencyKey, workspacePolicy } = {}) {
      requireId(taskId, "task.id");
      requireId(agentId, "agent.id");
      if (!Number.isInteger(expectedTaskVersion) || expectedTaskVersion < 0) {
        fail("VALIDATION_ERROR", "expectedTaskVersion must be a non-negative integer", {
          expectedTaskVersion: expectedTaskVersion ?? null,
        });
      }
      const limits = validateSchedulingPolicies(policies);
      const key = validateIdempotencyKey(idempotencyKey);
      let workspacePolicyValue = null;
      if (workspacePolicy !== undefined && workspacePolicy !== null) {
        if (!isPlainObject(workspacePolicy)) {
          fail("VALIDATION_ERROR", "workspacePolicy must be an object", { value: workspacePolicy });
        }
        workspacePolicyValue = workspacePolicy;
      }

      // Idempotent replay first (task may already be CLAIMED/version bumped).
      const existingId = commandIdempotency.get(key);
      if (existingId !== undefined) {
        const command = dispatchCommands.get(existingId);
        const run = requireRunEntry(command.runId);
        if (run.taskId !== taskId) {
          fail("VALIDATION_ERROR", "idempotencyKey was already used for another task", {
            idempotencyKey: key,
            taskId,
            existingTaskId: run.taskId,
          });
        }
        return { run: clone(run), command: clone(command), task: clone(requireTaskEntry(taskId)) };
      }

      // 1. Task exists, READY, expected version.
      const task = tasks.get(taskId);
      if (!task) {
        fail("TASK_VERSION_CONFLICT", `task "${taskId}" is not claimable`, {
          taskId,
          currentVersion: null,
          expectedVersion: expectedTaskVersion,
          reason: "task-not-found",
        });
      }
      if (task.status !== "READY") {
        fail("TASK_VERSION_CONFLICT", `task "${taskId}" is not READY`, {
          taskId,
          status: task.status,
          currentVersion: task.version,
          expectedVersion: expectedTaskVersion,
          reason: "not-ready",
        });
      }
      if (task.version !== expectedTaskVersion) {
        fail("TASK_VERSION_CONFLICT", `task "${taskId}" version conflict`, {
          taskId,
          currentVersion: task.version,
          expectedVersion: expectedTaskVersion,
          reason: "version-mismatch",
        });
      }

      // 2. Dependencies must exist and be DONE.
      const blockingTaskIds = task.deps.filter((dep) => {
        const dependency = tasks.get(dep);
        return !dependency || dependency.status !== "DONE";
      });
      if (blockingTaskIds.length > 0) {
        fail("TASK_DEPENDENCY_BLOCKED", `task "${taskId}" has unfinished dependencies`, {
          taskId,
          blockingTaskIds,
        });
      }

      // 3. Agent exists, IDLE, role/Function match.
      const agent = agents.get(agentId);
      if (!agent) {
        fail("CAPABILITY_UNAVAILABLE", `agent "${agentId}" is not registered`, {
          reason: "agent-not-found",
          agentId,
          taskId,
        });
      }
      if (agent.status !== "IDLE") {
        fail("CAPABILITY_UNAVAILABLE", `agent "${agentId}" is not IDLE`, {
          reason: "agent-not-idle",
          agentId,
          status: agent.status,
          taskId,
        });
      }
      if (agent.role !== task.roleRequired) {
        fail("CAPABILITY_UNAVAILABLE", `agent "${agentId}" has the wrong role`, {
          reason: "role-mismatch",
          agentId,
          agentRole: agent.role,
          roleRequired: task.roleRequired,
          taskId,
        });
      }
      if (!agent.capabilities.includes(task.functionRequired)) {
        fail("CAPABILITY_UNAVAILABLE", `agent "${agentId}" lacks the required Function`, {
          reason: "function-mismatch",
          agentId,
          capabilities: [...agent.capabilities],
          functionRequired: task.functionRequired,
          taskId,
        });
      }

      // 4. At most one active Run per task.
      const activeRun = [...runs.values()].find(
        (run) => run.taskId === taskId && ACTIVE_RUN_STATUSES.includes(run.status),
      );
      if (activeRun) {
        fail("TASK_VERSION_CONFLICT", `task "${taskId}" already has an active run`, {
          taskId,
          currentVersion: task.version,
          expectedVersion: expectedTaskVersion,
          activeRunId: activeRun.id,
          reason: "active-run",
        });
      }

      // 5. Capacity (limits travel with the claim; absent = unchecked).
      if (limits.maxConcurrentPerProject !== undefined) {
        const projectActive = [...runs.values()].filter((run) => {
          if (!ACTIVE_RUN_STATUSES.includes(run.status)) return false;
          const runTask = tasks.get(run.taskId);
          return runTask !== undefined && runTask.projectId === task.projectId;
        }).length;
        if (projectActive + 1 > limits.maxConcurrentPerProject) {
          fail("CAPABILITY_UNAVAILABLE", "project concurrency capacity reached", {
            reason: "capacity",
            scope: "project",
            projectId: task.projectId,
            active: projectActive,
            limit: limits.maxConcurrentPerProject,
            taskId,
          });
        }
      }
      if (limits.maxPerAgent !== undefined) {
        const agentActive = [...runs.values()].filter(
          (run) => run.agentId === agentId && ACTIVE_RUN_STATUSES.includes(run.status),
        ).length;
        if (agentActive + 1 > limits.maxPerAgent) {
          fail("CAPABILITY_UNAVAILABLE", "agent concurrency capacity reached", {
            reason: "capacity",
            scope: "agent",
            agentId,
            active: agentActive,
            limit: limits.maxPerAgent,
            taskId,
          });
        }
      }

      // 6. Write-scope conflict with active runs of the same project.
      const candidateFiles = task.files ?? [];
      if (candidateFiles.length > 0) {
        const conflictFiles = [];
        const conflictRunIds = [];
        for (const run of runs.values()) {
          if (!ACTIVE_RUN_STATUSES.includes(run.status)) continue;
          const runTask = tasks.get(run.taskId);
          if (runTask === undefined || runTask.projectId !== task.projectId) continue;
          const runFiles = run.files ?? runTask.files ?? [];
          const overlap = filesIntersection(candidateFiles, runFiles);
          if (overlap.length > 0) {
            conflictFiles.push(...overlap);
            conflictRunIds.push(run.id);
          }
        }
        if (conflictRunIds.length > 0) {
          fail("CAPABILITY_UNAVAILABLE", `task "${taskId}" write scope conflicts with an active run`, {
            reason: "write-scope-conflict",
            taskId,
            files: [...new Set(conflictFiles)].sort((a, b) => a.localeCompare(b)),
            activeRunIds: [...new Set(conflictRunIds)].sort((a, b) => a.localeCompare(b)),
          });
        }
      }

      // 7. Commit: build every row first, then mutate + append the two events.
      if (!canTransition(task.status, "CLAIMED")) {
        fail("VALIDATION_ERROR", `task.status cannot transition from ${task.status} to CLAIMED`, {
          from: task.status,
          to: "CLAIMED",
          allowed: ["CLAIMED"],
        });
      }
      const at = nowIso();
      const attempt = [...runs.values()].filter((run) => run.taskId === taskId).length + 1;
      const run = normalizeRun(
        {
          taskId,
          agentId,
          function: task.functionRequired,
          role: task.roleRequired,
          files: candidateFiles,
        },
        { now: at, attempt },
      );
      const updatedTask = { ...task, status: "CLAIMED", version: task.version + 1, updatedAt: at };
      const command = {
        id: generateId("CMD"),
        runId: run.id,
        taskId,
        commandType: "RUN_TASK",
        payload: clone({
          taskId,
          agentId,
          functionRequired: task.functionRequired,
          roleRequired: task.roleRequired,
          workspacePolicy: workspacePolicyValue,
          files: candidateFiles,
        }),
        status: "PENDING",
        idempotencyKey: key,
        ownerId: null,
        generation: 0,
        claimedUntil: null,
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      };
      tasks.set(taskId, updatedTask);
      runs.set(run.id, run);
      dispatchCommands.set(command.id, command);
      commandIdempotency.set(key, command.id);
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "run",
          aggregateId: run.id,
          type: "run.created",
          payload: {
            runId: run.id,
            taskId,
            agentId,
            function: run.function,
            role: run.role,
            status: run.status,
            attempt: run.attempt,
            version: run.version,
            ...(run.files === undefined ? {} : { files: run.files }),
          },
          now: at,
        }),
      );
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "task",
          aggregateId: taskId,
          type: "task.updated",
          payload: {
            taskId,
            status: "CLAIMED",
            previousStatus: "READY",
            version: updatedTask.version,
            runId: run.id,
            agentId,
          },
          now: at,
        }),
      );
      return { run: clone(run), command: clone(command), task: clone(updatedTask) };
    },

    listAgents() {
      return [...agents.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone);
    },

    upsertAgent(dto) {
      ensurePlainObject(dto, "agent");
      requireId(dto.id, "agent.id");
      const existing = agents.get(dto.id);
      if (existing) {
        const merged = mergeAgent(existing, dto, { now: nowIso() });
        agents.set(merged.id, merged);
        return clone(merged);
      }
      const agent = normalizeAgent(dto, { now: nowIso() });
      agents.set(agent.id, agent);
      return clone(agent);
    },

    getReview(id) {
      return clone(requireReviewEntry(id));
    },

    listReviews({ taskId, status, limit } = {}) {
      let list = [...reviews.values()];
      if (taskId !== undefined && taskId !== null) {
        requireId(taskId, "review.taskId");
        list = list.filter((review) => review.taskId === taskId);
      }
      if (status !== undefined && status !== null) {
        assertEnumFilter("review", status);
        list = list.filter((review) => review.status === status);
      }
      const capped = normalizeLimit(limit, { fallback: 50, max: 100 });
      return list
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, capped)
        .map(clone);
    },

    createReview(dto = {}) {
      ensurePlainObject(dto, "review");
      validateActor(dto.actor, "review.actor");
      requireId(dto.taskId, "review.taskId");
      const task = getTaskEntry(dto.taskId);
      if (!task) {
        fail("TASK_VERSION_CONFLICT", `task "${dto.taskId}" is not reviewable`, {
          taskId: dto.taskId,
          currentVersion: null,
          reason: "task-not-found",
        });
      }
      if (task.status !== "REVIEWING") {
        fail("TASK_VERSION_CONFLICT", `task "${dto.taskId}" is not REVIEWING`, {
          taskId: dto.taskId,
          status: task.status,
          currentVersion: task.version,
          reason: "not-reviewing",
        });
      }
      if (dto.runId !== undefined && dto.runId !== null) {
        requireId(dto.runId, "review.runId");
        const run = getRunEntry(dto.runId);
        if (!run) {
          fail("VALIDATION_ERROR", `run "${dto.runId}" does not exist`, { entity: "run", id: dto.runId });
        }
        if (run.taskId !== task.id) {
          fail("VALIDATION_ERROR", `run "${dto.runId}" does not belong to task "${task.id}"`, {
            runId: dto.runId,
            taskId: task.id,
            runTaskId: run.taskId,
          });
        }
      }
      const active = [...reviews.values()].find(
        (review) => review.taskId === task.id && review.status === "PENDING",
      );
      if (active) {
        fail("TASK_VERSION_CONFLICT", `task "${task.id}" already has an active review`, {
          taskId: task.id,
          reviewId: active.id,
          status: active.status,
          reason: "review-exists",
        });
      }
      const nextAttempt =
        [...reviews.values()].filter((review) => review.taskId === task.id).length + 1;
      const at = nowIso();
      const { review } = normalizeReview(
        { taskId: dto.taskId, runId: dto.runId, actor: dto.actor },
        { now: at, attempt: nextAttempt },
      );
      reviews.set(review.id, clone(review));
      const attemptId = generateId("RVA");
      reviewAttempts.set(attemptId, {
        id: attemptId,
        reviewId: review.id,
        runId: review.runId ?? null,
        attempt: review.attempt,
        status: "PENDING",
        verdict: null,
        manifestHash: null,
        findings: null,
        evidence: null,
        createdAt: at,
      });
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "review",
          aggregateId: review.id,
          type: "review.requested",
          payload: { taskId: review.taskId, reviewId: review.id, attempt: review.attempt },
          now: at,
        }),
      );
      return clone(requireReviewEntry(review.id));
    },

    submitReview({
      id,
      expectedVersion,
      verdict,
      manifestHash,
      commitSha,
      findings,
      evidence,
      actor,
      targetHash,
    } = {}) {
      requireId(id, "review.id");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        fail("VALIDATION_ERROR", "expectedVersion must be a non-negative integer", { expectedVersion });
      }
      const row = requireReviewEntry(id);
      if (row.version !== expectedVersion) {
        fail("VERSION_CONFLICT", `review "${id}" version conflict`, {
          entity: "review",
          id,
          expectedVersion,
          currentVersion: row.version,
        });
      }
      if (row.status !== "PENDING") {
        fail("REVIEW_INVALIDATED", `review "${id}" is not pending`, {
          reviewId: id,
          taskId: row.taskId,
          status: row.status,
        });
      }
      const task = requireTaskEntry(row.taskId);
      // QA-005: canonical identity comparison (trim + casefold) before actor
      // shape validation, so whitespace/case variants of the author are 403.
      const rawActor = typeof actor === "string" ? actor : "";
      const canonicalActor = canonicalAgentId(rawActor);
      const authors = new Map();
      if (row.runId !== undefined && row.runId !== null) {
        const producer = getRunEntry(row.runId);
        if (producer) authors.set(canonicalAgentId(producer.agentId), producer.agentId);
      }
      const latestProducer = latestProducerAgentId(row.taskId);
      if (latestProducer) authors.set(canonicalAgentId(latestProducer), latestProducer);
      if (canonicalActor !== "" && authors.has(canonicalActor)) {
        fail("SELF_REVIEW_FORBIDDEN", "an actor cannot review their own work", {
          actor: rawActor,
          authorAgentId: authors.get(canonicalActor),
          taskId: row.taskId,
          reviewId: id,
        });
      }
      const next = applyReviewVerdict(row, { verdict, manifestHash, commitSha, findings, evidence, actor }, { now: nowIso() });
      let passTargetHash;
      if (verdict === "PASS") {
        passTargetHash =
          targetHash !== undefined && targetHash !== null
            ? validateTargetHash(targetHash, "review.targetHash")
            : next.manifestHash;
      }
      const taskTo = verdict === "PASS" ? "INTEGRATING" : verdict === "CHANGES_REQUESTED" ? "REJECTED" : "BLOCKED";
      const updatedTask = transitionTaskEntry(
        row.taskId,
        taskTo,
        verdict === "PASS" ? { targetHash: passTargetHash } : undefined,
      );
      const persisted = { ...next, actor: next.reviewer };
      reviews.set(id, clone(persisted));
      for (const [attemptId, attempt] of reviewAttempts) {
        if (attempt.reviewId === id && attempt.attempt === row.attempt) {
          reviewAttempts.set(attemptId, {
            ...attempt,
            status: next.status,
            verdict: next.verdict,
            manifestHash: next.manifestHash ?? null,
            findings: next.findings === undefined ? null : clone(next.findings),
            evidence: next.evidence === undefined ? null : clone(next.evidence),
          });
        }
      }
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "review",
          aggregateId: id,
          type: "review.updated",
          payload: {
            taskId: row.taskId,
            reviewId: id,
            status: next.status,
            verdict: next.verdict,
            actor: next.reviewer,
            attempt: row.attempt,
            ...(passTargetHash === undefined ? {} : { targetHash: passTargetHash }),
          },
          now: next.updatedAt,
        }),
      );
      return { review: clone(requireReviewEntry(id)), task: updatedTask };
    },

    reworkTask({ taskId, reviewId, reason, actor, maxAttempts } = {}) {
      requireId(taskId, "task.id");
      requireId(reviewId, "review.id");
      if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
        fail("VALIDATION_ERROR", "maxAttempts must be a positive integer", { maxAttempts });
      }
      const limit = maxAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
      const reviewer = validateActor(actor, "review.actor");
      const task = requireTaskEntry(taskId);
      const reviewRow = requireReviewEntry(reviewId);
      if (reviewRow.taskId !== taskId) {
        fail("VALIDATION_ERROR", "review does not belong to the task", { taskId, reviewId });
      }
      if (reviewRow.status !== "CHANGES_REQUESTED") {
        fail("REVIEW_INVALIDATED", `review "${reviewId}" is not CHANGES_REQUESTED`, {
          reviewId,
          taskId,
          status: reviewRow.status,
        });
      }
      if (task.status !== "REJECTED") {
        fail("TASK_VERSION_CONFLICT", `task "${taskId}" is not REJECTED`, {
          taskId,
          status: task.status,
          currentVersion: task.version,
          reason: "not-rejected",
        });
      }
      const at = nowIso();
      const nextAttempt = reviewRow.attempt + 1;
      if (nextAttempt > limit) {
        const blocked = transitionTaskEntry(taskId, "BLOCKED");
        const blockedReview = {
          ...requireReviewEntry(reviewId),
          status: "BLOCKED",
          version: requireReviewEntry(reviewId).version + 1,
          updatedAt: at,
        };
        reviews.set(reviewId, blockedReview);
        appendEventEntry(
          makeEvent({
            projectId: task.projectId,
            aggregateType: "review",
            aggregateId: reviewId,
            type: "review.updated",
            payload: {
              taskId,
              reviewId,
              status: "BLOCKED",
              verdict: "CHANGES_REQUESTED",
              actor: reviewer,
              attempt: nextAttempt,
              reason: reason ?? null,
            },
            now: at,
          }),
        );
        appendEventEntry(
          makeEvent({
            projectId: task.projectId,
            aggregateType: "task",
            aggregateId: taskId,
            type: "task.updated",
            payload: {
              taskId,
              status: "BLOCKED",
              previousStatus: "REJECTED",
              reason: "rework-limit",
              attempt: nextAttempt,
            },
            now: at,
          }),
        );
        fail("REWORK_LIMIT_REACHED", `task "${taskId}" exhausted its rework budget`, {
          taskId,
          attempt: nextAttempt,
          maxAttempts: limit,
        });
      }
      const revived = transitionTaskEntry(taskId, "READY");
      // QA-005: no new review_attempts row here; the next createReview owns the
      // next attempt number (= number of review rows for this Task + 1), so a
      // Task can never have two rows for the same attempt.
      const advancedReview = {
        ...requireReviewEntry(reviewId),
        version: requireReviewEntry(reviewId).version + 1,
        updatedAt: at,
      };
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "review",
          aggregateId: reviewId,
          type: "review.updated",
          payload: {
            taskId,
            reviewId,
            status: "CHANGES_REQUESTED",
            verdict: "CHANGES_REQUESTED",
            actor: reviewer,
            attempt: nextAttempt,
            reason: reason ?? null,
          },
          now: at,
        }),
      );
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "task",
          aggregateId: taskId,
          type: "task.updated",
          payload: { taskId, status: "READY", previousStatus: "REJECTED", reason: "rework", attempt: nextAttempt },
          now: at,
        }),
      );
      return { review: clone(requireReviewEntry(reviewId)), task: revived, attempt: nextAttempt };
    },

    listApprovals({ taskId, status, limit } = {}) {
      let list = [...approvals.values()];
      if (taskId !== undefined && taskId !== null) {
        requireId(taskId, "approval.taskId");
        list = list.filter((approval) => approval.taskId === taskId);
      }
      if (status !== undefined && status !== null) {
        assertEnumFilter("acceptance", status);
        list = list.filter((approval) => approval.status === status);
      }
      const capped = normalizeLimit(limit, { fallback: 50, max: 100 });
      return list
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, capped)
        .map(clone);
    },

    createApproval(dto = {}) {
      ensurePlainObject(dto, "approval");
      requireId(dto.taskId, "approval.taskId");
      const task = getTaskEntry(dto.taskId);
      if (!task) notFound("task", dto.taskId);
      if (task.status !== "AWAITING_ACCEPTANCE") {
        fail("TASK_VERSION_CONFLICT", `task "${dto.taskId}" is not AWAITING_ACCEPTANCE`, {
          taskId: dto.taskId,
          status: task.status,
          currentVersion: task.version,
          reason: "not-awaiting-acceptance",
        });
      }
      const approval = normalizeApproval(
        { ...dto, projectId: task.projectId, taskId: task.id, status: dto.status ?? "PENDING" },
        { now: nowIso() },
      );
      approval.version = 0;
      approvals.set(approval.id, clone(approval));
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "approval",
          aggregateId: approval.id,
          type: "approval.recorded",
          payload: {
            taskId: task.id,
            approvalId: approval.id,
            status: approval.status,
            targetHash: approval.targetHash,
            actor: approval.actor,
          },
          now: approval.createdAt,
        }),
      );
      return clone(approvals.get(approval.id));
    },

    decideApproval({ id, decision: rawDecision, actor, targetHash } = {}) {
      requireId(id, "approval.id");
      const decision = validateApprovalDecision(rawDecision);
      const reviewer = validateActor(actor, "approval.actor");
      const receivedTargetHash = validateTargetHash(targetHash, "approval.targetHash");
      const row = approvals.get(id);
      if (!row) notFound("approval", id);
      if (row.status !== "PENDING") {
        fail("REVIEW_INVALIDATED", `approval "${id}" is not pending`, {
          approvalId: id,
          taskId: row.taskId,
          status: row.status,
        });
      }
      const task = requireTaskEntry(row.taskId);
      if (task.status !== "AWAITING_ACCEPTANCE") {
        fail("TASK_VERSION_CONFLICT", `task "${row.taskId}" is not AWAITING_ACCEPTANCE`, {
          taskId: row.taskId,
          status: task.status,
          currentVersion: task.version,
          reason: "not-awaiting-acceptance",
        });
      }
      if (receivedTargetHash !== row.targetHash) {
        fail("APPROVAL_STALE", `approval "${id}" is bound to a different target`, {
          approvalId: id,
          taskId: row.taskId,
          expectedTargetHash: row.targetHash,
          receivedTargetHash,
        });
      }
      if (task.targetHash !== undefined && task.targetHash !== null && task.targetHash !== receivedTargetHash) {
        fail("APPROVAL_STALE", `task "${row.taskId}" moved to a different target`, {
          approvalId: id,
          taskId: row.taskId,
          expectedTargetHash: task.targetHash,
          receivedTargetHash,
        });
      }
      const at = nowIso();
      // Rejected acceptance re-queues directly (m4-contracts 搂1 / Lead ruling):
      // Task.REJECTED is reserved for "review requested changes" and is only
      // escapable via reworkTask (CHANGES_REQUESTED Review); an acceptance
      // rejection has a PASS Review, so REJECTED would be a dead end.
      const taskTo = decision === "APPROVED" ? "DONE" : "READY";
      const updatedTask = transitionTaskEntry(row.taskId, taskTo);
      if (decision === "REJECTED") {
        appendEventEntry(
          makeEvent({
            projectId: task.projectId,
            aggregateType: "task",
            aggregateId: row.taskId,
            type: "task.updated",
            payload: {
              taskId: row.taskId,
              status: "READY",
              previousStatus: "AWAITING_ACCEPTANCE",
              reason: "rework",
            },
            now: at,
          }),
        );
      }
      const updatedApproval = {
        ...row,
        status: decision,
        decision,
        actor: reviewer,
        at,
        decidedAt: at,
        version: (row.version ?? 0) + 1,
      };
      approvals.set(id, updatedApproval);
      appendEventEntry(
        makeEvent({
          projectId: task.projectId,
          aggregateType: "approval",
          aggregateId: id,
          type: "approval.recorded",
          payload: {
            taskId: row.taskId,
            approvalId: id,
            decision,
            status: decision,
            targetHash: receivedTargetHash,
            actor: reviewer,
          },
          now: at,
        }),
      );
      return { approval: clone(updatedApproval), task: updatedTask };
    },

    // --- Overview ---------------------------------------------------------
    overview(projectId) {
      requireId(projectId, "project.id");
      const project = requireProject(projectId);
      const projectTasks = [...tasks.values()].filter((task) => task.projectId === projectId);
      const projectTaskIds = new Set(projectTasks.map((task) => task.id));
      const projectRuns = [...runs.values()].filter((run) => projectTaskIds.has(run.taskId));
      const recentEvents = events
        .filter((event) => event.projectId === projectId)
        .slice(-MAX_OVERVIEW_EVENTS)
        .reverse()
        .map(clone);
      return buildOverview({
        project: clone(project),
        tasks: projectTasks.map(clone),
        recentEvents,
        runsRunning: projectRuns.filter((run) => run.status === "STARTING" || run.status === "RUNNING").length,
        runsTotal: projectRuns.length,
      });
    },

    // --- Events -----------------------------------------------------------
    appendEvent(input) {
      ensurePlainObject(input, "event");
      return appendEventEntry(makeEvent({ ...input, now: nowIso() }));
    },

    listEvents(filters = {}) {
      const page = buildEventPage(filters);
      // Array-compatible (see sqlite.mjs): legacy callers keep using `.map`,
      // while new code can read `items`/`hasMore`/`nextAfterSeq`.
      const result = page.items.slice();
      Object.defineProperties(result, {
        items: { value: result, enumerable: false },
        hasMore: { value: page.hasMore, enumerable: false },
        nextAfterSeq: { value: page.nextAfterSeq, enumerable: false },
      });
      return result;
    },

    listEventsPage(filters = {}) {
      return buildEventPage(filters);
    },

    latestSeq() {
      return seq;
    },
  };

  Object.defineProperty(store, INTERNAL, {
    value: {
      kind: "memory",
      schemaVersion: SCHEMA_VERSION,
      debugPragmas: () => ({ journalMode: null, foreignKeys: null, busyTimeout: null, inTransaction: false }),
      /** Run `work` with a full snapshot; restore everything if it throws. */
      transaction: (work) => {
        const snapshot = {
          projects: new Map([...projects].map(([key, value]) => [key, clone(value)])),
          requirements: new Map([...requirements].map(([key, value]) => [key, clone(value)])),
          tasks: new Map([...tasks].map(([key, value]) => [key, clone(value)])),
          agents: new Map([...agents].map(([key, value]) => [key, clone(value)])),
          reviews: new Map([...reviews].map(([key, value]) => [key, clone(value)])),
          reviewAttempts: new Map([...reviewAttempts].map(([key, value]) => [key, clone(value)])),
          approvals: new Map([...approvals].map(([key, value]) => [key, clone(value)])),
          projectMeta: new Map([...projectMeta].map(([key, value]) => [key, clone(value)])),
          taskMeta: new Map([...taskMeta].map(([key, value]) => [key, clone(value)])),
          runs: new Map([...runs].map(([key, value]) => [key, clone(value)])),
          runLeases: new Map([...runLeases].map(([key, value]) => [key, clone(value)])),
          dispatchCommands: new Map([...dispatchCommands].map(([key, value]) => [key, clone(value)])),
          commandIdempotency: new Map([...commandIdempotency].map(([key, value]) => [key, value])),
          events: events.map(clone),
          seq,
        };
        try {
          return work();
        } catch (error) {
          const restore = (target, source) => {
            target.clear();
            for (const [key, value] of source) target.set(key, value);
          };
          restore(projects, snapshot.projects);
          restore(requirements, snapshot.requirements);
          restore(tasks, snapshot.tasks);
          restore(agents, snapshot.agents);
          restore(reviews, snapshot.reviews);
          restore(reviewAttempts, snapshot.reviewAttempts);
          restore(approvals, snapshot.approvals);
          restore(projectMeta, snapshot.projectMeta);
          restore(taskMeta, snapshot.taskMeta);
          restore(runs, snapshot.runs);
          restore(runLeases, snapshot.runLeases);
          restore(dispatchCommands, snapshot.dispatchCommands);
          restore(commandIdempotency, snapshot.commandIdempotency);
          events.length = 0;
          events.push(...snapshot.events);
          seq = snapshot.seq;
          throw error;
        }
      },
      /** Clear every business row; the migration ledger is SQLite-only. */
      clearBusinessTables: () => {
        projects.clear();
        requirements.clear();
        tasks.clear();
        agents.clear();
        reviews.clear();
        reviewAttempts.clear();
        approvals.clear();
        projectMeta.clear();
        taskMeta.clear();
        runs.clear();
        runLeases.clear();
        dispatchCommands.clear();
        commandIdempotency.clear();
        events.length = 0;
        seq = 0;
      },
      getProjectLegacy: (id) => clone(projectMeta.get(id)?.legacy ?? null),
      getProjectSettings: (id) => clone(projectMeta.get(id)?.settings ?? null),
      getTaskLegacy: (id) => clone(taskMeta.get(id)?.legacy ?? null),
      /** Read a dispatch command as JSON (test/fencing diagnostics only). */
      getDispatchCommand: (id) => {
        const command = dispatchCommands.get(id);
        return command === undefined ? null : clone(command);
      },
      /** Review attempt audit rows for one Task (test diagnostics only). */
      listReviewAttempts: (taskId) => {
        requireId(taskId, "task.id");
        const reviewIds = new Set(
          [...reviews.values()].filter((review) => review.taskId === taskId).map((review) => review.id),
        );
        return [...reviewAttempts.values()]
          .filter((attempt) => reviewIds.has(attempt.reviewId))
          .sort((a, b) => a.attempt - b.attempt || a.id.localeCompare(b.id))
          .map((attempt) => ({
            id: attempt.id,
            reviewId: attempt.reviewId,
            attempt: attempt.attempt,
            status: attempt.status,
          }));
      },
      /**
       * Migration-only writer (see sqlite.mjs): writes a legacy status without
       * the 搂5.2 transition check. Only importStateJson may use it.
       */
      setTaskStatus: (id, status) => {
        validateTaskStatus(status);
        const task = requireTaskEntry(id);
        const next = { ...task, status, version: task.version + 1, updatedAt: nowIso() };
        tasks.set(id, next);
        return clone(next);
      },
      listTasksAll: (projectId) =>
        [...tasks.values()]
          .filter((task) => task.projectId === projectId)
          .sort(compareTasks)
          .map(clone),
      listRunsAll: () =>
        [...runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(clone),
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return store;
}

