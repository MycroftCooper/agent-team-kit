// Shared test helpers: start a real HTTP server on a random port, make requests,
// and consume SSE streams with the same frame parser the web client will use.
import http from "node:http";

import { parseSseFrame } from "@atk/contracts";

import { requiredInternalRoles } from "../src/internal.mjs";
import { createServer } from "../src/server.mjs";
import { createFakeStore } from "./fake-store.mjs";

export const TEST_TOKEN = "test-session-token";
export const TEST_CSRF = "test-csrf-token";
export const TEST_INTERNAL_TOKEN = "test-internal-token";

export const SILENT_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

export function recordingLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info(message) {
      lines.info.push(String(message));
    },
    warn(message) {
      lines.warn.push(String(message));
    },
    error(message) {
      lines.error.push(String(message));
    },
  };
}

/** Start a backend on a random loopback port; the caller owns `server.close()`. */
export async function startServer(options = {}) {
  const store = options.store ?? createFakeStore();
  const server = createServer({
    token: TEST_TOKEN,
    csrf: TEST_CSRF,
    internalToken: TEST_INTERNAL_TOKEN,
    logger: SILENT_LOGGER,
    persistToken: false,
    ssePollMs: 25,
    sseHeartbeatMs: 80,
    ...options,
    store,
  });
  const info = await server.listen({ port: 0 });
  return { server, store, base: info.url, info, internalToken: server.internalToken };
}

/** Header set for `/internal/v1/*` calls (never the browser token).
 *  The role assertion is added per-endpoint by `request()` when omitted; pass an
 *  explicit role to exercise missing/forbidden-role negatives. */
export function internalHeaders(token = TEST_INTERNAL_TOKEN, role = undefined) {
  const headers = { "x-atk-internal": token };
  if (role !== undefined) headers["x-atk-internal-role"] = role;
  return headers;
}

export function request(base, { method = "GET", path = "/", headers = {}, body } = {}) {
  const url = new URL(path, base);
  const payload =
    body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      ...(payload === undefined
        ? {}
        : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
      ...headers,
    };
    // Default the internal role from the frozen endpoint matrix unless the test
    // explicitly supplies one (so role-forbidden/missing negatives stay possible).
    if (typeof requestHeaders["x-atk-internal"] === "string" && requestHeaders["x-atk-internal-role"] === undefined) {
      const roles = requiredInternalRoles(method, url.pathname);
      if (Array.isArray(roles) && roles.length > 0) requestHeaders["x-atk-internal-role"] = roles[0];
    }
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Headers for a read-only API request. */
export function readHeaders(token = TEST_TOKEN) {
  return { "x-atk-token": token };
}

/** Headers for a state-changing request (same-origin + token + CSRF). */
export function writeHeaders(base, { token = TEST_TOKEN, csrf = TEST_CSRF, origin = base } = {}) {
  const headers = { "x-atk-token": token, "x-atk-csrf": csrf };
  if (origin !== undefined) headers.origin = origin;
  return headers;
}

/**
 * Open an SSE stream. Resolves once response headers are received; frames are
 * appended to `client.frames` (parsed) and `client.rawFrames` (raw text).
 */
export function openSse(base, { token = TEST_TOKEN, lastEventId, path = "/api/v1/events/stream" } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const headers = { "x-atk-token": token };
    if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
    const req = http.request(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: "GET", headers },
      (res) => {
        const client = {
          status: res.statusCode,
          headers: res.headers,
          frames: [],
          rawFrames: [],
          buffer: "",
          waiters: [],
          ended: false,
          res,
          req,
        };
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          client.buffer += chunk;
          let index = client.buffer.indexOf("\n\n");
          while (index >= 0) {
            const raw = client.buffer.slice(0, index + 2);
            client.buffer = client.buffer.slice(index + 2);
            const frame = parseSseFrame(raw);
            client.rawFrames.push(raw);
            client.frames.push(frame);
            for (const waiter of [...client.waiters]) {
              if (waiter.predicate(frame, raw)) {
                client.waiters.splice(client.waiters.indexOf(waiter), 1);
                clearTimeout(waiter.timer);
                waiter.resolve({ frame, raw });
              }
            }
            index = client.buffer.indexOf("\n\n");
          }
        });
        res.on("end", () => {
          client.ended = true;
        });
        resolve(client);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Wait for the next (or already buffered) SSE frame matching `predicate`. */
export function waitForFrame(client, predicate, { timeoutMs = 4000 } = {}) {
  const existing = client.frames.findIndex((frame, index) => predicate(frame, client.rawFrames[index]));
  if (existing >= 0) return Promise.resolve({ frame: client.frames[existing], raw: client.rawFrames[existing] });
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      timer: null,
      resolve: (value) => {
        clearTimeout(waiter.timer);
        resolve(value);
      },
    };
    waiter.timer = setTimeout(() => {
      const index = client.waiters.indexOf(waiter);
      if (index >= 0) client.waiters.splice(index, 1);
      reject(
        new Error(
          `timeout after ${timeoutMs}ms waiting for SSE frame; received ${client.frames.length}: ${JSON.stringify(client.rawFrames)}`,
        ),
      );
    }, timeoutMs);
    client.waiters.push(waiter);
  });
}

export function closeSse(client) {
  try {
    client.req.destroy();
  } catch {
    // already gone
  }
  try {
    client.res.destroy();
  } catch {
    // already gone
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a predicate until true (or throw after `timeoutMs`). */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(intervalMs);
  }
  throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`);
}
