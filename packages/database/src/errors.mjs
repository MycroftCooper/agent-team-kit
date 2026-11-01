// Store errors follow the contract envelope `{ code, message, details? }`
// (docs/architecture/m1-contracts.md §1 + packages/contracts/src/errors.mjs).
//
// The Backend maps `error.code` to `ERROR_CODES[code].http`; the class only adds
// ergonomics (stack, instanceof) on top of the same fields. Never throw a bare
// string: every store failure is machine-readable.
import { ERROR_CODES } from "@atk/contracts";

export class StoreError extends Error {
  /**
   * @param {string} code   one of contracts.ERROR_CODES
   * @param {string} message human-readable, safe to log
   * @param {object} [details] JSON-safe structured context (never secrets)
   */
  constructor(code, message, details) {
    super(message ?? code);
    this.name = "StoreError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

/** Duck-typed check so errors crossing a JSON boundary still count. */
export function isStoreError(value) {
  return (
    value instanceof StoreError ||
    (Boolean(value) &&
      typeof value === "object" &&
      typeof value.code === "string" &&
      typeof value.message === "string" &&
      Object.prototype.hasOwnProperty.call(ERROR_CODES, value.code))
  );
}

/** Throw a contract-shaped error. Fails fast on a typo'd/unknown code. */
export function fail(code, message, details) {
  if (!Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
    throw new Error(`@atk/database: unknown error code "${code}"`);
  }
  throw new StoreError(code, message, details);
}

export function notFound(entity, id) {
  fail("NOT_FOUND", `${entity} "${id}" not found`, { entity, id });
}

export function validationError(message, details) {
  fail("VALIDATION_ERROR", message, details);
}
