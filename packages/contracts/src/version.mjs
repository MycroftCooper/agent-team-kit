// Contract version and compatibility rules.
//
// The contract version is independent from the package version: the package can
// bump for refactors, but `CONTRACT_VERSION` only moves when a DTO field, enum
// value, error code or event name changes in a way a consumer can observe.

/** Bumped whenever a consumer-visible contract changes. */
export const CONTRACT_VERSION = "1.0.0-draft.1";

/** Major version of the public HTTP API path (`/api/v1/...`). */
export const API_MAJOR = 1;

/** Event/SSE schema version carried in every `Event` payload. */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * A consumer must not silently accept a different major contract: the field it
 * reads may have changed meaning. Minor/patch differences are additive.
 */
export function compatibilityOf(version) {
  const major = Number.parseInt(String(version ?? "").split(".")[0], 10);
  if (!Number.isInteger(major)) return { ok: false, reason: "malformed-version" };
  if (major === API_MAJOR) return { ok: true, reason: "same-major" };
  return { ok: false, reason: "major-mismatch" };
}

/** Throws when a consumer speaks an incompatible contract. */
export function assertCompatible(version) {
  const result = compatibilityOf(version);
  if (!result.ok) {
    throw new Error(`contracts: incompatible contract version "${version}" (expected major ${API_MAJOR}): ${result.reason}`);
  }
  return result;
}
