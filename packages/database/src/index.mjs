// Public entry point for @atk/database (contracts 搂1).
//
// Backend imports only this module (SQLite store) while tests/QA may import
// `@atk/database/memory` for a Store with the same behaviour and no file.
export { openStore, SCHEMA_VERSION } from "./sqlite.mjs";
export { createMemoryStore } from "./memory.mjs";
export { importStateJson, exportStateJson, verifySwitchReadiness } from "./import-export.mjs";
export { StoreError, isStoreError } from "./errors.mjs";

