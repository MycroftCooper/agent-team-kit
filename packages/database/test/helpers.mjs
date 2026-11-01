// Shared fixtures for packages/database tests. Not a test file itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "@atk/database";

/**
 * Open a Store on a fresh temp database and guarantee the file is released
 * before the directory is removed (Windows cannot delete an open SQLite file).
 *
 * `open(extra)` opens additional stores on the same file (migration/re-open
 * tests); every one of them is closed by the single after-hook.
 */
export function useStore(t, { prefix = "atk-db-", subdir, ...options } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const file = path.join(dir, ...(subdir ? [subdir] : []), "atk.db");
  const opened = [];
  const open = (extra = {}) => {
    const store = openStore({ file, ...options, ...extra });
    opened.push(store);
    return store;
  };
  const store = open();
  t.after(() => {
    for (const instance of opened.reverse()) {
      try {
        instance.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, file, dir, open };
}

export function projectDto(overrides = {}) {
  return {
    id: "proj-1",
    name: "Demo project",
    repoPath: "E:\\CodeProject\\demo",
    defaultBranch: "main",
    ...overrides,
  };
}

export function taskDto(projectId, overrides = {}) {
  return {
    projectId,
    title: "Task title",
    description: "Task description",
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority: 2,
    deps: [],
    ...overrides,
  };
}

export const MAIN_CHAIN = Object.freeze([
  "DRAFT",
  "READY",
  "CLAIMED",
  "RUNNING",
  "REVIEWING",
  "INTEGRATING",
  "AWAITING_ACCEPTANCE",
  "DONE",
]);

/**
 * Move a task to `target` using only legal §5.2 transitions (fixture setup for
 * later states). Throws if the target is not reachable, so setup code can never
 * accidentally rely on an illegal jump.
 */
export function advanceTask(store, id, target) {
  for (let guard = 0; guard < 16; guard += 1) {
    const task = store.getTask(id);
    if (task.status === target) return task;
    const currentIndex = MAIN_CHAIN.indexOf(task.status);
    const targetIndex = MAIN_CHAIN.indexOf(target);
    let next;
    if (currentIndex >= 0 && targetIndex > currentIndex) next = MAIN_CHAIN[currentIndex + 1];
    else if (target === "BLOCKED" || target === "CANCELLED") next = target;
    else if (task.status === "BLOCKED" && targetIndex >= 0) next = "READY";
    else throw new Error(`advanceTask: cannot move ${task.status} -> ${target}`);
    store.patchTask(id, { expectedVersion: task.version, changes: { status: next } });
  }
  throw new Error(`advanceTask: transition guard exceeded for ${id} -> ${target}`);
}

/** Legacy state.json fixture modelled on examples/minimal plus archived data. */
export function sampleState(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: "2026-10-29T21:05:00+08:00",
    source: "test fixture",
    batch: {
      id: "DEMO-R01",
      goal: "Ship a tiny greet() helper with one tested behavior.",
      stopCondition: "The slice is QA-passed, applied and accepted by the user.",
      devClosedByUser: false,
      applyMode: "local-tree",
      openQuestions: ["Should greet() support a locale argument?"],
      slices: [
        {
          id: "SLICE-01",
          label: "Greet helper",
          status: "in_progress",
          qaPassed: null,
          applied: null,
          owner: "DEV",
          exit: "greet('Ada') returns 'Hello, Ada!'",
          evidence: "artifacts/evidence",
          note: "implementation in flight",
        },
      ],
    },
    counts: { total: 2, byStage: { implemented: 1, todo: 1 } },
    packages: [
      {
        id: "DEMO-01",
        type: "feature",
        owner: "DEV",
        module: "greeting",
        scope: "src/中文/greet.mjs",
        stage: "implemented",
        priority: "P1",
        evidence: "artifacts/evidence",
        note: "greet() implemented",
        deps: [],
        archived: false,
        verification: {},
      },
      {
        id: "DEMO-02",
        type: "bug",
        owner: "QA",
        module: "docs",
        scope: "README.md",
        stage: "todo",
        priority: "P2",
        evidence: "",
        note: "README example",
        deps: ["DEMO-01"],
        archived: false,
        verification: {},
      },
      {
        id: "DEMO-03",
        type: "feature",
        owner: "DEV",
        module: "legacy",
        scope: "src/old.mjs",
        stage: "done",
        priority: "P3",
        evidence: "",
        note: "archived",
        deps: [],
        archived: true,
        verification: { humanAccepted: true },
      },
    ],
    subitems: [
      { id: "DEMO-01-F01", parent: "DEMO-01", type: "feature", owner: "DEV; QA", stage: "partial" },
    ],
    ...overrides,
  };
}

export function sampleOwnership() {
  return {
    schemaVersion: 1,
    roles: ["DEV", "QA"],
    ignoredPrefixes: ["artifacts/", "node_modules/"],
    rules: [
      { prefix: "tests/", role: "QA" },
      { prefix: "src/", role: "DEV" },
    ],
  };
}

export function sampleRuntime() {
  return {
    schemaVersion: 3,
    updatedAt: "2026-10-29T21:05:00+08:00",
    agents: [
      {
        id: "agent-dev-01",
        role: "DEV",
        capabilities: ["WORKER"],
        status: "working",
        task: "DEMO-01",
        detail: "implementation",
        since: "2026-10-29T20:20:00+08:00",
      },
      { id: "agent-qa-01", role: "QA", capabilities: ["REVIEWER"], status: "waiting", task: "SLICE-01" },
    ],
    events: [{ at: "2026-10-29T20:10:00+08:00", role: "LEAD", text: "batch opened" }],
  };
}
