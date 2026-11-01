// Process-level tests for the Runtime Host CLI. QA-004 showed that a CLI entry
// point can be completely broken while every library test passes, so this spawns
// the real process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "cli.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
    env: { ...process.env, ATK_INTERNAL_TOKEN: "", ...env },
  });
}

test("cli.mjs --help prints usage and exits 0", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /Usage: atk-runtime-host/);
});

test("cli.mjs exits 2 with a clear message when the internal token is missing", () => {
  const result = run(["--once"]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /ATK_INTERNAL_TOKEN is required/);
});

test("cli.mjs --once exits 0 after a tick even when there is nothing to claim", () => {
  // Port 9 is closed: claim fails, but the host reports it and exits cleanly. The
  // point is that the process entry point loads and runs, which is exactly what
  // QA-004 found broken.
  const result = run(["--once", "--owner", "cli-test"], {
    ATK_INTERNAL_TOKEN: "test-token",
    ATK_BACKEND_URL: "http://127.0.0.1:9",
    ATK_HOST_STATE_FILE: path.join(here, "..", ".cli-test-state.json"),
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.ok(payload.stats, "the CLI must report host stats");
  assert.equal(typeof payload.stats.errors, "number");
});
