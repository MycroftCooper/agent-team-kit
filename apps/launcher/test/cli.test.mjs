// Process-level CLI tests: the binary must parse subcommands/flags and use the
// documented exit codes (0 ok, 2 usage). These spawn the real cli.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function makeCorruptDataDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-launcher-cli-corrupt-"));
  mkdirSync(path.join(dir, "runtime"), { recursive: true });
  writeFileSync(path.join(dir, "launcher.json"), '{"version":1,"children":"broken"');
  writeFileSync(path.join(dir, "runtime", "launcher.pid"), JSON.stringify({ pid: 999_999, startedAt: "2026-01-01T00:00:00.000Z" }));
  return dir;
}

test("stop on a corrupt launcher.json (no live supervisor) exits 1 and preserves the pidfile", () => {
  const dir = makeCorruptDataDir();
  try {
    const result = run(["stop", "--data", dir]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, /corrupt\/unreadable|corrupt/);
    assert.ok(existsSync(path.join(dir, "launcher.json")), "the corrupt state file must be preserved for inspection");
    assert.ok(existsSync(path.join(dir, "runtime", "launcher.pid")), "the pidfile must not be deleted on a failed stop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status --json on a corrupt launcher.json exits 1 and says it is not running", () => {
  const dir = makeCorruptDataDir();
  try {
    const result = run(["status", "--json", "--data", dir]);
    assert.equal(result.status, 1, `${result.stdout} ${result.stderr}`);
    const status = JSON.parse(result.stdout.trim());
    assert.equal(status.running, false);
    assert.equal(status.statePresent, true);
    assert.match(status.health.error, /corrupt/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start on a corrupt launcher.json without a live supervisor refuses to start (exit 1)", () => {
  const dir = makeCorruptDataDir();
  try {
    const result = run(["start", "--port", "1", "--data", dir], { timeoutMs: 20_000 });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, /corrupt\/unreadable|corrupt/);
    assert.ok(existsSync(path.join(dir, "launcher.json")), "start must not delete a corrupt state file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
