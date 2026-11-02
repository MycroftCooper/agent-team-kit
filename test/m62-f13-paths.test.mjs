// M6.2 F13: one repository path rule for contracts, database and scheduler-core.
//
// This is the integration-level check the per-package suites cannot make: the
// same input matrix must produce the same conclusion in all three layers.
//   - contracts:  `normalizeRepoPath` / `pathsOverlap` (the single implementation)
//   - database:   public `createMemoryStore` validation + `claimTask` write-scope
//                 conflict (it imports @atk/contracts for the rule)
//   - scheduler:  `normalizePath` / `pathsOverlap` / `resolveOwner`
//
// Only public package entry points are imported. The bare `@atk/*` specifiers
// are preferred; a clean checkout without a root workspace install has no root
// node_modules links, so the package entry files are used as the fallback (the
// legacy `node scripts/test.mjs` suite must run from a bare checkout).
import assert from "node:assert/strict";
import test from "node:test";

async function loadPackage(specifier, fallback) {
  try {
    return await import(specifier);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return import(fallback);
  }
}

const contracts = await loadPackage("@atk/contracts", "../packages/contracts/src/index.mjs");
const database = await loadPackage("@atk/database", "../packages/database/src/index.mjs");
const schedulerCore = await loadPackage("@atk/scheduler-core", "../packages/scheduler-core/src/index.mjs");

// Valid repository-relative paths and their one canonical form.
const VALID = [
  ["src/a.ts", "src/a.ts"],
  ["src\\a.ts", "src/a.ts"],
  [" src ", "src"],
  ["src//a.ts", "src/a.ts"],
  ["./src/a.ts", "src/a.ts"],
  ["a/../b", "b"],
  ["src/./api/../api/v1.ts", "src/api/v1.ts"],
];

// Shapes no layer may ever turn into a repository path (QA-M61-01: "C:\\abs").
const INVALID = ["C:\\abs", "C:/abs", "/abs", "//host/share", "../x", "..", "", "   "];

function databaseProject() {
  return { id: "proj-1", name: "F13", repoPath: "E:\\f13-demo", defaultBranch: "main" };
}

function databaseTask(projectId, files) {
  return {
    projectId,
    title: "f13",
    description: "f13",
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority: 2,
    deps: [],
    files,
  };
}

/** Canonical form the database stores for a declared file (public store API). */
function databaseCanonical(input) {
  const store = database.createMemoryStore();
  store.createProject(databaseProject());
  const task = store.createTask(databaseTask("proj-1", [input]));
  return task.files[0];
}

function freshStoreWith(agents) {
  const store = database.createMemoryStore();
  store.createProject(databaseProject());
  for (const agent of agents) store.upsertAgent(agent);
  return store;
}

function claim(store, task, agentId, idempotencyKey) {
  return store.claimTask({ taskId: task.id, agentId, expectedTaskVersion: task.version, idempotencyKey });
}

/**
 * Does the database consider two write scopes conflicting? Proven through the
 * public claim path: claim the left task, then claim the right one and inspect
 * the refusal reason.
 */
function databaseOverlaps(left, right) {
  const store = freshStoreWith([
    { id: "agent-1", role: "DEV", capabilities: ["WORKER"], status: "IDLE" },
    { id: "agent-2", role: "DEV", capabilities: ["WORKER"], status: "IDLE" },
  ]);
  const first = store.createTask(databaseTask("proj-1", [left]));
  const second = store.createTask(databaseTask("proj-1", [right]));
  claim(store, first, "agent-1", "k1");
  try {
    claim(store, second, "agent-2", "k2");
    return false;
  } catch (error) {
    assert.ok(database.isStoreError(error), `unexpected error: ${error?.message}`);
    if (error.code === "CAPABILITY_UNAVAILABLE" && error.details?.reason === "write-scope-conflict") return true;
    throw error;
  }
}

test("the same path has the same canonical form in contracts, database and scheduler-core", () => {
  for (const [input, expected] of VALID) {
    assert.equal(contracts.normalizeRepoPath(input), expected, `contracts: ${JSON.stringify(input)}`);
    assert.equal(schedulerCore.normalizePath(input), expected, `scheduler-core: ${JSON.stringify(input)}`);
    assert.equal(databaseCanonical(input), expected, `database: ${JSON.stringify(input)}`);
  }
});

test("all three layers reject drive/UNC absolute, escaping and empty paths", () => {
  for (const input of INVALID) {
    // contracts and scheduler-core are the same rule: the same TypeError.
    assert.throws(() => contracts.normalizeRepoPath(input), TypeError, `contracts must reject ${JSON.stringify(input)}`);
    assert.throws(() => schedulerCore.normalizePath(input), TypeError, `scheduler-core must reject ${JSON.stringify(input)}`);
    // The database rejects it at its write boundary with a StoreError.
    assert.throws(
      () => databaseCanonical(input),
      (error) => {
        assert.ok(database.isStoreError(error), `database must reject ${JSON.stringify(input)} with a StoreError`);
        assert.equal(error.code, "VALIDATION_ERROR", `database error code for ${JSON.stringify(input)}`);
        return true;
      },
    );
  }
  // Drive absolute paths are the F13 regression: the old local scheduler rule
  // accepted "C:\\abs" (and aliased it with "C:/abs"); every layer names the
  // repository-relative requirement now.
  for (const input of ["C:\\abs", "C:/abs"]) {
    assert.throws(() => contracts.normalizeRepoPath(input), /must be repository-relative/);
    assert.throws(() => schedulerCore.normalizePath(input), /must be repository-relative/);
    assert.throws(() => databaseCanonical(input), /repo-relative/);
  }
});

test("overlap conclusions agree in all three layers", () => {
  const cases = [
    ["src", "src/a.ts", true],
    ["src", "src2/a.ts", false],
    ["src\\a.ts", "src/a.ts", true],
    [" src ", "src", true],
    ["src", "src/", true],
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(contracts.pathsOverlap(left, right), expected, `contracts: ${left} vs ${right}`);
    assert.equal(schedulerCore.pathsOverlap(left, right), expected, `scheduler-core: ${left} vs ${right}`);
    assert.equal(databaseOverlaps(left, right), expected, `database: ${left} vs ${right}`);
  }
});

test("the scheduler's ownership resolution uses the same canonical paths", () => {
  const ownership = { rules: [{ prefix: "src", role: "DEV" }, { prefix: "src/../lib", role: "LIB" }] };
  assert.deepEqual(schedulerCore.resolveOwner(ownership, "src\\api\\v1.ts"), { role: "DEV", prefix: "src" });
  assert.deepEqual(schedulerCore.resolveOwner(ownership, "lib/x.ts"), { role: "LIB", prefix: "lib" });
  // A drive-absolute path is not a repository scope in any layer: no owner.
  assert.equal(schedulerCore.resolveOwner(ownership, "C:\\abs"), null);
  assert.throws(() => databaseCanonical("C:\\abs"), /repo-relative/);
});
