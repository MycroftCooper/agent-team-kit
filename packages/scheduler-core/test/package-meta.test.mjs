// Package-level guarantees: pure module, zero dependencies, zero clock/IO.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(PACKAGE_ROOT, "src");
const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
const source = readFileSync(path.join(SRC_DIR, "index.mjs"), "utf8");

/** Comments may mention forbidden APIs while explaining the rule; scan code only. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}
const code = stripComments(source);

test("package metadata matches the M3 contract", () => {
  assert.equal(manifest.name, "@atk/scheduler-core");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.private, true);
  assert.equal(manifest.main, "./src/index.mjs");
  assert.deepEqual(manifest.exports["."], "./src/index.mjs");
  assert.deepEqual(manifest.engines, { node: ">=22.5.0" });
});

test("the package has zero dependencies", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    assert.equal(manifest[field], undefined, `${field} must not exist (zero-dependency algorithm package)`);
  }
});

test("the source has no imports at all (not even node: builtins)", () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith(".mjs"));
  assert.deepEqual(files, ["index.mjs"]);
  assert.equal(/\bimport\b/.test(source), false, "src must not import anything");
  assert.equal(/\brequire\s*\(/.test(source), false, "src must not use require()");
});

test("the source has no clock, no I/O and no randomness", () => {
  for (const forbidden of [
    "Date.now(",
    "new Date(",
    "performance.now(",
    "Math.random(",
    "process.",
    "setTimeout(",
    "setInterval(",
    "fetch(",
    "node:fs",
    "node:http",
    "node:net",
    "child_process",
  ]) {
    assert.equal(code.includes(forbidden), false, `src must not contain ${forbidden}`);
  }
  // `now` is injected; only parsing/formatting of supplied values is allowed.
  assert.match(source, /Date\.parse\(/);
  assert.match(source, /function toEpochMs/);
});

test("the public surface exposes the documented functions and enums", async () => {
  const api = await import("../src/index.mjs");
  for (const name of [
    "detectCycles",
    "topologicalOrder",
    "readyCandidates",
    "scoreAndSort",
    "matchAgents",
    "detectConflicts",
    "planDispatch",
    "assertDeterministic",
    "resolveOwner",
    "normalizePath",
    "pathsOverlap",
    "SKIP_REASONS",
    "SKIP_REASON_VALUES",
    "PRIORITY_WEIGHT",
    "CYCLE_LIMITS",
  ]) {
    assert.ok(name in api, `missing export ${name}`);
  }
  assert.deepEqual(Object.values(api.SKIP_REASONS).sort(), [
    "capability-mismatch",
    "capacity",
    "cycle",
    "deps-incomplete",
    "no-idle-agent",
    "write-scope-conflict",
  ]);
  assert.ok(Object.isFrozen(api.SKIP_REASONS));
  assert.ok(Object.isFrozen(api.SKIP_REASON_VALUES));
});

test("README documents the fixed weights and cycle policy", () => {
  const readme = readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8");
  assert.match(readme, /priority/);
  assert.match(readme, /waiting/);
  assert.match(readme, /cycle/);
  assert.match(readme, /deterministic/i);
});
