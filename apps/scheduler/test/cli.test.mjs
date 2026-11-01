// Process-level tests: the CLI is the actual entry point operators and the
// launcher use. QA-004 found that it could not start at all while every
// library-level test stayed green, so these tests spawn it for real.
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
  assert.match(result.stdout, /Usage: atk-scheduler/);
});

test("cli.mjs exits 2 with a clear message when the internal token is missing", () => {
  const result = run(["--once"]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /ATK_INTERNAL_TOKEN is required/);
});

test("cli.mjs --once reports a failed round instead of crashing when the backend is down", () => {
  // No backend on this port: the round must be reported, not thrown, and the
  // process must still exit 0 because it did what was asked.
  const result = run(["--once", "--owner", "cli-test"], {
    ATK_INTERNAL_TOKEN: "test-token",
    ATK_BACKEND_URL: "http://127.0.0.1:9",
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(payload.result.ok, false);
  assert.equal(payload.result.reason, "snapshot-failed");
  assert.ok(payload.result.backoffMs >= 1000);
});
