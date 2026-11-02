// @atk/scheduler-core — pure scheduling algorithms for M3.
//
// Contract: docs/architecture/m3-contracts.md §1 and §0 invariants (ADR-003).
// This module is deliberately pure: no clock, no network, no file system, no
// process state. Its only dependency is @atk/contracts, for the shared
// repository path rules (M6.2 F13): one canonicaliser and one overlap rule for
// the database, the scheduler and the backend. `now` is always injected so the
// same snapshot and policy always produce byte-identical plans (spec §8.2).
//
// Hard rules encoded here:
//   1. A task whose dependencies are incomplete is never a candidate.
//   2. A cyclic DAG is rejected as a whole: proposals = [] and every task is
//      reported with reason "cycle" (never "skip the broken part and continue").
//   3. Output order is a fixed weight + stable sort, independent of input order.
//   4. Skipped reasons are machine-readable enum values, never free text.
//   5. An IDLE agent is not automatically dispatchable: a fresh heartbeat and
//      capacity are required too (m6.2 F10).

import { normalizeRepoPath, overlappingPaths, pathsOverlap } from "@atk/contracts";

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

/**
 * M6.2 F10: how long a host heartbeat keeps its agents dispatchable. A heartbeat
 * is live while `lastHeartbeatAt + ttlMs >= now`; the default matches the 10s
 * host heartbeat with room for three missed beats. Policies may override it
 * (`policies.heartbeatTtlMs`), but there is no "disabled" value: IDLE alone is
 * never enough to dispatch.
 */
export const DEFAULT_HEARTBEAT_TTL_MS = 30_000;

/** Machine-readable availability reasons (mirrors the database store, F10). */
export const AGENT_AVAILABILITY_REASONS = Object.freeze({
  OK: "ok",
  NO_HEARTBEAT: "no-heartbeat",
  STALE_HEARTBEAT: "stale-heartbeat",
  NO_CAPACITY: "no-capacity",
});

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

/**
 * Canonical repository-relative path (M6.2 F13).
 *
 * This is the @atk/contracts function itself, re-exported under the historical
 * name so existing callers keep working. It is intentionally NOT a wrapper: the
 * database and the scheduler compare the exact same function, and Windows drive
 * absolute paths (`C:\abs` / `C:/abs`), UNC paths and `..` escapes are rejected
 * (they throw a TypeError, exactly like the database boundary).
 */
export const normalizePath = normalizeRepoPath;

/**
 * True when two canonical repo paths name the same file or a directory scope
 * contains the other (M6.2 F13: the shared @atk/contracts rule).
 */
export { pathsOverlap };

/** Canonical repo path, or null when the shared rule rejects the input. */
function canonicalOrNull(value) {
  if (typeof value !== "string") return null;
  try {
    return normalizeRepoPath(value);
  } catch {
    return null;
  }
}

/**
 * Normalised, de-duplicated, sorted write-scope entries of a task/run.
 *
 * Entries the shared repository rule rejects (absolute, UNC, `..` escapes) are
 * not repository scopes, so they cannot create an overlap. The database refuses
 * them at write time (`validateFiles`); dropping them here keeps a malformed
 * snapshot from crashing the planner without inventing a scope for it.
 */
function writeScopeOf(record) {
  const seen = new Set();
  for (const entry of asArray(record?.files)) {
    const normalised = canonicalOrNull(entry);
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

/** Hard caps for simple-cycle enumeration (deterministic, never exponential). */
export const CYCLE_LIMITS = Object.freeze({ perScc: 100, total: 1000, visitBudget: 250_000 });

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

/** Kosaraju SCCs, iterative (no recursion depth limit) and deterministic. */
function stronglyConnectedComponents(ids, edges) {
  const visited = new Set();
  const order = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [{ id: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = edges.get(frame.id) ?? [];
      if (frame.next < neighbors.length) {
        const next = neighbors[frame.next];
        frame.next += 1;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ id: next, next: 0 });
        }
      } else {
        order.push(frame.id);
        stack.pop();
      }
    }
  }

  const reverse = new Map(ids.map((id) => [id, []]));
  for (const [from, tos] of edges) {
    for (const to of tos) reverse.get(to).push(from);
  }
  for (const list of reverse.values()) list.sort(compareIds);

  const assigned = new Set();
  const components = [];
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const start = order[index];
    if (assigned.has(start)) continue;
    const component = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const id = stack.pop();
      component.push(id);
      for (const next of reverse.get(id) ?? []) {
        if (!assigned.has(next)) {
          assigned.add(next);
          stack.push(next);
        }
      }
    }
    component.sort(compareIds);
    components.push(component);
  }
  components.sort((a, b) => compareIds(a[0], b[0]));
  return components;
}

/**
 * Enumerate every simple cycle inside one SCC (start node = smallest id in the
 * cycle, so each cycle is produced exactly once and already canonical).
 *
 * `budget` bounds the total number of DFS edge inspections for the whole
 * `detectCycles` call: a cyclic graph can have exponentially many simple paths,
 * and the cycle cap alone does not bound the work needed to find them.
 */
function enumerateSimpleCycles(component, edges, limit, budget) {
  const members = new Set(component);
  const cycles = [];
  let truncated = false;

  for (const start of component) {
    if (cycles.length >= limit) {
      truncated = true;
      break;
    }
    const path = [start];
    const onPath = new Set([start]);
    const dfs = (current) => {
      for (const next of edges.get(current) ?? []) {
        budget.visits += 1;
        if (budget.visits > budget.max) {
          truncated = true;
          return;
        }
        if (cycles.length >= limit) {
          truncated = true;
          return;
        }
        if (!members.has(next)) continue;
        if (next === start) {
          cycles.push([...path]);
          continue;
        }
        // The smallest id of a cycle must be its entry point; anything smaller
        // than `start` is a different rotation that another start already sees.
        if (compareIds(next, start) < 0) continue;
        if (onPath.has(next)) continue; // only `start` may repeat (to close)
        path.push(next);
        onPath.add(next);
        dfs(next);
        path.pop();
        onPath.delete(next);
        if (truncated) return;
      }
    };
    dfs(start);
    if (truncated) break;
  }
  return { cycles, truncated };
}

/**
 * Find every simple cycle in the dependency graph.
 *
 * - a self-dependency (`A -> A`) is a cycle of length one: `["A"]`;
 * - a dependency on a task that is not in the snapshot is NOT a cycle (it is a
 *   readiness problem reported by `readyCandidates` / `planDispatch`);
 * - cycles inside one strongly-connected component are enumerated individually,
 *   not just one per DFS branch: `A->B->D->A` and `A->C->D->A` are two cycles.
 *
 * Enumeration is bounded by {@link CYCLE_LIMITS} (per SCC and overall). When a
 * cap is hit, the cycles found so far are returned with `truncated: true` — an
 * explicit "incomplete" marker, never silently fewer cycles.
 *
 * Each cycle starts at its lexicographically smallest id; cycles are sorted, so
 * the result is deterministic for the same graph regardless of input order.
 *
 * @param {Array<{id: string, deps?: string[]}>} tasks
 * @returns {{ok: boolean, cycles: string[][], truncated: boolean}}
 */
export function detectCycles(tasks) {
  const index = buildTaskIndex(tasks);
  const ids = [...index.keys()];
  const edges = new Map(ids.map((id) => [id, taskDeps(index.get(id)).filter((dep) => index.has(dep))]));

  const components = stronglyConnectedComponents(ids, edges);
  const found = new Map();
  const budget = { visits: 0, max: CYCLE_LIMITS.visitBudget };
  let truncated = false;

  for (const component of components) {
    if (found.size >= CYCLE_LIMITS.total || budget.visits > budget.max) {
      truncated = true;
      break;
    }
    const only = component[0];
    const isSelfLoop = component.length === 1 && (edges.get(only) ?? []).includes(only);
    if (component.length === 1 && !isSelfLoop) continue;

    const limit = Math.min(CYCLE_LIMITS.perScc, CYCLE_LIMITS.total - found.size);
    const result = enumerateSimpleCycles(component, edges, limit, budget);
    for (const cycle of result.cycles) found.set(cycle.join("\u0000"), cycle);
    if (result.truncated) truncated = true;
  }

  const cycles = [...found.values()].sort((a, b) => compareIds(a.join("\u0000"), b.join("\u0000")));
  return { ok: cycles.length === 0, cycles, truncated };
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
 * reported in `missingDeps` (one entry per task, listing every missing dep id)
 * instead of silently disappearing. Contract §5 shape:
 * `[{ taskId, missing: string[] }]`.
 *
 * @param {{tasks?: Array}} input
 * @returns {{candidates: object[], missingDeps: Array<{taskId: string, missing: string[]}>}}
 */
export function readyCandidates({ tasks } = {}) {
  const index = buildTaskIndex(tasks);
  const candidates = [];
  const missing = new Map(); // taskId -> Set<depId>
  for (const [taskId, task] of index) {
    if (task.status !== READY_TASK_STATUS) continue;
    let ready = true;
    for (const depId of taskDeps(task)) {
      const dep = index.get(depId);
      if (!dep) {
        if (!missing.has(taskId)) missing.set(taskId, new Set());
        missing.get(taskId).add(depId);
        ready = false;
        continue;
      }
      if (dep.status !== DONE_TASK_STATUS) ready = false;
    }
    if (ready) candidates.push(task);
  }
  const missingDeps = [...missing.entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([taskId, depIds]) => ({ taskId, missing: [...depIds].sort(compareIds) }));
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

/** Validate the configured heartbeat TTL; `undefined` means the fixed default. */
function heartbeatTtlOf(policies) {
  const value = policies?.heartbeatTtlMs;
  if (value === undefined || value === null) return DEFAULT_HEARTBEAT_TTL_MS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError("scheduler-core: heartbeatTtlMs must be a positive integer when provided");
  }
  return value;
}

/**
 * Availability of one agent for scheduling (M6.2 F10).
 *
 * This is the pure mirror of the database store's `agentAvailability`: a fresh
 * heartbeat (`lastHeartbeatAt + ttlMs >= now`) plus positive capacity are
 * required, and `status === "IDLE"` is NOT consulted — an IDLE agent whose host
 * stopped checking in is not dispatchable. An unparsable heartbeat is stale, and
 * a missing one is `no-heartbeat`; neither is ever treated as available.
 *
 * @param {object} agent snapshot agent (`lastHeartbeatAt`, `capacity`)
 * @param {{now: Date|number|string, ttlMs?: number}} options
 * @returns {{available: boolean, reason: string}}
 */
export function agentAvailability(agent, { now, ttlMs = DEFAULT_HEARTBEAT_TTL_MS } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("scheduler-core: ttlMs must be a positive integer");
  }
  const nowMs = toEpochMs(now);
  if (!isPlainObject(agent)) return { available: false, reason: AGENT_AVAILABILITY_REASONS.NO_HEARTBEAT };
  const heartbeat = agent.lastHeartbeatAt;
  if (heartbeat === undefined || heartbeat === null || (typeof heartbeat === "string" && heartbeat.trim() === "")) {
    return { available: false, reason: AGENT_AVAILABILITY_REASONS.NO_HEARTBEAT };
  }
  const heartbeatMs = Date.parse(heartbeat);
  // Mirror the database rule exactly: `last + ttl >= now` is fresh, an
  // unparsable heartbeat can never satisfy it and therefore reads as stale.
  if (!Number.isFinite(heartbeatMs) || heartbeatMs + ttlMs < nowMs) {
    return { available: false, reason: AGENT_AVAILABILITY_REASONS.STALE_HEARTBEAT };
  }
  if (!(Number(agent.capacity ?? 0) > 0)) {
    return { available: false, reason: AGENT_AVAILABILITY_REASONS.NO_CAPACITY };
  }
  return { available: true, reason: AGENT_AVAILABILITY_REASONS.OK };
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
 * package never imports `lib/**` (M3 contract §1). Prefixes are canonicalised
 * with the shared repository rule; a prefix the rule rejects can never match a
 * repository path and is dropped. Tie-breaks are deterministic: longer prefix
 * first, then prefix lexicographic, then role lexicographic.
 *
 * @param {{rules?: Array<{prefix?: string, role?: string}>} | null} ownership
 * @param {string} filePath
 * @returns {{role: string, prefix: string} | null}
 */
export function resolveOwner(ownership, filePath) {
  const file = canonicalOrNull(filePath);
  if (!file) return null;
  const rules = asArray(ownership?.rules)
    .filter((rule) => isPlainObject(rule) && isNonEmptyString(rule.prefix) && isNonEmptyString(rule.role))
    .map((rule) => ({ role: rule.role, prefix: canonicalOrNull(rule.prefix) }))
    .filter((rule) => rule.prefix !== null)
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
    // M6.2 F13: the shared @atk/contracts rule computes which candidate paths
    // overlap this run; a plain string-prefix comparison would treat
    // "src2/a.ts" as inside "src".
    const overlapping = new Set(overlappingPaths(candidateFiles, run.files));
    for (const candidateFile of candidateFiles) {
      for (const runFile of run.files) {
        const owner = resolveOwner(ownership, candidateFile);
        const runOwner = resolveOwner(ownership, runFile);
        const pathOverlap = overlapping.has(candidateFile) && pathsOverlap(candidateFile, runFile);
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
  // m6.2 F10: heartbeat/capacity refusals reuse the availability reason codes.
  NO_HEARTBEAT: AGENT_AVAILABILITY_REASONS.NO_HEARTBEAT,
  STALE_HEARTBEAT: AGENT_AVAILABILITY_REASONS.STALE_HEARTBEAT,
  NO_CAPACITY: AGENT_AVAILABILITY_REASONS.NO_CAPACITY,
});

/** Agent exclusion reasons (machine-readable). */
export const AGENT_EXCLUSION_VALUES = Object.freeze(Object.values(AGENT_EXCLUSION));

/**
 * Agents that can execute a task: `status === "IDLE"`, the exact role, the
 * required Function present in `agent.capabilities`, and a live heartbeat with
 * positive capacity (m6.2 F10).
 *
 * Returns the candidates plus a per-agent exclusion reason so the planner can
 * distinguish "no idle agent" from "idle agents, wrong capability" and from
 * "IDLE but the host stopped checking in". The injected clock is mandatory: the
 * availability rule has no hidden `Date.now()` fallback.
 *
 * @param {{task?: object, agents?: object[], policies?: object, now: Date|number|string}} input
 * @returns {{candidates: object[], excluded: Array<{agentId: string, reason: string}>}}
 */
export function matchAgents({ task, agents, policies, now } = {}) {
  const ttlMs = heartbeatTtlOf(policies);
  const nowMs = toEpochMs(now);
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
    const availability = agentAvailability(agent, { now: nowMs, ttlMs });
    if (!availability.available) {
      excluded.push({ agentId: agent.id, reason: availability.reason });
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
 * m6.2 F10: an IDLE agent also needs a live heartbeat and positive capacity. When
 * any IDLE agent is refused for that reason the result additionally carries
 * `unavailableAgents: [{agentId, reason}]` and `heartbeatTtlMs`; the field is
 * absent when every IDLE agent is available (historical plan shape preserved).
 *
 * @param {{snapshot?: object, policies?: object, now?: Date|number|string}} input
 * @returns {{proposals: object[], skipped: Array<{taskId: string, reason: string}>, unavailableAgents?: Array<{agentId: string, reason: string}>, heartbeatTtlMs?: number}}
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

  // M6.2 F10: compute the heartbeat/capacity refusals once per round. They are
  // part of the scheduling result, not a silent filter: the CLI and smoke gates
  // must be able to explain why an IDLE agent got no work.
  const heartbeatTtlMs = heartbeatTtlOf(policies);
  const unavailableAgents = [];
  for (const agent of agents) {
    if (agent.status !== "IDLE") continue;
    const availability = agentAvailability(agent, { now, ttlMs: heartbeatTtlMs });
    if (!availability.available) unavailableAgents.push({ agentId: agent.id, reason: availability.reason });
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

    const match = matchAgents({ task, agents, policies, now });
    if (match.candidates.length === 0) {
      // "No idle agent" now means "no *available* idle agent": an IDLE agent
      // whose heartbeat expired does not count (m6.2 F10).
      const hasAvailableIdleAgent = agents.some(
        (agent) => agent.status === "IDLE" && agentAvailability(agent, { now, ttlMs: heartbeatTtlMs }).available,
      );
      skipped.push({
        taskId: task.id,
        reason: hasAvailableIdleAgent ? SKIP_REASONS.CAPABILITY_MISMATCH : SKIP_REASONS.NO_IDLE_AGENT,
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
  const result = { proposals, skipped };
  if (unavailableAgents.length > 0) {
    // Additive diagnostic (m6.2 F10): present only when some IDLE agent was
    // refused, so an all-available plan keeps the historical shape.
    result.unavailableAgents = unavailableAgents;
    result.heartbeatTtlMs = heartbeatTtlMs;
  }
  return result;
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
