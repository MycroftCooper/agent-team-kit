// Shared fixtures for @atk/scheduler-core tests. Not a test file.
export const NOW = "2026-01-01T00:10:00.000Z"; // 10 minutes after the default createdAt
export const NOW_MS = Date.parse(NOW);

export function task(id, overrides = {}) {
  return {
    id,
    projectId: "P-1",
    title: `task ${id}`,
    description: `task ${id}`,
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority: 2,
    status: "READY",
    deps: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function agent(id, overrides = {}) {
  return {
    id,
    role: "DEV",
    capabilities: ["WORKER"],
    status: "IDLE",
    version: 1,
    ...overrides,
  };
}

export function run(id, overrides = {}) {
  return {
    id,
    taskId: "T-0",
    agentId: "A-1",
    function: "WORKER",
    status: "RUNNING",
    version: 1,
    ...overrides,
  };
}

export function snapshot({ tasks = [], agents = [], runs = [], projects = [], ownership } = {}) {
  const value = { version: 1, generatedAt: NOW, projects, tasks, agents, runs, leases: [] };
  if (ownership !== undefined) value.ownership = ownership;
  return value;
}

export const POLICIES = Object.freeze({ maxConcurrentPerProject: 2, maxPerAgent: 1 });

/** Deterministic permutations used to prove input-order independence. */
export function permutations(list) {
  return [list, [...list].reverse(), [...list.slice(1), list[0]]];
}

export function plan(snapshotValue, { policies = POLICIES, now = NOW } = {}) {
  // Imported lazily so helpers stay usable from every suite.
  return import("../src/index.mjs").then(({ planDispatch }) => planDispatch({ snapshot: snapshotValue, policies, now }));
}
