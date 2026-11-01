// CLI smoke tests: usage, doctor, and the stack-free failure mode for
// migrate when @atk/database (a parallel worker's package) is not available.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 30_000,
    windowsHide: true,
  });
}

test("cli.mjs --help prints usage and exits 0", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: atk-backend/);
  assert.match(result.stdout, /serve/);
  assert.match(result.stdout, /migrate/);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /export/);
});

test("cli.mjs doctor --json is diagnostic JSON and exits 0", () => {
  const result = runCli(["doctor", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.ok, "boolean");
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  assert.ok(report.checks.some((check) => check.id === "node"));
  assert.equal(report.security.bind, "127.0.0.1");
  assert.equal(report.security.hostCheck, true);
  assert.equal(report.security.writeOriginCheck, true);
  for (const check of report.checks) {
    assert.ok(["PASS", "FAIL", "SKIPPED"].includes(check.status), `bad check status ${check.status}`);
  }
});

test("cli.mjs migrate with a missing state file fails cleanly (exit 2, no stack trace)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atk-cli-migrate-"));
  try {
    const result = runCli(["migrate", "--from", "does-not-exist.json", "--json"], { cwd });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /state file not found/);
    assert.match(result.stderr, /does-not-exist\.json/);
    assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("cli.mjs rejects an unknown command with exit 2 and a clean message", () => {
  const result = runCli(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "frobnicate"/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
});
