// Public library surface. Programmatic use (CI wrappers, custom commands) can
// import these helpers instead of shelling out to the CLI.
export { runCli, usageText, VERSION } from "./dispatch.mjs";
export { createContext } from "./context.mjs";
export {
  CONFIG_FILENAMES,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  FLOW_FILE_DEFAULTS,
  ConfigError,
  findConfig,
  loadConfig,
  mergeDeep,
  resolveLayout,
  toProjectRelative,
  validateConfig,
} from "./config.mjs";
export { getLabels, LABELS } from "./labels.mjs";
export {
  auditPath,
  checkPermission,
  evaluatePermission,
  readAudit,
  recordDecision,
  refusalText,
  resolveSubject,
} from "./permissions.mjs";
export { PERMISSION_OPERATIONS, PERMISSION_SUBJECTS, REASON, actionFor, getOperation } from "./permission-registry.mjs";
export * as util from "./util.mjs";
