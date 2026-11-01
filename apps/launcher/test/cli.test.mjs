// Process-level CLI tests: the binary must parse subcommands/flags and use the
// documented exit codes (0 ok, 2 usage). These spawn the real cli.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 20_000,
  });
}

test("--help lists the four commands and exits 0", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /atk <command>/);
  for (const command of ["start", "stop", "status", "logs"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`), `help must document ${command}`);
  }
});

test("no command prints usage and exits 2 (usage error, not success)", () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Usage: atk/);
});

test("an unknown command exits 2 with a usage error", () => {
  const result = run(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test("an unknown flag exits 2", () => {
  const result = run(["status", "--bogus"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --bogus/);
});

test("an invalid --hosts value exits 2", () => {
  const result = run(["start", "--hosts", "0", "--data", "ignored"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--hosts must be an integer in 1\.\.16/);
});

test("status --json on a data dir with no state reports running:false and exits 0", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-launcher-cli-"));
  try {
    const result = run(["status", "--json", "--data", dir]);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout.trim());
    assert.equal(status.running, false);
    assert.deepEqual(status.children, []);
    assert.equal(status.port, null);
    assert.doesNotMatch(result.stdout, /token/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs on an empty data dir reports that there is nothing to show and exits 0", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-launcher-cli-"));
  try {
    const result = run(["logs", "--data", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no logs yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
