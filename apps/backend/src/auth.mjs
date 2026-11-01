// Local access security (ADR-008): loopback only, Host allow-list, Origin for
// writes, session token + CSRF, and the token file in a user-scoped directory.
//
// This module is pure policy: no HTTP objects leak in, so every rule is unit
// testable and the server only wires the results to status codes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runtimePaths } from "./paths.mjs";

/** Short-lived by design; a new server process mints a new token. */
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** 0600 where the platform honours POSIX modes (Windows only maps read-only). */
export const SESSION_TOKEN_FILE_MODE = 0o600;

/** Hostnames accepted in the `Host` header. Brackets are what WHATWG URL keeps for IPv6. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Methods that mutate state and therefore need Origin + CSRF. */
export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Header carrying the explicit CLI marker (m1-contracts §2 "CLI 白名单"). */
export const CLI_CLIENT_HEADER = "x-atk-client";
export const CLI_CLIENT_VALUE = "cli";

/** Cryptographically random URL-safe token. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** True only for addresses that can only be the local machine. */
export function isLoopbackRemote(address) {
  const value = String(address ?? "");
  if (LOOPBACK_REMOTE_ADDRESSES.has(value)) return true;
  // Dual-stack sockets may report an IPv4-mapped form of 127/8.
  return value.startsWith("::ffff:127.");
}

/**
 * Parse a `Host` request header. Returns a reason on failure so the 403 body
 * can say which layer rejected the request without echoing attacker input.
 */
export function parseHostHeader(rawHost) {
  if (typeof rawHost !== "string" || rawHost.trim() === "") {
    return { ok: false, reason: "host-missing" };
  }
  const value = rawHost.trim();
  if (/[\s/\\@,?#]/.test(value)) return { ok: false, reason: "host-invalid" };
  let parsed;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    return { ok: false, reason: "host-invalid" };
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return { ok: false, reason: "host-invalid" };
  }
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "host-invalid" };
  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return { ok: false, reason: "host-not-loopback" };
  return { ok: true, hostname, port: parsed.port };
}

/** Convenience predicate used by tests and `doctor`. */
export function isAllowedHost(rawHost) {
  return parseHostHeader(rawHost).ok;
}

/**
 * Create the process session. The token authenticates every read; the CSRF token
 * is required on writes so a stolen token alone is not enough.
 */
export function createSession({ now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS, token, csrf } = {}) {
  const expiresAtMs = now + ttlMs;
  return {
    token: token ?? randomToken(),
    csrf: csrf ?? randomToken(),
    actor: "HUMAN",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
  };
}

/** `true` once the session TTL has elapsed; the token then stops working. */
export function isSessionExpired(session, now = Date.now()) {
  return !session || now >= session.expiresAtMs;
}

/** Validate `x-atk-token`. */
export function checkToken(session, presented, now = Date.now()) {
  if (!session) return { ok: false, reason: "session-unavailable" };
  if (isSessionExpired(session, now)) return { ok: false, reason: "token-expired" };
  if (typeof presented !== "string" || presented === "") return { ok: false, reason: "token-missing" };
  if (!safeEqual(presented, session.token)) return { ok: false, reason: "token-invalid" };
  return { ok: true, reason: "token-ok" };
}

/** Validate `x-atk-csrf` on state-changing requests. */
export function checkCsrf(session, presented) {
  if (!session) return { ok: false, reason: "session-unavailable" };
  if (typeof presented !== "string" || presented === "") return { ok: false, reason: "csrf-missing" };
  if (!safeEqual(presented, session.csrf)) return { ok: false, reason: "csrf-invalid" };
  return { ok: true, reason: "csrf-ok" };
}

/**
 * Origin rule for writes.
 *
 * - A present Origin must be same-origin with the request Host (or explicitly
 *   allow-listed). This is the CSRF/DNS-rebinding boundary.
 * - A missing Origin is rejected unless the request carries the explicit CLI
 *   marker (`x-atk-client: cli`). ADR-008: curl/CLI use the token instead of
 *   bypassing validation; the marker is that opt-in, not a bypass of token/CSRF.
 */
export function checkWriteOrigin({ origin, hostHeader, cliHeader, allowedOrigins = [] } = {}) {
  const cliMarked = typeof cliHeader === "string" && cliHeader.trim().toLowerCase() === CLI_CLIENT_VALUE;
  if (origin === undefined || origin === null || String(origin).trim() === "") {
    return cliMarked ? { ok: true, reason: "cli-whitelisted" } : { ok: false, reason: "origin-missing" };
  }
  for (const allowed of allowedOrigins) {
    if (typeof allowed === "string" && allowed === origin) return { ok: true, reason: "origin-allowlisted" };
  }
  const host = parseHostHeader(hostHeader);
  if (!host.ok) return { ok: false, reason: "host-invalid" };
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    return { ok: false, reason: "origin-invalid" };
  }
  if (parsed.protocol !== "http:") return { ok: false, reason: "origin-scheme" };
  const expected = `${host.hostname}:${host.port || "80"}`;
  const actual = `${parsed.hostname.toLowerCase()}:${parsed.port || "80"}`;
  if (actual !== expected) return { ok: false, reason: "origin-mismatch" };
  return { ok: true, reason: "same-origin" };
}

/**
 * `/session` bootstrap: a browser same-origin GET may omit Origin (browsers do
 * on ordinary same-origin GETs), but if an Origin is present it must pass.
 */
export function checkBootstrapOrigin({ origin, hostHeader, allowedOrigins = [] } = {}) {
  if (origin === undefined || origin === null || String(origin).trim() === "") {
    return { ok: true, reason: "origin-absent" };
  }
  return checkWriteOrigin({ origin, hostHeader, cliHeader: undefined, allowedOrigins });
}

/**
 * Write the session token to the user-scoped token file.
 *
 * Failure is not fatal (ADR-008 / task spec): the server keeps the token in
 * memory and logs a warning. Returns the outcome so `serve` and `doctor` can
 * report the degraded state instead of silently pretending it worked.
 */
export function persistSessionToken(token, { tokenFile, logger, env = process.env } = {}) {
  const file = tokenFile ?? runtimePaths(env).tokenFile;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: SESSION_TOKEN_FILE_MODE, flag: "w" });
    try {
      fs.chmodSync(file, SESSION_TOKEN_FILE_MODE);
    } catch {
      // Windows does not implement POSIX modes; the user-scoped ACL still applies.
    }
    return { persisted: true, tokenFile: file, warning: null };
  } catch (error) {
    const warning =
      `cannot persist session token to ${file}: ${error?.message ?? error}. ` +
      "Continuing with an in-memory session token; the CLI must read /api/v1/session bootstrap instead.";
    logger?.warn?.(`[atk] ${warning}`);
    return { persisted: false, tokenFile: file, warning };
  }
}
