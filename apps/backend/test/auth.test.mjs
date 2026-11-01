// ADR-008 access-control tests: these are the security claims of the backend.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateErrorBody } from "@atk/contracts";

import { createServer } from "../src/server.mjs";
import { createFakeStore } from "./fake-store.mjs";
import {
  SILENT_LOGGER,
  TEST_CSRF,
  TEST_TOKEN,
  closeSse,
  delay,
  openSse,
  readHeaders,
  recordingLogger,
  request,
  startServer,
  waitFor,
  waitForFrame,
  writeHeaders,
} from "./helpers.mjs";

function assertErrorEnvelope(res, expectedCode, expectedStatus) {
  assert.equal(res.status, expectedStatus, `expected HTTP ${expectedStatus}, body: ${res.text}`);
  assert.ok(res.json, `expected a JSON error body, got: ${res.text}`);
  const validation = validateErrorBody(res.json);
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(res.json.error.code, expectedCode);
  assert.equal(typeof res.json.error.message, "string");
  assert.equal(typeof res.json.error.requestId, "string");
  assert.equal(res.headers["x-request-id"], res.json.error.requestId);
}

test("GET /api/v1/system/health is unauthenticated and reports store health", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const res = await request(base, { path: "/api/v1/system/health" });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(typeof res.json.version, "string");
  assert.equal(res.json.db.ok, true);
  assert.equal(res.json.db.counts.tasks, 0);
  assert.ok(Number.isFinite(res.json.uptimeMs) && res.json.uptimeMs >= 0);
});

test("API requests without x-atk-token are 403 with the shared error envelope", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const res = await request(base, { path: "/api/v1/tasks" });
  assertErrorEnvelope(res, "NOT_AUTHORIZED", 403);
  assert.equal(res.json.error.details.reason, "token-missing");

  const wrong = await request(base, { path: "/api/v1/tasks", headers: { "x-atk-token": "not-the-token" } });
  assertErrorEnvelope(wrong, "NOT_AUTHORIZED", 403);
  assert.equal(wrong.json.error.details.reason, "token-invalid");
});

test("an expired session token stops working (403 reason token-expired)", async (t) => {
  const { server, base } = await startServer({ sessionTtlMs: 30 });
  t.after(() => server.close());
  await delay(60);
  const res = await request(base, { path: "/api/v1/tasks", headers: readHeaders() });
  assertErrorEnvelope(res, "NOT_AUTHORIZED", 403);
  assert.equal(res.json.error.details.reason, "token-expired");
});

test("an unexpected Host header is rejected (DNS-rebinding boundary)", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const res = await request(base, {
    path: "/api/v1/system/health",
    headers: { Host: "evil.example:1421" },
  });
  assertErrorEnvelope(res, "NOT_AUTHORIZED", 403);
  assert.equal(res.json.error.details.reason, "host-not-loopback");

  // localhost with a port is accepted (Vite proxies and local browsers use it).
  const localhost = await request(base, {
    path: "/api/v1/system/health",
    headers: { Host: `localhost:${new URL(base).port}` },
  });
  assert.equal(localhost.status, 200);
});

test("GET /api/v1/session bootstraps token + csrf for a same-origin browser", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const res = await request(base, { path: "/api/v1/session" });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ["actor", "csrf", "expiresAt", "token"]);
  assert.equal(res.json.actor, "HUMAN");
  assert.ok(Date.parse(res.json.expiresAt) > Date.now());
  assert.ok(typeof res.json.token === "string" && res.json.token.length > 0);
  assert.ok(typeof res.json.csrf === "string" && res.json.csrf.length > 0);

  // The bootstrapped token is enough for reads...
  const read = await request(base, { path: "/api/v1/tasks", headers: { "x-atk-token": res.json.token } });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { items: [] });

  // ...and token + csrf + same-origin Origin is enough for writes.
  const write = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { "x-atk-token": res.json.token, "x-atk-csrf": res.json.csrf, origin: base },
    body: { id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" },
  });
  assert.equal(write.status, 201, write.text);
  assert.equal(write.json.id, "P-1");
});

test("/api/v1/session rejects a cross-origin bootstrap", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const res = await request(base, { path: "/api/v1/session", headers: { origin: "http://evil.example" } });
  assertErrorEnvelope(res, "NOT_AUTHORIZED", 403);
  assert.equal(res.json.error.details.reason, "origin-mismatch");
});

test("write requests require Origin (CSRF boundary) unless the CLI marker is present", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const body = { id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" };

  const missingOrigin = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { "x-atk-token": TEST_TOKEN, "x-atk-csrf": TEST_CSRF },
    body,
  });
  assertErrorEnvelope(missingOrigin, "NOT_AUTHORIZED", 403);
  assert.equal(missingOrigin.json.error.details.reason, "origin-missing");

  const crossOrigin = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: writeHeaders(base, { origin: "http://evil.example" }),
    body,
  });
  assertErrorEnvelope(crossOrigin, "NOT_AUTHORIZED", 403);
  assert.equal(crossOrigin.json.error.details.reason, "origin-mismatch");

  const cliWrite = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { "x-atk-token": TEST_TOKEN, "x-atk-csrf": TEST_CSRF, "x-atk-client": "cli" },
    body,
  });
  assert.equal(cliWrite.status, 201, cliWrite.text);
  assert.equal(cliWrite.json.id, "P-1");
});

test("write requests require the CSRF token in addition to the session token", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const body = { id: "P-2", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" };

  const missing = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { "x-atk-token": TEST_TOKEN, origin: base },
    body,
  });
  assertErrorEnvelope(missing, "NOT_AUTHORIZED", 403);
  assert.equal(missing.json.error.details.reason, "csrf-missing");

  const wrong = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { "x-atk-token": TEST_TOKEN, "x-atk-csrf": "wrong", origin: base },
    body,
  });
  assertErrorEnvelope(wrong, "NOT_AUTHORIZED", 403);
  assert.equal(wrong.json.error.details.reason, "csrf-invalid");
});

test("a write request with a valid Origin but no token is still rejected", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await request(base, {
    method: "POST",
    path: "/api/v1/projects",
    headers: { "x-atk-csrf": TEST_CSRF, origin: base },
    body: { id: "P-3", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" },
  });
  assertErrorEnvelope(res, "NOT_AUTHORIZED", 403);
  assert.equal(res.json.error.details.reason, "token-missing");
});

test("SSE stream also requires the session token", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  // A wrong token gets the unified JSON 403 envelope, not an event stream.
  const client = await openSse(base, { token: "wrong" });
  assert.equal(client.status, 403);
  assert.equal(client.headers["content-type"], "application/json; charset=utf-8");
  closeSse(client);
  assert.equal(server.stats().sseClients, 0, "rejected streams are not attached to the hub");
});

test("server refuses to bind anything but 127.0.0.1", async (t) => {
  const store = createFakeStore();
  const server = createServer({ store, token: TEST_TOKEN, csrf: TEST_CSRF, logger: SILENT_LOGGER, persistToken: false });
  t.after(() => server.close());
  await assert.rejects(() => server.listen({ port: 0, host: "0.0.0.0" }), /ADR-008 requires 127\.0\.0\.1/);
  await assert.rejects(() => server.listen({ port: 0, host: "::" }), /ADR-008 requires 127\.0\.0\.1/);
});

test("a minted session token is persisted to the user-scoped token file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atk-token-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "runtime", "session-token");
  const server = createServer({ store: createFakeStore(), tokenFile, logger: SILENT_LOGGER });
  t.after(() => server.close());

  assert.equal(server.tokenPersisted, true);
  assert.equal(server.tokenFile, tokenFile);
  assert.equal(fs.readFileSync(tokenFile, "utf8").trim(), server.session.token);

  const info = await server.listen({ port: 0 });
  const res = await request(info.url, { path: "/api/v1/tasks", headers: { "x-atk-token": server.session.token } });
  assert.equal(res.status, 200);
});

test("token persistence failure degrades to in-memory with a warning, not a crash", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atk-token-blocked-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blockingFile = path.join(dir, "not-a-directory");
  fs.writeFileSync(blockingFile, "x");
  const logger = recordingLogger();
  const server = createServer({ store: createFakeStore(), tokenFile: path.join(blockingFile, "session-token"), logger });
  t.after(() => server.close());

  assert.equal(server.tokenPersisted, false);
  assert.ok(server.tokenWarning && server.tokenWarning.includes("cannot persist session token"));
  assert.ok(logger.lines.warn.some((line) => line.includes("cannot persist session token")));

  const info = await server.listen({ port: 0 });
  const session = await request(info.url, { path: "/api/v1/session" });
  assert.equal(session.status, 200);
  assert.equal(session.json.token, server.session.token);
});

test("SSE client disconnect cleans up hub timers/state", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const client = await openSse(base);
  await waitForFrame(client, (frame) => String(frame.comment ?? "").startsWith("connected"));
  assert.equal(server.stats().sseClients, 1);
  closeSse(client);
  await waitFor(() => server.stats().sseClients === 0, { label: "SSE client cleanup" });

  const second = await openSse(base);
  await waitForFrame(second, (frame) => String(frame.comment ?? "").startsWith("connected"));
  await server.close();
  assert.equal(server.stats().sseClients, 0);
});
