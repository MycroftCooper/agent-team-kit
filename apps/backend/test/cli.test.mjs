// CLI tests: usage, doctor exit-code semantics, and migrate's JSON inputs
// (QA2-04: UTF-8 BOM tolerance; broken JSON stays a clean exit-2 error).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

// migrate needs the database package; its tests skip (not pass) while it is
// unavailable, so this file never depends on another worker's progress.
let databaseAvailable = false;
try {
  const database = await import("@atk/database");
  databaseAvailable = typeof database.openStore === "function" && typeof database.importStateJson === "function";
} catch {
  databaseAvailable = false;
}
const DB_SKIP = databaseAvailable ? false : "@atk/database is not available in this checkout";

function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 30_000,
    windowsHide: true,
  });
}

function writeJson(file, value, { bom = false } = {}) {
  fs.writeFileSync(file, `${bom ? "\uFEFF" : ""}${JSON.stringify(value)}`, "utf8");
}

/** Legacy flow fixture; when `bom` is true every JSON file starts with U+FEFF. */
function createFlowFixture({ bom = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atk-cli-flow-"));
  const flow = path.join(root, ".agent-flow");
  fs.mkdirSync(flow, { recursive: true });
  writeJson(path.join(flow, "state.json"), { schemaVersion: 1 }, { bom });
  writeJson(
    path.join(flow, "ownership.json"),
    { schemaVersion: 1, roles: ["LEAD"], rules: [{ prefix: "apps/", role: "LEAD" }], ignoredPrefixes: [] },
    { bom },
  );
  writeJson(
    path.join(flow, "runtime.json"),
    { schemaVersion: 3, agents: [{ id: "agent-bom-01", role: "LEAD", capabilities: ["ORCHESTRATOR"], status: "idle" }] },
    { bom },
  );
  const config = path.join(root, "agent-flow.config.json");
  writeJson(config, { schemaVersion: 1, project: "bom-project" }, { bom });
  return { root, flow, config, db: path.join(root, "state.db") };
}

function migrateArgs(fixture) {
  return [
    "migrate",
    "--from",
    path.join(fixture.flow, "state.json"),
    "--config",
    fixture.config,
    "--data",
    fixture.db,
    "--dry-run",
    "--json",
  ];
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

test("cli.mjs doctor --json reports checks and couples its exit code to report.ok", () => {
  const result = runCli(["doctor", "--json"]);
  assert.ok([0, 1].includes(result.status), `unexpected exit ${result.status}: ${result.stderr}`);
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
  assert.equal(result.status === 0, report.ok, "doctor exit code must mirror report.ok");
});

test("doctor exits 1 when a check FAILs (port 1421 occupied)", async (t) => {
  // Hold 127.0.0.1:1421 from a separate process so doctor's port probe FAILs.
  // If the port is already occupied by something else, the outcome is the same.
  const blocker = spawn(
    process.execPath,
    [
      "-e",
      "const net=require('node:net');const s=net.createServer();s.on('error',()=>process.exit(0));s.listen(1421,'127.0.0.1',()=>setTimeout(()=>process.exit(0),20000));",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  t.after(() => {
    try {
      blocker.kill();
    } catch {
      // already gone
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 600));

  const result = runCli(["doctor", "--json"]);
  const report = JSON.parse(result.stdout);
  const portCheck = report.checks.find((check) => check.id === "port-1421");
  assert.equal(portCheck.status, "FAIL");
  assert.equal(report.ok, false);
  assert.equal(result.status, 1, "a failing doctor check must produce a non-zero exit code");
});

test("cli.mjs migrate with a missing state file fails cleanly (exit 2, no stack trace)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atk-cli-migrate-"));
  try {
    const result = runCli(["migrate", "--from", "does-not-exist.json", "--json"], { cwd });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /JSON file not found/);
    assert.match(result.stderr, /does-not-exist\.json/);
    assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("cli serve prints the internal token once and enforces it on /internal/v1", { skip: DB_SKIP }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atk-cli-serve-"));
  const child = spawn(process.execPath, [CLI, "serve", "--port", "0", "--data", path.join(dir, "serve.db")], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort on Windows file locks
    }
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !(/internal token: \S+/.test(stdout) && /listening on http/.test(stdout))) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(stdout, /listening on http:\/\/127\.0\.0\.1:\d+/, `server did not start: ${stdout} ${stderr}`);

  const tokenLines = stdout.match(/^internal token: (.+)$/gm) ?? [];
  assert.equal(tokenLines.length, 1, "the internal token is printed exactly once");
  const token = tokenLines[0].replace("internal token: ", "").trim();
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);

  const base = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)[1];
  const heartbeatBody = JSON.stringify({ ownerId: "host-1", status: "IDLE", capabilities: {}, sessions: [] });

  const authorized = await fetch(`${base}/internal/v1/runtime/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-atk-internal": token, "x-atk-internal-role": "runtime-host" },
    body: heartbeatBody,
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).ok, true);

  const unauthorized = await fetch(`${base}/internal/v1/runtime/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: heartbeatBody,
  });
  assert.equal(unauthorized.status, 403);
  const errorText = await unauthorized.text();
  assert.equal(errorText.includes(token), false, "the internal token never appears in a response");
  assert.match(errorText, /internal-token-missing/);

  // The browser session plane must not accept the internal credential either.
  const browserToken = await fetch(`${base}/api/v1/tasks`, { headers: { "x-atk-internal": token } });
  assert.equal(browserToken.status, 403);
});

test("cli.mjs rejects an unknown command with exit 2 and a clean message", () => {
  const result = runCli(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "frobnicate"/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
});

test("migrate accepts BOM-prefixed state/ownership/runtime/config (QA2-04)", { skip: DB_SKIP }, (t) => {
  const fixture = createFlowFixture({ bom: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = runCli(migrateArgs(fixture), { cwd: fixture.root });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "PASS");
  assert.equal(report.manifest.project.id, "bom-project", "BOM config.json was read");
  assert.equal(report.manifest.ownership.rules, 1, "BOM ownership.json was read");
  assert.equal(report.manifest.runtime.agents, 1, "BOM runtime.json was read");
  assert.equal(report.problems.some((problem) => problem.level === "error"), false);
});

test("migrate still accepts the same files without a BOM (no regression)", { skip: DB_SKIP }, (t) => {
  const fixture = createFlowFixture({ bom: false });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = runCli(migrateArgs(fixture), { cwd: fixture.root });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "PASS");
  assert.equal(report.manifest.project.id, "bom-project");
});

test("migrate rejects broken state JSON with file name, location and exit 2", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atk-cli-badstate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, ".agent-flow", "state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, '\uFEFF{\n  "schemaVersion": 1,\n  bad\n}', "utf8");

  const result = runCli(["migrate", "--from", stateFile, "--json"], { cwd: root });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /Invalid JSON in/);
  assert.ok(result.stderr.includes(stateFile), "message names the broken file");
  assert.match(result.stderr, /line \d+|position \d+|offset \d+/, "message locates the problem");
  assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
});

test("migrate rejects broken ownership.json with the sidecar file name", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atk-cli-badown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const flow = path.join(root, ".agent-flow");
  fs.mkdirSync(flow, { recursive: true });
  writeJson(path.join(flow, "state.json"), { schemaVersion: 1 });
  fs.writeFileSync(path.join(flow, "ownership.json"), "{ not json", "utf8");

  const result = runCli(["migrate", "--from", path.join(flow, "state.json"), "--json"], { cwd: root });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /Invalid JSON in/);
  assert.match(result.stderr, /ownership\.json/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
});
