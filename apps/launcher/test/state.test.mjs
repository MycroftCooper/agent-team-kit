// `launcher.json` contract: closed shape, atomic write, never carries the token.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readState, removeState, statePathFor, validateState, writeState, STATE_VERSION } from "../src/state.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-launcher-state-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sampleState(overrides = {}) {
  return {
    version: STATE_VERSION,
    port: 1421,
    startedAt: "2026-01-01T00:00:00.000Z",
    children: [
      { name: "backend", pid: 101, role: "backend" },
      { name: "scheduler", pid: 102, role: "scheduler" },
      { name: "host-1", pid: 103, role: "host" },
    ],
    ...overrides,
  };
}

test("state file round-trips and renders the documented shape", () => {
  withTempDir((dir) => {
    const file = statePathFor(dir);
    const state = sampleState();
    writeState(file, state);
    assert.deepEqual(readState(file), state);
    const text = readFileSync(file, "utf8");
    assert.match(text, /"children"/);
    assert.doesNotMatch(text, /token/i);
    assert.equal(readdirSync(dir).filter((entry) => entry.endsWith(".tmp")).length, 0, "atomic write leaves no temp file");
  });
});

test("writeState is atomic: a second write replaces the whole file (no partial state)", () => {
  withTempDir((dir) => {
    const file = statePathFor(dir);
    writeState(file, sampleState());
    writeState(file, sampleState({ port: 1999, children: [{ name: "backend", pid: 500, role: "backend" }] }));
    const parsed = readState(file);
    assert.equal(parsed.port, 1999);
    assert.deepEqual(parsed.children, [{ name: "backend", pid: 500, role: "backend" }]);
  });
});

test("readState returns null for missing / corrupt / out-of-contract files", () => {
  withTempDir((dir) => {
    const file = statePathFor(dir);
    assert.equal(readState(file), null);
    writeFileSync(file, "{not json");
    assert.equal(readState(file), null);
    writeFileSync(file, JSON.stringify(sampleState({ children: [] })));
    assert.equal(readState(file), null);
    writeFileSync(file, JSON.stringify(sampleState({ port: 0 })));
    assert.equal(readState(file), null);
  });
});

test("validateState rejects anything that could smuggle the internal credential", () => {
  assert.throws(() => validateState(sampleState({ token: "secret" })), /unknown top-level field|refusing to persist/i);
  assert.throws(
    () =>
      validateState(
        sampleState({ children: [{ name: "backend", pid: 1, role: "backend", internalToken: "secret" }] }),
      ),
    /unknown child field|refusing to persist/i,
  );
});

test("removeState is idempotent", () => {
  withTempDir((dir) => {
    const file = statePathFor(dir);
    assert.equal(removeState(file), false);
    writeState(file, sampleState());
    assert.equal(removeState(file), true);
    assert.equal(removeState(file), false);
  });
});
