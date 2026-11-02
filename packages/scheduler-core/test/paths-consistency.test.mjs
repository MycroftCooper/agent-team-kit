// M6.2 F13: scheduler-core must use the shared repository path rules instead of
// its own copy. The old local `normalizePath` accepted Windows drive absolute
// paths ("C:/abs" looks relative after separator conversion), so a declared write
// scope could alias a path that no repository can contain. QA-M61-01 recorded the
// divergence; this suite is its closing evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRepoPath, pathsOverlap as contractsPathsOverlap } from "@atk/contracts";
import { detectConflicts, normalizePath, pathsOverlap, resolveOwner } from "../src/index.mjs";

// Repository-relative forms every layer must canonicalise the same way.
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

test("scheduler-core canonicalises paths exactly like @atk/contracts", () => {
  for (const [input, expected] of VALID) {
    assert.equal(normalizeRepoPath(input), expected, `contracts: ${JSON.stringify(input)}`);
    assert.equal(normalizePath(input), expected, `scheduler-core: ${JSON.stringify(input)}`);
  }
  for (const input of INVALID) {
    assert.throws(() => normalizeRepoPath(input), TypeError, `contracts must reject ${JSON.stringify(input)}`);
    assert.throws(() => normalizePath(input), TypeError, `scheduler-core must reject ${JSON.stringify(input)}`);
  }
});

test("the path rules are the shared functions, not a second implementation", () => {
  // Identity (not just equal output) is the point: one function can never drift
  // from itself, so the database (which imports @atk/contracts) and the scheduler
  // cannot disagree about a write-scope path again.
  assert.equal(normalizePath, normalizeRepoPath);
  assert.equal(pathsOverlap, contractsPathsOverlap);
});

test("overlap conclusions agree between scheduler-core and @atk/contracts", () => {
  const cases = [
    ["src", "src/a.ts", true],
    ["src", "src2/a.ts", false],
    ["src\\a.ts", "src/a.ts", true],
    [" src ", "src", true],
    ["src", "src/", true],
    ["a/b", "a/b/c", true],
    ["a/b", "a/c", false],
    ["src/a.ts", "src/a.ts", true],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(pathsOverlap(left, right), expected, `scheduler-core: ${left} vs ${right}`);
    assert.equal(contractsPathsOverlap(left, right), expected, `contracts: ${left} vs ${right}`);
  }
});

test("absolute or escaping write scopes never become repo scopes", () => {
  const ownership = { rules: [{ prefix: "src", role: "DEV" }] };
  // The old local normaliser returned "C:/abs" and resolved an owner; the shared
  // rule rejects the shape, so the planner treats it as "no repository scope".
  assert.equal(resolveOwner(ownership, "C:\\abs"), null);
  assert.equal(resolveOwner(ownership, "C:/abs"), null);
  assert.equal(resolveOwner(ownership, "../outside.ts"), null);
  // Invalid rule prefixes are dropped for the same reason (they can never match).
  assert.equal(
    resolveOwner({ rules: [{ prefix: "C:\\abs", role: "X" }, { prefix: "src", role: "DEV" }] }, "src/a.ts").role,
    "DEV",
  );
  // Two absolute paths that the old implementation would normalise to the same
  // string ("C:/abs") are not a write-scope conflict: neither is a repo path.
  assert.deepEqual(
    detectConflicts({
      task: { id: "T-1", files: ["C:\\abs", "C:/abs"] },
      activeRuns: [{ id: "R-1", status: "RUNNING", files: ["C:\\abs", "C:/abs"] }],
    }),
    { ok: true, reasons: [] },
  );
});
