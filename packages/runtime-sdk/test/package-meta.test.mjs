// Package-level guarantees: zero third-party dependencies, no network/no
// subprocess code in the mock, and an export map that points at real files.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(PACKAGE_ROOT, "src");
const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const specifiers = [];
  for (const match of text.matchAll(IMPORT_RE)) specifiers.push(match[1] ?? match[2]);
  return specifiers;
}

test("package name, module type and engines match the M2 contract", () => {
  assert.equal(manifest.name, "@atk/runtime-sdk");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.private, true);
  assert.equal(manifest.main, "./src/index.mjs");
  assert.deepEqual(manifest.engines, { node: ">=22.5.0" });
  assert.deepEqual(manifest.exports["."], "./src/index.mjs");
  assert.deepEqual(manifest.exports["./mock"], "./src/mock.mjs");
  assert.deepEqual(manifest.exports["./dsh"], "./src/dsh-unsupported.mjs");
});

test("the only declared dependency is the workspace contracts package", () => {
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@atk/contracts"]);
  assert.equal(manifest.dependencies["@atk/contracts"], "workspace:*");
  for (const field of ["devDependencies", "peerDependencies", "optionalDependencies"]) {
    assert.equal(manifest[field], undefined, `${field} must stay empty (zero third-party deps)`);
  }
});

test("every export target exists", () => {
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (key === "./package.json") continue;
    const full = path.join(PACKAGE_ROOT, target);
    assert.ok(readFileSync(full, "utf8").length > 0, `${key} -> ${target}`);
  }
});

test("src modules import only relative files and node: builtins", () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith(".mjs"));
  assert.deepEqual(files.sort(), ["dsh-unsupported.mjs", "index.mjs", "mock.mjs"]);
  for (const file of files) {
    for (const specifier of importsOf(path.join(SRC_DIR, file))) {
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("node:"),
        `${file}: unexpected import "${specifier}" (only relative modules and node: builtins are allowed; zero third-party deps)`,
      );
    }
  }
});

test("the mock has no network, subprocess or wall-clock scheduling hooks", () => {
  const text = readFileSync(path.join(SRC_DIR, "mock.mjs"), "utf8");
  for (const forbidden of ["child_process", "node:net", "node:http", "node:https", "fetch(", "spawn(", "exec("]) {
    assert.equal(text.includes(forbidden), false, `mock.mjs must not contain ${forbidden}`);
  }
  // Timers must be unref'd and tracked so a hanging scenario cannot leak.
  assert.match(text, /\.unref\?\.\(\)/);
  assert.match(text, /_pendingTimers/);
});

test("public modules expose the documented surface", async () => {
  const index = await import("../src/index.mjs");
  for (const name of [
    "CAPABILITY_UNAVAILABLE",
    "CapabilityUnavailableError",
    "ALL_CAPABILITIES_FALSE",
    "RUNTIME_CAPABILITY_KEYS",
    "validateCapabilities",
    "validateStartRunInput",
    "validateRuntimeEvent",
    "validateRuntimeHealth",
    "validateRuntimeSessionHandle",
    "validateAgentRuntime",
    "unsupportedCapabilities",
    "assertCapabilities",
  ]) {
    assert.ok(name in index, `index.mjs must export ${name}`);
  }
  const mock = await import("../src/mock.mjs");
  assert.deepEqual(Object.keys(mock), ["createMockRuntime"]);
  const dsh = await import("../src/dsh-unsupported.mjs");
  assert.deepEqual(Object.keys(dsh).sort(), ["DSH_UNSUPPORTED_DETAIL", "createDshRuntimeStub"]);
});
