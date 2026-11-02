// Scheduler internal-client tests: the client is the only place that talks to
// /internal/v1/*, so the role assertion promised by m6.1-contracts §2 has to be
// provable here. The backend is a real HTTP server in this process: a fake
// `fetch` would not catch a missing header.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createSchedulerClient, SchedulerApiError } from "../src/client.mjs";
import { createScheduler } from "../src/index.mjs";

const TOKEN = "internal-test";

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(text || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Backend-like gate (m6.1-contracts §2): `x-atk-internal` is the credential and
 * `x-atk-internal-role` is checked on every request; a missing role is
 * `internal-role-required`, a wrong one `internal-role-forbidden`.
 */
function roleGate(handler) {
  return async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const role = req.headers["x-atk-internal-role"];
    if (req.headers["x-atk-internal"] !== TOKEN || role !== "scheduler") {
      const reason = role === undefined ? "internal-role-required" : "internal-role-forbidden";
      return json(res, 403, { error: { code: "NOT_AUTHORIZED", details: { reason } } });
    }
    return handler(req, res, url);
  };
}

test("every scheduler client request asserts x-atk-internal-role: scheduler", async (t) => {
  const seen = [];
  const { server, base } = await listen((req, res) => {
    seen.push({
      method: req.method,
      path: req.url,
      token: req.headers["x-atk-internal"],
      role: req.headers["x-atk-internal-role"],
    });
    if (req.url === "/internal/v1/scheduling/snapshot") return json(res, 200, { version: 1, tasks: [], agents: [], runs: [], leases: [] });
    if (req.url.endsWith("/claim")) return json(res, 200, { run: { id: "run-1" } });
    if (req.url === "/internal/v1/scheduler/heartbeat") return json(res, 200, { ok: true });
    return json(res, 404, { error: { code: "NOT_FOUND" } });
  });
  t.after(() => server.close());

  const client = createSchedulerClient({ baseUrl: base, token: TOKEN });
  await client.snapshot();
  await client.claim("T-1", { agentId: "agent-a", expectedTaskVersion: 1 });
  await client.heartbeat({ ownerId: "s1", status: "RUNNING" });

  assert.equal(seen.length, 3);
  for (const entry of seen) {
    assert.equal(entry.token, TOKEN);
    assert.equal(entry.role, "scheduler", `${entry.method} ${entry.path} must assert the scheduler role`);
  }
  assert.deepEqual(seen.map((entry) => entry.method), ["GET", "POST", "POST"]);
});

test("the scheduler role is fixed: a role option cannot escape it", async (t) => {
  let role;
  const { server, base } = await listen((req, res) => {
    role = req.headers["x-atk-internal-role"];
    json(res, 200, { version: 1, tasks: [], agents: [], runs: [], leases: [] });
  });
  t.after(() => server.close());

  const client = createSchedulerClient({ baseUrl: base, token: TOKEN, role: "runtime-host" });
  await client.snapshot();
  assert.equal(role, "scheduler", "the Scheduler may not present another caller's role");
});

test("a real role gate refuses a wrong or missing role but accepts the scheduler client", async (t) => {
  const { server, base } = await listen(roleGate((req, res) => json(res, 200, { version: 1, tasks: [], agents: [], runs: [], leases: [] })));
  t.after(() => server.close());

  const wrong = await fetch(`${base}/internal/v1/scheduling/snapshot`, {
    headers: { "x-atk-internal": TOKEN, "x-atk-internal-role": "runtime-host" },
  });
  assert.equal(wrong.status, 403);
  const denied = await wrong.json();
  assert.equal(denied.error.code, "NOT_AUTHORIZED");
  assert.equal(denied.error.details.reason, "internal-role-forbidden");

  const missing = await fetch(`${base}/internal/v1/scheduling/snapshot`, {
    headers: { "x-atk-internal": TOKEN },
  });
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).error.details.reason, "internal-role-required");

  const client = createSchedulerClient({ baseUrl: base, token: TOKEN });
  assert.deepEqual(await client.snapshot(), { version: 1, tasks: [], agents: [], runs: [], leases: [] });
});

test("a 403 from the role gate surfaces as a typed SchedulerApiError", async (t) => {
  const { server, base } = await listen((req, res) =>
    json(res, 403, { error: { code: "NOT_AUTHORIZED", details: { reason: "internal-role-forbidden" } } }),
  );
  t.after(() => server.close());

  const client = createSchedulerClient({ baseUrl: base, token: TOKEN });
  await assert.rejects(client.snapshot(), (error) => {
    assert.ok(error instanceof SchedulerApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "NOT_AUTHORIZED");
    assert.deepEqual(error.details, { reason: "internal-role-forbidden" });
    return true;
  });
});

test("a real scheduler round passes a role-gated backend (m4-smoke item 6 shape)", async (t) => {
  const claims = [];
  const { server, base } = await listen(
    roleGate(async (req, res, url) => {
      if (url.pathname === "/internal/v1/scheduling/snapshot") {
        return json(res, 200, { version: 3, tasks: [], agents: [], runs: [], leases: [] });
      }
      if (url.pathname.endsWith("/claim")) {
        claims.push(await readBody(req));
        return json(res, 200, { run: { id: "run-1" } });
      }
      return json(res, 404, { error: { code: "NOT_FOUND" } });
    }),
  );
  t.after(() => server.close());

  const client = createSchedulerClient({ baseUrl: base, token: TOKEN });
  const scheduler = createScheduler({
    client,
    core: {
      planDispatch: () => ({
        proposals: [{ taskId: "M4-REWORK", agentId: "agent-dev-1", expectedTaskVersion: 1 }],
        skipped: [],
      }),
    },
    policies: {},
    ownerId: "scheduler-1",
    logger: { info() {}, warn() {}, error() {} },
  });
  const result = await scheduler.runOnce();

  assert.equal(result.ok, true, "the role assertion must make the snapshot succeed");
  assert.equal(result.reason, undefined);
  assert.equal(claims.length, 1);
  assert.equal(result.results[0].claimed, true);
  await scheduler.stop();
});
