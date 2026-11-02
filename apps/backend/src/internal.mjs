// Internal credential for `/internal/v1/*` (M2 / ADR-008 §5, ADR-010 §2).
//
// The internal credential is deliberately a different mechanism from the browser
// session token:
// - generated per Backend process, never persisted, never logged, never returned
//   in an HTTP response;
// - handed to child processes only through the environment (`ATK_INTERNAL_TOKEN`);
// - internal routes only read `x-atk-internal` and never accept `x-atk-token`,
//   and browser routes never accept the internal token.
import crypto from "node:crypto";

import { safeEqual } from "./auth.mjs";

/** Request header carrying the internal credential. */
export const INTERNAL_TOKEN_HEADER = "x-atk-internal";

/** Additional assertion: which kind of internal caller is this? (m6.1 §2) */
export const INTERNAL_ROLE_HEADER = "x-atk-internal-role";

/** The only roles the Backend trusts, and what each may do. */
export const INTERNAL_ROLES = Object.freeze(["scheduler", "runtime-host", "user-action"]);

/**
 * Endpoint → allowed internal roles. `null` means "not declared yet" and is
 * treated as deny-by-default by callers: an undeclared internal endpoint never
 * silently accepts any role.
 */
export const INTERNAL_ROLE_MATRIX = Object.freeze([
  { method: "POST", pattern: /^\/internal\/v1\/tasks\/[^/]+\/claim$/, roles: ["scheduler"] },
  { method: "GET", pattern: /^\/internal\/v1\/scheduling\/snapshot$/, roles: ["scheduler"] },
  { method: "POST", pattern: /^\/internal\/v1\/scheduler\/heartbeat$/, roles: ["scheduler"] },
  { method: "POST", pattern: /^\/internal\/v1\/tasks\/[^/]+\/integration$/, roles: ["scheduler", "user-action"] },
  { method: "POST", pattern: /^\/internal\/v1\/dispatch\/sweep$/, roles: ["scheduler", "user-action"] },
  { method: "GET", pattern: /^\/internal\/v1\/dispatch\/claim$/, roles: ["runtime-host"] },
  { method: "POST", pattern: /^\/internal\/v1\/dispatch\/[^/]+\/result$/, roles: ["runtime-host"] },
  { method: "POST", pattern: /^\/internal\/v1\/runs\/[^/]+\/renew$/, roles: ["runtime-host"] },
  { method: "POST", pattern: /^\/internal\/v1\/runs\/[^/]+\/events$/, roles: ["runtime-host"] },
  { method: "GET", pattern: /^\/internal\/v1\/runs\/[^/]+\/reconcile$/, roles: ["runtime-host"] },
  { method: "GET", pattern: /^\/internal\/v1\/runs\/[^/]+\/spec$/, roles: ["scheduler", "runtime-host"] },
  { method: "GET", pattern: /^\/internal\/v1\/runtime\/availability$/, roles: ["scheduler"] },
  { method: "POST", pattern: /^\/internal\/v1\/runtime\/register$/, roles: ["runtime-host"] },
  { method: "POST", pattern: /^\/internal\/v1\/runtime\/heartbeat$/, roles: ["runtime-host"] },
  { method: "POST", pattern: /^\/internal\/v1\/tasks\/[^/]+\/review-runs$/, roles: ["scheduler", "user-action"] },
]);

/** Roles allowed for a request, or null when the route is not declared. */
export function requiredInternalRoles(method, pathname) {
  const entry = INTERNAL_ROLE_MATRIX.find((route) => route.method === method && route.pattern.test(pathname));
  return entry ? [...entry.roles] : null;
}

/**
 * Validate the role assertion for an internal request.
 * reason codes are part of m6.1-contracts §2 (do not reword).
 */
export function checkInternalRole(presented, allowedRoles) {
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : INTERNAL_ROLES;
  if (typeof presented !== "string" || presented.trim() === "") {
    return { ok: false, reason: "internal-role-required", allowed: [...allowed] };
  }
  const role = presented.trim();
  if (!INTERNAL_ROLES.includes(role)) {
    return { ok: false, reason: "internal-role-forbidden", role, allowed: [...allowed] };
  }
  if (!allowed.includes(role)) {
    return { ok: false, reason: "internal-role-forbidden", role, allowed: [...allowed] };
  }
  return { ok: true, role };
}

/** Environment variable used to hand the credential to runtime-host. */
export const INTERNAL_TOKEN_ENV = "ATK_INTERNAL_TOKEN";

/** 32 random bytes, base64url — same strength as the browser session token. */
export function createInternalToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/** The two independent internal token roles (M6.3 P0-2). */
export const INTERNAL_ROLE_SCHEDULER = "scheduler";
export const INTERNAL_ROLE_RUNTIME_HOST = "runtime-host";

/** Two independent, non-equal credentials. */
export function createInternalTokens() {
  const scheduler = createInternalToken();
  let runtimeHost = createInternalToken();
  while (runtimeHost === scheduler) runtimeHost = createInternalToken();
  return { [INTERNAL_ROLE_SCHEDULER]: scheduler, [INTERNAL_ROLE_RUNTIME_HOST]: runtimeHost };
}

/** Normalise the supported token-map spellings (`host` is an accepted alias). */
export function normalizeInternalTokens(value) {
  if (!value || typeof value !== "object") return null;
  const scheduler = value[INTERNAL_ROLE_SCHEDULER];
  const runtimeHost = value[INTERNAL_ROLE_RUNTIME_HOST] ?? value.host;
  if (typeof scheduler !== "string" || scheduler === "") return null;
  if (typeof runtimeHost !== "string" || runtimeHost === "") return null;
  return { [INTERNAL_ROLE_SCHEDULER]: scheduler, [INTERNAL_ROLE_RUNTIME_HOST]: runtimeHost };
}

/**
 * M6.3 P0-2: the single token→role binding entry point. Endpoint authorization
 * must be based on this result, never on a client-declared role header.
 */
export function resolveInternalIdentity(tokens, presented) {
  if (typeof presented !== "string" || presented === "") {
    return { ok: false, reason: "internal-token-missing" };
  }
  const normalized = normalizeInternalTokens(tokens);
  if (normalized === null) return { ok: false, reason: "internal-token-unavailable" };
  if (safeEqual(presented, normalized[INTERNAL_ROLE_SCHEDULER])) {
    return { ok: true, role: INTERNAL_ROLE_SCHEDULER };
  }
  if (safeEqual(presented, normalized[INTERNAL_ROLE_RUNTIME_HOST])) {
    return { ok: true, role: INTERNAL_ROLE_RUNTIME_HOST };
  }
  return { ok: false, reason: "internal-token-invalid" };
}

/**
 * Optional `x-atk-internal-role` is only an additional assertion: when present
 * it must equal the role bound to the token.
 */
export function checkInternalRoleHeader(boundRole, presented) {
  if (presented === undefined || presented === null || presented === "") return { ok: true, role: boundRole };
  if (presented === boundRole) return { ok: true, role: boundRole };
  return {
    ok: false,
    reason: "internal-role-forbidden",
    role: presented,
    expectedRole: boundRole,
  };
}

/**
 * Validate `x-atk-internal`. Reason codes are part of m2-contracts §2 and must
 * not be reworded.
 */
export function checkInternalToken(expectedToken, presented) {
  if (typeof expectedToken !== "string" || expectedToken === "") {
    return { ok: false, reason: "internal-token-unavailable" };
  }
  if (typeof presented !== "string" || presented === "") {
    return { ok: false, reason: "internal-token-missing" };
  }
  if (!safeEqual(presented, expectedToken)) {
    return { ok: false, reason: "internal-token-invalid" };
  }
  return { ok: true, reason: "internal-token-ok" };
}

/**
 * Normalise a lease from the store into the HTTP shape promised by
 * m2-contracts §2 (`{ ownerId, generation, claimedUntil }`). The database may
 * use `holderId`/`expiresAt` internally; the public/internal contract stays
 * stable either way.
 */
export function normalizeLease(lease) {
  if (!lease || typeof lease !== "object") return null;
  return {
    ownerId: lease.ownerId ?? lease.holderId ?? null,
    generation: Number.isInteger(lease.generation) ? lease.generation : null,
    claimedUntil: lease.claimedUntil ?? lease.expiresAt ?? null,
  };
}
