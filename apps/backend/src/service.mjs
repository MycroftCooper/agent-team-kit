import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { openStore } from "../../../packages/database/src/index.mjs";
import {
  AppError,
  requireThat,
  requiredString,
  object,
  integer,
  LEASE_MS,
  HEARTBEAT_MS,
  MAX_ATTEMPTS,
} from "../../../packages/contracts/src/index.mjs";
import {
  normalizePlan,
  normalizeRole,
  normalizeScopes,
  scopeContains,
  validateEvidence,
} from "../../../packages/domain/src/index.mjs";
import {
  dependenciesReady,
  orderedTasks,
  pathsOverlap,
} from "../../../packages/scheduler-core/src/index.mjs";
import {
  projectPaths,
  canonical,
  lockKey,
  resolveScope,
  capture,
  normalizeAfter,
  currentDifferences,
  atomicJson,
  writeDocument,
  sha,
} from "../../../packages/project-files/src/index.mjs";

const active = (r) =>
  ["RUNNING", "STOP_REQUESTED", "QUARANTINED"].includes(r.status);
const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const safeAgent = ({ credentialHash, ...agent }) => agent;
const runSummary = ({ spec, before, artifact, ...run }) => ({
  ...run,
  title: spec?.title,
});
const planSummary = ({
  id,
  sourceTaskId,
  projectId,
  status,
  revision,
  version,
}) => ({ id, sourceTaskId, projectId, status, revision, version });
const fileMetadata = (files) =>
  Object.fromEntries(
    Object.entries(files).map(([file, { text, ...value }]) => [file, value]),
  );
export function createService({ dataDir, now = () => Date.now() } = {}) {
  const store = openStore(path.join(dataDir, "data", "next.db")),
    signals = new EventEmitter();
  signals.setMaxListeners(0);
  const at = () => new Date(now()).toISOString();
  const get = (table, id) => {
    const row = store.get(table, id);
    requireThat(row, "NOT_FOUND", `${table}: ${id} not found`, 404);
    return row;
  };
  const put = (table, row) => store.put(table, { ...row, updatedAt: at() });
  const make = (table, values) =>
    put(table, { id: uid(table.slice(0, -1)), createdAt: at(), ...values });
  function emit(type, projectId, entityId, data = {}) {
    const seq = store.emit({
      eventId: uid("evt"),
      type,
      projectId,
      entityId,
      data,
      createdAt: at(),
    });
    queueMicrotask(() => signals.emit("change", seq));
    return seq;
  }
  function project(id) {
    const p = get("projects", id);
    requireThat(!p.archived, "PROJECT_ARCHIVED", "Project is archived", 409);
    requireThat(
      fs.existsSync(p.root),
      "PROJECT_UNAVAILABLE",
      "Project path is unavailable",
      409,
    );
    return p;
  }
  function expected(row, version) {
    requireThat(
      Number.isInteger(version) && row.version === version,
      "VERSION_CONFLICT",
      "The item changed; refresh and retry",
      409,
      { currentVersion: row.version },
    );
  }
  function queueDoc(p, kind, id, payload) {
    return make("materializations", {
      projectId: p.id,
      status: "PENDING",
      kind,
      target: `${kind}/${id}.json`,
      payload,
      attempts: 0,
      error: null,
    });
  }
  function working() {
    return store.activeRuns();
  }
  function locksFor(scopes, p) {
    return scopes.map((s) => resolveScope(p, s));
  }
  function permittedScopes(p, files, role) {
    const grants = role.files.map((s) => resolveScope(p, s));
    for (const s of locksFor(files, p))
      requireThat(
        grants.some(
          (g) =>
            (g.key === s.key && (!s.directory || g.directory)) ||
            (g.directory && s.key.startsWith(g.key + "/")),
        ),
        "SCOPE_FORBIDDEN",
        "Resolved task files exceed role permissions",
        403,
      );
  }
  function taskProjection(task, existingLocks) {
    if (task.kind !== "WORK" || task.status !== "READY") return task;
    const unmet = task.deps
      .map((id) => get("tasks", id))
      .filter((t) => !["VERIFIED", "DONE"].includes(t.status));
    if (unmet.length)
      return {
        ...task,
        waiting: {
          code: "DEPENDENCIES",
          tasks: unmet.map(({ id, title, status }) => ({ id, title, status })),
        },
      };
    try {
      const p = project(task.projectId),
        scopes = locksFor(task.files, p),
        held = (existingLocks ?? store.all("locks")).filter((l) =>
          scopes.some((s) => pathsOverlap(s.key, l.path)),
        );
      if (held.length)
        return {
          ...task,
          waiting: {
            code: "FILE_LOCKED",
            holders: held.map((l) => ({
              runId: l.runId,
              taskId: l.taskId,
              agentId: l.agentId,
              agentName: store.get("agents", l.agentId)?.name ?? "HUMAN",
              file: l.relative,
            })),
          },
        };
    } catch (error) {
      return {
        ...task,
        waiting: { code: error.code ?? "PROJECT_UNAVAILABLE" },
      };
    }
    return { ...task, waiting: null };
  }
  function conflicts(scopes) {
    return store
      .all("locks")
      .filter((l) => scopes.some((s) => pathsOverlap(l.path, s.key)));
  }
  function lock(run, p, scopes) {
    const found = conflicts(scopes);
    requireThat(!found.length, "FILE_LOCKED", "Files are occupied", 409, {
      locks: found,
    });
    for (const s of scopes)
      make("locks", {
        runId: run.id,
        projectId: p.id,
        path: s.key,
        relative: s.relative,
        directory: s.directory,
        status: "HELD",
        agentId: run.agentId,
        taskId: run.taskId,
      });
  }
  function unlock(runId) {
    for (const l of store.all("locks").filter((l) => l.runId === runId))
      store.remove("locks", l.id);
  }
  function agentContext(agentId) {
    const a = get("agents", agentId);
    requireThat(!a.revoked, "AGENT_REVOKED", "Agent is revoked", 403);
    return {
      agent: a,
      role: get("roles", a.roleId),
      team: get("teams", a.teamId),
    };
  }
  function allowed(a, t, p) {
    return (
      p.teamId === t.id &&
      (t.projectIds.length === 0 || t.projectIds.includes(p.id))
    );
  }
  function validRun(agentId, runId, body, { allowStopped = false } = {}) {
    const r = get("runs", runId);
    requireThat(
      r.agentId === agentId,
      "RUN_FORBIDDEN",
      "Run belongs to another identity",
      403,
    );
    requireThat(
      body.generation === r.generation,
      "STALE_GENERATION",
      "Execution generation does not match",
      409,
    );
    requireThat(
      r.status === "RUNNING" ||
        (allowStopped && ["STOP_REQUESTED", "QUARANTINED"].includes(r.status)),
      "RUN_NOT_ACTIVE",
      "Execution is no longer active",
      409,
    );
    if (!allowStopped)
      requireThat(
        r.leaseUntil > now(),
        "LEASE_EXPIRED",
        "Stop writing; lease has expired",
        409,
      );
    return r;
  }
  function tasksOf(planId) {
    return store.all("tasks", { planId }).filter((t) => t.kind === "WORK");
  }
  function manifestFor(planId) {
    const tasks = tasksOf(planId),
      outputs = Object.create(null),
      owners = Object.create(null);
    const runs = tasks
      .map((t) => store.get("runs", t.latestRunId))
      .filter(Boolean)
      .sort((a, b) => (a.completedSeq ?? 0) - (b.completedSeq ?? 0));
    for (const r of runs) {
      Object.assign(outputs, r.artifact?.after ?? {});
      for (const file of Object.keys(r.artifact?.after ?? {}))
        owners[file] = r.taskId;
    }
    const clean = Object.fromEntries(
      Object.entries(outputs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([f, v]) => [f, { hash: v.hash, size: v.size }]),
    );
    const results = tasks
      .map((t) => ({ taskId: t.id, resultHash: t.resultHash }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    const scopes = normalizeScopes(tasks.flatMap((t) => t.files));
    return {
      files: clean,
      owners,
      scopes,
      results,
      planId,
      targetHash: sha({ planId, results, files: clean }),
    };
  }
  function refreshSource(planId) {
    const plan = get("plans", planId);
    if (plan.status !== "APPROVED") return;
    const source = get("tasks", plan.sourceTaskId),
      tasks = tasksOf(planId);
    if (source.status === "DONE" || source.status === "CANCELLED") return;
    if (
      tasks.length &&
      tasks.every((t) => ["VERIFIED", "DONE"].includes(t.status))
    ) {
      const manifest = manifestFor(planId),
        p = project(plan.projectId);
      let acceptance = store
        .all("acceptances", { parentId: source.id })
        .find(
          (a) => a.targetHash === manifest.targetHash && a.status === "PENDING",
        );
      if (!acceptance) {
        for (const old of store
          .all("acceptances", { parentId: source.id })
          .filter((a) => a.status === "PENDING"))
          put("acceptances", { ...old, status: "STALE" });
        acceptance = make("acceptances", {
          projectId: p.id,
          sourceTaskId: source.id,
          planId,
          status: "PENDING",
          ...manifest,
        });
        queueDoc(p, "acceptances", acceptance.id, acceptance);
        emit("acceptance.created", p.id, acceptance.id);
      }
      put("tasks", {
        ...source,
        status: "AWAITING_ACCEPTANCE",
        blockReason: null,
      });
    } else if (source.status !== "BLOCKED")
      put("tasks", {
        ...source,
        status: tasks.some((t) => t.status !== "READY") ? "RUNNING" : "READY",
      });
    emit("task.updated", source.projectId, source.id);
  }
  function validateReviewTarget(task) {
    const run = get("runs", task.latestRunId);
    const p = project(task.projectId);
    return currentDifferences(p, run.artifact?.after ?? {}, run.files);
  }
  function invalidateTargets(p) {
    for (const t of store.all("tasks", {
      projectId: p.id,
      status: "REVIEWING",
    })) {
      const changes = validateReviewTarget(t);
      if (!changes.length) continue;
      put("tasks", {
        ...t,
        status: "BLOCKED",
        blockReason: "REVIEW_TARGET_CHANGED",
        drift: changes,
      });
      for (const r of store
        .all("runs", { parentId: t.id })
        .filter((r) => r.stage === "REVIEW" && r.status === "RUNNING"))
        put("runs", { ...r, status: "INTERRUPTED", endedAt: at() });
      emit("review.invalidated", p.id, t.id, { changes });
    }
    for (const a of store.all("acceptances", {
      projectId: p.id,
      status: "PENDING",
    })) {
      const changes = currentDifferences(p, a.files, a.scopes);
      if (changes.length) {
        put("acceptances", { ...a, status: "STALE", drift: changes });
        emit("acceptance.invalidated", p.id, a.id, { changes });
      }
    }
  }
  function runSpec(p, task, plan, role, stage) {
    const frozenRole = plan?.roleSnapshots?.[role?.id] ?? role;
    const base = {
      schemaVersion: 1,
      stage,
      taskId: task.id,
      taskVersion: task.version,
      planId: plan?.id ?? null,
      planVersion: plan?.revision ?? null,
      title: task.title,
      description: task.description,
      acceptance: task.acceptance ?? "",
      files: task.files ?? [],
      checks: task.checks ?? [],
      instructions: frozenRole?.instructions ?? "",
      output: frozenRole?.output ?? "",
      project: { id: p.id, name: p.name, root: p.root, docsRoot: p.docsRoot },
      lease: { heartbeatMs: HEARTBEAT_MS, leaseMs: LEASE_MS },
    };
    if (stage === "PLANNING") {
      const team = get("teams", p.teamId);
      base.roles = team.roleIds.map((id) => get("roles", id));
      base.team = { id: team.id, defaultReview: team.defaultReview };
      base.revisionNote = task.revisionNote ?? null;
      base.previousPlanRef = plan ? `/api/agent/v1/plans/${plan.id}` : null;
      base.output =
        "Submit summary and nodes; each node requires key, title, description, acceptance, executorType, roleId, files, checks, reviewPolicy, reviewRoleId and deps. Do not edit project files.";
    } else {
      base.dependencies = (task.deps ?? []).map((id) => {
        const d = get("tasks", id);
        return {
          id,
          title: d.title,
          resultHash: d.resultHash,
          resultRef: d.latestRunId
            ? `/api/agent/v1/runs/${d.latestRunId}/artifact`
            : null,
        };
      });
    }
    if (stage === "REVIEW") {
      base.targetHash = task.resultHash;
      base.artifactRef = `/api/agent/v1/runs/${task.latestRunId}/artifact`;
      base.instructions +=
        "\nRead-only review. Do not edit project files. Bind your verdict to targetHash.";
    }
    return base;
  }
  function createRun(p, task, plan, agentId, role, stage, files) {
    if (stage === "EXECUTION")
      permittedScopes(p, files, plan?.roleSnapshots?.[role.id] ?? role);
    requireThat(
      canonical(p.docsRoot) === p.docsRoot,
      "PROJECT_DATA_MOVED",
      "Project data path changed; relocate the project before executing",
      409,
    );
    const scopes = locksFor(files, p);
    const found = conflicts(scopes);
    if (found.length)
      return {
        blocked: true,
        reason: "FILE_LOCKED",
        taskId: task.id,
        locks: found,
      };
    const generation =
      store
        .all("runs", { parentId: task.id })
        .reduce((max, r) => Math.max(max, r.generation), 0) + 1;
    let run = make("runs", {
      projectId: p.id,
      taskId: task.id,
      parentId: task.id,
      planId: plan?.id ?? null,
      agentId,
      stage,
      status: "RUNNING",
      generation,
      leaseUntil: now() + LEASE_MS,
      files,
      startedAt: at(),
      spec: runSpec(p, task, plan, role, stage),
    });
    lock(run, p, scopes);
    const dir = path.join(p.docsRoot, "runs", run.id);
    const before =
      stage === "EXECUTION" || stage === "HUMAN"
        ? capture(p, files, {
            outputDir: path.join(dir, "before"),
            includeContent: true,
          })
        : {};
    if (stage === "EXECUTION" || stage === "HUMAN")
      atomicJson(path.join(dir, "before.json"), before);
    run = put("runs", {
      ...run,
      before: fileMetadata(before),
      specHash: sha(run.spec),
      artifactDir: dir,
    });
    if (stage !== "PLANNING")
      put("tasks", {
        ...task,
        status: stage === "REVIEW" ? "REVIEWING" : "RUNNING",
        blockReason: null,
      });
    if (plan && stage === "EXECUTION") {
      const source = get("tasks", plan.sourceTaskId);
      put("tasks", { ...source, status: "RUNNING" });
    }
    emit("run.created", p.id, run.id, { taskId: task.id, stage });
    return {
      run: runSummary(run),
      spec: run.spec,
      generation,
      leaseUntil: run.leaseUntil,
    };
  }
  if (!store.get("roles", "role-pm"))
    store.tx(() => {
      const common = { createdAt: at() };
      for (const r of [
        {
          id: "role-pm",
          name: "Product manager",
          function: "ORCHESTRATOR",
          files: [],
          instructions:
            "Clarify the DRAFT, decompose tasks, choose roles, dependencies and acceptance. Submit a plan for human approval. Never execute or review your own plan.",
        },
        {
          id: "role-dev",
          name: "Developer",
          function: "WORKER",
          files: ["."],
          instructions:
            "Work only within the approved task and leased file scopes. Report checks, changes and completion through the protocol.",
        },
        {
          id: "role-qa",
          name: "Reviewer",
          function: "REVIEWER",
          files: [],
          instructions:
            "Independently review the frozen output and check evidence. Never approve your own work.",
        },
      ])
        put("roles", {
          ...common,
          ...r,
          output: "Structured summary and evidence",
        });
      put("teams", {
        ...common,
        id: "team-default",
        name: "Default team",
        roleIds: ["role-pm", "role-dev", "role-qa"],
        projectIds: [],
        maxConcurrent: 4,
        defaultReview: "NONE",
      });
    });
  const api = {
    store,
    signals,
    dataDir,
    list(table, filters = {}) {
      const page = store.list(table, filters);
      const currentLocks =
        table === "tasks" &&
        page.items.some((t) => t.kind === "WORK" && t.status === "READY")
          ? store.all("locks")
          : undefined;
      return {
        ...page,
        items:
          table === "agents"
            ? page.items.map(safeAgent)
            : table === "runs"
              ? page.items.map(({ spec, before, artifact, ...row }) => ({
                  ...row,
                  title: spec?.title,
                }))
              : table === "tasks"
                ? page.items.map((t) => taskProjection(t, currentLocks))
                : page.items,
      };
    },
    get(table, id) {
      const r = get(table, id);
      return table === "agents"
        ? safeAgent(r)
        : table === "tasks"
          ? taskProjection(r)
          : r;
    },
    createProject(body) {
      return store.tx(() => {
        object(body);
        const paths = projectPaths(body.root, body.docsRoot);
        requireThat(
          !store
            .all("projects")
            .some((p) => lockKey(p.root) === lockKey(paths.root)),
          "PROJECT_EXISTS",
          "Project is already registered",
          409,
        );
        const team = get("teams", body.teamId ?? "team-default");
        const p = make("projects", {
          name: requiredString(body.name, "name", 128),
          ...paths,
          teamId: team.id,
          status: "AVAILABLE",
          archived: false,
        });
        queueDoc(p, "project", p.id, {
          id: p.id,
          name: p.name,
          createdAt: p.createdAt,
        });
        emit("project.created", p.id, p.id);
        return p;
      });
    },
    updateProject(id, body) {
      return store.tx(() => {
        const p = get("projects", id);
        expected(p, body.version);
        requireThat(
          !working().some((r) => r.projectId === id),
          "PROJECT_BUSY",
          "Stop active and uncertain runs before changing the project",
          409,
        );
        const paths =
          body.root || body.docsRoot
            ? projectPaths(body.root ?? p.root, body.docsRoot ?? p.docsRoot)
            : { root: p.root, docsRoot: p.docsRoot };
        requireThat(
          !store
            .all("projects")
            .some(
              (other) =>
                other.id !== id && lockKey(other.root) === lockKey(paths.root),
            ),
          "PROJECT_EXISTS",
          "Project is already registered",
          409,
        );
        if (body.teamId) get("teams", body.teamId);
        const next = put("projects", {
          ...p,
          ...paths,
          name: body.name ? requiredString(body.name, "name", 128) : p.name,
          teamId: body.teamId ?? p.teamId,
          archived: body.archived ?? p.archived,
        });
        emit("project.updated", id, id);
        return next;
      });
    },
    createRole(body) {
      return store.tx(() => {
        const r = make("roles", normalizeRole(body));
        emit("role.created", null, r.id);
        return r;
      });
    },
    updateRole(id, body) {
      return store.tx(() => {
        const r = get("roles", id);
        expected(r, body.version);
        requireThat(
          !working().some(
            (run) => store.get("agents", run.agentId)?.roleId === id,
          ),
          "ROLE_BUSY",
          "Role has active runs",
          409,
        );
        requireThat(
          !body.function ||
            body.function === r.function ||
            !store.all("agents").some((a) => !a.revoked && a.roleId === id),
          "ROLE_IN_USE",
          "Create a new role to change the function of existing identities",
          409,
        );
        const next = put("roles", {
          ...r,
          ...normalizeRole({ ...r, ...body }),
        });
        emit("role.updated", null, id);
        return next;
      });
    },
    createTeam(body) {
      return store.tx(() => {
        object(body);
        requireThat(
          Array.isArray(body.roleIds) && body.roleIds.length,
          "VALIDATION_ERROR",
          "Select roles",
        );
        for (const id of body.roleIds) get("roles", id);
        for (const id of body.projectIds ?? []) get("projects", id);
        requireThat(
          ["NONE", "INDEPENDENT"].includes(body.defaultReview ?? "NONE"),
          "VALIDATION_ERROR",
          "Invalid review policy",
        );
        const t = make("teams", {
          name: requiredString(body.name, "name", 128),
          roleIds: [...new Set(body.roleIds)],
          projectIds: [...new Set(body.projectIds ?? [])],
          maxConcurrent: integer(body.maxConcurrent, 4, 1, 100),
          defaultReview: body.defaultReview ?? "NONE",
        });
        emit("team.created", null, t.id);
        return t;
      });
    },
    updateTeam(id, body) {
      return store.tx(() => {
        const t = get("teams", id);
        expected(t, body.version);
        requireThat(
          !working().some((r) => store.get("agents", r.agentId)?.teamId === id),
          "TEAM_BUSY",
          "Team has active runs",
          409,
        );
        const merged = { ...t, ...body };
        for (const role of merged.roleIds) get("roles", role);
        for (const pid of merged.projectIds) get("projects", pid);
        requireThat(
          ["NONE", "INDEPENDENT"].includes(merged.defaultReview),
          "VALIDATION_ERROR",
          "Invalid review policy",
        );
        const next = put("teams", {
          ...t,
          name: requiredString(merged.name, "name"),
          roleIds: merged.roleIds,
          projectIds: merged.projectIds,
          maxConcurrent: integer(merged.maxConcurrent, 4, 1, 100),
          defaultReview: merged.defaultReview,
        });
        emit("team.updated", null, id);
        return next;
      });
    },
    createAgent(body) {
      return store.tx(() => {
        const role = get("roles", body.roleId),
          team = get("teams", body.teamId);
        requireThat(
          team.roleIds.includes(role.id),
          "ROLE_FORBIDDEN",
          "Role is not part of this team",
          403,
        );
        const credential = crypto.randomBytes(32).toString("base64url");
        const a = make("agents", {
          name: requiredString(body.name, "name", 128),
          roleId: role.id,
          teamId: team.id,
          credentialHash: sha(credential),
          revoked: false,
          status: "OFFLINE",
          capacity: integer(body.capacity, 1, 1, 20),
          lastSeen: null,
        });
        emit("agent.created", null, a.id);
        return { agent: safeAgent(a), credential };
      });
    },
    updateAgent(id, body) {
      return store.tx(() => {
        const a = get("agents", id);
        expected(a, body.version);
        requireThat(
          !working().some((r) => r.agentId === id),
          "AGENT_BUSY",
          "Stop active and uncertain executions first",
          409,
        );
        const role = get("roles", body.roleId ?? a.roleId),
          team = get("teams", body.teamId ?? a.teamId);
        requireThat(
          team.roleIds.includes(role.id),
          "ROLE_FORBIDDEN",
          "Role is not part of the team",
          403,
        );
        const next = put("agents", {
          ...a,
          name: body.name ? requiredString(body.name, "name", 128) : a.name,
          roleId: role.id,
          teamId: team.id,
          capacity: integer(body.capacity, a.capacity, 1, 20),
        });
        emit("agent.updated", null, id);
        return safeAgent(next);
      });
    },
    runStatus(id) {
      return runSummary(get("runs", id));
    },
    revokeAgent(id) {
      return store.tx(() => {
        const a = get("agents", id);
        put("agents", { ...a, revoked: true, status: "REVOKED" });
        for (const r of working().filter((r) => r.agentId === id))
          api.requestStop(r.id);
        emit("agent.revoked", null, id);
        return { revoked: true };
      });
    },
    authenticate(credential) {
      const hash = sha(credential ?? "");
      const a = store
        .all("agents")
        .find((a) => a.credentialHash === hash && !a.revoked);
      requireThat(a, "UNAUTHENTICATED", "Invalid agent credential", 401);
      return a;
    },
    connect(agentId) {
      return store.tx(() => {
        const { agent } = agentContext(agentId);
        const next = put("agents", {
          ...agent,
          status: "ONLINE",
          lastSeen: now(),
        });
        emit("agent.connected", null, agentId);
        return {
          agent: safeAgent(next),
          heartbeatMs: HEARTBEAT_MS,
          leaseMs: LEASE_MS,
        };
      });
    },
    createDraft(body) {
      return store.tx(() => {
        const p = project(body.projectId);
        const t = make("tasks", {
          projectId: p.id,
          kind: "REQUEST",
          parentId: null,
          title: requiredString(body.title, "title", 256),
          description: requiredString(body.description, "description"),
          acceptance:
            typeof body.acceptance === "string" ? body.acceptance : "",
          status: "DRAFT",
          priority: integer(body.priority, 2, 0, 9),
          planId: null,
          deps: [],
          files: [],
          checks: [],
        });
        queueDoc(p, "requests", t.id, t);
        emit("task.created", p.id, t.id);
        return t;
      });
    },
    claim(agentId, body = {}) {
      api.maintenance({ documents: false, drift: false });
      return store.tx(() => {
        const { agent: a, role, team } = agentContext(agentId);
        const activeRuns = working(),
          taskMaps = new Map(),
          projectCache = new Map();
        put("agents", { ...a, status: "ONLINE", lastSeen: now() });
        requireThat(
          activeRuns.filter((r) => r.agentId === a.id).length < a.capacity,
          "AGENT_CAPACITY",
          "Agent has no free capacity",
          409,
        );
        const teamCount = activeRuns.filter(
          (r) => store.get("agents", r.agentId)?.teamId === team.id,
        ).length;
        requireThat(
          teamCount < team.maxConcurrent,
          "TEAM_CAPACITY",
          "Team has no free capacity",
          409,
        );
        const stage = {
          ORCHESTRATOR: "PLANNING",
          WORKER: "EXECUTION",
          REVIEWER: "REVIEW",
        }[role.function];
        requireThat(
          !body.stage || body.stage === stage,
          "STAGE_FORBIDDEN",
          "Stage does not match this identity",
          403,
        );
        const candidates = store.all("tasks", {
          status:
            stage === "PLANNING"
              ? "DRAFT"
              : stage === "REVIEW"
                ? "REVIEWING"
                : "READY",
        });
        const waits = [];
        for (const task of orderedTasks(candidates)) {
          if (body.taskId && task.id !== body.taskId) continue;
          if (body.projectId && task.projectId !== body.projectId) continue;
          let p;
          try {
            p = projectCache.get(task.projectId) ?? project(task.projectId);
            projectCache.set(task.projectId, p);
          } catch {
            continue;
          }
          if (!allowed(a, team, p)) continue;
          if (stage === "PLANNING" && task.kind !== "REQUEST") continue;
          if (
            stage !== "PLANNING" &&
            (task.kind !== "WORK" || task.executorType !== "AGENT")
          )
            continue;
          if (activeRuns.some((r) => r.taskId === task.id)) continue;
          const plan = task.planId ? get("plans", task.planId) : null;
          if (stage === "PLANNING" && plan?.status === "SUBMITTED") continue;
          if (stage !== "PLANNING") {
            if (plan?.status !== "APPROVED" || plan.authorAgentId === a.id)
              continue;
            if (
              (stage === "REVIEW" ? task.reviewRoleId : task.roleId) !== role.id
            )
              continue;
            if (!taskMaps.has(p.id))
              taskMaps.set(
                p.id,
                new Map(
                  store.all("tasks", { projectId: p.id }).map((t) => [t.id, t]),
                ),
              );
            const map = taskMaps.get(p.id);
            if (!dependenciesReady(task, map)) {
              waits.push({ taskId: task.id, reason: "DEPENDENCIES" });
              continue;
            }
            if (stage === "REVIEW") {
              const prior = get("runs", task.latestRunId);
              if (prior.agentId === a.id) continue;
              const differences = validateReviewTarget(task);
              if (differences.length) {
                put("tasks", {
                  ...task,
                  status: "BLOCKED",
                  blockReason: "REVIEW_TARGET_CHANGED",
                  drift: differences,
                });
                emit("review.invalidated", p.id, task.id, {
                  changes: differences,
                });
                continue;
              }
            }
          }
          const files = stage === "EXECUTION" ? task.files : [];
          if (body.files) {
            const declared = normalizeScopes(body.files);
            requireThat(
              sha(declared) === sha(files),
              "SCOPE_MISMATCH",
              "Claim must declare the complete approved file scope",
              409,
            );
          }
          const result = createRun(p, task, plan, a.id, role, stage, files);
          if (result.blocked) {
            waits.push(result);
            continue;
          }
          return result;
        }
        return { run: null, waiting: waits.slice(0, 20), retryAfterMs: 1000 };
      });
    },
    heartbeat(agentId, runId, body) {
      return store.tx(() => {
        const { agent } = agentContext(agentId);
        put("agents", { ...agent, status: "ONLINE", lastSeen: now() });
        if (!runId) return { ok: true, heartbeatMs: HEARTBEAT_MS };
        const prior = get("runs", runId);
        requireThat(
          prior.agentId === agentId,
          "RUN_FORBIDDEN",
          "Run belongs to another identity",
          403,
        );
        requireThat(
          prior.generation === body.generation,
          "STALE_GENERATION",
          "Execution generation does not match",
          409,
        );
        if (["COMPLETED", "FAILED", "INTERRUPTED"].includes(prior.status))
          return { ok: false, finished: true, status: prior.status };
        const r = validRun(agentId, runId, body, { allowStopped: true });
        if (r.status !== "RUNNING")
          return { ok: false, stopRequired: true, status: r.status };
        requireThat(
          r.leaseUntil > now(),
          "LEASE_EXPIRED",
          "Stop writing; lease expired",
          409,
        );
        put("runs", { ...r, leaseUntil: now() + LEASE_MS });
        return { ok: true, leaseUntil: now() + LEASE_MS };
      });
    },
    runEvents(agentId, runId, body) {
      return store.tx(() => {
        validRun(agentId, runId, body);
        requireThat(
          Array.isArray(body.events) && body.events.length <= 100,
          "VALIDATION_ERROR",
          "events must contain at most 100 items",
        );
        const accepted = [];
        for (const event of body.events) {
          object(event);
          const eventId = requiredString(event.eventId, "eventId", 128);
          const prior = store.event(eventId);
          if (prior) {
            requireThat(
              prior.runId === runId,
              "IDEMPOTENCY_CONFLICT",
              "Event belongs to another run",
              409,
            );
            accepted.push(prior.seq);
            continue;
          }
          requireThat(
            ["progress", "log", "blocked", "usage"].includes(event.type),
            "VALIDATION_ERROR",
            "Unsupported agent event type",
          );
          const r = get("runs", runId);
          const data = {
            runId,
            agentId,
            type: event.type,
            message: requiredString(
              event.message ?? event.type,
              "message",
              16384,
            ),
          };
          if (event.type === "usage") {
            data.usage = api.normalizeUsage(event.usage);
            put("runs", { ...r, usage: data.usage });
          }
          const seq = store.emit({
            eventId,
            type: `run.${event.type}`,
            projectId: r.projectId,
            entityId: runId,
            data,
            createdAt: at(),
          });
          accepted.push(seq);
        }
        queueMicrotask(() => signals.emit("change"));
        return { persisted: true, accepted };
      });
    },
    normalizeUsage(input) {
      if (!input) return null;
      object(input);
      const usage = {};
      for (const key of ["inputTokens", "outputTokens", "cachedTokens"])
        if (input[key] !== undefined)
          usage[key] = integer(input[key], 0, 0, 1_000_000_000);
      return Object.keys(usage).length ? usage : null;
    },
    submitPlan(agentId, runId, body) {
      return store.tx(() => {
        const prior = get("runs", runId);
        const key = requiredString(body.idempotencyKey, "idempotencyKey", 128);
        if (
          prior.status === "COMPLETED" &&
          prior.agentId === agentId &&
          prior.submitKey === key &&
          prior.generation === body.generation
        )
          return {
            persisted: true,
            run: runSummary(prior),
            plan: planSummary(get("plans", prior.submittedPlanId)),
          };
        const run = validRun(agentId, runId, body);
        requireThat(
          run.stage === "PLANNING",
          "STAGE_FORBIDDEN",
          "Only planning runs submit plans",
          403,
        );
        const p = project(run.projectId),
          source = get("tasks", run.taskId),
          team = get("teams", p.teamId);
        const normalized = normalizePlan(body.plan, store.all("roles"), team);
        for (const node of normalized.nodes)
          if (node.executorType === "AGENT")
            permittedScopes(p, node.files, get("roles", node.roleId));
        const revision =
          store
            .all("plans", { parentId: source.id })
            .reduce((max, p) => Math.max(max, p.revision), 0) + 1;
        const plan = make("plans", {
          projectId: p.id,
          sourceTaskId: source.id,
          authorAgentId: agentId,
          status: "SUBMITTED",
          revision,
          ...normalized,
        });
        if (source.planId) {
          const old = get("plans", source.planId);
          if (old.status !== "APPROVED")
            put("plans", { ...old, status: "SUPERSEDED" });
        }
        put("tasks", {
          ...source,
          planId: plan.id,
          blockReason: null,
          status: "DRAFT",
        });
        const finished = put("runs", {
          ...run,
          status: "COMPLETED",
          endedAt: at(),
          submitKey: key,
          submittedPlanId: plan.id,
        });
        queueDoc(p, "plans", plan.id, plan);
        emit("plan.submitted", p.id, plan.id, { sourceTaskId: source.id });
        return {
          persisted: true,
          run: runSummary(finished),
          plan: planSummary(plan),
        };
      });
    },
    approvePlan(id, body) {
      return store.tx(() => {
        const plan = get("plans", id);
        expected(plan, body.version);
        requireThat(
          plan.status === "SUBMITTED",
          "PLAN_NOT_SUBMITTED",
          "Only submitted plans can be approved",
          409,
        );
        const source = get("tasks", plan.sourceTaskId),
          p = project(plan.projectId);
        requireThat(
          source.planId === plan.id,
          "PLAN_STALE",
          "This plan has been superseded",
          409,
        );
        normalizePlan(plan, store.all("roles"), get("teams", p.teamId));
        for (const node of plan.nodes)
          if (node.executorType === "AGENT")
            permittedScopes(p, node.files, get("roles", node.roleId));
        const oldTasks = store.all("tasks", { parentId: source.id });
        requireThat(
          !oldTasks.some((t) => working().some((r) => r.taskId === t.id)),
          "PLAN_BUSY",
          "Stop executions before revising a plan",
          409,
        );
        for (const old of oldTasks)
          if (old.status !== "DONE")
            put("tasks", { ...old, status: "CANCELLED" });
        for (const old of store
          .all("plans", { parentId: source.id })
          .filter((p) => p.status === "APPROVED"))
          put("plans", { ...old, status: "SUPERSEDED" });
        const ids = new Map(plan.nodes.map((n) => [n.key, uid("task")]));
        const tasks = plan.nodes.map((n) =>
          make("tasks", {
            ...n,
            id: ids.get(n.key),
            nodeKey: n.key,
            projectId: p.id,
            parentId: source.id,
            planId: plan.id,
            kind: "WORK",
            status: "READY",
            deps: n.deps.map((k) => ids.get(k)),
            resultHash: null,
            latestRunId: null,
            blockReason: null,
          }),
        );
        const roleSnapshots = Object.fromEntries(
          get("teams", p.teamId).roleIds.map((id) => [id, get("roles", id)]),
        );
        const approved = put("plans", {
          ...plan,
          status: "APPROVED",
          approvedAt: at(),
          approvedBy: "HUMAN",
          roleSnapshots,
        });
        put("tasks", { ...source, status: "READY", blockReason: null });
        queueDoc(p, "plans", id, approved);
        emit("plan.approved", p.id, id, { sourceTaskId: source.id });
        return { plan: approved, tasks };
      });
    },
    requestPlanRevision(id, body) {
      return store.tx(() => {
        const plan = get("plans", id);
        expected(plan, body.version);
        const source = get("tasks", plan.sourceTaskId);
        requireThat(
          source.planId === id && source.status !== "DONE",
          "PLAN_STALE",
          "Cannot revise a completed or superseded plan",
          409,
        );
        requireThat(
          !working().some((r) => r.planId === id || r.taskId === source.id),
          "PLAN_BUSY",
          "Stop active and uncertain executions first",
          409,
        );
        put("plans", {
          ...plan,
          status: "CHANGES_REQUESTED",
          revisionNote: requiredString(body.reason, "reason"),
        });
        for (const t of tasksOf(id))
          if (t.status !== "DONE") put("tasks", { ...t, status: "CANCELLED" });
        for (const a of store
          .all("acceptances", { parentId: source.id })
          .filter((a) => a.status === "PENDING"))
          put("acceptances", { ...a, status: "STALE" });
        const next = put("tasks", {
          ...source,
          status: "DRAFT",
          revisionNote: body.reason,
        });
        emit("plan.changes_requested", plan.projectId, id);
        return next;
      });
    },
    finishRun(agentId, runId, body) {
      return store.tx(() => {
        const prior = get("runs", runId),
          key = requiredString(body.idempotencyKey, "idempotencyKey", 128);
        if (
          ["COMPLETED", "FAILED", "INTERRUPTED"].includes(prior.status) &&
          prior.agentId === agentId &&
          prior.submitKey === key &&
          prior.generation === body.generation
        )
          return {
            persisted: true,
            run: runSummary(prior),
            task: get("tasks", prior.taskId),
          };
        const run = validRun(agentId, runId, body, {
          allowStopped: body.outcome !== "COMPLETED",
        });
        requireThat(
          ["EXECUTION", "HUMAN"].includes(run.stage),
          "STAGE_FORBIDDEN",
          "Use the planning or review endpoint",
          403,
        );
        requireThat(
          body.stopped === true,
          "STOP_CONFIRMATION_REQUIRED",
          "Confirm that all file writes have stopped",
          409,
        );
        requireThat(
          ["COMPLETED", "FAILED", "INTERRUPTED"].includes(body.outcome),
          "VALIDATION_ERROR",
          "Invalid outcome",
        );
        const p = project(run.projectId),
          task = get("tasks", run.taskId),
          summary = requiredString(body.summary, "summary");
        requireThat(
          canonical(p.docsRoot) === p.docsRoot,
          "PROJECT_DATA_MOVED",
          "Project data path changed during execution",
          409,
        );
        if (body.outcome === "COMPLETED")
          validateEvidence(task.checks, body.checks);
        const after = normalizeAfter(
          run.before,
          capture(p, run.files, {
            outputDir: path.join(run.artifactDir, "after"),
            includeContent: true,
          }),
        );
        const artifact = {
          schemaVersion: 1,
          runId,
          taskId: task.id,
          planId: run.planId,
          generation: run.generation,
          specHash: run.specHash,
          before: JSON.parse(
            fs.readFileSync(path.join(run.artifactDir, "before.json"), "utf8"),
          ),
          after,
          checks: body.checks ?? [],
          summary,
          createdAt: at(),
        };
        artifact.targetHash = sha(artifact);
        atomicJson(path.join(run.artifactDir, "receipt.json"), artifact);
        const seq = emit("run.completed", p.id, runId, {
          taskId: task.id,
          outcome: body.outcome,
        });
        const finished = put("runs", {
          ...run,
          status: body.outcome,
          endedAt: at(),
          submitKey: key,
          artifact: {
            ...artifact,
            before: fileMetadata(artifact.before),
            after: fileMetadata(artifact.after),
          },
          resultHash: artifact.targetHash,
          completedSeq: seq,
          usage: api.normalizeUsage(body.usage),
        });
        let status =
          body.outcome === "COMPLETED"
            ? run.stage === "HUMAN"
              ? "DONE"
              : task.reviewPolicy === "INDEPENDENT"
                ? "REVIEWING"
                : "VERIFIED"
            : "BLOCKED";
        if (run.status === "STOP_REQUESTED" || run.status === "QUARANTINED")
          status = "BLOCKED";
        const updated = put("tasks", {
          ...task,
          status,
          latestRunId: runId,
          resultHash: artifact.targetHash,
          blockReason: status === "BLOCKED" ? body.outcome : null,
          drift: null,
        });
        unlock(runId);
        invalidateTargets(p);
        if (run.planId) refreshSource(run.planId);
        emit("task.updated", p.id, task.id);
        queueDoc(p, "receipts", runId, {
          runId,
          targetHash: artifact.targetHash,
        });
        return { persisted: true, run: runSummary(finished), task: updated };
      });
    },
    submitReview(agentId, runId, body) {
      return store.tx(() => {
        const prior = get("runs", runId),
          key = requiredString(body.idempotencyKey, "idempotencyKey", 128);
        if (
          prior.status === "COMPLETED" &&
          prior.agentId === agentId &&
          prior.submitKey === key &&
          prior.generation === body.generation
        )
          return {
            persisted: true,
            run: runSummary(prior),
            task: get("tasks", prior.taskId),
          };
        const run = validRun(agentId, runId, body);
        requireThat(
          run.stage === "REVIEW",
          "STAGE_FORBIDDEN",
          "Only REVIEWER runs submit reviews",
          403,
        );
        const { role } = agentContext(agentId),
          task = get("tasks", run.taskId),
          plan = get("plans", run.planId),
          worker = get("runs", task.latestRunId);
        requireThat(
          role.function === "REVIEWER" &&
            worker.agentId !== agentId &&
            plan.authorAgentId !== agentId,
          "SELF_REVIEW",
          "Independent review identity required",
          403,
        );
        requireThat(
          body.targetHash === task.resultHash &&
            body.targetHash === run.spec.targetHash,
          "REVIEW_STALE",
          "Review hash does not match the candidate",
          409,
        );
        const drift = validateReviewTarget(task);
        requireThat(
          !drift.length,
          "REVIEW_STALE",
          "Files changed after execution",
          409,
          { changes: drift },
        );
        requireThat(
          ["PASS", "CHANGES_REQUESTED", "BLOCKED"].includes(body.verdict),
          "VALIDATION_ERROR",
          "Invalid verdict",
        );
        requiredString(body.summary, "summary");
        if (body.verdict === "PASS")
          validateEvidence(task.checks, worker.artifact.checks);
        const finished = put("runs", {
          ...run,
          status: "COMPLETED",
          endedAt: at(),
          submitKey: key,
          review: {
            verdict: body.verdict,
            targetHash: body.targetHash,
            summary: body.summary,
            findings: body.findings ?? [],
          },
          usage: api.normalizeUsage(body.usage),
        });
        const attempts = store
          .all("runs", { parentId: task.id })
          .filter((r) => r.stage === "EXECUTION").length;
        const status =
          body.verdict === "PASS"
            ? "VERIFIED"
            : body.verdict === "CHANGES_REQUESTED" && attempts < MAX_ATTEMPTS
              ? "READY"
              : "BLOCKED";
        const updated = put("tasks", {
          ...task,
          status,
          reviewRunId: runId,
          blockReason: status === "BLOCKED" ? "REVIEW_BLOCKED" : null,
        });
        queueDoc(project(task.projectId), "reviews", runId, finished.review);
        emit("review.submitted", task.projectId, task.id, {
          verdict: body.verdict,
        });
        refreshSource(plan.id);
        return { persisted: true, run: runSummary(finished), task: updated };
      });
    },
    requestStop(runId) {
      return store.tx(() => {
        const r = get("runs", runId);
        requireThat(active(r), "RUN_NOT_ACTIVE", "Run is not active", 409);
        const next = put("runs", {
          ...r,
          status: r.status === "QUARANTINED" ? r.status : "STOP_REQUESTED",
        });
        emit("run.stop_requested", r.projectId, r.id);
        return next;
      });
    },
    confirmStopped(runId, body) {
      return store.tx(() => {
        const r = get("runs", runId);
        requireThat(
          ["STOP_REQUESTED", "QUARANTINED"].includes(r.status) &&
            body.confirmStopped === true,
          "STOP_CONFIRMATION_REQUIRED",
          "Confirm the old execution has stopped",
          409,
        );
        const p = get("projects", r.projectId);
        if (fs.existsSync(p.root) && ["EXECUTION", "HUMAN"].includes(r.stage)) {
          const after = normalizeAfter(
            r.before,
            capture(p, r.files, {
              outputDir: path.join(r.artifactDir, "interrupted"),
              includeContent: true,
            }),
          );
          atomicJson(path.join(r.artifactDir, "interrupted.json"), {
            runId,
            before: r.before,
            after,
            reason: body.reason ?? "Stopped by human",
            at: at(),
          });
        }
        const next = put("runs", {
          ...r,
          status: "INTERRUPTED",
          endedAt: at(),
        });
        unlock(r.id);
        const task = get("tasks", r.taskId);
        put("tasks", {
          ...task,
          status: r.stage === "PLANNING" ? "DRAFT" : "BLOCKED",
          blockReason: "INTERRUPTED",
        });
        emit("run.interrupted", r.projectId, r.id);
        return next;
      });
    },
    acknowledgeStop(agentId, runId, body) {
      const r = validRun(agentId, runId, body, { allowStopped: true });
      requireThat(
        r.status !== "RUNNING",
        "STOP_NOT_REQUESTED",
        "Request stop first",
        409,
      );
      return api.confirmStopped(runId, {
        confirmStopped: body.stopped,
        reason: "Agent confirmed stopped",
      });
    },
    retryTask(taskId, body) {
      return store.tx(() => {
        const task = get("tasks", taskId);
        expected(task, body.version);
        requireThat(
          task.kind === "WORK" && task.status === "BLOCKED",
          "TASK_NOT_BLOCKED",
          "Only blocked execution tasks can be retried",
          409,
        );
        requireThat(
          !working().some((r) => r.taskId === task.id),
          "TASK_BUSY",
          "Confirm old execution is stopped",
          409,
        );
        const plan = get("plans", task.planId);
        requireThat(
          plan.status === "APPROVED",
          "PLAN_NOT_APPROVED",
          "Plan needs approval",
          409,
        );
        const next = put("tasks", {
          ...task,
          status: "READY",
          blockReason: null,
          drift: null,
        });
        const source = get("tasks", task.parentId);
        put("tasks", { ...source, status: "RUNNING", blockReason: null });
        emit("task.requeued", task.projectId, task.id);
        return next;
      });
    },
    startHuman(taskId, body) {
      return store.tx(() => {
        const task = get("tasks", taskId);
        expected(task, body.version);
        requireThat(
          task.executorType === "HUMAN" && task.status === "READY",
          "TASK_NOT_READY",
          "Human task is not ready",
          409,
        );
        const plan = get("plans", task.planId);
        requireThat(
          plan.status === "APPROVED",
          "PLAN_NOT_APPROVED",
          "Plan needs approval",
          409,
        );
        const map = new Map(
          store
            .all("tasks", { projectId: task.projectId })
            .map((t) => [t.id, t]),
        );
        requireThat(
          dependenciesReady(task, map),
          "DEPENDENCIES",
          "Complete dependencies first",
          409,
        );
        const r = createRun(
          project(task.projectId),
          task,
          plan,
          null,
          null,
          "HUMAN",
          task.files,
        );
        requireThat(!r.blocked, "FILE_LOCKED", "Files are occupied", 409, {
          locks: r.locks,
        });
        return r;
      });
    },
    finishHuman(taskId, body) {
      const task = get("tasks", taskId),
        run = working().find(
          (r) => r.taskId === task.id && r.stage === "HUMAN",
        );
      requireThat(run, "RUN_NOT_ACTIVE", "Start the human task first", 409);
      return api.finishRun(null, run.id, {
        ...body,
        generation: run.generation,
        outcome: "COMPLETED",
        stopped: true,
        idempotencyKey: body.idempotencyKey ?? `human-${run.id}`,
      });
    },
    heartbeatHuman(taskId) {
      return store.tx(() => {
        const run = working().find(
          (r) => r.taskId === taskId && r.stage === "HUMAN",
        );
        requireThat(
          run?.status === "RUNNING" && run.leaseUntil > now(),
          "LEASE_EXPIRED",
          "Confirm the old human execution has stopped",
          409,
        );
        put("runs", { ...run, leaseUntil: now() + LEASE_MS });
        return { ok: true };
      });
    },
    accept(id, body) {
      return store.tx(() => {
        const a = get("acceptances", id);
        expected(a, body.version);
        requireThat(
          a.status === "PENDING" && body.targetHash === a.targetHash,
          "APPROVAL_STALE",
          "Acceptance target changed",
          409,
        );
        const plan = get("plans", a.planId),
          source = get("tasks", a.sourceTaskId),
          p = project(a.projectId);
        requireThat(
          plan.status === "APPROVED" &&
            source.planId === plan.id &&
            tasksOf(plan.id).every((t) =>
              ["VERIFIED", "DONE"].includes(t.status),
            ),
          "PLAN_INCOMPLETE",
          "Plan has incomplete tasks",
          409,
        );
        const scopes = locksFor(Object.keys(a.files), p),
          occupied = conflicts(scopes);
        requireThat(
          !occupied.length,
          "FILE_LOCKED",
          "Wait for active writers before accepting",
          409,
          { locks: occupied },
        );
        // BEGIN IMMEDIATE and the single backend writer reserve the validation
        // window against cooperative claims; unrelated editors remain detectable.
        for (const task of tasksOf(plan.id))
          if (task.latestRunId) api.artifact(task.latestRunId);
        const changes = currentDifferences(p, a.files, a.scopes);
        requireThat(
          !changes.length,
          "APPROVAL_STALE",
          "Files changed; revalidate the affected tasks",
          409,
          { changes },
        );
        requireThat(
          manifestFor(plan.id).targetHash === a.targetHash,
          "APPROVAL_STALE",
          "Plan results changed",
          409,
        );
        const next = put("acceptances", {
          ...a,
          status: "APPROVED",
          acceptedBy: "HUMAN",
          acceptedAt: at(),
        });
        for (const t of tasksOf(plan.id))
          if (t.status === "VERIFIED") put("tasks", { ...t, status: "DONE" });
        put("tasks", { ...source, status: "DONE" });
        queueDoc(p, "acceptances", id, next);
        emit("plan.accepted", p.id, plan.id);
        return next;
      });
    },
    revalidateAcceptance(id) {
      return store.tx(() => {
        const a = get("acceptances", id);
        requireThat(
          ["PENDING", "STALE"].includes(a.status),
          "APPROVAL_FINAL",
          "Acceptance already completed",
          409,
        );
        const p = project(a.projectId),
          changes = currentDifferences(p, a.files, a.scopes);
        const candidates = tasksOf(a.planId)
          .filter((t) => t.status === "VERIFIED")
          .sort(
            (x, y) =>
              (store.get("runs", y.latestRunId)?.completedSeq ?? 0) -
              (store.get("runs", x.latestRunId)?.completedSeq ?? 0),
          );
        const affected = new Set(
          changes.map(
            (c) =>
              a.owners?.[c.path] ??
              candidates.find((t) =>
                t.files.some((scope) => scopeContains(scope, c.path)),
              )?.id,
          ),
        );
        for (const t of tasksOf(a.planId).filter(
          (t) => t.status === "VERIFIED",
        )) {
          if (affected.has(t.id))
            put("tasks", {
              ...t,
              status: "BLOCKED",
              blockReason: "FINAL_TARGET_CHANGED",
              drift: changes,
            });
        }
        put("acceptances", { ...a, status: "STALE", drift: changes });
        const source = get("tasks", a.sourceTaskId);
        put("tasks", {
          ...source,
          status: changes.length ? "BLOCKED" : "RUNNING",
          blockReason: changes.length ? "FINAL_TARGET_CHANGED" : null,
        });
        if (!changes.length) refreshSource(a.planId);
        emit("acceptance.revalidation", a.projectId, id, { changes });
        return { changes };
      });
    },
    artifact(runId) {
      const r = get("runs", runId);
      if (!r.artifact) return { spec: r.spec, review: r.review ?? null };
      const p = get("projects", r.projectId),
        file = path.join(p.docsRoot, "runs", r.id, "receipt.json");
      requireThat(
        canonical(file) === file && fs.existsSync(file),
        "ARTIFACT_UNAVAILABLE",
        "The frozen receipt is missing or its path changed",
        409,
      );
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      const { targetHash, ...content } = receipt;
      requireThat(
        targetHash === r.resultHash && sha(content) === targetHash,
        "ARTIFACT_MODIFIED",
        "The frozen receipt was modified",
        409,
      );
      return receipt;
    },
    flushDocuments() {
      for (const job of store
        .all("materializations")
        .filter((j) => j.status !== "DONE" && j.attempts < 10)
        .slice(0, 50)) {
        try {
          const p = get("projects", job.projectId);
          requireThat(
            fs.existsSync(p.root),
            "PROJECT_UNAVAILABLE",
            "Project root unavailable",
          );
          writeDocument(
            p,
            job.target,
            JSON.stringify(
              job.kind === "receipts"
                ? api.artifact(job.payload.runId)
                : job.payload,
              null,
              2,
            ) + "\n",
          );
          put("materializations", {
            ...job,
            status: "DONE",
            attempts: job.attempts + 1,
            error: null,
          });
        } catch (e) {
          put("materializations", {
            ...job,
            status: "FAILED",
            attempts: job.attempts + 1,
            error: e.message,
          });
        }
        emit("materialization.updated", job.projectId, job.id);
      }
    },
    retryDocuments(projectId) {
      for (const job of store
        .all("materializations", { projectId })
        .filter((j) => j.status === "FAILED"))
        put("materializations", {
          ...job,
          status: "PENDING",
          attempts: 0,
          error: null,
        });
      api.flushDocuments();
      return { ok: true };
    },
    maintenance({ documents = true, drift = true } = {}) {
      store.tx(() => {
        for (const r of store
          .all("runs", { status: "RUNNING" })
          .filter((r) => r.leaseUntil <= now())) {
          put("runs", { ...r, status: "QUARANTINED" });
          for (const l of store.all("locks").filter((l) => l.runId === r.id))
            put("locks", { ...l, status: "QUARANTINED" });
          const t = get("tasks", r.taskId);
          put("tasks", {
            ...t,
            status: "BLOCKED",
            blockReason: "LEASE_EXPIRED",
          });
          emit("run.quarantined", r.projectId, r.id);
        }
        if (drift)
          for (const p of store
            .all("projects")
            .filter((p) => !p.archived && fs.existsSync(p.root)))
            invalidateTargets(p);
      });
      if (documents) api.flushDocuments();
    },
    overview(projectId) {
      const filter = projectId ? { projectId } : {};
      const counts = {};
      for (const r of store.db
        .prepare(
          `SELECT status,count(*) AS n FROM tasks${projectId ? " WHERE project_id=?" : ""} GROUP BY status`,
        )
        .all(...(projectId ? [projectId] : [])))
        counts[r.status] = Number(r.n);
      const runs = store.all("runs", filter);
      return {
        counts,
        projects: store
          .all("projects")
          .map((p) => ({ ...p, available: fs.existsSync(p.root) })),
        agents: store.all("agents").map((a) => ({
          ...safeAgent(a),
          online:
            !a.revoked && a.lastSeen !== null && now() - a.lastSeen < LEASE_MS,
        })),
        activeRuns: runs.filter(active).length,
        locks: store.list("locks", { ...filter, limit: 100 }).items,
        usage: {
          inputTokens: runs.some((r) => r.usage)
            ? runs.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0)
            : null,
          outputTokens: runs.some((r) => r.usage)
            ? runs.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0)
            : null,
        },
        latestSeq: store.latestSeq(),
      };
    },
    inbox(projectId) {
      const filter = projectId ? { projectId } : {};
      const byId = new Map(store.all("tasks", filter).map((t) => [t.id, t]));
      return {
        plans: store.all("plans", { ...filter, status: "SUBMITTED" }),
        humanTasks: [...byId.values()].filter(
          (t) =>
            t.executorType === "HUMAN" &&
            ["READY", "RUNNING"].includes(t.status) &&
            dependenciesReady(t, byId),
        ),
        acceptances: store
          .all("acceptances", filter)
          .filter((a) => ["PENDING", "STALE"].includes(a.status)),
        runs: working().filter(
          (r) =>
            (!projectId || r.projectId === projectId) && r.status !== "RUNNING",
        ),
        blockedTasks: [...byId.values()].filter(
          (t) => t.kind === "WORK" && t.status === "BLOCKED",
        ),
        materializations: store.all("materializations", {
          ...filter,
          status: "FAILED",
        }),
      };
    },
    close() {
      store.close();
      signals.removeAllListeners();
    },
  };
  return api;
}
