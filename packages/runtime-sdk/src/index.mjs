// @atk/runtime-sdk — AgentRuntime contract for M2.
//
// Contract source: docs/architecture/m2-contracts.md §1 (spec §9.1/§9.2,
// ADR-004, ADR-010). This module is pure: constants, JSDoc types and runtime
// validators, with no imports and no side effects. The deterministic
// MockRuntime lives in ./mock.mjs; the unsupported DSH placeholder lives in
// ./dsh-unsupported.mjs.
//
// Discipline (ADR-004 §2, ADR-010 §5): an adapter that cannot actually do a
// thing must say `false` in RuntimeCapabilities and reject with
// CAPABILITY_UNAVAILABLE. Never infer QA state from terminal text.

/** Version of the runtime contract implemented by this package. */
export const RUNTIME_CONTRACT_VERSION = "1";

/**
 * The seven capability booleans from spec §9.1. Append-only order: capability
 * snapshots are compared key by key across processes and releases.
 */
export const RUNTIME_CAPABILITY_KEYS = Object.freeze([
  "canStart",
  "canSend",
  "canObserveStructuredEvents",
  "canStop",
  "canReconnect",
  "canSpecifySessionModel",
  "canRunRestricted",
]);

/**
 * Machine-readable code an adapter must throw/reject with when asked for a
 * capability it reported as `false` (spec §9.1, ADR-004). It mirrors
 * `@atk/contracts`' ERROR_CODES.CAPABILITY_UNAVAILABLE; the value is duplicated
 * here on purpose so this package has no runtime import, which keeps it usable
 * before the workspace link exists and makes the interface the only contract.
 */
export const CAPABILITY_UNAVAILABLE = "CAPABILITY_UNAVAILABLE";

/** Error raised when an unsupported capability is exercised. */
export class CapabilityUnavailableError extends Error {
  /**
   * @param {string} detail human-readable explanation
   * @param {{capability?: string, adapterKind?: string}} [options]
   */
  constructor(detail, { capability, adapterKind } = {}) {
    super(`${CAPABILITY_UNAVAILABLE}: ${detail}`);
    this.name = "CapabilityUnavailableError";
    this.code = CAPABILITY_UNAVAILABLE;
    this.detail = detail;
    if (capability !== undefined) this.capability = capability;
    if (adapterKind !== undefined) this.adapterKind = adapterKind;
  }
}

/** True when `value` is a CapabilityUnavailableError (or shaped like one). */
export function isCapabilityUnavailableError(value) {
  return Boolean(value) && value.code === CAPABILITY_UNAVAILABLE;
}

/** The seven capabilities, all `false`. Frozen: adapters must not mutate it. */
export const ALL_CAPABILITIES_FALSE = Object.freeze(
  Object.fromEntries(RUNTIME_CAPABILITY_KEYS.map((key) => [key, false])),
);

/** Every RuntimeEvent `type` (the discriminated union from the contract). */
export const RUNTIME_EVENT_TYPES = Object.freeze([
  "session.started",
  "output",
  "state",
  "session.ended",
  "log",
]);

/** Allowed `stream` values for `output` events. */
export const OUTBOUND_STREAMS = Object.freeze(["stdout", "stderr"]);

/** Allowed `state` values for `state` events. */
export const RUNTIME_STATES = Object.freeze(["running", "idle", "waiting_input"]);

/** Allowed `reason` values for `session.ended` events. */
export const RUNTIME_END_REASONS = Object.freeze(["completed", "failed", "cancelled", "interrupted"]);

/** Allowed `level` values for `log` events. */
export const LOG_LEVELS = Object.freeze(["info", "warn", "error"]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushString(errors, label, value) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a non-empty string`);
}

function pushId(errors, label, value) {
  if (typeof value !== "string" || !ID_RE.test(value)) errors.push(`${label} must be an id string`);
}

function pushIso(errors, label, value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) errors.push(`${label} must be an ISO-8601 timestamp`);
}

function pushEnum(errors, label, value, allowed) {
  if (!allowed.includes(value)) errors.push(`${label} must be one of: ${allowed.join(", ")}`);
}

function pushUnknownKeys(errors, label, value, allowedKeys) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) errors.push(`${label}.${key} is not part of the contract`);
  }
}

/**
 * Validate a RuntimeCapabilities object. Returns `{ok, errors}` and never
 * throws, matching the contracts package style so callers can map a malformed
 * snapshot to VALIDATION_ERROR instead of crashing.
 */
export function validateCapabilities(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["capabilities must be an object"] };
  for (const key of RUNTIME_CAPABILITY_KEYS) {
    if (typeof value[key] !== "boolean") errors.push(`capabilities.${key} must be a boolean`);
  }
  pushUnknownKeys(errors, "capabilities", value, RUNTIME_CAPABILITY_KEYS);
  return { ok: errors.length === 0, errors };
}

/** Validate a StartRunInput object. */
export function validateStartRunInput(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["start input must be an object"] };
  pushId(errors, "runId", value.runId);
  pushId(errors, "taskId", value.taskId);
  pushString(errors, "prompt", value.prompt);
  pushString(errors, "cwd", value.cwd);
  if (value.model !== undefined) pushString(errors, "model", value.model);
  if (value.env !== undefined) {
    if (!isPlainObject(value.env)) {
      errors.push("env must be an object of string values");
    } else {
      for (const [key, envValue] of Object.entries(value.env)) {
        if (typeof envValue !== "string") errors.push(`env.${key} must be a string`);
      }
    }
  }
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0)) {
    errors.push("timeoutMs must be a positive integer");
  }
  pushUnknownKeys(errors, "startInput", value, ["runId", "taskId", "prompt", "cwd", "model", "env", "timeoutMs"]);
  return { ok: errors.length === 0, errors };
}

/** Validate a RuntimeSessionHandle returned by start()/reconnect(). */
export function validateRuntimeSessionHandle(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["session handle must be an object"] };
  pushString(errors, "sessionId", value.sessionId);
  if (value.nativeSessionId !== undefined) pushString(errors, "nativeSessionId", value.nativeSessionId);
  pushIso(errors, "startedAt", value.startedAt);
  const caps = validateCapabilities(value.capabilities);
  if (!caps.ok) for (const error of caps.errors) errors.push(`handle.${error}`);
  pushUnknownKeys(errors, "sessionHandle", value, ["sessionId", "nativeSessionId", "startedAt", "capabilities"]);
  return { ok: errors.length === 0, errors };
}

/** Validate a RuntimeHealth returned by probe(). */
export function validateRuntimeHealth(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["health must be an object"] };
  if (typeof value.ok !== "boolean") errors.push("health.ok must be a boolean");
  pushString(errors, "kind", value.kind);
  if (value.version !== undefined) pushString(errors, "version", value.version);
  if (value.detail !== undefined && typeof value.detail !== "string") errors.push("health.detail must be a string");
  const caps = validateCapabilities(value.capabilities);
  if (!caps.ok) for (const error of caps.errors) errors.push(`health.${error}`);
  pushUnknownKeys(errors, "health", value, ["ok", "kind", "version", "detail", "capabilities"]);
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a RuntimeEvent. Rejects an unknown `type`, a missing required field
 * for that variant, and any field that is not part of the contract union.
 */
export function validateRuntimeEvent(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["event must be an object"] };
  if (!RUNTIME_EVENT_TYPES.includes(value.type)) {
    errors.push(`event.type "${value.type}" is not a RuntimeEvent type`);
    // Do not run per-type checks against an unknown discriminator.
    return { ok: false, errors };
  }
  pushString(errors, "event.sessionId", value.sessionId);
  pushIso(errors, "event.at", value.at);

  switch (value.type) {
    case "session.started":
      pushUnknownKeys(errors, "event", value, ["type", "sessionId", "at"]);
      break;
    case "output":
      pushEnum(errors, "event.stream", value.stream, OUTBOUND_STREAMS);
      if (typeof value.text !== "string") errors.push("event.text must be a string");
      pushUnknownKeys(errors, "event", value, ["type", "sessionId", "at", "stream", "text"]);
      break;
    case "state":
      pushEnum(errors, "event.state", value.state, RUNTIME_STATES);
      pushUnknownKeys(errors, "event", value, ["type", "sessionId", "at", "state"]);
      break;
    case "session.ended":
      pushEnum(errors, "event.reason", value.reason, RUNTIME_END_REASONS);
      if (value.exitCode !== null && !Number.isInteger(value.exitCode)) {
        errors.push("event.exitCode must be an integer or null");
      }
      pushUnknownKeys(errors, "event", value, ["type", "sessionId", "at", "reason", "exitCode"]);
      break;
    case "log":
      pushEnum(errors, "event.level", value.level, LOG_LEVELS);
      pushString(errors, "event.message", value.message);
      pushUnknownKeys(errors, "event", value, ["type", "sessionId", "at", "level", "message"]);
      break;
    default:
      break;
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Capability keys that are not positively asserted. Anything other than a
 * literal `true` counts as unsupported: an unset or malformed value must never
 * be treated as available.
 */
export function unsupportedCapabilities(capabilities) {
  return Object.freeze(RUNTIME_CAPABILITY_KEYS.filter((key) => capabilities?.[key] !== true));
}

/**
 * Throw when any required capability is not supported. Returns nothing on
 * success; used by callers that need a hard precondition.
 * @param {object} capabilities
 * @param {string[]} required
 */
export function assertCapabilities(capabilities, required) {
  const missing = required.filter((key) => capabilities?.[key] !== true);
  if (missing.length > 0) {
    throw new CapabilityUnavailableError(`missing capabilities: ${missing.join(", ")}`, { capability: missing[0] });
  }
}

/**
 * @typedef {object} RuntimeCapabilities
 * @property {boolean} canStart
 * @property {boolean} canSend
 * @property {boolean} canObserveStructuredEvents
 * @property {boolean} canStop
 * @property {boolean} canReconnect
 * @property {boolean} canSpecifySessionModel
 * @property {boolean} canRunRestricted
 */

/**
 * @typedef {object} RuntimeHealth
 * @property {boolean} ok
 * @property {string} kind
 * @property {string} [version]
 * @property {string} [detail]
 * @property {RuntimeCapabilities} capabilities
 */

/**
 * @typedef {object} StartRunInput
 * @property {string} runId
 * @property {string} taskId
 * @property {string} prompt
 * @property {string} cwd
 * @property {string} [model]
 * @property {Record<string, string>} [env]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {object} RuntimeSessionHandle
 * @property {string} sessionId
 * @property {string} [nativeSessionId]
 * @property {string} startedAt
 * @property {RuntimeCapabilities} capabilities
 */

/**
 * @typedef {{type: "session.started", sessionId: string, at: string}
 *   | {type: "output", sessionId: string, stream: "stdout"|"stderr", text: string, at: string}
 *   | {type: "state", sessionId: string, state: "running"|"idle"|"waiting_input", at: string}
 *   | {type: "session.ended", sessionId: string, at: string, reason: "completed"|"failed"|"cancelled"|"interrupted", exitCode: number|null}
 *   | {type: "log", sessionId: string, level: "info"|"warn"|"error", message: string, at: string}} RuntimeEvent
 */

/**
 * @typedef {object} AgentRuntime
 * @property {string} kind
 * @property {() => Promise<RuntimeHealth>} probe
 * @property {() => Promise<RuntimeCapabilities>} capabilities
 * @property {(input: StartRunInput) => Promise<RuntimeSessionHandle>} start
 * @property {(sessionId: string, prompt: string) => Promise<void>} send
 * @property {(sessionId: string) => Promise<void>} stop
 * @property {(sessionId: string) => Promise<RuntimeSessionHandle | null>} reconnect
 * @property {(sessionId: string, sink: (event: RuntimeEvent) => void) => Promise<() => void>} subscribe
 */

/**
 * Structural check that an object exposes every AgentRuntime member with the
 * right arity type. Returns `{ok, errors}` like the other validators.
 */
export function validateAgentRuntime(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["runtime must be an object"] };
  if (typeof value.kind !== "string" || value.kind.trim() === "") errors.push("runtime.kind must be a non-empty string");
  for (const method of ["probe", "capabilities", "start", "send", "stop", "reconnect", "subscribe"]) {
    if (typeof value[method] !== "function") errors.push(`runtime.${method} must be a function`);
  }
  return { ok: errors.length === 0, errors };
}
