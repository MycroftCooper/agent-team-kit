// In-memory store used by the backend tests.
//
// It implements exactly the subset of `m1-contracts §1` the backend calls, so
// these tests do not depend on the (parallel) @atk/database implementation.
// Behavioural quirks the tests rely on:
// - sync methods, plain JSON-serialisable values
// - CAS on patchTask with `details.currentVersion`
// - `_dropEventsBefore(seq)` simulates a pruned event log for the resync test
import { createEvent } from "@atk/contracts";

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
  let events = [];
  let seq = 0;
  let counters = { task: 0, run: 0, requirement: 0, approval: 0 };

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
      const run = runs.get(id);
      if (!run) {
        const error = new Error(`run ${id} not found`);
        error.code = "NOT_FOUND";
        throw error;
      }
      return clone(run);
    },

    listAgents() {
      return [...agents.values()].map(clone);
    },
    upsertAgent(dto) {
      const agent = { ...clone(dto), createdAt: agents.get(dto.id)?.createdAt ?? nowIso() };
      agents.set(agent.id, agent);
      return clone(agent);
    },

    listReviews({ status } = {}) {
      return [...reviews.values()].filter((review) => !status || review.status === status).map(clone);
    },
    listApprovals({ taskId, status } = {}) {
      return [...approvals.values()]
        .filter((approval) => (!taskId || approval.taskId === taskId) && (!status || approval.status === status))
        .map(clone);
    },
    createApproval(dto) {
      const approval = { ...clone(dto), id: dto.id ?? nextId("APR", "approval"), createdAt: nowIso() };
      approvals.set(approval.id, approval);
      return clone(approval);
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
    listEvents({ projectId, afterSeq = 0, limit } = {}) {
      let items = events.filter((event) => event.seq > afterSeq);
      if (projectId) items = items.filter((event) => event.projectId === projectId);
      items = items.sort((a, b) => a.seq - b.seq);
      if (Number.isInteger(limit)) items = items.slice(0, limit);
      return items.map(clone);
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
  };
}
