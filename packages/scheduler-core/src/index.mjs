// @atk/scheduler-core — pure scheduling algorithms for M3.
//
// Contract: docs/architecture/m3-contracts.md §1 and §0 invariants (ADR-003).
// This module is deliberately pure: no imports, no clock, no network, no file
// system, no process state. `now` is always injected so the same snapshot and
// policy always produce byte-identical plans (spec §8.2).
//
// Hard rules encoded here:
//   1. A task whose dependencies are incomplete is never a candidate.
//   2. A cyclic DAG is rejected as a whole: proposals = [] and every task is
//      reported with reason "cycle" (never "skip the broken part and continue").
//   3. Output order is a fixed weight + stable sort, independent of input order.
//   4. Skipped reasons are machine-readable enum values, never free text.

/** Machine-readable skip reasons (m3-contracts §1). Never add free text here. */
export const SKIP_REASONS = Object.freeze({
  CYCLE: "cycle",
  DEPS_INCOMPLETE: "deps-incomplete",
  NO_IDLE_AGENT: "no-idle-agent",
  CAPABILITY_MISMATCH: "capability-mismatch",
  WRITE_SCOPE_CONFLICT: "write-scope-conflict",
  CAPACITY: "capacity",
});

/** Allowed values of `skipped[].reason`; tests assert membership of this set. */
export const SKIP_REASON_VALUES = Object.freeze(Object.values(SKIP_REASONS));

/** First-version fixed weight (m3-contracts §1): score = priority * W - waitingMs. */
export const PRIORITY_WEIGHT = 1_000_000_000_000;

/** Default workspace policy carried by a proposal when none is configured. */
export const DEFAULT_WORKSPACE_POLICY = Object.freeze({ kind: "none" });

/** Run statuses that still occupy capacity / a write scope. */
export const ACTIVE_RUN_STATUSES = Object.freeze(["QUEUED", "STARTING", "RUNNING"]);

/** Run statuses that no longer count as active. */
export const TERMINAL_RUN_STATUSES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]);

/** Task statuses eligible for scheduling. */
export const READY_TASK_STATUS = "READY";

/** Task status considered finished for dependency purposes. */
export const DONE_TASK_STATUS = "DONE";

/** Fallback priority when a task omits `priority` (NORMAL in contracts). */
export const DEFAULT_TASK_PRIORITY = 2;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function compareIds(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Normalise a declared file/scope path for conflict comparison (pure). */
export function normalizePath(value) {
  if (typeof value !== "string") return "";
  const posix = value.replace(/\\/g, "/").trim();
  if (posix === "") return "";
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(posix);
  const prefix = drive ? `${drive[1]}/` : posix.startsWith("/") ? "/" : "";
  let rest = posix;
  if (drive) rest = posix.slice(drive[0].length);
  else if (prefix === "/") rest = posix.slice(1);
  const segments = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length && segments.at(-1) !== "..") segments.pop();
      else segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return prefix || "";
  return `${prefix}${segments.join("/")}`;
}

/** True when two normalised paths name the same file or a directory scope contains it. */
export function pathsOverlap(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Normalised, de-duplicated, sorted write-scope entries of a task/run. */
function writeScopeOf(record) {
  const seen = new Set();
  for (const entry of asArray(record?.files)) {
    if (typeof entry !== "string") continue;
    const normalised = normalizePath(entry);
    if (normalised) seen.add(normalised);
  }
  return [...seen].sort(compareIds);
}

function taskDeps(task) {
  const seen = new Set();
  for (const dep of asArray(task?.deps)) {
    if (typeof dep === "string" && dep !== "") seen.add(dep);
  }
  return [...seen].sort(compareIds);
}

function buildTaskIndex(tasks) {
  const index = new Map();
  for (const task of asArray(tasks)) {
    if (!isPlainObject(task) || !isNonEmptyString(task.id)) continue;
    // A duplicate id is ambiguous input; the first occurrence in id order wins
    // so the result does not depend on the caller's array order.
    if (!index.has(task.id)) index.set(task.id, task);
  }
  return new Map([...index.entries()].sort(([a], [b]) => compareIds(a, b)));
}

/**
 * Find every cycle in the dependency graph.
 *
 * - a self-dependency (`A -> A`) is a cycle of length one: `["A"]`;
 * - a dependency on a task that is not in the snapshot is NOT a cycle (it is a
 *   readiness problem reported by `readyCandidates` / `planDispatch`).
 *
 * Each cycle is returned once, rotated so the lexicographically smallest id is
 * first, and cycles are sorted, so the result is deterministic.
 *
 * @param {Array<{id: string, deps?: string[]}>} tasks
 * @returns {{ok: boolean, cycles: string[][]}}
 */
export function detectCycles(tasks) {
  const index = buildTaskIndex(tasks);
  const ids = [...index.keys()];
  const edges = new Map(ids.map((id) => [id, taskDeps(index.get(id)).filter((dep) => index.has(dep))]));

  const state = new Map(); // 0 = unvisited, 1 = in current stack, 2 = done
  const stack = [];
  const found = new Map();

  const canonical = (cycle) => {
    let best = 0;
    for (let i = 1; i < cycle.length; i += 1) {
      if (compareIds(cycle[i], cycle[best]) < 0) best = i;
    }
    return [...cycle.slice(best), ...cycle.slice(0, best)];
  };

  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) {
        const start = stack.indexOf(next);
        const cycle = canonical(stack.slice(start));
        found.set(cycle.join("\u0000"), cycle);
      } else if (nextState === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) visit(id);
  }

  const cycles = [...found.values()].sort((a, b) => compareIds(a.join("\u0000"), b.join("\u0000")));
  return { ok: cycles.length === 0, cycles };
}

/**
 * Deterministic levelised topological order.
 *
 * Missing dependencies are treated as external prerequisites and ignored for
 * ordering (readiness is reported separately); cycles make the whole order fail.
 * `order` is the flattening of `levels`; every task's known deps appear earlier.
 *
 * @param {Array<{id: string, deps?: string[]}>} tasks
 * @returns {{ok: true, order: string[], levels: string[][]} | {ok: false, cycles: string[][]}}
 */
export function topologicalOrder(tasks) {
  const cycleResult = detectCycles(tasks);
  if (!cycleResult.ok) return { ok: false, cycles: cycleResult.cycles };

  const index = buildTaskIndex(tasks);
  const ids = [...index.keys()];
  const deps = new Map(ids.map((id) => [id, taskDeps(index.get(id)).filter((dep) => index.has(dep))]));

  const remaining = new Set(ids);
  const levels = [];
  while (remaining.size > 0) {
    const layer = ids
      .filter((id) => remaining.has(id) && deps.get(id).every((dep) => !remaining.has(dep)))
      .sort(compareIds);
    // detectCycles already proved acyclic, so a layer must exist.
    if (layer.length === 0) return { ok: false, cycles: cycleResult.cycles };
    levels.push(layer);
    for (const id of layer) remaining.delete(id);
  }
  return { ok: true, order: levels.flat(), levels };
}

/**
 * READY tasks whose dependencies are all DONE and present.
 *
 * A dependency that does not exist in the snapshot is treated as incomplete and
 * reported in `missingDeps` instead of silently disappearing.
 *
 * @param {{tasks?: Array}} input
 * @returns {{candidates: object[], missingDeps: Array<{taskId: string, depId: string}>}}
 */
export function readyCandidates({ tasks } = {}) {
  const index = buildTaskIndex(tasks);
  const candidates = [];
  const missing = new Map();
  for (const [taskId, task] of index) {
    if (task.status !== READY_TASK_STATUS) continue;
    let ready = true;
    for (const depId of taskDeps(task)) {
      const dep = index.get(depId);
      if (!dep) {
        missing.set(`${taskId}\u0000${depId}`, { taskId, depId });
        ready = false;
        continue;
      }
      if (dep.status !== DONE_TASK_STATUS) ready = false;
    }
    if (ready) candidates.push(task);
  }
  const missingDeps = [...missing.values()].sort(
    (a, b) => compareIds(a.taskId, b.taskId) || compareIds(a.depId, b.depId),
  );
  return { candidates, missingDeps };
}

function toEpochMs(now) {
  let ms;
  if (now instanceof Date) ms = now.getTime();
  else if (typeof now === "number") ms = now;
  else if (typeof now === "string") ms = Date.parse(now);
  else ms = Number.NaN;
  if (!Number.isFinite(ms)) throw new TypeError("scheduler-core: now must be a valid Date, epoch ms or ISO-8601 string");
  return ms;
}

/**
 * Stable scheduling order with the first-version fixed weights:
 *
 *   priority ascending (smaller = more urgent)
 *   → waiting time descending (older tasks first)
 *   → taskId lexicographic ascending
 *
 * `score = priority * PRIORITY_WEIGHT - waitingMs`, so the same ordering can be
 * recomputed by consumers without re-implementing it. Waiting time is clamped at
 * zero for missing/invalid `createdAt`, and `now` must be injected.
 *
 * @param {Array<{id: string, priority?: number, createdAt?: string}>} tasks
 * @param {{now: Date|number|string}} options
 * @returns {Array<{taskId: string, priority: number, waitingMs: number, score: number}>}
 */
export function scoreAndSort(tasks, { now } = {}) {
  const nowMs = toEpochMs(now);
  const rows = [];
  for (const task of asArray(tasks)) {
    if (!isPlainObject(task) || !isNonEmptyString(task.id)) continue;
    const priority = Number.isInteger(task.priority) ? task.priority : DEFAULT_TASK_PRIORITY;
    const createdMs = typeof task.createdAt === "string" ? Date.parse(task.createdAt) : Number.NaN;
    const waitingMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0;
    rows.push({ taskId: task.id, priority, waitingMs, score: priority * PRIORITY_WEIGHT - waitingMs });
  }
  rows.sort((a, b) => a.score - b.score || compareIds(a.taskId, b.taskId));
  return rows;
}

/**
 * Map a file path to its ownership rule using the longest matching prefix.
 *
 * The rules shape is supplied by the caller (`{rules: [{prefix, role}]}`) so this
 * package never imports `lib/**` (M3 contract §1). Tie-breaks are deterministic:
 * longer prefix first, then prefix lexicographic, then role lexicographic.
 *
 * @param {{rules?: Array<{prefix?: string, role?: string}>} | null} ownership
 * @param {string} filePath
 * @returns {{role: string, prefix: string} | null}
 */
export function resolveOwner(ownership, filePath) {
  const file = normalizePath(filePath);
  if (!file) return null;
  const rules = asArray(ownership?.rules)
    .filter((rule) => isPlainObject(rule) && isNonEmptyString(rule.prefix) && isNonEmptyString(rule.role))
    .map((rule) => ({ role: rule.role, prefix: normalizePath(rule.prefix) }))
    .filter((rule) => rule.prefix !== "")
    .sort((a, b) => b.prefix.length - a.prefix.length || compareIds(a.prefix, b.prefix) || compareIds(a.role, b.role));
  for (const rule of rules) {
    if (pathsOverlap(file, rule.prefix)) return rule;
  }
  return null;
}

/**
 * Declared write scopes conflict.
 *
 * Baseline (no ownership): a candidate file conflicts with an active run when
 * the paths name the same file/directory scope (same rule as the backend claim
 * check, plus path normalisation).
 *
 * When `ownership` is supplied, two files that resolve to the same longest
 * ownership prefix also conflict: that ownership region is treated as one write
 * domain, which is the conservative reading of "写域冲突（最长前缀规则）".
 * Being stricter than the backend is safe (the backend re-checks and would
 * simply allow a claim the scheduler did not propose).
 *
 * @param {{task?: object, activeRuns?: object[], ownership?: object|null}} input
 * @returns {{ok: boolean, reasons: Array<{kind: string, detail: string}>}}
 */
export function detectConflicts({ task, activeRuns, ownership } = {}) {
  const candidateFiles = writeScopeOf(task);
  if (candidateFiles.length === 0) return { ok: true, reasons: [] };
  const reasons = [];
  const runs = asArray(activeRuns)
    .filter((run) => isPlainObject(run) && !TERMINAL_RUN_STATUSES.includes(run.status))
    .map((run) => ({ id: isNonEmptyString(run.id) ? run.id : "(unknown-run)", files: writeScopeOf(run) }))
    .filter((run) => run.files.length > 0)
    .sort((a, b) => compareIds(a.id, b.id));

  for (const run of runs) {
    for (const candidateFile of candidateFiles) {
      for (const runFile of run.files) {
        const owner = resolveOwner(ownership, candidateFile);
        const runOwner = resolveOwner(ownership, runFile);
        const pathOverlap = pathsOverlap(candidateFile, runFile);
        const sameRegion = Boolean(owner && runOwner && owner.prefix === runOwner.prefix);
        if (!pathOverlap && !sameRegion) continue;
        const reason = pathOverlap ? "path-overlap" : "ownership-region";
        reasons.push({
          kind: SKIP_REASONS.WRITE_SCOPE_CONFLICT,
          detail: `task file "${candidateFile}" conflicts with active run ${run.id} file "${runFile}" (${reason}${owner ? `, ownership ${owner.role}:${owner.prefix}` : ""})`,
        });
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

const AGENT_EXCLUSION = Object.freeze({
  NOT_IDLE: "not-idle",
  ROLE_MISMATCH: "role-mismatch",
  FUNCTION_MISSING: "function-missing",
});

/** Agent exclusion reasons (machine-readable). */
export const AGENT_EXCLUSION_VALUES = Object.freeze(Object.values(AGENT_EXCLUSION));

/**
 * Agents that can execute a task: `status === "IDLE"`, the exact role and the
 * required Function present in `agent.capabilities`.
 *
 * Returns the candidates plus a per-agent exclusion reason so the planner can
 * distinguish "no idle agent" from "idle agents, wrong capability".
 *
 * @param {{task?: object, agents?: object[], policies?: object}} input
 * @returns {{candidates: object[], excluded: Array<{agentId: string, reason: string}>}}
 */
export function matchAgents({ task, agents, policies } = {}) {
  void policies;
  const excluded = [];
  const candidates = [];
  const sorted = asArray(agents)
    .filter((agent) => isPlainObject(agent) && isNonEmptyString(agent.id))
    .slice()
    .sort((a, b) => compareIds(a.id, b.id));
  for (const agent of sorted) {
    if (agent.status !== "IDLE") {
      excluded.push({ agentId: agent.id, reason: AGENT_EXCLUSION.NOT_IDLE });
      continue;
    }
    if (agent.role !== task?.roleRequired) {
      excluded.push({ agentId: agent.id, reason: AGENT_EXCLUSION.ROLE_MISMATCH });
      continue;
    }
    if (!asArray(agent.capabilities).includes(task?.functionRequired)) {
      excluded.push({ agentId: agent.id, reason: AGENT_EXCLUSION.FUNCTION_MISSING });
      continue;
    }
    candidates.push(agent);
  }
  return { candidates, excluded };
}

function positiveIntegerOrInfinity(value, label) {
  if (value === undefined || value === null || value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`scheduler-core: ${label} must be a positive integer when provided`);
  }
  return value;
}

function cloneWorkspacePolicy(value, label) {
  if (value === undefined || value === null) return { ...DEFAULT_WORKSPACE_POLICY };
  if (!isPlainObject(value)) throw new TypeError(`scheduler-core: ${label} must be an object`);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Deterministic dispatch plan.
 *
 * The plan is a pure function of `{snapshot, policies, now}`:
 *   1. any cycle rejects the whole plan (`proposals: []`, every task `cycle`);
 *   2. READY tasks with all dependencies DONE are ordered by priority/age/id;
 *   3. matching agents, capacity and write-scope conflicts are checked in that
 *      fixed order; each rejected task gets a machine-readable skip reason;
 *   4. accepted tasks become proposals and immediately consume capacity and
 *      write scope, so one plan never proposes two conflicting tasks.
 *
 * @param {{snapshot?: object, policies?: object, now?: Date|number|string}} input
 * @returns {{proposals: object[], skipped: Array<{taskId: string, reason: string}>}}
 */
export function planDispatch({ snapshot, policies = {}, now } = {}) {
  if (!isPlainObject(snapshot)) throw new TypeError("scheduler-core: snapshot must be an object");
  if (!isPlainObject(policies)) throw new TypeError("scheduler-core: policies must be an object");
  // Validate the injected clock even on the empty snapshot: no hidden Date.now().
  toEpochMs(now);

  const allTasks = asArray(snapshot.tasks).filter((task) => isPlainObject(task) && isNonEmptyString(task.id));
  const tasksIndex = buildTaskIndex(allTasks);
  const tasks = [...tasksIndex.values()];
  const agents = asArray(snapshot.agents)
    .filter((agent) => isPlainObject(agent) && isNonEmptyString(agent.id))
    .slice()
    .sort((a, b) => compareIds(a.id, b.id));
  const runs = asArray(snapshot.runs).filter((run) => isPlainObject(run) && isNonEmptyString(run.id));
  const projectPolicies = new Map(
    asArray(snapshot.projects)
      .filter((project) => isPlainObject(project) && isNonEmptyString(project.id))
      .map((project) => [project.id, isPlainObject(project.policy) ? project.policy : {}]),
  );
  const ownership = isPlainObject(snapshot.ownership) ? snapshot.ownership : isPlainObject(policies.ownership) ? policies.ownership : null;

  const cycles = detectCycles(tasks).cycles;
  if (cycles.length > 0) {
    return {
      proposals: [],
      skipped: tasks.map((task) => ({ taskId: task.id, reason: SKIP_REASONS.CYCLE })).sort((a, b) => compareIds(a.taskId, b.taskId)),
    };
  }

  const activeRuns = runs.filter((run) => !TERMINAL_RUN_STATUSES.includes(run.status));
  const activeProjectCounts = new Map();
  const activeAgentCounts = new Map();
  for (const run of activeRuns) {
    const runTask = tasksIndex.get(run.taskId);
    if (runTask) {
      const projectId = runTask.projectId;
      activeProjectCounts.set(projectId, (activeProjectCounts.get(projectId) ?? 0) + 1);
    }
    if (isNonEmptyString(run.agentId)) activeAgentCounts.set(run.agentId, (activeAgentCounts.get(run.agentId) ?? 0) + 1);
  }

  const globalMaxProject = positiveIntegerOrInfinity(policies.maxConcurrentPerProject, "maxConcurrentPerProject");
  const globalMaxAgent = positiveIntegerOrInfinity(policies.maxPerAgent, "maxPerAgent");
  const policyProjectId = isNonEmptyString(policies.projectId) ? policies.projectId : null;

  // Every READY task in scope is examined, including the ones that are not yet
  // dispatchable: a task blocked by an unfinished/missing dependency must show
  // up as skipped(deps-incomplete), not vanish from the plan silently.
  const readyScoped = tasks.filter(
    (task) => task.status === READY_TASK_STATUS && (!policyProjectId || task.projectId === policyProjectId),
  );
  const tasksById = tasksIndex;
  const scored = scoreAndSort(readyScoped, { now });
  const proposals = [];
  const skipped = [];
  const proposedScopes = [];

  const dependenciesSatisfied = (task) =>
    taskDeps(task).every((depId) => {
      const dep = tasksById.get(depId);
      return Boolean(dep) && dep.status === DONE_TASK_STATUS;
    });

  for (const row of scored) {
    const task = tasksById.get(row.taskId);
    if (!dependenciesSatisfied(task)) {
      skipped.push({ taskId: task.id, reason: SKIP_REASONS.DEPS_INCOMPLETE });
      continue;
    }
    const projectId = task.projectId;
    const projectPolicy = projectPolicies.get(projectId) ?? {};
    const maxProject = positiveIntegerOrInfinity(
      projectPolicy.maxConcurrentPerProject ?? globalMaxProject,
      `projects.${projectId}.maxConcurrentPerProject`,
    );
    const maxAgent = positiveIntegerOrInfinity(
      projectPolicy.maxPerAgent ?? globalMaxAgent,
      `projects.${projectId}.maxPerAgent`,
    );

    // A READY task must not already have an active Run; if the snapshot says it
    // does, the data is inconsistent and the backend will fence the claim. Skip
    // it without inventing a reason that is not in the contract enum.
    if (activeRuns.some((run) => run.taskId === task.id)) continue;

    if ((activeProjectCounts.get(projectId) ?? 0) >= maxProject) {
      skipped.push({ taskId: task.id, reason: SKIP_REASONS.CAPACITY });
      continue;
    }

    const match = matchAgents({ task, agents });
    if (match.candidates.length === 0) {
      const hasIdleAgent = agents.some((agent) => agent.status === "IDLE");
      skipped.push({
        taskId: task.id,
        reason: hasIdleAgent ? SKIP_REASONS.CAPABILITY_MISMATCH : SKIP_REASONS.NO_IDLE_AGENT,
      });
      continue;
    }
    const eligibleAgents = match.candidates.filter((agent) => (activeAgentCounts.get(agent.id) ?? 0) < maxAgent);
    if (eligibleAgents.length === 0) {
      skipped.push({ taskId: task.id, reason: SKIP_REASONS.CAPACITY });
      continue;
    }
    eligibleAgents.sort((a, b) => {
      const load = (activeAgentCounts.get(a.id) ?? 0) - (activeAgentCounts.get(b.id) ?? 0);
      return load || compareIds(a.id, b.id);
    });

    const conflict = detectConflicts({ task, activeRuns: [...activeRuns, ...proposedScopes], ownership });
    if (!conflict.ok) {
      skipped.push({ taskId: task.id, reason: SKIP_REASONS.WRITE_SCOPE_CONFLICT });
      continue;
    }

    const agent = eligibleAgents[0];
    const expectedTaskVersion = Number.isInteger(task.version) ? task.version : 0;
    const workspacePolicy = cloneWorkspacePolicy(
      projectPolicy.workspacePolicy ?? policies.workspacePolicy,
      `projects.${projectId}.workspacePolicy`,
    );
    proposals.push({
      taskId: task.id,
      agentId: agent.id,
      expectedTaskVersion,
      workspacePolicy,
      reason: `priority=${row.priority}; waitingMs=${row.waitingMs}`,
      idempotencyKey: `claim-${task.id}-${expectedTaskVersion}`,
    });
    activeProjectCounts.set(projectId, (activeProjectCounts.get(projectId) ?? 0) + 1);
    activeAgentCounts.set(agent.id, (activeAgentCounts.get(agent.id) ?? 0) + 1);
    proposedScopes.push({ id: `proposal-${task.id}`, taskId: task.id, status: "RUNNING", files: task.files });
  }

  skipped.sort((a, b) => compareIds(a.taskId, b.taskId));
  return { proposals, skipped };
}

/**
 * Test helper: throw unless two plan values serialise identically. Keeping this
 * here lets every consumer prove determinism the same way.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {unknown} a
 */
export function assertDeterministic(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left !== right) throw new Error(`scheduler-core: output is not deterministic\n  a=${left}\n  b=${right}`);
  return a;
}
