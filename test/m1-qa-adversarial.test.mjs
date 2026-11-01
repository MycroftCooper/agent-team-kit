// QA-002: independent adversarial suite for M1 (frozen commit d80862b).
//
// The suite is written against docs/architecture/m1-contracts.md and ADR-008,
// not against the implementation. It asserts the boundaries M1 promises:
// loopback/Host/Origin/CSRF auth, static-file containment, parameterised data
// access, idempotent migration, SSE resync semantics, i18n coverage and the
// dependency/packaging rules.
//
// Runs only where the M1 workspace can run (`node:sqlite` needs Node >= 22.5).
// On older runtimes the file prints a SKIPPED line and registers no test: a
// capability skip, never a pass (mirrors scripts/test-workspace.mjs).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import http from "node:http";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number);
const WORKSPACE_OK = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 5);

if (!WORKSPACE_OK) {
  process.stderr.write(
    `m1-qa-adversarial: SKIPPED workspace checks: node:sqlite requires Node >= 22.5.0 ` +
      `(running ${process.versions.node}). This is a skip, not a pass.\n`,
  );
} else {
  await runSuite();
}

async function runSuite() {
  const { createServer } = await import("../apps/backend/src/server.mjs");
  const { createMemoryStore, importStateJson, openStore } = await import("../packages/database/src/index.mjs");
  const { parseSseFrame, resumePlan } = await import("../packages/contracts/src/events.mjs");
  const { GATE_STATUSES, TASK_STATUSES, RUN_STATUSES, AGENT_STATUSES, REVIEW_STATUSES, INTEGRATION_STATUSES, ACCEPTANCE_STATUSES, FUNCTIONS } =
    await import("../packages/contracts/src/enums.mjs");

  const TEST_TOKEN = "qa-m1-session-token";
  const TEST_CSRF = "qa-m1-csrf-token";
  const SILENT = Object.freeze({ info() {}, warn() {}, error() {} });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async function startBackend(t, options = {}) {
    const store = options.store ?? createMemoryStore();
    const server = createServer({
      store,
      token: TEST_TOKEN,
      csrf: TEST_CSRF,
      logger: SILENT,
      persistToken: false,
      webDist: options.webDist ?? null,
      ssePollMs: 20,
      sseHeartbeatMs: 40,
      sessionTtlMs: options.sessionTtlMs,
      ...options,
    });
    const info = await server.listen({ port: 0 });
    t.after(async () => {
      await server.close();
      store.close?.();
    });
    return { server, store, base: info.url, port: info.port };
  }

  function request(base, { method = "GET", path: requestPath = "/", headers = {}, body } = {}) {
    const url = new URL(requestPath, base);
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    return new Promise((resolve) => {
      let settled = false;
      let text = "";
      const finish = (status, resHeaders) => {
        if (settled) return;
        settled = true;
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status, headers: resHeaders, text, json });
      };
      const req = http.request(
        {
          host: "127.0.0.1",
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method,
          // One connection per request: a server that rejects an oversized body
          // may reset its socket, and a pooled keep-alive socket must not make
          // the next (unrelated) probe look like a victim of that reset.
          agent: false,
          headers: {
            ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
            ...(headers.host === undefined ? { host: url.host } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            text = Buffer.concat(chunks).toString("utf8");
            finish(res.statusCode, res.headers);
          });
          // A server that rejects a body/URL may reset the socket mid-response;
          // that is still an answer ("content-reset"), not a test crash.
          res.on("error", () => {
            text = Buffer.concat(chunks).toString("utf8");
            finish(res.statusCode ?? -1, res.headers);
          });
        },
      );
      req.on("error", () => {
        if (!settled) {
          settled = true;
          resolve({ status: -1, headers: {}, text, json: undefined });
        }
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** Raw HTTP/1.0 request with an exact request target and no implicit Host. */
  function rawRequest({ port, requestPath, headers = {}, version = "HTTP/1.0" }) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      let response = "";
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(parseRaw(response));
      };
      socket.setTimeout(5000, () => {
        socket.destroy();
        if (!settled) {
          settled = true;
          resolve({ status: -1, head: "", text: "", json: undefined });
        }
      });
      socket.on("error", (error) => {
        if (settled) return;
        // A server that closes the socket without an HTTP response is a valid
        // rejection outcome for malformed requests: report it as "no status".
        settled = true;
        if (response !== "") resolve(parseRaw(response));
        else resolve({ status: -1, head: "", text: "", json: undefined, error: error.code });
      });
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.on("end", finish);
      socket.on("close", finish);
      socket.on("connect", () => {
        const lines = [`GET ${requestPath} ${version}`];
        for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      });
    });
  }

  function parseRaw(response) {
    const splitAt = response.indexOf("\r\n\r\n");
    const head = splitAt < 0 ? response : response.slice(0, splitAt);
    const text = splitAt < 0 ? "" : response.slice(splitAt + 4);
    const status = Number.parseInt(String(head).split(" ")[1] ?? "-1", 10);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status, head, text, json };
  }

  const auth = () => ({ "x-atk-token": TEST_TOKEN });
  const csrf = () => ({ "x-atk-csrf": TEST_CSRF });
  const writeHeaders = (base, extra = {}) => ({ ...auth(), ...csrf(), origin: base, ...extra });

  const projectDto = (id, extra = {}) => ({
    id,
    name: `Project ${id}`,
    repoPath: ".",
    defaultBranch: "main",
    ...extra,
  });
  const taskDto = (projectId, id, extra = {}) => ({
    id,
    projectId,
    title: `Task ${id}`,
    description: "adversarial fixture",
    functionRequired: "WORKER",
    roleRequired: "DEV",
    priority: 2,
    deps: [],
    ...extra,
  });

  async function createProjectOverHttp(base, id) {
    const response = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: writeHeaders(base),
      body: projectDto(id),
    });
    assert.equal(response.status, 201, `project create failed: ${response.status} ${response.text}`);
    return response.json;
  }

  /** Open an SSE stream; collect parsed frames and expose a waiter. */
  function openStream(base, { token = TEST_TOKEN, lastEventId } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { "x-atk-token": token };
      if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
      const req = http.request(
        { host: "127.0.0.1", port: new URL(base).port, path: "/api/v1/events/stream", headers },
        (res) => {
          const client = { status: res.statusCode, headers: res.headers, raw: [], frames: [], buffer: "", waiters: [], ended: false };
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            client.buffer += chunk;
            let index = client.buffer.indexOf("\n\n");
            while (index >= 0) {
              const block = client.buffer.slice(0, index + 2);
              client.buffer = client.buffer.slice(index + 2);
              const frame = parseSseFrame(block);
              client.raw.push(block);
              client.frames.push(frame);
              for (const waiter of [...client.waiters]) {
                if (waiter.predicate(frame, block)) {
                  client.waiters.splice(client.waiters.indexOf(waiter), 1);
                  clearTimeout(waiter.timer);
                  waiter.resolve({ frame, block });
                }
              }
              index = client.buffer.indexOf("\n\n");
            }
          });
          res.on("end", () => {
            client.ended = true;
          });
          res.on("error", () => {});
          resolve(client);
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function waitForFrame(client, predicate, { timeoutMs = 3000 } = {}) {
    const existing = client.frames.find((frame, index) => predicate(frame, client.raw[index]));
    if (existing) return Promise.resolve({ frame: existing });
    return new Promise((resolve, reject) => {
      const waiter = { predicate, timer: null, resolve };
      waiter.timer = setTimeout(() => {
        const index = client.waiters.indexOf(waiter);
        if (index >= 0) client.waiters.splice(index, 1);
        reject(new Error(`timeout waiting for SSE frame; got ${JSON.stringify(client.raw)}`));
      }, timeoutMs);
      client.waiters.push(waiter);
    });
  }

  function closeStream(client) {
    try {
      client.res?.destroy();
    } catch {
      /* already gone */
    }
  }

  async function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // =========================================================================
  // A. auth boundary (ADR-008 / m1-contracts §2)
  // =========================================================================

  test("A1: Host allow-list rejects DNS-rebinding names and accepts loopback", async (t) => {
    const { base, port } = await startBackend(t);
    const ok = await request(base, { path: "/api/v1/system/health", headers: { host: `127.0.0.1:${port}` } });
    assert.equal(ok.status, 200);
    const localhost = await request(base, { path: "/api/v1/system/health", headers: { host: `localhost:${port}` } });
    assert.equal(localhost.status, 200, "localhost is a documented loopback name");
    for (const host of [`localhost.evil.com:${port}`, `127.0.0.1.evil.com:${port}`, `evil.example:${port}`]) {
      const response = await request(base, { path: "/api/v1/system/health", headers: { host } });
      assert.equal(response.status, 403, `Host ${host} must be refused`);
      assert.equal(response.json?.error?.code, "NOT_AUTHORIZED");
      assert.equal(response.json?.error?.details?.reason, "host-not-loopback", `Host ${host}`);
    }
    const ipv6 = await request(base, { path: "/api/v1/system/health", headers: { host: `[::1]:${port}` } });
    assert.equal(ipv6.status, 200, "[::1] is an allowed loopback hostname");
  });

  test("A2: a request without a Host header is refused", async (t) => {
    const { port } = await startBackend(t);
    const response = await rawRequest({ port, requestPath: "/api/v1/system/health" });
    assert.equal(response.status, 403);
    assert.equal(response.json?.error?.details?.reason, "host-missing");
  });

  test("A3: cross-origin, null and missing Origin writes are refused", async (t) => {
    const { base } = await startBackend(t);
    const cross = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: writeHeaders(base, { origin: "http://evil.example" }),
      body: projectDto("QA-CROSS"),
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.json?.error?.details?.reason, "origin-mismatch");

    const nullOrigin = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: writeHeaders(base, { origin: "null" }),
      body: projectDto("QA-NULL"),
    });
    assert.equal(nullOrigin.status, 403, "Origin: null must never be treated as same-origin");

    const noOrigin = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { ...auth(), ...csrf() },
      body: projectDto("QA-NOORIGIN"),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.json?.error?.details?.reason, "origin-missing");

    const stored = await createProjectOverHttp(base, "QA-SAMEORIGIN");
    assert.equal(stored.id, "QA-SAMEORIGIN");
  });

  test("A4: missing Origin is allowed only for the explicit CLI marker, and marker is not a token bypass", async (t) => {
    const { base } = await startBackend(t);
    const cliWrite = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { ...auth(), ...csrf(), "x-atk-client": "cli" },
      body: projectDto("QA-CLI"),
    });
    assert.equal(cliWrite.status, 201, `CLI marker + token + csrf must be accepted: ${cliWrite.text}`);

    const noCsrf = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { ...auth(), "x-atk-client": "cli" },
      body: projectDto("QA-CLI-NOCSRF"),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json?.error?.details?.reason, "csrf-missing");

    const noToken = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { ...csrf(), "x-atk-client": "cli" },
      body: projectDto("QA-CLI-NOTOKEN"),
    });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json?.error?.details?.reason, "token-missing", "the CLI marker never replaces the session token");

    // The CLI marker must not weaken the browser Origin boundary either.
    const cliCrossOrigin = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { ...auth(), ...csrf(), "x-atk-client": "cli", origin: "http://evil.example" },
      body: projectDto("QA-CLI-CROSS"),
    });
    assert.equal(cliCrossOrigin.status, 403);
    assert.equal(cliCrossOrigin.json?.error?.details?.reason, "origin-mismatch");
  });

  test("A5: the session token is header-only and never accepted from the URL", async (t) => {
    const { base } = await startBackend(t);
    const queryOnly = await request(base, { path: `/api/v1/tasks?token=${encodeURIComponent(TEST_TOKEN)}` });
    assert.equal(queryOnly.status, 403);
    assert.equal(queryOnly.json?.error?.details?.reason, "token-missing");

    const session = await request(base, { path: "/api/v1/session" });
    assert.equal(session.status, 200);
    assert.ok(typeof session.json?.token === "string" && session.json.token.length >= 16);
    assert.ok(!session.text.includes("?token="), "session bootstrap must not publish a token URL");
  });

  test("A6: invalid and expired tokens are refused", async (t) => {
    const { base } = await startBackend(t);
    const wrong = await request(base, { path: "/api/v1/tasks", headers: { "x-atk-token": "not-the-token" } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json?.error?.details?.reason, "token-invalid");

    const short = await startBackend(t, { sessionTtlMs: 30, token: "short-lived-token", csrf: TEST_CSRF });
    await delay(80);
    const expired = await request(short.base, { path: "/api/v1/tasks", headers: { "x-atk-token": "short-lived-token" } });
    assert.equal(expired.status, 403);
    assert.equal(expired.json?.error?.details?.reason, "token-expired");
  });

  test("A7: CSRF is mandatory on writes even with a valid token and same origin", async (t) => {
    const { base } = await startBackend(t);
    const missing = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { ...auth(), origin: base },
      body: projectDto("QA-NOCSRF"),
    });
    assert.equal(missing.status, 403);
    assert.equal(missing.json?.error?.details?.reason, "csrf-missing");

    const wrong = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { ...auth(), "x-atk-csrf": "wrong-csrf", origin: base },
      body: projectDto("QA-BADCSRF"),
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json?.error?.details?.reason, "csrf-invalid");
  });

  test("A8: header names are case-insensitive", async (t) => {
    const { base } = await startBackend(t);
    const read = await request(base, { path: "/api/v1/tasks", headers: { "X-ATK-TOKEN": TEST_TOKEN } });
    assert.equal(read.status, 200);
    const write = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { "X-ATK-TOKEN": TEST_TOKEN, "X-ATK-CSRF": TEST_CSRF, Origin: base },
      body: projectDto("QA-CASE"),
    });
    assert.equal(write.status, 201);
  });

  test("A9: only health/session are unauthenticated, and session bootstrap enforces Origin", async (t) => {
    const { base } = await startBackend(t);
    assert.equal((await request(base, { path: "/api/v1/system/health" })).status, 200);
    assert.equal((await request(base, { path: "/api/v1/session" })).status, 200);
    for (const requestPath of ["/api/v1/projects", "/api/v1/tasks", "/api/v1/events", "/api/v1/agents", "/api/v1/events/stream"]) {
      const response = await request(base, { path: requestPath });
      assert.equal(response.status, 403, `${requestPath} must require a token`);
      assert.equal(response.json?.error?.code, "NOT_AUTHORIZED");
    }
    const cross = await request(base, { path: "/api/v1/session", headers: { origin: "http://evil.example" } });
    assert.equal(cross.status, 403, "a cross-origin session bootstrap must not hand out tokens");
  });

  // =========================================================================
  // B. static serving and query/body injection
  // =========================================================================

  test("B1: static serving cannot escape the dist directory", async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "atk-qa-m1-static-"));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const dist = path.join(tmp, "dist");
    await writeFile(path.join(tmp, "secret-outside.txt"), "TOP-SECRET-QA", "utf8");
    await mkdir(path.join(dist), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<div id=\"root\">SPA-ROOT-MARKER</div>", "utf8");
    await writeFile(path.join(dist, "asset.txt"), "PUBLIC-ASSET", "utf8");
    const { port } = await startBackend(t, { webDist: dist });
    const control = await request(`http://127.0.0.1:${port}`, { path: "/asset.txt" });
    assert.equal(control.status, 200);
    assert.match(control.text, /PUBLIC-ASSET/);

    const attempts = [
      "/../secret-outside.txt",
      "/%2e%2e/secret-outside.txt",
      "/assets/../../secret-outside.txt",
      "/..%5csecret-outside.txt",
      "/%2e%2e%5csecret-outside.txt",
      "/....//secret-outside.txt",
      "//secret-outside.txt",
      "/%00secret-outside.txt",
    ];
    for (const requestPath of attempts) {
      const response = await rawRequest({ port, requestPath });
      assert.ok(response.status >= 200 && response.status < 500, `${requestPath} -> ${response.status}`);
      assert.doesNotMatch(response.text, /TOP-SECRET-QA/, `${requestPath} leaked a file outside dist`);
    }
  });

  test("B2: /api/.. confusion never leaks static files and never skips auth", async (t) => {
    const { base, port } = await startBackend(t);
    // The URL parser normalises dot segments before routing; whatever the
    // normalised target is, it must not become a static-file read of repo files
    // and it must not turn a protected API call into an anonymous one.
    for (const requestPath of ["/api/../package.json", "/api/%2e%2e/package.json", "/api/../api/v1/tasks"]) {
      const response = await rawRequest({ port, requestPath });
      assert.doesNotMatch(response.text, /"name": "agent-team-kit"/, `${requestPath} leaked package.json`);
      assert.doesNotMatch(response.text, /"dependencies"/, `${requestPath} leaked package metadata`);
    }
    const unauthenticated = await rawRequest({ port, requestPath: "/api/%2e%2e/api/v1/tasks" });
    assert.equal(unauthenticated.status, 403, "dot-segment normalisation must not skip the token check");
    for (const requestPath of ["/api/v1/tasks/%2e%2e%2f%2e%2e%2fpackage.json"]) {
      const response = await request(base, { path: requestPath, headers: auth() });
      assert.ok(response.status >= 400 && response.status < 500, `${requestPath} -> ${response.status}`);
      assert.equal(typeof response.json, "object", `${requestPath} must answer with the JSON error envelope`);
      assert.doesNotMatch(response.text, /"name": "agent-team-kit"/);
    }
  });

  test("B3: query filters reject SQL/integer abuse and parameterise search", async (t) => {
    const { base } = await startBackend(t);
    await createProjectOverHttp(base, "QA-FILTERS");
    const rejected = [
      "/api/v1/tasks?status=READY%27%20OR%201%3D1--",
      "/api/v1/tasks?status=NOPE",
      "/api/v1/tasks?limit=-1",
      "/api/v1/tasks?limit=0",
      "/api/v1/tasks?limit=abc",
      "/api/v1/tasks?limit=501",
      "/api/v1/tasks?projectId=QA-FILTERS%27--",
      "/api/v1/events?afterSeq=-1",
      "/api/v1/events?limit=0",
      "/api/v1/runs?limit=100000",
    ];
    for (const requestPath of rejected) {
      const response = await request(base, { path: requestPath, headers: auth() });
      assert.equal(response.status, 400, `${requestPath} must be a 400 not a silent fallback (${response.status})`);
      assert.equal(response.json?.error?.code, "VALIDATION_ERROR", requestPath);
    }
    const injection = await request(base, {
      path: `/api/v1/tasks?q=${encodeURIComponent("%' OR 1=1 --" + "x".repeat(4000))}`,
      headers: auth(),
    });
    assert.equal(injection.status, 200, "a long/odd search term must be a filter, not SQL or a crash");
    assert.ok(Array.isArray(injection.json?.items));
  });

  test("B4: oversized bodies/URLs are rejected without killing the server", async (t) => {
    const { base } = await startBackend(t);
    const huge = JSON.stringify({ blob: "x".repeat(2 * 1024 * 1024) });
    const response = await request(base, {
      method: "POST",
      path: "/api/v1/projects",
      headers: writeHeaders(base),
      body: huge,
    });
    // Either a clean 4xx or a reset after refusing to buffer the body; never a
    // 201 and never a dead server.
    assert.ok(response.status === -1 || (response.status >= 400 && response.status < 500), `oversized body -> ${response.status}`);
    assert.notEqual(response.status, 201);
    await delay(50);
    const health = await request(base, { path: "/api/v1/system/health" });
    assert.equal(health.status, 200, "the server must survive an oversized body");

    const raw = await rawRequest({ port: new URL(base).port, requestPath: `/${"a".repeat(20000)}` });
    assert.ok(raw.status === -1 || (raw.status >= 400 && raw.status < 500), `oversized URL -> ${raw.status}`);
    const after = await request(base, { path: "/api/v1/system/health" });
    assert.equal(after.status, 200, "the server must survive an oversized URL");
  });

  // =========================================================================
  // C. data: migration idempotency, hostile inputs, CAS, SSE
  // =========================================================================

  function legacyState() {
    return {
      schemaVersion: 1,
      updatedAt: "2026-01-01T00:00:00+00:00",
      batch: { id: "QA-BATCH", goal: "QA legacy import", stopCondition: "done", slices: [{ id: "S1", label: "Slice one", status: "todo", owner: "DEV" }] },
      counts: { total: 2 },
      packages: [
        { id: "PKG-01", type: "feature", owner: "DEV", module: "m", scope: "src", stage: "todo", priority: "P1", depsRaw: "", evidence: "" },
        { id: "PKG-02", type: "bug", owner: "QA", module: "m", scope: "src", stage: "implemented", priority: "P2", depsRaw: "PKG-01", evidence: "" },
      ],
      subitems: [],
    };
  }

  test("C1: migrations and the legacy import are idempotent (no duplicated tasks)", async (t) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "atk-qa-m1-migrate-"));
    const dbFile = path.join(tmp, "atk.db");
    let store = null;
    t.after(async () => {
      try {
        store?.close?.();
      } catch {
        /* already closed */
      }
      await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    });

    store = openStore({ file: dbFile, migrate: true });
    // Assert that migrations ran, not which generation they are on: M2 adds
    // migrations of its own, and the exact version is asserted by the database
    // package's own migration tests.
    assert.ok(store.health().schemaVersion >= 1);
    store.close();
    store = openStore({ file: dbFile, migrate: true });
    assert.ok(store.health().schemaVersion >= 1, "migrating an already-migrated file is a no-op");
    store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbFile);
    const applied = Number(raw.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get().c);
    raw.close();
    // Derive the expected count from the migrations directory instead of hard
    // coding a generation: every ordered .sql file must be recorded exactly once,
    // and re-opening the same file must not add a row (checked above/below).
    const { readdirSync } = await import("node:fs");
    const migrationFiles = readdirSync(new URL("../packages/database/migrations/", import.meta.url)).filter((name) =>
      name.endsWith(".sql"),
    );
    assert.equal(
      applied,
      migrationFiles.length,
      `schema_migrations must record exactly one row per ordered migration (${migrationFiles.join(", ")})`,
    );

    store = openStore({ file: dbFile, migrate: true });
    const runtime = {
      schemaVersion: 3,
      agents: [{ id: "agent-dev-qa", role: "DEV", capabilities: ["WORKER"], status: "idle", task: "", detail: "", since: "2026-01-01T00:00:00+00:00" }],
      events: [],
    };
    const first = importStateJson(store, { stateJson: legacyState(), runtime });
    assert.equal(first.status, "PASS", JSON.stringify(first.problems));
    assert.equal(first.counts.tasks, 3);
    const tasksAfterFirst = store.listTasks({ projectId: "default" }).length;
    assert.equal(tasksAfterFirst, 3);

    const second = importStateJson(store, { stateJson: legacyState(), runtime });
    assert.equal(second.status, "PASS", JSON.stringify(second.problems));
    assert.equal(second.counts.tasks, 0, "a second import must create zero tasks");
    assert.equal(second.counts.projects, 0);
    assert.equal(second.counts.agents, 0);
    assert.equal(store.listTasks({ projectId: "default" }).length, tasksAfterFirst, "task count must not double on re-import");
  });

  test("C2: hostile legacy state is refused before any write", async (t) => {
    const store = createMemoryStore();
    t.after(() => store.close());

    const escaping = legacyState();
    escaping.packages[0].scope = "../outside";
    escaping.packages[0].evidence = "C:\\Windows\\secret.txt";
    const escaped = importStateJson(store, { stateJson: escaping });
    assert.equal(escaped.status, "SKIPPED", "path escapes must block the import");
    assert.ok(
      escaped.problems.some((entry) => entry.level === "error" && entry.code === "PATH_ESCAPE"),
      JSON.stringify(escaped.problems),
    );
    assert.equal(store.listTasks().length, 0, "a refused import must not leave partial rows");
    assert.equal(store.listProjects().length, 0);

    const duplicate = legacyState();
    duplicate.subitems = [{ id: "PKG-01", owner: "DEV", scope: "src", stage: "todo" }];
    const duplicated = importStateJson(store, { stateJson: duplicate });
    assert.equal(duplicated.status, "SKIPPED");
    assert.ok(duplicated.problems.some((entry) => entry.code === "DUPLICATE_ID"), JSON.stringify(duplicated.problems));
    assert.equal(store.listTasks().length, 0);

    const nonAscii = legacyState();
    nonAscii.packages[0].scope = "src/模块";
    const noted = importStateJson(store, { stateJson: nonAscii });
    assert.equal(noted.status, "PASS");
    assert.ok(noted.problems.some((entry) => entry.code === "NON_ASCII_PATH"), JSON.stringify(noted.problems));
    assert.ok(store.listTasks().length >= 1);
  });

  test("C3: PATCH is a CAS: a stale expectedVersion is a 409 with currentVersion", async (t) => {
    const { base } = await startBackend(t);
    await createProjectOverHttp(base, "QA-CAS");
    const created = await request(base, {
      method: "POST",
      path: "/api/v1/tasks",
      headers: writeHeaders(base),
      body: taskDto("QA-CAS", "QA-TASK-1"),
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.status, "READY", "the server owns the initial status");
    assert.equal(created.json.version, 0);

    const first = await request(base, {
      method: "PATCH",
      path: "/api/v1/tasks/QA-TASK-1",
      headers: writeHeaders(base),
      body: { expectedVersion: 0, changes: { title: "renamed once" } },
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.version, 1);

    const stale = await request(base, {
      method: "PATCH",
      path: "/api/v1/tasks/QA-TASK-1",
      headers: writeHeaders(base),
      body: { expectedVersion: 0, changes: { title: "stale write" } },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json?.error?.code, "TASK_VERSION_CONFLICT");
    assert.equal(stale.json?.error?.details?.currentVersion, 1);

    const missing = await request(base, {
      method: "PATCH",
      path: "/api/v1/tasks/QA-TASK-1",
      headers: writeHeaders(base),
      body: { title: "no version" },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json?.error?.code, "VALIDATION_ERROR");

    // Creation must not accept a client-chosen status (the server starts READY).
    const statusOnCreate = await request(base, {
      method: "POST",
      path: "/api/v1/tasks",
      headers: writeHeaders(base),
      body: taskDto("QA-CAS", "QA-TASK-2", { status: "DONE" }),
    });
    assert.equal(statusOnCreate.status, 400);
    assert.match(String(statusOnCreate.json?.error?.message), /server-owned/i);
  });

  function appendEvents(store, count) {
    const events = [];
    for (let index = 1; index <= count; index += 1) {
      events.push(
        store.appendEvent({
          projectId: null,
          aggregateType: "task",
          aggregateId: "QA-TASK-1",
          type: "task.updated",
          payload: { taskId: "QA-TASK-1", status: "RUNNING", version: index },
        }),
      );
    }
    return events;
  }

  test("C4: SSE replays forward-only frames for a valid Last-Event-ID", async (t) => {
    const store = createMemoryStore();
    t.after(() => store.close());
    appendEvents(store, 3);
    const { base } = await startBackend(t, { store });

    const client = await openStream(base, { lastEventId: 0 });
    t.after(() => closeStream(client));
    assert.equal(client.status, 200);
    assert.match(String(client.headers["content-type"]), /text\/event-stream/);
    await waitForFrame(client, (frame) => frame.seq === 3);
    const seqs = client.frames.map((frame) => frame.seq).filter((seq) => seq !== null);
    assert.deepEqual(seqs, [1, 2, 3], `replayed ids must be forward-only and complete: ${JSON.stringify(seqs)}`);
    const eventFrames = client.frames.filter((frame) => frame.seq !== null);
    assert.ok(eventFrames.every((frame) => frame.type === "task.updated"));
    assert.ok(eventFrames.every((frame) => frame.payload?.taskId === "QA-TASK-1"));
  });

  test("C5: SSE demands a resync for invalid, future and pruned Last-Event-ID values", async (t) => {
    const store = createMemoryStore();
    t.after(() => store.close());
    appendEvents(store, 6);
    const { base } = await startBackend(t, { store });

    const invalid = await openStream(base, { lastEventId: "not-a-number" });
    t.after(() => closeStream(invalid));
    const invalidFrame = await waitForFrame(invalid, (frame) => frame.type === "system.resync-required");
    assert.equal(invalidFrame.frame.payload?.reason, "invalid-last-event-id");

    const future = await openStream(base, { lastEventId: 9999 });
    t.after(() => closeStream(future));
    const futureFrame = await waitForFrame(future, (frame) => frame.type === "system.resync-required");
    assert.equal(futureFrame.frame.payload?.reason, "gap");

    // Simulate retention pruning: the oldest retained seq is 5 while latest is 6.
    const wrapping = createMemoryStore();
    t.after(() => wrapping.close());
    appendEvents(wrapping, 6);
    const prunedStore = {
      ...wrapping,
      listEvents(options = {}) {
        if (options.limit === 1 && options.afterSeq === undefined) return wrapping.listEvents({ afterSeq: 4, limit: 1 });
        return wrapping.listEvents(options);
      },
      latestSeq() {
        return wrapping.latestSeq();
      },
    };
    const prunedBackend = await startBackend(t, { store: prunedStore });
    const pruned = await openStream(prunedBackend.base, { lastEventId: 1 });
    t.after(() => closeStream(pruned));
    const prunedFrame = await waitForFrame(pruned, (frame) => frame.type === "system.resync-required");
    assert.equal(prunedFrame.frame.payload?.reason, "gap", "a pruned gap must force a snapshot resync");

    // Pure contract check for the same rule: 1 + 1 < 5 => resync.
    assert.deepEqual(resumePlan(1, 5, 6), { action: "resync" });
    assert.deepEqual(resumePlan(4, 5, 6), { action: "replay", from: 5 });
  });

  test("C6: the real CLI migrate command twice does not duplicate tasks", async (t) => {
    const { spawnSync } = await import("node:child_process");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "atk-qa-m1-cli-"));
    const dbFile = path.join(tmp, "cli.db");
    const stateFile = path.join(tmp, "state.json");
    const cli = path.join(REPO, "apps", "backend", "cli.mjs");
    let store = null;
    t.after(async () => {
      try {
        store?.close?.();
      } catch {
        /* already closed */
      }
      await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    });
    const fixture = legacyState();
    await writeFile(stateFile, JSON.stringify(fixture, null, 2), "utf8");
    const runMigrate = () =>
      spawnSync(process.execPath, [cli, "migrate", "--data", dbFile, "--from", stateFile, "--json"], {
        cwd: tmp,
        encoding: "utf8",
        windowsHide: true,
      });
    const first = runMigrate();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstReport = JSON.parse(first.stdout.slice(first.stdout.indexOf("{")));
    assert.equal(firstReport.status, "PASS", JSON.stringify(firstReport.problems));
    assert.equal(firstReport.counts.tasks, 3);

    store = openStore({ file: dbFile, migrate: true });
    const afterFirst = store.listTasks({ limit: 1000 }).length;
    store.close();
    store = null;

    const second = runMigrate();
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const secondReport = JSON.parse(second.stdout.slice(second.stdout.indexOf("{")));
    assert.equal(secondReport.status, "PASS", JSON.stringify(secondReport.problems));
    assert.equal(secondReport.counts.tasks, 0, "a second CLI migrate must not create tasks");
    store = openStore({ file: dbFile, migrate: true });
    assert.equal(store.listTasks({ limit: 1000 }).length, afterFirst, "task count must not double");
  });

  // =========================================================================
  // D. web: i18n coverage (own scanners, not the project's tests)
  // =========================================================================

  const WEB_SRC = path.join(REPO, "apps", "web", "src");
  const I18N_DIR = path.join(WEB_SRC, "i18n");
  const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

  async function listSourceFiles(dir, skip) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (skip && skip(full)) continue;
      if (entry.isDirectory()) files.push(...(await listSourceFiles(full, skip)));
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) files.push(full);
    }
    return files;
  }

  test("D1: no hard-coded CJK outside the i18n directory", async () => {
    const files = await listSourceFiles(WEB_SRC, (file) => file === I18N_DIR);
    const findings = [];
    for (const file of files) {
      const raw = await readFile(file, "utf8");
      // Comments are not user-visible labels; strip them before scanning.
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (CJK_RE.test(line)) findings.push(`${path.relative(REPO, file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
    assert.deepEqual(findings, [], "visible text must come from the dictionaries");
  });

  /** Parse `{ "key": "value", ... }` object literals out of the TS dictionaries. */
  function parseDictionary(source) {
    const entries = new Map();
    const pattern = /^\s*"([^"]+)"\s*:\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*,?\s*$/gm;
    for (const match of source.matchAll(pattern)) {
      const raw = match[2].slice(1, -1);
      entries.set(match[1], JSON.parse(match[2].startsWith("`") ? JSON.stringify(raw) : match[2]));
    }
    return entries;
  }

  test("D2: en and zh-CN dictionaries have identical keys, non-empty values and matching placeholders", async () => {
    const en = parseDictionary(await readFile(path.join(I18N_DIR, "en.ts"), "utf8"));
    const zh = parseDictionary(await readFile(path.join(I18N_DIR, "zh-CN.ts"), "utf8"));
    assert.ok(en.size >= 200, `expected a non-trivial dictionary, got ${en.size} keys`);
    assert.deepEqual([...zh.keys()].sort(), [...en.keys()].sort(), "the two dictionaries must expose the same key set");
    const placeholders = (value) => [...String(value).matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of en) {
      assert.ok(value.trim() !== "", `en[${key}] must not be blank`);
      assert.ok(String(zh.get(key)).trim() !== "", `zh-CN[${key}] must not be blank`);
      assert.deepEqual(placeholders(zh.get(key)), placeholders(value), `placeholder mismatch for ${key}`);
    }
  });

  test("D3: every contracts status enum has a label mapping and dictionary text", async () => {
    const statusSource = await readFile(path.join(WEB_SRC, "domain", "status.ts"), "utf8");
    const en = parseDictionary(await readFile(path.join(I18N_DIR, "en.ts"), "utf8"));
    const zh = parseDictionary(await readFile(path.join(I18N_DIR, "zh-CN.ts"), "utf8"));
    const groups = {
      task: TASK_STATUSES,
      run: RUN_STATUSES,
      agent: AGENT_STATUSES,
      review: REVIEW_STATUSES,
      integration: INTEGRATION_STATUSES,
      acceptance: ACCEPTANCE_STATUSES,
      gate: GATE_STATUSES,
      function: FUNCTIONS,
    };
    for (const [group, values] of Object.entries(groups)) {
      const block = new RegExp(`const ${group.toUpperCase()}_[A-Z_]*META[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(statusSource);
      assert.ok(block, `status.ts has no mapping block for ${group}`);
      for (const value of values) {
        assert.ok(new RegExp(`\\b${value}:\\s*\\{`).test(block[1]), `${group}.${value} has no label mapping`);
        const key = `status.${group}.${value}`;
        assert.ok(en.has(key), `en dictionary is missing ${key}`);
        assert.ok(zh.has(key), `zh-CN dictionary is missing ${key}`);
      }
    }
    // Unknown values must degrade to the neutral fallback instead of crashing.
    assert.match(statusSource, /status\.unknown/);
  });

  test("D4: language resolution and persistence handle hostile inputs", async () => {
    const core = await import("../apps/web/src/i18n/core.ts");
    for (const tag of ["zh", "zh-CN", "zh-TW", "zh-Hant", "ZH-hans", " zh-cn "]) {
      assert.equal(core.resolveLanguage(tag), "zh-CN", tag);
    }
    for (const tag of ["en-US", "EN", "fr-FR", "", null, undefined, "zz"]) {
      assert.equal(core.resolveLanguage(tag), "en", String(tag));
    }
    assert.equal(core.isLang("zh-TW"), false);
    assert.equal(core.pickInitialLanguage("klingon", "zh-TW"), "zh-CN");
    assert.equal(core.pickInitialLanguage("en", "zh-CN"), "en");

    const throwing = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    assert.equal(core.readStoredLanguage(throwing), null, "blocked storage must not throw");
    assert.equal(core.writeStoredLanguage(throwing, "en"), false);
    assert.equal(core.writeStoredLanguage(null, "en"), false);
    const memoryStorage = () => {
      const map = new Map();
      return { map, getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, value) };
    };
    const storage = memoryStorage();
    assert.equal(core.writeStoredLanguage(storage, "zh-CN"), true);
    assert.equal(storage.map.get(core.LANG_STORAGE_KEY), "zh-CN");
    assert.equal(core.readStoredLanguage(storage), "zh-CN");
    assert.equal(core.readStoredLanguage({ getItem: () => "zh-Hant" }), null, "unsupported stored tags are ignored");
  });

  // =========================================================================
  // E. privacy and packaging
  // =========================================================================

  test("E1: M1 sources contain no secret material or real user-home paths", async () => {
    const roots = ["apps", "packages", "scripts"];
    const files = [];
    for (const root of roots) files.push(...(await listSourceFiles(path.join(REPO, root), (file) => /node_modules|[\\/]dist[\\/]/.test(file))));
    files.push(
      path.join(REPO, "docs", "architecture", "m1-contracts.md"),
      path.join(REPO, "docs", "architecture", "adr", "ADR-009-m1-stack.md"),
    );
    const secretish = /\bsk-[A-Za-z0-9]{24,}\b|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----/;
    const realHome = /[A-Za-z]:\\+Users\\+(?![\\<])/;
    const findings = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (secretish.test(text)) findings.push(`${path.relative(REPO, file)}: secret-like token`);
      if (realHome.test(text)) findings.push(`${path.relative(REPO, file)}: real user-home path`);
    }
    assert.deepEqual(findings, []);
  });

  test("E2: packaging stays legacy-only and contracts stays dependency-free", async () => {
    const rootPkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
    assert.ok(Array.isArray(rootPkg.files));
    for (const entry of rootPkg.files) {
      assert.doesNotMatch(String(entry), /node_modules|[\\/]?dist[\\/]?$|^apps$|^packages$/, `published files must not include ${entry}`);
    }
    const contracts = JSON.parse(await readFile(path.join(REPO, "packages", "contracts", "package.json"), "utf8"));
    assert.equal(contracts.dependencies, undefined);
    assert.equal(contracts.devDependencies, undefined);
    const workspace = await readFile(path.join(REPO, "pnpm-workspace.yaml"), "utf8");
    assert.match(workspace, /apps\/\*/);
    assert.match(workspace, /packages\/\*/);
  });

  // A quiet summary of the capability gate is printed only on old runtimes;
  // reaching here means every check above ran for real.
  process.stdout.write(`m1-qa-adversarial: ${process.versions.node} (workspace checks enabled)\n`);
}
