// `<dataDir>/launcher.json`: the launcher's process bookkeeping.
//
// Contract (m5-contracts §1): `{ version, port, startedAt, children: [{name, pid, role}] }`.
// The file deliberately has a closed shape and never carries the internal token:
// the token is handed to children through their environment only (ADR-010). Any
// attempt to smuggle a token-like field into the state is a programming error and
// throws, so a future refactor cannot silently leak it to disk.
import fs from "node:fs";
import path from "node:path";

export const STATE_VERSION = 1;
export const CHILD_ROLES = Object.freeze(["backend", "scheduler", "host"]);
const STATE_KEYS = Object.freeze(["version", "port", "startedAt", "children"]);
const CHILD_KEYS = Object.freeze(["name", "pid", "role"]);
const FORBIDDEN_KEY = /token|secret|credential|password/i;

export function statePathFor(dataDir) {
  return path.join(dataDir, "launcher.json");
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`launcher state: ${label} must be an object`);
  }
}

function assertNoForbiddenKeys(value, label) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${label}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`launcher state: refusing to persist "${label}.${key}" — the internal credential belongs in child env, not on disk`);
    }
    assertNoForbiddenKeys(entry, `${label}.${key}`);
  }
}

/** Validate the exact contract shape (closed: unknown keys are rejected). */
export function validateState(state) {
  assertPlainObject(state, "state");
  assertNoForbiddenKeys(state, "state");
  const extra = Object.keys(state).filter((key) => !STATE_KEYS.includes(key));
  if (extra.length > 0) throw new Error(`launcher state: unknown top-level field(s): ${extra.join(", ")}`);
  if (state.version !== STATE_VERSION) throw new Error(`launcher state: version must be ${STATE_VERSION}, got ${state.version}`);
  if (!Number.isInteger(state.port) || state.port <= 0 || state.port > 65535) {
    throw new Error(`launcher state: port must be an integer in 1..65535, got ${state.port}`);
  }
  if (typeof state.startedAt !== "string" || Number.isNaN(Date.parse(state.startedAt))) {
    throw new Error(`launcher state: startedAt must be an ISO-8601 string, got ${state.startedAt}`);
  }
  if (!Array.isArray(state.children) || state.children.length === 0) {
    throw new Error("launcher state: children must be a non-empty array");
  }
  for (const child of state.children) {
    assertPlainObject(child, "child");
    const childExtra = Object.keys(child).filter((key) => !CHILD_KEYS.includes(key));
    if (childExtra.length > 0) throw new Error(`launcher state: unknown child field(s): ${childExtra.join(", ")}`);
    if (typeof child.name !== "string" || child.name === "") throw new Error("launcher state: child.name must be a non-empty string");
    if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error(`launcher state: child.pid must be a positive integer (${child.name})`);
    if (!CHILD_ROLES.includes(child.role)) throw new Error(`launcher state: child.role must be one of ${CHILD_ROLES.join(", ")} (${child.name})`);
  }
  return state;
}

/** Read `<dataDir>/launcher.json`; a missing/corrupt/hostile file reads as `null`. */
export function readState(stateFile) {
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    return validateState(parsed);
  } catch {
    return null;
  }
}

/**
 * Atomic write: serialize to a sibling temp file, fsync it, then rename over the
 * target (same volume, so the rename is atomic and readers never see half a file).
 */
export function writeState(stateFile, state) {
  validateState(state);
  const directory = path.dirname(stateFile);
  fs.mkdirSync(directory, { recursive: true });
  const tempFile = path.join(
    directory,
    `.${path.basename(stateFile)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  const body = `${JSON.stringify(state, null, 2)}\n`;
  let handle;
  try {
    handle = fs.openSync(tempFile, "wx", 0o600);
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  try {
    fs.renameSync(tempFile, stateFile);
  } catch (error) {
    // Windows can refuse replacing a file that another process briefly holds;
    // retry once, then fall back to copy+unlink (still leaves a complete file).
    try {
      fs.renameSync(tempFile, stateFile);
    } catch {
      fs.copyFileSync(tempFile, stateFile);
      fs.unlinkSync(tempFile);
    }
    if (error?.code !== "EEXIST" && error?.code !== "EPERM" && error?.code !== "EACCES") {
      // The fallback above already wrote the complete body; no rethrow needed.
    }
  }
  return state;
}

/** Remove the state file if it exists (idempotent). */
export function removeState(stateFile) {
  try {
    fs.unlinkSync(stateFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
