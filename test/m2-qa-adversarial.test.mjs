// M2 independent QA: adversarial regression suite (QA-003).
//
// Scope: the M2 "execution layer" from the frozen commit `fed5ee8` and its
// post-freeze fix `b8fc426`: internal API credential isolation, atomic dispatch
// claim / lease fencing, Run state machine + single-writer events, crash-time
// recovery, migration v1 -> v2 and the honesty of the `m2-smoke` gate itself.
//
// Conventions
// - real SQLite (`node:sqlite`) and a real `cli.mjs serve` on a random port;
// - every test gets its own temp database/directory, cleaned up afterwards;
// - tests marked `{ todo }` assert the M2 contract but FAIL on fed5ee8/b8fc426:
//   they encode open QA findings (QA3-02/03/04/05). When the fix lands they turn
//   into Node's "unexpected pass" and the todo marker must be removed.
//
// Node < 22.5 has no `node:sqlite`: the whole file is skipped, never "passed".
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "apps", "backend", "cli.mjs");
const STATE = path.join(REPO, ".agent-flow", "state.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

if (!hasSqlite) {
  test("m2 adversarial suite (skipped: node:sqlite is unavailable)", { skip: "node:sqlite requires Node >= 22.5; this file is skipped, not passed" }, () => {});
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { openStore } = await import(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href);
  const { createMockRuntime } = await import(pathToFileURL(path.join(REPO, "packages/runtime-sdk/src/mock.mjs")).href);
  const { createHost } = await import(pathToFileURL(path.join(REPO, "apps/runtime-host/src/host.mjs")).href);
  const { createInternalClient } = await import(pathToFileURL(path.join(REPO, "apps/runtime-host/src/client.mjs")).href);
  const quiet = { info() {}, warn() {}, error() {} };

  function migrate(dbFile) {
    const result = spawnSync(process.execPath, [CLI, "migrate", "--data", dbFile, "--from", STATE, "--json"], {
      cwd: REPO,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, `migrate failed: ${result.stderr || result.stdout}`);
  }

  async function makeEnv(t, { withBackend = false } = {}) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m2-qa-"));
    const dbFile = path.join(tmp, "atk.db");
    migrate(dbFile);
    const store = openStore({ file: dbFile, migrate: true });
    const project = store.listProjects()[0];
    const task = store.listTasks({ projectId: project.id })[0];
    assert.ok(project && task, "migrated repository state must expose a project and a task");

    const env = {
      tmp,
      dbFile,
      store,
      project,
      task,
      backend: null,
      base: null,
      internalToken: null,
      session: null,
      seed(label = "qa") {
        // M6.3 F05: the Host refuses to start without a frozen TaskExecutionSpec.
        // Freeze it as the real claim path would; the backend dispatch route
        // attaches it to the claim response.
        const frozen = typeof store.freezeTaskSpec === "function" ? store.freezeTaskSpec(task.id, { workspace: { kind: "none" } }) : null;
        const run = store.createRun({ taskId: task.id, agentId: "agent-dev-01", function: "WORKER", role: "DEV", ...(frozen ? { specHash: frozen.specHash, workspace: frozen.spec.workspace } : {}) });
        const command = store.enqueueDispatchCommand({
          runId: run.id,
          commandType: "START_RUN",
          payload: { prompt: label, ...(frozen ? { specHash: frozen.specHash } : {}) },
          idempotencyKey: `${label}-${run.id}`,
        });
        return { run: store.getRun(run.id), command };
      },
      raw() {
        return new DatabaseSync(dbFile);
      },
      async start() {
        env.base = null;
        const started = await freePort();
        env.port = started;
        const child = spawn(process.execPath, [CLI, "serve", "--port", String(started), "--data", dbFile], {
          cwd: REPO,
          windowsHide: true,
          env: { ...process.env, LOCALAPPDATA: tmp },
        });
        env.backend = child;
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        let healthy = false;
        for (let i = 0; i < 120; i += 1) {
          try {
            const response = await fetch(`http://127.0.0.1:${started}/api/v1/system/health`);
            if (response.ok) {
              healthy = true;
              break;
            }
          } catch {
            /* not up yet */
          }
          await sleep(50);
        }
        assert.ok(healthy, `backend did not become healthy: ${output.slice(-500)}`);
        const tokenPair = output.match(/internal tokens:\s*scheduler=(\S+)\s+runtime-host=(\S+)/);
        assert.ok(tokenPair, `backend did not print the two internal tokens: ${output.slice(-700)}`);
        env.tokens = { scheduler: tokenPair[1], "runtime-host": tokenPair[2] };
        // Backwards-compatible fixture alias: most existing probes use the
        // scheduler credential; host-only calls use env.tokens["runtime-host"].
        env.internalToken = env.tokens.scheduler;
        env.base = `http://127.0.0.1:${started}`;
        env.output = () => output;
        env.session = await (await fetch(`${env.base}/api/v1/session`)).json();
        // M6.1: /internal/v1/* is role-scoped. This is the fixture-side mirror
        // of the frozen endpoint matrix (no import of backend internals).
        const roleFor = (method, route) => {
          const pathname = route.split("?")[0];
          if (method === "GET" && pathname === "/internal/v1/dispatch/claim") return "runtime-host";
          if (method === "POST" && /^\/internal\/v1\/dispatch\/[^/]+\/result$/.test(pathname)) return "runtime-host";
          if (/^\/internal\/v1\/runs\/[^/]+\/(renew|events)$/.test(pathname)) return "runtime-host";
          if (method === "GET" && /^\/internal\/v1\/runs\/[^/]+\/reconcile$/.test(pathname)) return "runtime-host";
          if (pathname === "/internal/v1/runtime/heartbeat") return "runtime-host";
          if (method === "POST" && /^\/internal\/v1\/tasks\/[^/]+\/claim$/.test(pathname)) return "scheduler";
          if (pathname === "/internal/v1/scheduling/snapshot") return "scheduler";
          if (pathname === "/internal/v1/scheduler/heartbeat") return "scheduler";
          if (pathname === "/internal/v1/dispatch/sweep") return "scheduler";
          if (method === "POST" && /^\/internal\/v1\/tasks\/[^/]+\/integration$/.test(pathname)) return "scheduler";
          return null;
        };
        env.internal = async (method, route, body) => {
          const role = roleFor(method, route);
          const token = env.tokens[role] ?? env.tokens.scheduler;
          const response = await fetch(`${env.base}${route}`, {
            method,
            headers: {
              "x-atk-internal": token,
              ...(role ? { "x-atk-internal-role": role } : {}),
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          return { status: response.status, body: await response.json().catch(() => null) };
        };
        env.api = async (route) => {
          const response = await fetch(`${env.base}${route}`, { headers: { "x-atk-token": env.session.token } });
          return { status: response.status, body: await response.json().catch(() => null) };
        };
        return env;
      },
    };

    t.after(async () => {
      if (env.backend && env.backend.exitCode === null) {
        env.backend.kill();
        for (let i = 0; i < 40 && env.backend.exitCode === null; i += 1) await sleep(25);
      }
      try {
        store.close();
      } catch {
        /* already closed */
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(tmp, { recursive: true, force: true });
          return;
        } catch {
          await sleep(150);
        }
      }
    });

    if (withBackend) await env.start();
    return env;
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

  function readRun(env, runId) {
    const raw = env.raw();
    try {
      return raw.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    } finally {
      raw.close();
    }
  }

  function readCommand(env, runId) {
    const raw = env.raw();
    try {
      return raw.prepare("SELECT * FROM dispatch_commands WHERE run_id = ?").get(runId);
    } finally {
      raw.close();
    }
  }

  function countEvents(env, runId, type) {
    const raw = env.raw();
    try {
      return raw.prepare("SELECT COUNT(*) AS c FROM events WHERE aggregate_id = ? AND type = ?").get(runId, type).c;
    } finally {
      raw.close();
    }
  }

  function setLeaseWindow(env, runId, iso) {
    const raw = env.raw();
    try {
      raw.prepare("UPDATE dispatch_commands SET claimed_until = ? WHERE run_id = ?").run(iso, runId);
      raw.prepare("UPDATE run_leases SET claimed_until = ? WHERE run_id = ?").run(iso, runId);
    } finally {
      raw.close();
    }
  }

  async function waitFor(predicate, timeoutMs = 8000, label = "condition") {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  // -------------------------------------------------------------------------
  // A. internal credential plane
  // -------------------------------------------------------------------------
  test("A1 the internal plane accepts only x-atk-internal (both directions)", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const anonymous = await fetch(`${env.base}/internal/v1/dispatch/claim?owner=qa&leaseMs=1000`);
    assert.equal(anonymous.status, 403);
    assert.equal((await anonymous.json()).error.details.reason, "internal-token-missing");

    const wrong = await fetch(`${env.base}/internal/v1/dispatch/claim?owner=qa&leaseMs=1000`, { headers: { "x-atk-internal": "not-the-token" } });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).error.details.reason, "internal-token-invalid");

    const browserOnInternal = await fetch(`${env.base}/internal/v1/dispatch/claim?owner=qa&leaseMs=1000`, { headers: { "x-atk-token": env.session.token } });
    assert.equal(browserOnInternal.status, 403);
    assert.equal((await browserOnInternal.json()).error.details.reason, "internal-token-missing");

    const internalOnBrowser = await fetch(`${env.base}/api/v1/tasks`, { headers: { "x-atk-internal": env.internalToken } });
    assert.equal(internalOnBrowser.status, 403);
    assert.equal((await internalOnBrowser.json()).error.details.reason, "token-missing");

    // public diagnostics stay public; the browser session endpoint ignores the internal header
    assert.equal((await fetch(`${env.base}/api/v1/system/health`, { headers: { "x-atk-internal": env.internalToken } })).status, 200);
    assert.equal((await fetch(`${env.base}/api/v1/session`, { headers: { "x-atk-internal": env.internalToken } })).status, 200);
  });

  test("A2 the internal plane keeps the loopback Host allow-list", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const forged = await rawHttp(env.port, "GET /internal/v1/dispatch/claim?owner=qa&leaseMs=1000 HTTP/1.1\r\nHost: localhost.evil.example\r\nx-atk-internal: " + env.internalToken + "\r\nConnection: close\r\n\r\n");
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error.details.reason, "host-not-loopback");

    const noHost = await rawHttp(env.port, "GET /internal/v1/dispatch/claim?owner=qa&leaseMs=1000 HTTP/1.0\r\n\r\n");
    assert.equal(noHost.status, 403);
    assert.equal(noHost.body.error.details.reason, "host-missing");
  });

  test("A3 the internal token never leaks (responses, headers, files, repeated stdout, M2 sources)", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const surface = [];
    const scan = async (label, response) => {
      const text = await response.text();
      surface.push({ label, body: text.includes(env.internalToken), headers: JSON.stringify([...response.headers]).includes(env.internalToken) });
    };
    await scan("health", await fetch(`${env.base}/api/v1/system/health`));
    await scan("session", await fetch(`${env.base}/api/v1/session`));
    await scan("claim", await fetch(`${env.base}/internal/v1/dispatch/claim?owner=qa&leaseMs=1000`, { headers: { "x-atk-internal": env.internalToken } }));
    await scan("bad-token", await fetch(`${env.base}/internal/v1/dispatch/claim?owner=qa&leaseMs=1000`, { headers: { "x-atk-internal": "wrong" } }));
    await scan("unknown-internal-route", await fetch(`${env.base}/internal/v1/nope`, { headers: { "x-atk-internal": env.internalToken } }));
    assert.deepEqual(surface, surface.map((entry) => ({ ...entry, body: false, headers: false })), "token leaked into an HTTP surface");

    const occurrences = env.output().split(env.internalToken).length - 1;
    assert.equal(occurrences, 1, "the internal token must be printed exactly once (child env handoff), never logged repeatedly");

    const leakedFiles = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          try {
            if (readFileSync(full, "utf8").includes(env.internalToken)) leakedFiles.push(path.relative(env.tmp, full));
          } catch {
            /* binary/unreadable */
          }
        }
      }
    };
    walk(env.tmp);
    assert.deepEqual(leakedFiles, [], "the internal token must never be persisted to disk");

    const roots = ["apps/runtime-host", "packages/runtime-sdk", "packages/workspace"];
    const files = [];
    const collect = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.isFile() && /\.(mjs|js|ts|json|md)$/.test(entry.name)) files.push(full);
      }
    };
    for (const relative of roots) collect(path.join(REPO, relative));
    for (const relative of ["docs/architecture/m2-contracts.md", "docs/roadmap/m2-status.md", "scripts/m2-smoke.mjs"]) files.push(path.join(REPO, relative));
    const secretHits = [];
    const userName = process.env.USERNAME;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/\bsk-[A-Za-z0-9_-]{12,}/.test(text)) secretHits.push(`${path.relative(REPO, file)}:sk-*`);
      if (userName && text.includes(userName)) secretHits.push(`${path.relative(REPO, file)}:username`);
      if (/C:\\\\Users\\\\[^\\\s<]/.test(text)) secretHits.push(`${path.relative(REPO, file)}:absolute-home`);
    }
    assert.deepEqual(secretHits, [], "M2 sources must not embed credentials or real local paths");
  });

  test("A4 the internal token does not leak into SSE frames", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("sse-leak");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=sse&leaseMs=5000");
    assert.equal(claim.status, 200);

    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`${env.base}/api/v1/events/stream`, {
      headers: { "x-atk-token": env.session.token },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readSome = async () => {
      const { value, done } = await reader.read();
      if (done) return false;
      text += decoder.decode(value, { stream: true });
      return true;
    };
    await Promise.race([readSome(), sleep(2000)]);
    await env.internal("POST", `/internal/v1/runs/${run.id}/events`, {
      generation: claim.body.lease.generation,
      events: [{ type: "session.started", sessionId: "sse-leak", at: new Date().toISOString() }],
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !text.includes("run.updated")) await readSome();
    assert.ok(text.includes("run.updated"), `expected a run.updated frame, got: ${JSON.stringify(text.slice(0, 300))}`);
    assert.ok(!text.includes(env.internalToken), "the internal token must never appear in SSE frames");
  });

  // -------------------------------------------------------------------------
  // B. claim + lease concurrency (own harness, not the product tests)
  // -------------------------------------------------------------------------
  test("B1 two real processes claiming at the same instant produce one winner", async (t) => {
    const env = await makeEnv(t);
    env.seed("proc-claim");
    const childFile = path.join(env.tmp, "claim-child.mjs");
    writeFileSync(
      childFile,
      `import { openStore } from ${JSON.stringify(pathToFileURL(path.join(REPO, "packages/database/src/index.mjs")).href)};
const [db, owner, startAt] = process.argv.slice(2);
const store = openStore({ file: db, migrate: true });
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));
const claim = store.claimDispatchCommand({ ownerId: owner, leaseMs: 5000 });
store.close();
process.stdout.write(JSON.stringify({ owner, claimed: Boolean(claim), commandId: claim?.command?.id ?? null, generation: claim?.lease?.generation ?? null, attempts: claim?.command?.attempts ?? null }));
`,
    );
    const startAt = Date.now() + 700;
    const runChild = (owner) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [childFile, env.dbFile, owner, String(startAt)], { cwd: env.tmp, windowsHide: true });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.on("close", () => {
          try {
            resolve(JSON.parse(output));
          } catch {
            resolve({ owner, raw: output });
          }
        });
      });
    const results = await Promise.all([runChild("proc-A"), runChild("proc-B")]);
    const winners = results.filter((entry) => entry.claimed);
    assert.equal(winners.length, 1, `exactly one claim may win, got ${JSON.stringify(results)}`);
    assert.equal(winners[0].attempts, 1);
    assert.ok(["proc-A", "proc-B"].includes(winners[0].owner));
  });

  test("B2 a live lease is not stealable; an expired one is", async (t) => {
    const env = await makeEnv(t);
    const { command } = env.seed("live-lease");
    const first = env.store.claimDispatchCommand({ ownerId: "holder-A", leaseMs: 5000 });
    assert.ok(first);
    assert.equal(env.store.claimDispatchCommand({ ownerId: "holder-B", leaseMs: 5000 }), null, "a live lease must not be claimable");

    setLeaseWindow(env, command.runId, new Date(Date.now() - 1).toISOString());
    const second = env.store.claimDispatchCommand({ ownerId: "holder-B", leaseMs: 5000 });
    assert.ok(second, "an expired lease must be re-claimable");
    assert.equal(second.command.attempts, 2);
    assert.equal(second.lease.generation, first.lease.generation + 1, "generation must be monotonic across claims");
    assert.equal(second.lease.ownerId, "holder-B");
  });

  test("B3 lease expiry boundary: closed 1 ms before, open 1 ms after", async (t) => {
    const env = await makeEnv(t);
    const { command } = env.seed("boundary");
    assert.ok(env.store.claimDispatchCommand({ ownerId: "boundary", leaseMs: 5000 }));
    setLeaseWindow(env, command.runId, new Date(Date.now() + 1000).toISOString());
    assert.equal(env.store.claimDispatchCommand({ ownerId: "boundary-2", leaseMs: 5000 }), null, "1000 ms before expiry a claim must lose");
    setLeaseWindow(env, command.runId, new Date(Date.now() - 1).toISOString());
    const after = env.store.claimDispatchCommand({ ownerId: "boundary-2", leaseMs: 5000 });
    assert.ok(after, "1 ms after expiry a claim must win");
    assert.equal(after.command.attempts, 2);
  });

  test("B4 a second PENDING command for the same run waits for the live lease", async (t) => {
    const env = await makeEnv(t);
    const first = env.seed("two-commands");
    const second = env.store.enqueueDispatchCommand({
      runId: first.run.id,
      commandType: "START_RUN",
      payload: { prompt: "second" },
      idempotencyKey: `second-${first.run.id}`,
    });
    assert.notEqual(second.id, first.command.id);
    const claim = env.store.claimDispatchCommand({ ownerId: "two", leaseMs: 5000 });
    assert.equal(claim.command.id, first.command.id);
    assert.equal(env.store.claimDispatchCommand({ ownerId: "two-b", leaseMs: 5000 }), null, "the second command must wait for the live lease");

    setLeaseWindow(env, first.run.id, new Date(Date.now() - 1).toISOString());
    const reclaimed = env.store.claimDispatchCommand({ ownerId: "two-c", leaseMs: 5000 });
    assert.ok(reclaimed);
    assert.equal(reclaimed.command.id, first.command.id, "claim retries the expired command before a fresh PENDING one (ruling 6)");
    assert.equal(reclaimed.command.attempts, 2);
    const raw = env.raw();
    try {
      assert.equal(raw.prepare("SELECT status FROM dispatch_commands WHERE id = ?").get(second.id).status, "PENDING");
    } finally {
      raw.close();
    }
  });

  test("B5 idempotencyKey replays one command and re-claims raise attempts/generation", async (t) => {
    const env = await makeEnv(t);
    const { run } = env.seed("idem");
    const key = `idem-${run.id}`;
    const a = env.store.enqueueDispatchCommand({ runId: run.id, commandType: "START_RUN", payload: { prompt: "a" }, idempotencyKey: key });
    const b = env.store.enqueueDispatchCommand({ runId: run.id, commandType: "START_RUN", payload: { prompt: "b" }, idempotencyKey: key });
    assert.equal(a.id, b.id, "the same idempotencyKey must not create a second command");
    const claim = env.store.claimDispatchCommand({ ownerId: "idem", leaseMs: 5000 });
    assert.equal(claim.command.id, a.id);
    assert.equal(claim.command.attempts, 1);
    setLeaseWindow(env, run.id, new Date(Date.now() - 1).toISOString());
    const reclaimed = env.store.claimDispatchCommand({ ownerId: "idem-2", leaseMs: 5000 });
    assert.equal(reclaimed.command.attempts, 2);
    assert.equal(reclaimed.lease.generation, 2);
  });

  test("B6 a full host session closes the dispatch command (DONE) without swallowed errors", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("full-session");
    const runtime = createMockRuntime({ scenario: "complete", sessionIdFactory: () => "full-session" });
    const host = createHost({
      client: createInternalClient({ baseUrl: env.base, token: env.tokens["runtime-host"] }),
      runtime,
      ownerId: "qa-host",
      agents: [{ agentId: "agent-dev-01", role: "DEV", function: "WORKER" }],
      allowNoneWorkspace: true,
      leaseMs: 2000,
      pollMs: 20,
      flushMs: 10,
      heartbeatMs: 500,
      logger: quiet,
    });
    await host.tick();
    await waitFor(async () => (await env.api(`/api/v1/runs/${run.id}`)).body.status === "COMPLETED", 8000, "run COMPLETED");
    await host.stop();
    const command = readCommand(env, run.id);
    assert.equal(command.status, "DONE", "the dispatch command must reach DONE; a 400 swallowed by the host is not a pass");
    assert.equal(host.stats.errors, 0, "the host must not swallow any internal API error");
  });

  // -------------------------------------------------------------------------
  // C. fencing, events, state machine
  // -------------------------------------------------------------------------
  test("C1 a stale generation is refused and writes nothing", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("stale");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=stale&leaseMs=5000");
    const generation = claim.body.lease.generation;
    const renewed = await env.internal("POST", `/internal/v1/runs/${run.id}/renew`, { ownerId: "stale", generation, leaseMs: 5000 });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.lease.generation, generation + 1);

    const staleEvents = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, {
      generation,
      events: [{ type: "session.started", sessionId: "stale", at: new Date().toISOString() }],
    });
    assert.equal(staleEvents.status, 409);
    assert.equal(staleEvents.body.error.code, "STALE_GENERATION");
    const staleResult = await env.internal("POST", `/internal/v1/dispatch/${claim.body.command.id}/result`, { ownerId: "stale", generation, status: "DONE", result: {} });
    assert.equal(staleResult.status, 409);
    const staleRenew = await env.internal("POST", `/internal/v1/runs/${run.id}/renew`, { ownerId: "stale", generation, leaseMs: 5000 });
    assert.equal(staleRenew.status, 409);

    assert.equal((await env.api(`/api/v1/runs/${run.id}`)).body.status, "STARTING");
    assert.equal(readRun(env, run.id).version, 0);
    assert.equal(countEvents(env, run.id, "run.updated"), 0);
  });

  test("an expired lease fences updateRunStatus, not just the generation (ruling 2/8)", async (t) => {
    const env = await makeEnv(t);
    const { run } = env.seed("expired-state");
    const claim = env.store.claimDispatchCommand({ ownerId: "expired-state", leaseMs: 1000 });
    env.store.updateRunStatus(run.id, { status: "RUNNING" });
    await sleep(1300);
    assert.throws(
      () => env.store.updateRunStatus(run.id, { status: "COMPLETED", exitCode: 0, generation: claim.lease.generation }),
      (error) => error.code === "STALE_GENERATION",
      "an expired holder must not be able to advance the Run",
    );
  });

  test("an expired lease fences the dispatch result", async (t) => {
    const env = await makeEnv(t);
    env.seed("expired-result");
    const claim = env.store.claimDispatchCommand({ ownerId: "expired-result", leaseMs: 1000 });
    await sleep(1300);
    assert.throws(
      () => env.store.completeDispatchCommand({ id: claim.command.id, ownerId: "expired-result", generation: claim.lease.generation, status: "DONE", result: {} }),
      (error) => error.code === "STALE_GENERATION",
      "an expired holder must not be able to close the command",
    );
  });

  test("an empty event batch is a real pure fence (ruling 3/10)", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("empty-fence");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=empty-fence&leaseMs=5000");
    const generation = claim.body.lease.generation;
    await env.internal("POST", `/internal/v1/runs/${run.id}/renew`, { ownerId: "empty-fence", generation, leaseMs: 5000 });
    const stale = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, { generation, events: [] });
    assert.equal(stale.status, 409, "an empty batch with a stale generation must be refused");
    const fresh = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, { generation: generation + 1, events: [] });
    assert.equal(fresh.status, 200, "an empty batch with the live generation is a legal no-op");
    assert.deepEqual(fresh.body.appended, []);
  });

  test("C5 large output is truncated at 8 KiB with honest byte accounting", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("truncate");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=truncate&leaseMs=5000");
    const text = "x".repeat(9000);
    const events = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, {
      generation: claim.body.lease.generation,
      events: [{ type: "output", sessionId: "truncate", stream: "stdout", text, at: new Date().toISOString() }],
    });
    assert.equal(events.status, 200);
    const raw = env.raw();
    try {
      const row = raw.prepare("SELECT payload_json FROM events WHERE aggregate_id = ? AND type = 'run.log'").get(run.id);
      assert.ok(row, "output must become a run.log event");
      const payload = JSON.parse(row.payload_json);
      assert.equal(payload.truncated, true);
      assert.equal(payload.bytes, 9000);
      assert.ok(Buffer.byteLength(payload.text, "utf8") <= 8192, "the stored text must be capped at 8 KiB");
    } finally {
      raw.close();
    }
  });

  test("C6 malformed or unknown runtime events are refused with zero writes", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("malformed");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=malformed&leaseMs=5000");
    const generation = claim.body.lease.generation;
    for (const event of [{ type: "nope", sessionId: "x", at: new Date().toISOString() }, { type: "output", sessionId: "x", stream: "stdout" }, { type: "session.started", sessionId: 42, at: new Date().toISOString() }]) {
      const response = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, { generation, events: [event] });
      assert.equal(response.status, 400, `malformed event must be refused: ${JSON.stringify(event)}`);
    }
    assert.equal((await env.api(`/api/v1/runs/${run.id}`)).body.status, "STARTING");
    assert.equal(readRun(env, run.id).version, 0);
    assert.equal(countEvents(env, run.id, "run.log"), 0);
    assert.equal(countEvents(env, run.id, "run.updated"), 0);
  });

  test("C7 duplicate batches are skipped and each transition emits exactly one run.updated", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("events");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=events&leaseMs=5000");
    const generation = claim.body.lease.generation;
    const at = new Date().toISOString();
    const batch = [
      { type: "session.started", sessionId: "s1", at },
      { type: "output", sessionId: "s1", stream: "stdout", text: "hello", at },
      { type: "session.ended", sessionId: "s1", reason: "completed", exitCode: 0, at },
    ];
    const first = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, { generation, events: batch });
    assert.equal(first.status, 200);
    const second = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, { generation, events: batch });
    assert.equal(second.status, 200);
    assert.equal(second.body.appended.length, 0);
    assert.equal(second.body.skipped, 3, "a replayed batch must be skipped, not re-applied");

    const raw = env.raw();
    try {
      const updated = raw.prepare("SELECT COUNT(*) AS c FROM events WHERE aggregate_id = ? AND type = 'run.updated'").get(run.id).c;
      assert.equal(updated, 2, "RUNNING and COMPLETED are the only transitions, one run.updated each (ruling 1)");
      const types = raw.prepare("SELECT type FROM events WHERE aggregate_id = ? AND type = 'run.updated' ORDER BY seq").all(run.id).map((row) => row.type);
      assert.deepEqual(types, ["run.updated", "run.updated"]);
      const runRow = raw.prepare("SELECT status, version FROM runs WHERE id = ?").get(run.id);
      assert.equal(runRow.status, "COMPLETED");
      assert.equal(runRow.version, 2);
    } finally {
      raw.close();
    }
    assert.equal(countEvents(env, run.id, "run.log"), 1);
  });

  test("C8 reconcile on a finished run returns the expired lease with its generation kept", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("reconcile");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=reconcile&leaseMs=5000");
    const generation = claim.body.lease.generation;
    await env.internal("POST", `/internal/v1/runs/${run.id}/events`, {
      generation,
      events: [
        { type: "session.started", sessionId: "r", at: new Date().toISOString() },
        { type: "session.ended", sessionId: "r", reason: "completed", exitCode: 0, at: new Date().toISOString() },
      ],
    });
    const result = await env.internal("POST", `/internal/v1/dispatch/${claim.body.command.id}/result`, { ownerId: "reconcile", generation, status: "DONE", result: { exitCode: 0 } });
    assert.equal(result.status, 200);
    const reconciled = await env.internal("GET", `/internal/v1/runs/${run.id}/reconcile`);
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.run.status, "COMPLETED");
    assert.ok(reconciled.body.lease, "ruling 4: releasing a lease expires it, never deletes it");
    assert.equal(reconciled.body.lease.generation, generation);
    assert.ok(Date.parse(reconciled.body.lease.claimedUntil) <= Date.now(), "the released lease must already be expired");
    assert.deepEqual(reconciled.body.sessions, []);
  });

  // -------------------------------------------------------------------------
  // D. crash windows (real backend, real host, real SQLite)
  // -------------------------------------------------------------------------
  async function crashScenario(env, { advanceStarted = false, completeRun = false } = {}) {
    const { run } = env.seed("crash");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=dead&leaseMs=1000");
    assert.equal(claim.status, 200, "seed command must be claimable");
    const generation = claim.body.lease.generation;
    const events = [];
    if (advanceStarted) events.push({ type: "session.started", sessionId: "dead", at: new Date().toISOString() });
    if (completeRun) events.push({ type: "session.ended", sessionId: "dead", reason: "completed", exitCode: 0, at: new Date().toISOString() });
    if (events.length > 0) {
      const sent = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, { generation, events });
      assert.equal(sent.status, 200);
    }
    await sleep(1300); // the dead host's lease expires here
    const recoveryRuntime = createMockRuntime({ scenario: "complete", sessionIdFactory: () => "recovery" });
    const recoveryHost = createHost({
      client: createInternalClient({ baseUrl: env.base, token: env.tokens["runtime-host"] }),
      runtime: recoveryRuntime,
      ownerId: "recovery",
      agents: [{ agentId: "agent-dev-01", role: "DEV", function: "WORKER" }],
      allowNoneWorkspace: true,
      leaseMs: 2000,
      pollMs: 20,
      flushMs: 10,
      heartbeatMs: 500,
      logger: quiet,
    });
    await recoveryHost.tick();
    await sleep(400);
    await recoveryHost.stop();
    return { run, claim, generation, recoveryRuntime, recoveryHost };
  }

  test("D1 a host that crashed before start is reclaimed as INTERRUPTED, never started", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const crash = await crashScenario(env);
    assert.equal(crash.recoveryRuntime._sessionCount, 0, "a reclaimed command must not start a second session");
    assert.equal(crash.recoveryHost.stats.interrupted, 1);
    assert.equal((await env.api(`/api/v1/runs/${crash.run.id}`)).body.status, "INTERRUPTED", "unknown start must never be guessed as COMPLETED");
    const command = readCommand(env, crash.run.id);
    assert.equal(command.status, "FAILED");
    assert.equal(command.attempts, 2);
    assert.equal(Number(command.generation), crash.generation + 1);
    assert.match(command.result_json ?? "", /reclaimed-after-lost-lease/, "ruling 5: the command carries the reclaimed reason");
  });

  test("D2 a host that crashed after session.started is reclaimed without a second start", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const crash = await crashScenario(env, { advanceStarted: true });
    assert.equal(crash.recoveryRuntime._sessionCount, 0);
    assert.equal((await env.api(`/api/v1/runs/${crash.run.id}`)).body.status, "INTERRUPTED");
    assert.equal(readCommand(env, crash.run.id).status, "FAILED");
  });

  test("a Run completed before the result arrived is swept into a terminal command (ruling 9)", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const crash = await crashScenario(env, { advanceStarted: true, completeRun: true });
    assert.equal((await env.api(`/api/v1/runs/${crash.run.id}`)).body.status, "COMPLETED");
    assert.equal(crash.recoveryRuntime._sessionCount, 0, "recovery must not start a session for a finished Run");
    const command = readCommand(env, crash.run.id);
    assert.equal(command.status, "DONE", "the sweep must derive DONE from the COMPLETED Run (ruling 9)");
    assert.match(command.result_json ?? "", /run-terminal/, "the swept command records where its terminal state came from");
    assert.ok(command.completed_at, "a swept command must carry completed_at");
  });

  test("D4 an old holder that wakes up after a reclaim is fenced", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("resurrect");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=dead&leaseMs=1000");
    const generation = claim.body.lease.generation;
    await sleep(1300);
    const reclaim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=new&leaseMs=3000");
    assert.equal(reclaim.status, 200);
    assert.equal(reclaim.body.lease.generation, generation + 1);
    const staleEvents = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, { generation, events: [{ type: "output", sessionId: "old", stream: "stdout", text: "late", at: new Date().toISOString() }] });
    assert.equal(staleEvents.status, 409);
    const staleResult = await env.internal("POST", `/internal/v1/dispatch/${claim.body.command.id}/result`, { ownerId: "dead", generation, status: "DONE", result: {} });
    assert.equal(staleResult.status, 409);
    assert.equal(readCommand(env, run.id).status, "CLAIMED");
    assert.equal(Number(readCommand(env, run.id).generation), generation + 1);
  });

  // -------------------------------------------------------------------------
  // E. migration
  // -------------------------------------------------------------------------
  test("E1 an M1 v1 database upgrades to v2 in place and keeps its rows", async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "atk-m2-migrate-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const dbFile = path.join(tmp, "atk.db");
    const raw = new DatabaseSync(dbFile);
    try {
      raw.exec(readFileSync(path.join(REPO, "packages/database/migrations/0001_init.sql"), "utf8"));
      raw.exec(`INSERT INTO schema_migrations (version,name,applied_at) VALUES (1,'0001_init.sql','${new Date().toISOString()}')`);
      raw.exec("INSERT INTO projects (id,name,repo_path,default_branch,created_at,updated_at) VALUES ('P-V1','legacy','.','main','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
      raw.exec("INSERT INTO tasks (id,project_id,title,description,function_required,role_required,priority,status,created_at,updated_at) VALUES ('T-V1','P-V1','legacy task','d','WORKER','DEV',2,'READY','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    } finally {
      raw.close();
    }
    const upgraded = openStore({ file: dbFile, migrate: true });
    try {
      assert.ok(upgraded.health().schemaVersion >= 2, "a v1 database must upgrade to at least schema v2");
      assert.equal(upgraded.getProject("P-V1").name, "legacy", "v1 data must survive the in-place upgrade");
      assert.equal(upgraded.listTasks({ projectId: "P-V1" }).length, 1);
    } finally {
      upgraded.close();
    }
    const reopened = openStore({ file: dbFile, migrate: true });
    try {
      assert.ok(reopened.health().schemaVersion >= 2, "a second open must be idempotent");
    } finally {
      reopened.close();
    }
    const check = new DatabaseSync(dbFile);
    try {
      assert.ok(check.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get().c >= 2);
      assert.ok(check.prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name = 'workspace_id'").get(), "0002 columns must exist");
    } finally {
      check.close();
    }
  });

  // -------------------------------------------------------------------------
  // F. contract shape + the gate itself
  // -------------------------------------------------------------------------
  test("stale-generation details use the contract shape (ruling 11)", async (t) => {
    const env = await makeEnv(t, { withBackend: true });
    const { run } = env.seed("details");
    const claim = await env.internal("GET", "/internal/v1/dispatch/claim?owner=details&leaseMs=5000");
    const generation = claim.body.lease.generation;
    await env.internal("POST", `/internal/v1/runs/${run.id}/renew`, { ownerId: "details", generation, leaseMs: 5000 });
    const stale = await env.internal("POST", `/internal/v1/runs/${run.id}/events`, {
      generation,
      events: [{ type: "session.started", sessionId: "details", at: new Date().toISOString() }],
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(Object.keys(stale.body.error.details).sort(), ["currentGeneration", "generation", "reason", "runId"]);
  });

  test("F2 the m2 gate itself asserts the dispatch-command lifecycle (no swallowed 400s)", async (t) => {
    const result = spawnSync(process.execPath, [path.join(REPO, "scripts", "m2-smoke.mjs"), "--verbose"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `m2-smoke failed:\n${combined.slice(-2000)}`);
    assert.doesNotMatch(result.stdout, /^FAIL/m, `the gate reported a FAIL line:\n${result.stdout}`);
    const summary = result.stdout.match(/(\d+)\/(\d+) checks passed/);
    assert.ok(summary, `the gate must end with "N/N checks passed", got:\n${result.stdout.slice(-800)}`);
    assert.equal(summary[1], summary[2], "every gate check must pass");
    assert.ok(Number(summary[1]) >= 4, `the gate must keep at least the four M2 checks, got ${summary[0]}`);
    assert.match(result.stdout, /command FAILED/, "the gate must assert the durable command, not only the Run row");
    assert.ok(!/\[host\][^\n]*(400|VALIDATION_ERROR|STALE_GENERATION|illegal run transition)/.test(result.stderr), `the host must not swallow internal API errors:\n${result.stderr}`);
    assert.ok(!/\[host\]/.test(result.stderr), "the host must not log any request failure during the gate");
  });

  function rawHttp(port, requestText) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(requestText));
      let buffer = "";
      socket.setEncoding("utf8");
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error(`raw request timed out: ${requestText.split("\r\n")[0]}`));
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
      });
      socket.on("error", reject);
      socket.on("close", () => {
        const status = Number(buffer.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
        const bodyText = buffer.slice(buffer.indexOf("\r\n\r\n") + 4);
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = { raw: bodyText.slice(0, 200) };
        }
        resolve({ status, body });
      });
    });
  }
}


