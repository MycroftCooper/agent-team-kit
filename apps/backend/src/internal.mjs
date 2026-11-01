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

/** Environment variable used to hand the credential to runtime-host. */
export const INTERNAL_TOKEN_ENV = "ATK_INTERNAL_TOKEN";

/** 32 random bytes, base64url — same strength as the browser session token. */
export function createInternalToken() {
  return crypto.randomBytes(32).toString("base64url");
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
