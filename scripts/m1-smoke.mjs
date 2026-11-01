#!/usr/bin/env node
// M1 end-to-end smoke gate.
//
// Boots the real backend (real SQLite store, real HTTP server) against a
// throwaway database migrated from this repository's own .agent-flow/state.json,
// serves the built SPA, and asserts the behaviours M1 promises: health without a
// token, 403 without a token, session bootstrap, project/task reads, a live SSE
// stream, the SPA (including client-side routes) and a refusal for a non-loopback
// Host. Everything runs on a free port in the OS temp dir.
//
// Usage: node scripts/m1-smoke.mjs [--verbose]
// Exit: 0 = all checks pass, 1 = a check failed, 2 = prerequisites missing.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");
const CLI = path.join(ROOT, "apps", "backend", "cli.mjs");
const DIST = path.join(ROOT, "apps", "web", "dist");
const STATE = path.join(ROOT, ".agent-flow", "state.json");

function log(...args) {
  if (verbose) process.stdout.write(`${args.join(" ")}\n`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function waitForHealth(base, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`${base}/api/v1/system/health`);
      if (response.ok) return response;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

const checks = [];
function check(name, fn) {
  checks.push(async () => {
    try {
      const detail = await fn();
      return { name, ok: true, detail: detail ?? "" };
    } catch (error) {
      return { name, ok: false, detail: String(error?.message ?? error) };
    }
  });
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
function json(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Minimal raw HTTP/1.1 GET so the harness can send a forged Host header
 *  (`fetch` refuses to override Host, and the DNS-rebinding guard is exactly
 *  about that header). Returns the status code and the body text. */
function rawGet({ port, host, requestPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let response = "";
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5000, () => fail(new Error("raw request timed out")));
    socket.on("error", fail);
    socket.on("connect", () => {
      const lines = [`GET ${requestPath} HTTP/1.1`, `Host: ${host}`, "Connection: close"];
      for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("close", () => {
      const [head] = response.split("\r\n\r\n");
      const status = Number.parseInt(String(head).split(" ")[1] ?? "-1", 10);
      resolve({ status, text: response.slice(response.indexOf("\r\n\r\n") + 4) });
    });
  });
}

if (!existsSync(CLI)) {
  process.stderr.write(`m1-smoke: missing ${CLI}\n`);
  process.exit(2);
}
if (!existsSync(STATE)) {
  process.stderr.write(`m1-smoke: missing ${STATE} (run this from the repository root)\n`);
  process.exit(2);
}
const hasDist = existsSync(path.join(DIST, "index.html"));
if (!hasDist) process.stdout.write("note: apps/web/dist is not built; SPA checks will be skipped (NOT a pass)\n");

const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m1-smoke-"));
const dbFile = path.join(tmp, "atk.db");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const results = [];

// ---------------------------------------------------------------------------
// migrate the repository's own legacy state into a real database
// ---------------------------------------------------------------------------
const migrate = await run(["migrate", "--data", dbFile, "--from", STATE, "--json"]);
const migrateReport = json(migrate.stdout.slice(migrate.stdout.indexOf("{")));
if (migrate.code !== 0 || !migrateReport) {
  process.stderr.write(`m1-smoke: migrate failed (exit ${migrate.code})\n${migrate.stdout}\n${migrate.stderr}\n`);
  process.exit(1);
}

check("migrate reports PASS and maps the legacy state", () => {
  expect(migrateReport.status === "PASS", `expected status PASS, got ${JSON.stringify(migrateReport.status)}`);
  const counts = migrateReport.counts ?? {};
  expect(Number.isInteger(counts.projects) && counts.projects >= 1, `expected >=1 project, got ${counts.projects}`);
  return `projects=${counts.projects} tasks=${counts.tasks} agents=${counts.agents}`;
});

// ---------------------------------------------------------------------------
// boot the real server
// ---------------------------------------------------------------------------
const server = spawn(
  process.execPath,
  [CLI, "serve", "--port", String(port), "--data", dbFile, "--web-dist", DIST],
  { cwd: ROOT, windowsHide: true },
);
let serverOut = "";
server.stdout.on("data", (chunk) => {
  serverOut += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOut += chunk;
});

const healthResponse = await waitForHealth(base);
if (!healthResponse) {
  process.stderr.write(`m1-smoke: server did not become healthy on ${base}\n${serverOut}\n`);
  server.kill();
  process.exit(1);
}

try {
  check("health answers without a token and reports the schema", async () => {
    const body = json(await healthResponse.text());
    expect(body?.ok === true, `expected ok:true, got ${JSON.stringify(body)}`);
    expect(body?.db?.schemaVersion === 1, `expected schemaVersion 1, got ${body?.db?.schemaVersion}`);
    return `schemaVersion=${body.db.schemaVersion}`;
  });

  check("a read without a token is refused with a JSON 403", async () => {
    const response = await fetch(`${base}/api/v1/tasks`);
    expect(response.status === 403, `expected 403, got ${response.status}`);
    expect(String(response.headers.get("content-type")).includes("application/json"), "expected a JSON body");
    const body = json(await response.text());
    expect(body?.error?.code === "NOT_AUTHORIZED", `expected NOT_AUTHORIZED, got ${body?.error?.code}`);
    return `403 ${body.error.code}`;
  });

  check("a non-loopback Host is refused (DNS rebinding guard)", async () => {
    const response = await rawGet({ port, host: "evil.example", requestPath: "/api/v1/system/health" });
    expect(response.status === 403, `expected 403 for a foreign Host, got ${response.status}`);
    const body = json(response.text);
    expect(body?.error?.details?.reason === "host-not-loopback", `expected host-not-loopback, got ${JSON.stringify(body?.error)}`);
    return "403 host-not-loopback";
  });

  let session;
  check("session bootstrap returns a token and a csrf value", async () => {
    const response = await fetch(`${base}/api/v1/session`);
    expect(response.ok, `expected 200, got ${response.status}`);
    session = json(await response.text());
    expect(typeof session?.token === "string" && session.token.length >= 16, "expected a token");
    expect(typeof session?.csrf === "string" && session.csrf.length >= 8, "expected a csrf value");
    return `token ${session.token.length} chars, csrf ${session.csrf.length} chars`;
  });

  const authed = () => ({ "x-atk-token": session?.token ?? "" });
  const writeHeaders = () => ({
    ...authed(),
    "x-atk-csrf": session?.csrf ?? "",
    "content-type": "application/json",
    origin: base,
  });

  check("an authenticated project list returns the migrated project", async () => {
    const response = await fetch(`${base}/api/v1/projects`, { headers: authed() });
    expect(response.ok, `expected 200, got ${response.status}`);
    const body = json(await response.text());
    const items = body?.items ?? body;
    expect(Array.isArray(items) && items.length >= 1, `expected at least one project, got ${JSON.stringify(body)}`);
    return `projects=${items.map((item) => item.id).join(",")}`;
  });

  check("an authenticated task list works and PATCH requires expectedVersion", async () => {
    const list = await fetch(`${base}/api/v1/tasks`, { headers: authed() });
    expect(list.ok, `expected 200, got ${list.status}`);
    const body = json(await list.text());
    const tasks = body?.items ?? [];
    expect(Array.isArray(tasks), "expected items[]");
    if (tasks.length === 0) return "0 tasks (maintained project has no tasks yet)";
    const patch = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(tasks[0].id)}`, {
      method: "PATCH",
      headers: writeHeaders(),
      body: JSON.stringify({ title: "smoke" }),
    });
    expect(patch.status === 400, `expected 400 without expectedVersion, got ${patch.status}`);
    const patchBody = json(await patch.text());
    expect(patchBody?.error?.code === "VALIDATION_ERROR", `expected VALIDATION_ERROR, got ${patchBody?.error?.code}`);
    return `tasks=${tasks.length}, PATCH without expectedVersion -> 400 ${patchBody.error.code}`;
  });

  check("the event stream opens and delivers a keep-alive or an event frame", async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/v1/events/stream`, {
      headers: authed(),
      signal: controller.signal,
    });
    expect(response.ok, `expected 200, got ${response.status}`);
    expect(String(response.headers.get("content-type")).includes("text/event-stream"), "expected text/event-stream");
    const reader = response.body.getReader();
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
    ]);
    controller.abort();
    expect(!chunk.timeout, "no SSE bytes within 5s");
    const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
    expect(text.includes(":") || text.includes("event:"), `expected SSE framing, got ${JSON.stringify(text.slice(0, 80))}`);
    return "stream open, first chunk received";
  });

  if (hasDist) {
    check("the SPA index is served at / with a no-cache header", async () => {
      const response = await fetch(`${base}/`);
      expect(response.ok, `expected 200, got ${response.status}`);
      const body = await response.text();
      expect(/<div id="root">/.test(body), "expected the SPA root element");
      expect(String(response.headers.get("cache-control")).includes("no-cache"), "expected no-cache");
      return `${body.length} bytes`;
    });

    check("a client-side route falls back to the SPA index", async () => {
      const response = await fetch(`${base}/tasks/TASK-1`);
      expect(response.ok, `expected 200, got ${response.status}`);
      const body = await response.text();
      expect(/<div id="root">/.test(body), "expected the SPA fallback");
      return "SPA fallback";
    });
  } else {
    check("SPA checks skipped because apps/web/dist is missing", () => {
      throw new Error("apps/web/dist not built: run `pnpm --filter @atk/web build` (SKIPPED, not a pass)");
    });
  }

  check("an unknown API path is a JSON 404", async () => {
    const response = await fetch(`${base}/api/v1/nope`, { headers: authed() });
    expect(response.status === 404, `expected 404, got ${response.status}`);
    const body = json(await response.text());
    expect(body?.error?.code === "NOT_FOUND", `expected NOT_FOUND, got ${body?.error?.code}`);
    return "404 NOT_FOUND";
  });

  check("the server process shuts down without hanging", async () => {
    if (server.exitCode !== null) {
      throw new Error(`server already exited with code ${server.exitCode} before shutdown test:\n${serverOut.slice(-800)}`);
    }
    const exited = new Promise((resolve) => server.on("close", (code) => resolve(code)));
    server.kill("SIGINT");
    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000))]);
    expect(code !== "timeout", "server did not exit within 8s of SIGINT");
    // On Windows SIGINT maps to TerminateProcess, so a graceful exit code is not
    // guaranteed there; on POSIX the handler must return 0.
    if (process.platform !== "win32") expect(code === 0, `expected exit 0, got ${code}`);
    return `exited (${code})`;
  });

  // Run the checks while the server is still up; the finally block below stops it.
  for (const runCheck of checks) results.push(await runCheck());
} finally {
  if (!server.killed) server.kill();
}

let failed = 0;
process.stdout.write("M1 smoke gate (real backend + real SQLite + built SPA)\n");
process.stdout.write(`port: ${port}  db: ${path.basename(dbFile)}  dist: ${hasDist ? "yes" : "no"}\n\n`);
for (const result of results) {
  if (!result.ok) failed += 1;
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n`);
  if (result.detail) process.stdout.write(`      ${result.detail.split("\n").join("\n      ")}\n`);
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
if (failed > 0) {
  process.stdout.write(`\n--- diagnostics ---\nserver pid=${server.pid} exitCode=${server.exitCode} killed=${server.killed}\n`);
  try {
    const probe = await fetch(`${base}/api/v1/system/health`);
    process.stdout.write(`post-check probe: HTTP ${probe.status}\n`);
  } catch (error) {
    process.stdout.write(
      `post-check probe FAILED: ${error?.message} cause=${error?.cause?.code ?? error?.cause?.message ?? "none"}\n`,
    );
  }
  process.stdout.write(`\n--- server output (tail) ---\n${serverOut.slice(-2000) || "(empty)"}\n`);
}

if (process.argv.includes("--keep")) process.stdout.write(`kept database: ${dbFile}\n`);
else rmSync(tmp, { recursive: true, force: true });

// Close the child's pipes before exiting: on Windows, process.exit() while the
// pipe handles are still closing trips a libuv assertion (win/async.c).
server.stdout?.destroy();
server.stderr?.destroy();
server.stdin?.destroy();
process.exitCode = failed === 0 ? 0 : 1;
