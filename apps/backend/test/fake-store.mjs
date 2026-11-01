// In-memory store used by the backend tests.
//
// It implements exactly the subset of `m1-contracts §1` the backend calls, so
// these tests do not depend on the (parallel) @atk/database implementation.
// Behavioural quirks the tests rely on:
// - sync methods, plain JSON-serialisable values
// - CAS on patchTask with `details.currentVersion`
// - `_dropEventsBefore(seq)` simulates a pruned event log for the resync test
import { createEvent } from "@atk/contracts";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

export function createFakeStore(seed = {}) {
  const projects = new Map();
  const requirements = new Map();
  const tasks = new Map();
  const runs = new Map();
  const agents = new Map();
  const reviews = new Map();
  const approvals = new Map();
  const dispatchCommands = new Map();
  const leases = new Map();
  let events = [];
  let seq = 0;
  let counters = { task: 0, run: 0, requirement: 0, approval: 0, command: 0, review: 0 };
  let snapshotVersion = 1;
  let switchReadiness = { ok: true, blockers: [] };

  for (const project of seed.projects ?? []) projects.set(project.id, { version: 0, createdAt: nowIso(), ...clone(project) });
  for (const requirement of seed.requirements ?? []) {
    requirements.set(requirement.id, { createdAt: nowIso(), ...clone(requirement) });
  }
  for (const task of seed.tasks ?? []) {
    tasks.set(task.id, { version: 0, createdAt: nowIso(), ...clone(task) });
  }
  for (const run of seed.runs ?? []) runs.set(run.id, { createdAt: nowIso(), ...clone(run) });
  for (const agent of seed.agents ?? []) agents.set(agent.id, { createdAt: nowIso(), ...clone(agent) });
  for (const review of seed.reviews ?? []) reviews.set(review.id, { createdAt: nowIso(), ...clone(review) });
  for (const approval of seed.approvals ?? []) approvals.set(approval.id, { createdAt: nowIso(), ...clone(approval) });

  function nextId(prefix, kind) {
    counters[kind] += 1;
    return `${prefix}-${counters[kind].toString(36).toUpperCase()}`;
  }

  function requireTask(id) {
    const task = tasks.get(id);
    if (!task) {
      const error = new Error(`task ${id} not found`);
      error.code = "NOT_FOUND";
      throw error;
    }
    return task;
  }

  function requireRun(id) {
    const run = runs.get(id);
    if (!run) {
      const error = new Error(`run ${id} not found`);
      error.code = "NOT_FOUND";
      throw error;
    }
    return run;
  }

  function staleGeneration(details) {
    const error = new Error(`stale generation: ${JSON.stringify(details)}`);
    error.code = "STALE_GENERATION";
    error.details = details;
    throw error;
  }

  function fail(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  }

  function recordEvent({ projectId = null, aggregateType, aggregateId, type, payload = {} }) {
    seq += 1;
    const event = createEvent({ seq, projectId, aggregateType, aggregateId, type, payload });
    events.push(event);
    return clone(event);
  }

  return {
    close() {},

    health() {
      return {
        ok: true,
        file: null,
        schemaVersion: 1,
        counts: {
          projects: projects.size,
          tasks: tasks.size,
          runs: runs.size,
          events: events.length,
          agents: agents.size,
        },
      };
    },

    listProjects() {
      return [...projects.values()].map(clone);
    },
    getProject(id) {
      const project = projects.get(id);
      if (!project) {
        const error = new Error(`project ${id} not found`);
        error.code = "NOT_FOUND";
        throw error;
      }
      return clone(project);
    },
    createProject(dto) {
      if (projects.has(dto.id)) {
        const error = new Error(`project ${dto.id} already exists`);
        error.code = "VERSION_CONFLICT";
        error.details = { currentVersion: projects.get(dto.id).version };
        throw error;
      }
      const project = { ...clone(dto), version: 0, createdAt: nowIso() };
      projects.set(project.id, project);
      return clone(project);
    },
    updateProject(id, { expectedVersion, changes }) {
      const project = projects.get(id);
      if (!project) {
        const error = new Error(`project ${id} not found`);
        error.code = "NOT_FOUND";
        throw error;
      }
      if (project.version !== expectedVersion) {
        const error = new Error("project version conflict");
        error.code = "VERSION_CONFLICT";
        error.details = { currentVersion: project.version, expectedVersion };
        throw error;
      }
      Object.assign(project, clone(changes), { version: project.version + 1 });
      return clone(project);
    },

    listRequirements({ projectId } = {}) {
      return [...requirements.values()].filter((item) => !projectId || item.projectId === projectId).map(clone);
    },
    createRequirement(dto) {
      const requirement = { ...clone(dto), id: dto.id ?? nextId("REQ", "requirement"), createdAt: nowIso() };
      requirements.set(requirement.id, requirement);
      return clone(requirement);
    },

    listTasks({ projectId, status, roleRequired, functionRequired, q, limit } = {}) {
      let items = [...tasks.values()];
      if (projectId) items = items.filter((task) => task.projectId === projectId);
      if (status) items = items.filter((task) => task.status === status);
      if (roleRequired) items = items.filter((task) => task.roleRequired === roleRequired);
      if (functionRequired) items = items.filter((task) => task.functionRequired === functionRequired);
      if (q) {
        const needle = String(q).toLowerCase();
        items = items.filter(
          (task) => task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle),
        );
      }
      if (Number.isInteger(limit)) items = items.slice(0, limit);
      return items.map(clone);
    },
    getTask(id) {
      return clone(requireTask(id));
    },
    createTask(dto) {
      const missingDeps = (dto.deps ?? []).filter((dep) => !tasks.has(dep));
      if (missingDeps.length > 0) {
        const error = new Error(`task references unknown dependencies: ${missingDeps.join(", ")}`);
        error.code = "VALIDATION_ERROR";
        error.details = { missingDeps };
        throw error;
      }
      counters.task += 1;
      const task = {
        ...clone(dto),
        id: dto.id ?? `TASK-${counters.task.toString(36).toUpperCase()}`,
        status: "READY",
        version: 0,
        createdAt: nowIso(),
      };
      tasks.set(task.id, task);
      return clone(task);
    },
    patchTask(id, { expectedVersion, changes }) {
      const task = requireTask(id);
      if (task.version !== expectedVersion) {
        const error = new Error(`task ${id} version conflict`);
        error.code = "TASK_VERSION_CONFLICT";
        error.details = { currentVersion: task.version, expectedVersion };
        throw error;
      }
      Object.assign(task, clone(changes), { version: task.version + 1 });
      return clone(task);
    },

    listRuns({ taskId, status, limit } = {}) {
      let items = [...runs.values()];
      if (taskId) items = items.filter((run) => run.taskId === taskId);
      if (status) items = items.filter((run) => run.status === status);
      if (Number.isInteger(limit)) items = items.slice(0, limit);
      return items.map(clone);
    },
    getRun(id) {
      return clone(requireRun(id));
    },

    // ---- M2: Run lifecycle, dispatch commands and leases (m2-contracts §3) ----
    createRun(dto) {
      counters.run += 1;
      const id = dto.id ?? `RUN-${counters.run.toString(36).toUpperCase()}`;
      if (runs.has(id)) {
        const error = new Error(`run ${id} already exists`);
        error.code = "VERSION_CONFLICT";
        error.details = { entity: "run", id, currentVersion: runs.get(id).version ?? 0 };
        throw error;
      }
      const now = nowIso();
      const run = {
        agentId: "agent-unassigned",
        function: "WORKER",
        attempt: 1,
        ...clone(dto),
        id,
        // The command is already persisted; the run starts STARTING.
        status: "STARTING",
        version: 0,
        exitCode: null,
        createdAt: now,
        updatedAt: now,
      };
      runs.set(id, run);
      const task = tasks.get(run.taskId);
      seq += 1;
      events.push(
        createEvent({
          seq,
          projectId: task?.projectId ?? null,
          aggregateType: "run",
          aggregateId: id,
          type: "run.created",
          payload: {
            runId: id,
            taskId: run.taskId,
            agentId: run.agentId,
            function: run.function,
            role: run.role,
            status: run.status,
            attempt: run.attempt,
            version: run.version,
          },
        }),
      );
      return clone(run);
    },
    updateRunStatus(id, { status, exitCode, endedAt, generation } = {}) {
      const run = requireRun(id);
      // Optional generation turns the status change into a fenced operation
      // (mirrors the database M2 signature): validate the lease in the same
      // "transaction" before touching anything.
      if (generation !== undefined) {
        if (!Number.isInteger(generation) || generation < 1) {
          const error = new Error("generation must be a positive integer");
          error.code = "VALIDATION_ERROR";
          error.details = { generation };
          throw error;
        }
        const lease = leases.get(id);
        if (!lease) staleGeneration({ runId: id, generation, reason: "lease-missing", currentGeneration: null });
        if (lease.generation !== generation) {
          staleGeneration({ runId: id, generation, reason: "generation-mismatch", currentGeneration: lease.generation });
        }
        if (Date.parse(lease.expiresAt) <= Date.now()) {
          staleGeneration({ runId: id, generation, reason: "lease-expired", currentGeneration: lease.generation });
        }
      }
      const allowed = {
        QUEUED: ["STARTING", "FAILED", "CANCELLED", "INTERRUPTED"],
        STARTING: ["RUNNING", "FAILED", "INTERRUPTED"],
        RUNNING: ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"],
        COMPLETED: [],
        FAILED: [],
        CANCELLED: [],
        INTERRUPTED: [],
      };
      if (run.status === status) return clone(run);
      const transitions = allowed[run.status] ?? [];
      if (!transitions.includes(status)) {
        const error = new Error(`run ${id} cannot transition ${run.status} -> ${status}`);
        error.code = "VALIDATION_ERROR";
        error.details = { from: run.status, to: status, allowed: transitions };
        throw error;
      }
      const previousStatus = run.status;
      run.status = status;
      run.version += 1;
      run.updatedAt = nowIso();
      if (exitCode !== undefined) run.exitCode = exitCode;
      if (endedAt !== undefined) run.endedAt = endedAt;
      if (["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(status) && run.endedAt == null) {
        run.endedAt = endedAt ?? nowIso();
      }
      // Mirrors the database: the status change and its single run.updated event
      // are committed together, so SSE never sees an event ahead of the state.
      const task = tasks.get(run.taskId);
      seq += 1;
      events.push(
        createEvent({
          seq,
          projectId: task?.projectId ?? null,
          aggregateType: "run",
          aggregateId: id,
          type: "run.updated",
          payload: {
            runId: id,
            taskId: run.taskId,
            status: run.status,
            previousStatus,
            version: run.version,
            ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
            ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
          },
        }),
      );
      return clone(run);
    },
    enqueueDispatchCommand({ runId, commandType = "start_run", payload = {}, idempotencyKey = null } = {}) {
      requireRun(runId);
      if (idempotencyKey) {
        for (const command of dispatchCommands.values()) {
          if (command.idempotencyKey === idempotencyKey) return clone(command);
        }
      }
      counters.command += 1;
      const now = nowIso();
      const command = {
        id: `CMD-${counters.command.toString(36).toUpperCase()}`,
        runId,
        commandType,
        payload: clone(payload) ?? {},
        idempotencyKey,
        status: "PENDING",
        ownerId: null,
        generation: 0,
        claimedUntil: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      dispatchCommands.set(command.id, command);
      return clone(command);
    },
    claimDispatchCommand({ ownerId, leaseMs = 30_000 } = {}) {
      const command = [...dispatchCommands.values()].find((candidate) => candidate.status === "PENDING");
      if (!command) return null;
      const now = Date.now();
      const claimedUntil = new Date(now + leaseMs).toISOString();
      command.status = "CLAIMED";
      command.ownerId = ownerId;
      command.generation = (command.generation ?? 0) + 1;
      command.claimedUntil = claimedUntil;
      command.attempts += 1;
      command.updatedAt = nowIso();
      const lease = {
        runId: command.runId,
        ownerId,
        holderId: ownerId,
        generation: command.generation,
        claimedUntil,
        expiresAt: claimedUntil,
        lastHeartbeatAt: nowIso(),
      };
      leases.set(command.runId, lease);
      return { command: clone(command), lease: clone(lease) };
    },
    completeDispatchCommand({ id, ownerId, generation, status, result = {} } = {}) {
      const command = dispatchCommands.get(id);
      if (!command) {
        const error = new Error(`dispatch command ${id} not found`);
        error.code = "NOT_FOUND";
        throw error;
      }
      if (command.status === "DONE" || command.status === "FAILED") {
        if (command.status === status) return clone(command); // idempotent retry
        const error = new Error(`dispatch command ${id} already finalized as ${command.status}`);
        error.code = "VALIDATION_ERROR";
        error.details = { errors: [`command already finalized as ${command.status}`] };
        throw error;
      }
      if (command.ownerId !== ownerId || command.generation !== generation) {
        staleGeneration({
          commandId: id,
          generation,
          expectedGeneration: command.generation,
          currentOwnerId: command.ownerId,
          reason: "lease-mismatch",
        });
      }
      command.status = status;
      command.result = clone(result);
      command.updatedAt = nowIso();
      return clone(command);
    },
    renewRunLease({ runId, ownerId, generation, leaseMs = 30_000 } = {}) {
      const lease = leases.get(runId);
      if (!lease) staleGeneration({ runId, generation, reason: "lease-missing", currentGeneration: null });
      if (lease.ownerId !== ownerId) {
        staleGeneration({ runId, generation, reason: "holder-mismatch", currentGeneration: lease.generation });
      }
      if (lease.generation !== generation) {
        staleGeneration({ runId, generation, reason: "generation-mismatch", currentGeneration: lease.generation });
      }
      if (Date.parse(lease.expiresAt) <= Date.now()) {
        staleGeneration({ runId, generation, reason: "lease-expired", currentGeneration: lease.generation });
      }
      lease.generation += 1;
      lease.expiresAt = new Date(Date.now() + leaseMs).toISOString();
      lease.claimedUntil = lease.expiresAt;
      lease.lastHeartbeatAt = nowIso();
      return clone(lease);
    },
    appendRunEvent({ runId, generation, events: mappedEvents = [] } = {}) {
      const run = requireRun(runId);
      if (!Number.isInteger(generation) || generation < 1) {
        const error = new Error("generation must be a positive integer");
        error.code = "VALIDATION_ERROR";
        error.details = { generation };
        throw error;
      }
      if (!Array.isArray(mappedEvents)) {
        const error = new Error("run.events must be an array");
        error.code = "VALIDATION_ERROR";
        error.details = { events: mappedEvents ?? null };
        throw error;
      }
      if (mappedEvents.length > 1000) {
        const error = new Error("run.events accepts at most 1000 events per call");
        error.code = "VALIDATION_ERROR";
        error.details = { length: mappedEvents.length };
        throw error;
      }
      const lease = leases.get(runId);
      if (!lease) staleGeneration({ runId, generation, reason: "lease-missing", currentGeneration: null });
      if (lease.generation !== generation) {
        staleGeneration({ runId, generation, reason: "generation-mismatch", currentGeneration: lease.generation });
      }
      if (Date.parse(lease.expiresAt) <= Date.now()) {
        staleGeneration({ runId, generation, reason: "lease-expired", currentGeneration: lease.generation });
      }
      // M2 MINOR-1: an empty batch is a pure generation fence and writes nothing.
      if (mappedEvents.length === 0) return [];
      const task = tasks.get(run.taskId);
      const inserted = mappedEvents.map((mapped) => {
        seq += 1;
        const event = createEvent({
          seq,
          projectId: task?.projectId ?? null,
          aggregateType: "run",
          aggregateId: runId,
          type: mapped.type,
          payload: mapped.payload,
        });
        events.push(event);
        return clone(event);
      });
      return inserted;
    },
    sweepDispatchCommands({ now: at } = {}) {
      const terminalRuns = new Set(["COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED"]);
      const completedAt = typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : nowIso();
      const closed = [];
      for (const command of dispatchCommands.values()) {
        if (command.status !== "CLAIMED") continue;
        const run = runs.get(command.runId);
        if (!run || !terminalRuns.has(run.status)) continue;
        const status = run.status === "COMPLETED" ? "DONE" : "FAILED";
        command.status = status;
        command.result = { derivedFrom: "run-terminal", runStatus: run.status };
        command.completedAt = completedAt;
        command.updatedAt = completedAt;
        closed.push({ commandId: command.id, runId: command.runId, status });
      }
      return { closed, count: closed.length };
    },
    reconcileRun({ runId } = {}) {
      const run = requireRun(runId);
      // M2 contract: sessions are an empty array until M4 records them.
      return { run: clone(run), lease: clone(leases.get(runId) ?? null), sessions: [] };
    },

    // ---- M3: scheduling snapshot + atomic claim (m3-contracts §2) ----
    schedulingSnapshot() {
      return {
        version: snapshotVersion,
        projects: [...projects.values()].map((project) => ({ id: project.id, policy: project.policy ?? null })),
        tasks: [...tasks.values()].map(clone),
        agents: [...agents.values()].map(clone),
        runs: [...runs.values()].map(clone),
        leases: [...leases.values()].map(clone),
      };
    },
    claimTask({
      taskId,
      agentId,
      expectedTaskVersion,
      function: requiredFunction,
      role: requiredRole,
      workspacePolicy = null,
      policies = null,
      idempotencyKey = null,
    } = {}) {
      // Idempotent replay first: the Task version has advanced, so validating
      // before this check would turn a retry into a false conflict.
      if (idempotencyKey) {
        for (const existing of dispatchCommands.values()) {
          if (existing.idempotencyKey === idempotencyKey) {
            const run = runs.get(existing.runId);
            return { run: clone(run), command: clone(existing), task: clone(tasks.get(run.taskId)) };
          }
        }
      }

      const task = requireTask(taskId);
      if (task.status !== "READY" || task.version !== expectedTaskVersion) {
        const error = new Error(`task ${taskId} version conflict`);
        error.code = "TASK_VERSION_CONFLICT";
        error.details = { taskId, currentVersion: task.version, expectedVersion: expectedTaskVersion, status: task.status };
        throw error;
      }

      const blockingTaskIds = (task.deps ?? []).filter((depId) => tasks.get(depId)?.status !== "DONE");
      if (blockingTaskIds.length > 0) {
        const error = new Error(`task ${taskId} has unfinished dependencies`);
        error.code = "TASK_DEPENDENCY_BLOCKED";
        error.details = { taskId, blockingTaskIds };
        throw error;
      }

      const requiredFunctionValue = requiredFunction ?? task.functionRequired;
      const requiredRoleValue = requiredRole ?? task.roleRequired;
      const agent = agents.get(agentId) ?? null;
      const unavailable = (extra) => {
        const error = new Error(`agent ${agentId} cannot take task ${taskId}`);
        error.code = "CAPABILITY_UNAVAILABLE";
        error.details = {
          reason: "capability-mismatch",
          agentId,
          taskId,
          requiredFunction: requiredFunctionValue,
          requiredRole: requiredRoleValue,
          ...extra,
        };
        throw error;
      };
      if (!agent) unavailable({ agentStatus: null, agentRole: null, agentCapabilities: [] });
      if (agent.status !== "IDLE" || agent.role !== requiredRoleValue || !(agent.capabilities ?? []).includes(requiredFunctionValue)) {
        unavailable({ agentStatus: agent.status, agentRole: agent.role, agentCapabilities: agent.capabilities ?? [] });
      }

      const active = [...runs.values()].filter((run) => ["QUEUED", "STARTING", "RUNNING"].includes(run.status));
      const taskActive = active.filter((run) => run.taskId === taskId);
      if (taskActive.length > 0) {
        const error = new Error(`task ${taskId} already has an active run`);
        error.code = "TASK_VERSION_CONFLICT";
        error.details = { taskId, currentVersion: task.version, activeRunId: taskActive[0].id };
        throw error;
      }

      if (policies) {
        if (Number.isInteger(policies.maxConcurrentPerProject)) {
          const current = active.filter((run) => tasks.get(run.taskId)?.projectId === task.projectId).length;
          if (current >= policies.maxConcurrentPerProject) {
            const error = new Error(`project ${task.projectId} is at capacity`);
            error.code = "CAPABILITY_UNAVAILABLE";
            error.details = {
              reason: "capacity",
              scope: "project",
              taskId,
              projectId: task.projectId,
              limit: policies.maxConcurrentPerProject,
              current,
            };
            throw error;
          }
        }
        if (Number.isInteger(policies.maxPerAgent)) {
          const current = active.filter((run) => run.agentId === agentId).length;
          if (current >= policies.maxPerAgent) {
            const error = new Error(`agent ${agentId} is at capacity`);
            error.code = "CAPABILITY_UNAVAILABLE";
            error.details = { reason: "capacity", scope: "agent", taskId, agentId, limit: policies.maxPerAgent, current };
            throw error;
          }
        }
      }

      const candidateFiles = Array.isArray(task.files) ? task.files : [];
      if (candidateFiles.length > 0) {
        for (const run of active) {
          const files = Array.isArray(run.files) ? run.files : tasks.get(run.taskId)?.files ?? [];
          const overlap = candidateFiles.filter((file) => files.includes(file));
          if (overlap.length > 0) {
            const error = new Error(`task ${taskId} write scope conflicts with run ${run.id}`);
            error.code = "CAPABILITY_UNAVAILABLE";
            error.details = { reason: "write-scope-conflict", taskId, conflictingRunId: run.id, files: overlap };
            throw error;
          }
        }
      }

      // Atomic commit (the fake is synchronous, so the whole block is "one transaction").
      const previousStatus = task.status;
      task.status = "CLAIMED";
      task.version += 1;
      task.updatedAt = nowIso();

      counters.run += 1;
      const runId = `RUN-${counters.run.toString(36).toUpperCase()}`;
      const now = nowIso();
      const run = {
        id: runId,
        taskId,
        agentId,
        function: requiredFunctionValue,
        role: requiredRoleValue,
        attempt: 1,
        status: "STARTING",
        version: 0,
        exitCode: null,
        createdAt: now,
        updatedAt: now,
        ...(workspacePolicy ? { workspacePolicy: clone(workspacePolicy) } : {}),
        ...(candidateFiles.length > 0 ? { files: clone(candidateFiles) } : {}),
      };
      runs.set(runId, run);
      seq += 1;
      events.push(
        createEvent({
          seq,
          projectId: task.projectId ?? null,
          aggregateType: "run",
          aggregateId: runId,
          type: "run.created",
          payload: {
            runId,
            taskId,
            agentId,
            function: requiredFunctionValue,
            role: requiredRoleValue,
            status: "STARTING",
            attempt: 1,
            version: 0,
          },
        }),
      );

      counters.command += 1;
      const command = {
        id: `CMD-${counters.command.toString(36).toUpperCase()}`,
        runId,
        taskId,
        commandType: "RUN_TASK",
        payload: { taskId, agentId, workspacePolicy: workspacePolicy ? clone(workspacePolicy) : null },
        idempotencyKey,
        status: "PENDING",
        ownerId: null,
        generation: 0,
        claimedUntil: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      dispatchCommands.set(command.id, command);

      seq += 1;
      events.push(
        createEvent({
          seq,
          projectId: task.projectId ?? null,
          aggregateType: "task",
          aggregateId: taskId,
          type: "task.updated",
          payload: { taskId, status: task.status, previousStatus, version: task.version, agentId, runId },
        }),
      );
      snapshotVersion += 1;
      return { run: clone(run), command: clone(command), task: clone(task) };
    },

    listAgents() {
      return [...agents.values()].map(clone);
    },
    upsertAgent(dto) {
      const agent = { ...clone(dto), createdAt: agents.get(dto.id)?.createdAt ?? nowIso() };
      agents.set(agent.id, agent);
      return clone(agent);
    },

    // ---- M4: reviews / rework / human approval (m4-contracts §1) ----
    listReviews({ taskId, status, limit } = {}) {
      let items = [...reviews.values()];
      if (taskId) items = items.filter((review) => review.taskId === taskId);
      if (status) items = items.filter((review) => review.status === status);
      if (Number.isInteger(limit)) items = items.slice(0, limit);
      return items.map(clone);
    },
    getReview(id) {
      const review = reviews.get(id);
      if (!review) fail("NOT_FOUND", `review ${id} not found`, { entity: "review", id });
      return clone(review);
    },
    createReview({ taskId, runId = null, actor = "HUMAN", attempt } = {}) {
      const task = requireTask(taskId);
      if (task.status !== "REVIEWING") {
        fail("TASK_VERSION_CONFLICT", `task ${taskId} is not REVIEWING`, {
          taskId,
          status: task.status,
          currentVersion: task.version,
          reason: "not-reviewing",
        });
      }
      if (runId) {
        const run = requireRun(runId);
        if (run.taskId !== taskId) fail("VALIDATION_ERROR", `run ${runId} does not belong to task ${taskId}`, { errors: ["runId does not belong to task"] });
      }
      const active = [...reviews.values()].find((review) => review.taskId === taskId && review.status === "PENDING" && review.verdict === null);
      if (active) {
        fail("VERSION_CONFLICT", `task ${taskId} already has an active review`, {
          entity: "review",
          taskId,
          activeReviewId: active.id,
          currentVersion: active.version ?? 0,
        });
      }
      counters.review += 1;
      const review = {
        id: `REV-${counters.review.toString(36).toUpperCase()}`,
        taskId,
        runId,
        actor,
        status: "PENDING",
        verdict: null,
        attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
        version: 0,
        findings: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      reviews.set(review.id, review);
      recordEvent({
        projectId: task.projectId ?? null,
        aggregateType: "review",
        aggregateId: review.id,
        type: "review.requested",
        payload: { reviewId: review.id, taskId, runId, actor, attempt: review.attempt },
      });
      return clone(review);
    },
    submitReview({ id, expectedVersion, verdict, manifestHash = null, commitSha = null, findings = [], evidence = null, actor = "HUMAN" } = {}) {
      const review = reviews.get(id);
      if (!review) fail("NOT_FOUND", `review ${id} not found`, { entity: "review", id });
      if (review.version !== expectedVersion) {
        fail("VERSION_CONFLICT", `review ${id} version conflict`, {
          entity: "review",
          id,
          currentVersion: review.version,
          expectedVersion,
        });
      }
      if (review.status !== "PENDING") {
        fail("VERSION_CONFLICT", `review ${id} is not pending`, { entity: "review", id, status: review.status, reason: "not-pending", currentVersion: review.version });
      }
      const task = requireTask(review.taskId);
      const run = review.runId ? runs.get(review.runId) ?? null : null;
      const authorAgentId = run?.agentId ?? task.assignee ?? null;
      if (authorAgentId && authorAgentId === actor) {
        fail("SELF_REVIEW_FORBIDDEN", "the author cannot review their own work", { actor, authorAgentId });
      }
      if (verdict !== "PASS" && verdict !== "CHANGES_REQUESTED" && verdict !== "BLOCKED") {
        fail("VALIDATION_ERROR", "unsupported verdict", { errors: ["verdict must be PASS, CHANGES_REQUESTED or BLOCKED"] });
      }
      if (verdict === "PASS") {
        const tests = isPlainObject(evidence?.tests) ? evidence.tests : null;
        if (typeof manifestHash !== "string" || manifestHash.trim() === "" || !tests || !Number.isInteger(tests.passed) || !Number.isInteger(tests.total) || tests.total <= 0 || tests.passed !== tests.total) {
          fail("EVIDENCE_MISSING", "PASS requires manifestHash and passing tests", { errors: ["manifestHash and evidence.tests.passed===total>0 are required"] });
        }
      }
      if (verdict === "CHANGES_REQUESTED" && (!Array.isArray(findings) || findings.length === 0)) {
        fail("VALIDATION_ERROR", "CHANGES_REQUESTED requires findings", { errors: ["findings must be a non-empty array"] });
      }
      const previousTaskStatus = task.status;
      review.verdict = verdict;
      review.status = verdict === "PASS" ? "PASS" : verdict === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : "BLOCKED";
      review.version += 1;
      review.manifestHash = manifestHash;
      review.commitSha = commitSha;
      review.findings = clone(findings ?? []);
      review.evidence = clone(evidence);
      review.submittedAt = nowIso();
      review.updatedAt = review.submittedAt;
      task.status = verdict === "PASS" ? "INTEGRATING" : verdict === "CHANGES_REQUESTED" ? "REJECTED" : "BLOCKED";
      // m4-contracts §0.3: a PASS publishes the Task's candidate target hash.
      if (verdict === "PASS" && typeof manifestHash === "string" && manifestHash !== "") {
        task.targetHash = manifestHash;
      }
      task.version += 1;
      task.updatedAt = nowIso();
      recordEvent({
        projectId: task.projectId ?? null,
        aggregateType: "review",
        aggregateId: review.id,
        type: "review.updated",
        payload: { reviewId: review.id, taskId: task.id, verdict, status: review.status, attempt: review.attempt, version: review.version },
      });
      recordEvent({
        projectId: task.projectId ?? null,
        aggregateType: "task",
        aggregateId: task.id,
        type: "task.updated",
        payload: { taskId: task.id, status: task.status, previousStatus: previousTaskStatus, version: task.version, reason: `review-${verdict.toLowerCase()}` },
      });
      return { review: clone(review), task: clone(task) };
    },
    reworkTask({ taskId, reviewId, reason, actor = "HUMAN" } = {}) {
      const review = reviews.get(reviewId);
      if (!review) fail("NOT_FOUND", `review ${reviewId} not found`, { entity: "review", id: reviewId });
      const task = requireTask(taskId);
      if (review.status !== "CHANGES_REQUESTED") {
        fail("VERSION_CONFLICT", `review ${reviewId} is not CHANGES_REQUESTED`, {
          entity: "review",
          id: reviewId,
          status: review.status,
          reason: "not-changes-requested",
        });
      }
      const MAX_ATTEMPTS = 3;
      const previousTaskStatus = task.status;
      if (review.attempt >= MAX_ATTEMPTS) {
        review.status = "BLOCKED";
        review.version += 1;
        review.updatedAt = nowIso();
        task.status = "BLOCKED";
        task.version += 1;
        task.blockReason = "rework-limit";
        task.updatedAt = nowIso();
        recordEvent({
          projectId: task.projectId ?? null,
          aggregateType: "review",
          aggregateId: review.id,
          type: "review.updated",
          payload: { reviewId: review.id, taskId, status: "BLOCKED", reason: "rework-limit", attempt: review.attempt },
        });
        recordEvent({
          projectId: task.projectId ?? null,
          aggregateType: "task",
          aggregateId: taskId,
          type: "task.updated",
          payload: { taskId, status: "BLOCKED", previousStatus: previousTaskStatus, version: task.version, reason: "rework-limit" },
        });
        fail("REWORK_LIMIT_REACHED", `task ${taskId} reached the rework limit`, {
          taskId,
          attempt: review.attempt,
          maxAttempts: MAX_ATTEMPTS,
        });
      }
      review.attempt += 1;
      review.version += 1;
      review.updatedAt = nowIso();
      task.status = "READY";
      task.version += 1;
      task.updatedAt = nowIso();
      recordEvent({
        projectId: task.projectId ?? null,
        aggregateType: "review",
        aggregateId: review.id,
        type: "review.updated",
        payload: { reviewId: review.id, taskId, status: review.status, reason: "rework", attempt: review.attempt, version: review.version },
      });
      recordEvent({
        projectId: task.projectId ?? null,
        aggregateType: "task",
        aggregateId: taskId,
        type: "task.updated",
        payload: { taskId, status: task.status, previousStatus: previousTaskStatus, version: task.version, reason: "rework" },
      });
      return { review: clone(review), task: clone(task), attempt: review.attempt };
    },
    listApprovals({ taskId, status, limit } = {}) {
      let items = [...approvals.values()];
      if (taskId) items = items.filter((approval) => approval.taskId === taskId);
      if (status) items = items.filter((approval) => approval.status === status);
      if (Number.isInteger(limit)) items = items.slice(0, limit);
      return items.map(clone);
    },
    createApproval(dto = {}) {
      const task = requireTask(dto.taskId);
      counters.approval += 1;
      const now = nowIso();
      const approval = {
        id: dto.id ?? `APR-${counters.approval.toString(36).toUpperCase()}`,
        taskId: dto.taskId,
        projectId: task.projectId ?? null,
        scope: dto.scope,
        targetHash: dto.targetHash,
        actor: dto.actor ?? "HUMAN",
        status: dto.status ?? "PENDING",
        at: dto.at ?? now,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      approvals.set(approval.id, approval);
      recordEvent({
        projectId: approval.projectId,
        aggregateType: "approval",
        aggregateId: approval.id,
        type: "approval.recorded",
        payload: { approvalId: approval.id, taskId: approval.taskId, scope: approval.scope, targetHash: approval.targetHash, status: approval.status, actor: approval.actor },
      });
      return clone(approval);
    },
    decideApproval({ id, decision, actor = "HUMAN", targetHash } = {}) {
      const approval = approvals.get(id);
      if (!approval) fail("NOT_FOUND", `approval ${id} not found`, { entity: "approval", id });
      const task = requireTask(approval.taskId);
      if (approval.status !== "PENDING") {
        fail("VERSION_CONFLICT", `approval ${id} is not pending`, { entity: "approval", id, status: approval.status, reason: "not-pending" });
      }
      if (approval.targetHash !== targetHash) {
        fail("APPROVAL_STALE", `approval ${id} target hash is stale`, {
          approvalId: id,
          taskId: task.id,
          expectedTargetHash: approval.targetHash,
          receivedTargetHash: targetHash ?? null,
        });
      }
      if (typeof task.targetHash === "string" && task.targetHash !== "" && task.targetHash !== targetHash) {
        fail("APPROVAL_STALE", `task ${task.id} target hash changed`, {
          approvalId: id,
          taskId: task.id,
          expectedTargetHash: task.targetHash,
          receivedTargetHash: targetHash ?? null,
        });
      }
      const previousTaskStatus = task.status;
      approval.status = decision;
      approval.decision = decision;
      approval.decidedAt = nowIso();
      approval.updatedAt = approval.decidedAt;
      approval.version += 1;
      task.status = decision === "APPROVED" ? "DONE" : "READY";
      task.version += 1;
      task.updatedAt = nowIso();
      recordEvent({
        projectId: approval.projectId ?? null,
        aggregateType: "approval",
        aggregateId: id,
        type: "approval.recorded",
        payload: { approvalId: id, taskId: task.id, decision, status: approval.status, targetHash, actor },
      });
      recordEvent({
        projectId: approval.projectId ?? null,
        aggregateType: "task",
        aggregateId: task.id,
        type: "task.updated",
        payload: { taskId: task.id, status: task.status, previousStatus: previousTaskStatus, version: task.version, reason: `approval-${decision.toLowerCase()}` },
      });
      return { approval: clone(approval), task: clone(task) };
    },

    overview(projectId) {
      const project = projects.get(projectId);
      if (!project) {
        const error = new Error(`project ${projectId} not found`);
        error.code = "NOT_FOUND";
        throw error;
      }
      const projectTasks = [...tasks.values()].filter((task) => task.projectId === projectId);
      const tasksByStatus = {};
      for (const task of projectTasks) tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
      const projectTaskIds = new Set(projectTasks.map((task) => task.id));
      const projectRuns = [...runs.values()].filter((run) => projectTaskIds.has(run.taskId));
      const runsRunning = projectRuns.filter((run) => run.status === "STARTING" || run.status === "RUNNING").length;
      const awaitingAcceptance = projectTasks.filter((task) => task.status === "AWAITING_ACCEPTANCE");
      const blocked = projectTasks.filter((task) => task.status === "BLOCKED");
      const recentEvents = events
        .filter((event) => event.projectId === projectId)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, 20)
        .map(clone);
      return {
        project: clone(project),
        counts: {
          tasksByStatus,
          runsRunning,
          runsTotal: projectRuns.length,
          awaitingAcceptance: awaitingAcceptance.length,
        },
        blocked: blocked.map(clone),
        awaitingAcceptance: awaitingAcceptance.map(clone),
        recentEvents,
      };
    },

    appendEvent({ projectId = null, aggregateType, aggregateId, type, payload = {} }) {
      seq += 1;
      const event = createEvent({ seq, projectId, aggregateType, aggregateId, type, payload });
      events.push(event);
      return clone(event);
    },
    listEvents({ projectId, afterSeq = 0, limit, aggregateId, aggregateType, type } = {}) {
      let items = events.filter((event) => event.seq > afterSeq);
      if (projectId) items = items.filter((event) => event.projectId === projectId);
      if (aggregateId) items = items.filter((event) => event.aggregateId === aggregateId);
      if (aggregateType) items = items.filter((event) => event.aggregateType === aggregateType);
      if (type) items = items.filter((event) => event.type === type);
      items = items.sort((a, b) => a.seq - b.seq);
      if (Number.isInteger(limit)) items = items.slice(0, limit);
      return items.map(clone);
    },
    verifySwitchReadiness() {
      return clone(switchReadiness);
    },
    _setSwitchReadiness(value) {
      switchReadiness = clone(value);
    },
    latestSeq() {
      return seq;
    },

    // ---- test-only helpers (not part of the store contract) ----
    _dropEventsBefore(minSeq) {
      events = events.filter((event) => event.seq >= minSeq);
    },
    _appendRun(run) {
      const record = { id: nextId("R", "run"), status: "RUNNING", ...clone(run) };
      runs.set(record.id, record);
      return clone(record);
    },
    _listDispatchCommands() {
      return [...dispatchCommands.values()].map(clone);
    },
    _getDispatchCommand(id) {
      return clone(dispatchCommands.get(id) ?? null);
    },
    _updateTask(id, changes) {
      const task = tasks.get(id);
      if (!task) return null;
      Object.assign(task, clone(changes));
      task.version += 1;
      task.updatedAt = nowIso();
      return clone(task);
    },
  };
}
