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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** Read an SSE body until `predicate(text)` is true or the deadline passes. */
async function readFor(reader, timeoutMs, predicate = null) {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
    ]);
    if (chunk.timeout || chunk.done) break;
    text += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
    if (predicate && predicate(text)) break;
  }
  return text;
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

check("migrate reports PASS and maps every task the legacy state carries", () => {
  expect(migrateReport.status === "PASS", `expected status PASS, got ${JSON.stringify(migrateReport.status)}`);
  const counts = migrateReport.counts ?? {};
  expect(Number.isInteger(counts.projects) && counts.projects >= 1, `expected >=1 project, got ${counts.projects}`);
  // The legacy state maps every slice + package + subitem to a task, so a silent
  // drop (the failure mode a "projects >= 1" assertion would miss) shows up here.
  const legacy = JSON.parse(readFileSync(STATE, "utf8").replace(/^\uFEFF/, ""));
  const expectedTasks = (legacy.batch?.slices?.length ?? 0) + (legacy.packages?.length ?? 0) + (legacy.subitems?.length ?? 0);
  expect(expectedTasks > 0, "the source state.json carries no tasks; the fixture is not useful");
  expect(
    counts.tasks === expectedTasks,
    `expected ${expectedTasks} migrated tasks (slices+packages+subitems), got ${counts.tasks}`,
  );
  return `projects=${counts.projects} tasks=${counts.tasks}/${expectedTasks} agents=${counts.agents}`;
});

// ---------------------------------------------------------------------------
// boot the real server
// ---------------------------------------------------------------------------
const server = spawn(
  process.execPath,
  [CLI, "serve", "--port", String(port), "--data", dbFile, "--web-dist", DIST],
  {
    cwd: ROOT,
    windowsHide: true,
    // Keep the session-token file inside the throwaway directory: the backend
    // writes it under %LOCALAPPDATA%, and a smoke run must not overwrite the
    // token of the user's running instance (QA finding QA2-03).
    env: { ...process.env, LOCALAPPDATA: tmp },
  },
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
  check("the token file stays inside the throwaway data directory", () => {
    const tokenFile = path.join(tmp, "AgentTeamKit", "runtime", "session-token");
    expect(existsSync(tokenFile), `expected the session token at ${tokenFile}`);
    const userTokenFile = path.join(process.env.LOCALAPPDATA ?? "", "AgentTeamKit", "runtime", "session-token");
    expect(path.resolve(tokenFile) !== path.resolve(userTokenFile), "the smoke run must not touch the user's token file");
    return `isolated at ${path.join("...", "AgentTeamKit", "runtime", "session-token")}`;
  });
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
    // A zero-task list must not be reported as a pass: it would hide a migration
    // that silently dropped everything (QA finding QA2-02).
    expect(tasks.length >= 1, `expected at least one task, got ${tasks.length}`);
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

  check("a write without the csrf header is refused", async () => {
    const list = await fetch(`${base}/api/v1/tasks`, { headers: authed() });
    const tasks = json(await list.text())?.items ?? [];
    expect(tasks.length >= 1, "expected a task to patch");
    const { "x-atk-csrf": _csrf, ...noCsrf } = writeHeaders();
    const response = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(tasks[0].id)}`, {
      method: "PATCH",
      headers: noCsrf,
      body: JSON.stringify({ title: "smoke" }),
    });
    expect(response.status === 403, `expected 403 without csrf, got ${response.status}`);
    const body = json(await response.text());
    expect(body?.error?.code === "NOT_AUTHORIZED", `expected NOT_AUTHORIZED, got ${body?.error?.code}`);
    return `403 ${body.error.details?.reason ?? body.error.code}`;
  });

  check("the write path works: create 201, patch 200 with the returned version, stale patch 409", async () => {
    const projects = json(await (await fetch(`${base}/api/v1/projects`, { headers: authed() })).text());
    const projectId = (projects?.items ?? projects)[0]?.id;
    expect(projectId, "expected a project id");
    const created = await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({
        projectId,
        title: "smoke task",
        description: "created by scripts/m1-smoke.mjs",
        functionRequired: "WORKER",
        roleRequired: "DEV",
        priority: 2,
        deps: [],
        acceptance: "the smoke gate can write",
      }),
    });
    const createdText = await created.text();
    expect(created.status === 201, `expected 201, got ${created.status}: ${createdText}`);
    const task = json(createdText);
    expect(task?.id, "expected a created task id");
    expect(task?.status === "READY", `expected the server to own status READY, got ${task?.status}`);

    const patched = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: writeHeaders(),
      body: JSON.stringify({ expectedVersion: task.version, title: "patched by the smoke gate" }),
    });
    const patchedText = await patched.text();
    expect(patched.status === 200, `expected 200, got ${patched.status}: ${patchedText}`);
    const updated = json(patchedText);
    expect(updated?.version === task.version + 1, `expected version ${task.version + 1}, got ${updated?.version}`);

    const stale = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: writeHeaders(),
      body: JSON.stringify({ expectedVersion: task.version, title: "stale write" }),
    });
    expect(stale.status === 409, `expected 409 for a stale version, got ${stale.status}`);
    const staleBody = json(await stale.text());
    expect(staleBody?.error?.code === "TASK_VERSION_CONFLICT", `expected TASK_VERSION_CONFLICT, got ${staleBody?.error?.code}`);
    return `201 -> 200 (v${task.version}→v${updated.version}) -> 409 ${staleBody.error.code}`;
  });

  check("the event stream opens with a heartbeat", async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/v1/events/stream`, { headers: authed(), signal: controller.signal });
    expect(response.ok, `expected 200, got ${response.status}`);
    expect(String(response.headers.get("content-type")).includes("text/event-stream"), "expected text/event-stream");
    const reader = response.body.getReader();
    const text = await readFor(reader, 5000);
    controller.abort();
    expect(text.length > 0, "no SSE bytes within 5s");
    // A heartbeat/comment frame proves the stream is alive; business events need a
    // producer, which M1 does not have yet (that is M2/M3).
    expect(/^: /m.test(text), `expected an SSE comment frame, got ${JSON.stringify(text.slice(0, 120))}`);
    return "heartbeat frame received";
  });

  check("a last-event-id past the log asks the client to resync instead of skipping", async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/v1/events/stream`, {
      headers: { ...authed(), "last-event-id": "999999" },
      signal: controller.signal,
    });
    expect(response.ok, `expected 200, got ${response.status}`);
    const reader = response.body.getReader();
    const text = await readFor(reader, 5000);
    controller.abort();
    expect(/event: system\.resync-required/.test(text), `expected a resync frame, got ${JSON.stringify(text.slice(0, 200))}`);
    return "system.resync-required received";
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
