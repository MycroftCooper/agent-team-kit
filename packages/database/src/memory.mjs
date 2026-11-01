// In-memory Store: the same interface and the same behaviour as the SQLite
// store (contracts §1), for backend/QA flows that must not touch a database
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
  MAX_EVENT_LIMIT,
  MAX_OVERVIEW_EVENTS,
  SCHEMA_VERSION,
  assertEnumFilter,
  buildOverview,
  compareTasks,
  ensurePlainObject,
  makeEvent,
  mergeAgent,
  mergeProject,
  mergeTask,
  normalizeAgent,
  normalizeApproval,
  normalizeLimit,
  normalizeProject,
  normalizeRequirement,
  normalizeTask,
  nowIso,
  requireId,
  safeJson,
  validateTaskStatus,
} from "./model.mjs";

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
  const approvals = new Map();
  const events = [];
  const projectMeta = new Map();
  const taskMeta = new Map();
  const runs = new Map();
  let seq = 0;

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

    listReviews({ status } = {}) {
      if (status !== undefined && status !== null) assertEnumFilter("review", status);
      return [];
    },

    listApprovals({ taskId, status } = {}) {
      let list = [...approvals.values()];
      if (taskId !== undefined && taskId !== null) {
        requireId(taskId, "approval.taskId");
        list = list.filter((approval) => approval.taskId === taskId);
      }
      if (status !== undefined && status !== null) {
        assertEnumFilter("acceptance", status);
        list = list.filter((approval) => approval.status === status);
      }
      return list
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .map(clone);
    },

    createApproval(dto) {
      ensurePlainObject(dto, "approval");
      const approval = normalizeApproval(dto, { now: nowIso() });
      if (approval.projectId !== undefined) requireProject(approval.projectId);
      if (approval.taskId !== undefined) requireTaskEntry(approval.taskId);
      approvals.set(approval.id, approval);
      return clone(approval);
    },

    // --- Overview ---------------------------------------------------------
    overview(projectId) {
      requireId(projectId, "project.id");
      const project = requireProject(projectId);
      const projectTasks = [...tasks.values()].filter((task) => task.projectId === projectId);
      const recentEvents = events
        .filter((event) => event.projectId === projectId)
        .slice(-MAX_OVERVIEW_EVENTS)
        .reverse()
        .map(clone);
      return buildOverview({
        project: clone(project),
        tasks: projectTasks.map(clone),
        recentEvents,
        runsRunning: 0,
        runsTotal: 0,
      });
    },

    // --- Events -----------------------------------------------------------
    appendEvent(input) {
      ensurePlainObject(input, "event");
      const event = makeEvent({ ...input, now: nowIso() });
      seq += 1;
      const persisted = { ...event, seq, schemaVersion: EVENT_SCHEMA_VERSION };
      events.push(persisted);
      return clone(persisted);
    },

    listEvents({ projectId, afterSeq, limit } = {}) {
      if (projectId !== undefined && projectId !== null) requireId(projectId, "event.projectId");
      if (afterSeq !== undefined && afterSeq !== null) {
        if (!Number.isInteger(afterSeq) || afterSeq < 0) {
          fail("VALIDATION_ERROR", "afterSeq must be a non-negative integer", { afterSeq });
        }
      }
      const max = normalizeLimit(limit, { fallback: 200, max: MAX_EVENT_LIMIT });
      return events
        .filter((event) => (projectId === undefined || projectId === null ? true : event.projectId === projectId))
        .filter((event) => (afterSeq === undefined || afterSeq === null ? true : event.seq > afterSeq))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, max)
        .map(clone);
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
      getProjectLegacy: (id) => clone(projectMeta.get(id)?.legacy ?? null),
      getProjectSettings: (id) => clone(projectMeta.get(id)?.settings ?? null),
      getTaskLegacy: (id) => clone(taskMeta.get(id)?.legacy ?? null),
      /**
       * Migration-only writer (see sqlite.mjs): writes a legacy status without
       * the §5.2 transition check. Only importStateJson may use it.
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
