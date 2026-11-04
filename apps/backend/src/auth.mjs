// Retained loopback, constant-time authentication and separate browser CSRF policy.
import crypto from "node:crypto";
export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? "")),
    b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function isLoopbackRemote(address) {
  return (
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) ||
    String(address).startsWith("::ffff:127.")
  );
}
export function isAllowedHost(host) {
  if (typeof host !== "string" || /[\s/\\@,?#]/.test(host)) return false;
  try {
    const u = new URL(`http://${host}`);
    return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}
export function createSession() {
  const now = Date.now();
  return {
    token: crypto.randomBytes(32).toString("base64url"),
    csrf: crypto.randomBytes(32).toString("base64url"),
    expiresAtMs: now + 8 * 60 * 60 * 1000,
    expiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
  };
}
export function isSessionExpired(session) {
  return !session || Date.now() >= session.expiresAtMs;
}
