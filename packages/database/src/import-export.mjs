// Legacy JSON <-> SQLite import/export (M1 `atk migrate` / `atk export` carrier).
//
// Import maps the pre-M1 workflow files into the store:
//   state.json    -> project (+ requirement from `batch`) + tasks
//                    (`packages[]`, `subitems[]`, `batch.slices[]`)
//   runtime.json  -> agent_instances
//   ownership.json/agent-flow.config.json -> project metadata used by the
//                    migration manifest (kept for audit/export, no rules table
//                    in schema v1)
// Old files contain no Run records, so `runs` is imported as genuinely empty:
// we report that explicitly in `manifest.runs` instead of fabricating rows.
//
// Rules from contracts §1:
//   * `dryRun` only counts, never writes;
//   * duplicate execution is idempotent (same id -> skip, never a second row);
//   * a duplicate id *inside one input* is an error (`DUPLICATE_ID`), not a
//     silent overwrite of other data;
//   * any `level: "error"` problem means `status !== "PASS"`.
import { createHash } from "node:crypto";
import { FUNCTIONS, ID_RE } from "@atk/contracts";
import { fail, notFound } from "./errors.mjs";
import { INTERNAL } from "./internal.mjs";
import { MAX_LIST_LIMIT, isPlainObject, isoOrNull, nowIso } from "./model.mjs";

const TOOL = "@atk/database";
const TOOL_VERSION = "0.1.0";
const MANIFEST_SCHEMA_VERSION = 1;
const LEGACY_STATE_SCHEMA_VERSION = 1;

// --- Legacy vocabulary maps -------------------------------------------------
// package/subitem stage -> Task.status (INTERNALS.md §4.1 stage enum)
const PACKAGE_STAGE_TO_STATUS = Object.freeze({
  done: "DONE",
  implemented: "AWAITING_ACCEPTANCE",
  partial: "RUNNING",
  "in-progress": "RUNNING",
  todo: "READY",
  blocked: "BLOCKED",
  proposed: "READY",
  // Tolerant extra values: they are not in the old stage enum but export writes
  // them when a migrated task has since been cancelled, and a round-trip must
  // not silently turn CANCELLED into READY.
  cancelled: "CANCELLED",
});
// batch slice status -> Task.status
const SLICE_STATUS_TO_STATUS = Object.freeze({
  todo: "READY",
  in_progress: "RUNNING",
  frozen: "REVIEWING",
  qa: "REVIEWING",
  qa_with_gap: "REVIEWING",
  awaiting_apply: "INTEGRATING",
  awaiting_accept: "AWAITING_ACCEPTANCE",
  blocked: "BLOCKED",
  paused: "BLOCKED",
  done: "DONE",
  cancelled: "CANCELLED",
});
// Task.status -> legacy stage (export of tasks created after migration)
const STATUS_TO_STAGE = Object.freeze({
  DRAFT: "proposed",
  READY: "todo",
  CLAIMED: "in-progress",
  RUNNING: "in-progress",
  REVIEWING: "qa",
  INTEGRATING: "awaiting_apply",
  AWAITING_ACCEPTANCE: "implemented",
  DONE: "done",
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
});
// Task.status -> legacy slice status
const STATUS_TO_SLICE = Object.freeze({
  DRAFT: "todo",
  READY: "todo",
  CLAIMED: "in_progress",
  RUNNING: "in_progress",
  REVIEWING: "qa",
  INTEGRATING: "awaiting_apply",
  AWAITING_ACCEPTANCE: "awaiting_accept",
  DONE: "done",
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
});
const RUNTIME_STATUS_TO_AGENT = Object.freeze({
  working: "BUSY",
  waiting: "WAITING_APPROVAL",
  idle: "IDLE",
  offline: "OFFLINE",
  error: "ERROR",
  disconnected: "DISCONNECTED",
});

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

/** Deterministic, contract-valid id derived from arbitrary legacy text. */
function safeId(value) {
  let text = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._:]+/, "")
    .replace(/[-._:]+$/, "");
  if (text === "") text = "X";
  if (!/^[A-Za-z0-9]/.test(text)) text = `X-${text}`;
  return text.slice(0, 128);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function ensureStore(store, label) {
  if (
    !store ||
    typeof store !== "object" ||
    typeof store.listProjects !== "function" ||
    typeof store.getProject !== "function" ||
    typeof store.createTask !== "function"
  ) {
    fail("VALIDATION_ERROR", `${label} requires a Store instance`, { entity: label });
  }
  return store;
}

/** Read one optional input, accepting an object or a raw JSON string. */
function readJsonInput(value, label, report) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      report("error", "INVALID_JSON", { input: label, reason: error.message });
      return null;
    }
  }
  if (!isPlainObject(value)) {
    report("error", "INVALID_RECORD", { input: label, reason: "must be an object" });
    return null;
  }
  return value;
}

function readOrNull(read, id) {
  try {
    return read(id);
  } catch (error) {
    if (error && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** Report non-ASCII paths (ADR-006 sample) without rejecting them. */
function noteNonAsciiPath(value, report, context) {
  if (typeof value === "string" && /[^\x00-\x7F]/.test(value)) {
    report("info", "NON_ASCII_PATH", { ...context, path: value });
  }
}

/**
 * Reject repo-relative paths that escape the project root (path traversal /
 * absolute host paths). Imports never write files, but a migrated state.json
 * must not smuggle paths the old tools would later follow outside the repo.
 */
function checkRelativePath(value, report, context) {
  if (typeof value !== "string" || value.trim() === "") return;
  const text = value.replace(/\\/g, "/");
  if (text.includes("\0")) {
    report("error", "PATH_ESCAPE", { ...context, path: value, reason: "nul-byte" });
    return;
  }
  if (/^[A-Za-z]:/.test(text) || text.startsWith("/") || text.startsWith("//")) {
    report("error", "PATH_ESCAPE", { ...context, path: value, reason: "absolute-path" });
    return;
  }
  if (text.split("/").some((segment) => segment === "..")) {
    report("error", "PATH_ESCAPE", { ...context, path: value, reason: "parent-segment" });
    return;
  }
  noteNonAsciiPath(value, report, context);
}

function roleFromOwner(owner, report, context) {
  if (typeof owner !== "string" || owner.trim() === "") {
    report("warning", "ROLE_DERIVED", { ...context, reason: "missing owner", role: "DEV" });
    return "DEV";
  }
  const token = owner.split(/[;；,，、/+|]+/).map((part) => part.trim()).find((part) => part !== "");
  const role = (token ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!/^[A-Z][A-Z0-9_]*$/.test(role)) {
    report("warning", "ROLE_DERIVED", { ...context, owner, reason: "unparseable owner", role: "DEV" });
    return "DEV";
  }
  return role;
}

function functionFromOwner(owner) {
  if (typeof owner !== "string") return "WORKER";
  const text = owner.toUpperCase();
  if (/(^|[^A-Z0-9_])QA([^A-Z0-9_]|$)/.test(text)) return "REVIEWER";
  if (/(^|[^A-Z0-9_])LEAD([^A-Z0-9_]|$)/.test(text)) return "ORCHESTRATOR";
  return "WORKER";
}

function priorityFromLegacy(value, report, context) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const match = /^P(\d+)$/i.exec(value.trim());
    if (match) return Number.parseInt(match[1], 10);
    const numeric = Number.parseInt(value, 10);
    if (Number.isInteger(numeric)) return numeric;
    if (value.trim() !== "") {
      report("warning", "PRIORITY_DERIVED", { ...context, value, priority: 2 });
    }
  }
  return 2;
}

function legacyDeps(item, report, context) {
  if (Array.isArray(item.deps)) return stringArray(item.deps);
  if (typeof item.depsRaw === "string" && item.depsRaw.trim() !== "") {
    return item.depsRaw
      .split(/[,;，；\s]+/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  return [];
}

function legacyStatusOf(item, kind, report, context) {
  if (kind === "slice") {
    const status = typeof item.status === "string" ? item.status.trim() : "";
    const mapped = SLICE_STATUS_TO_STATUS[status];
    if (mapped) return mapped;
    if (status !== "") report("warning", "STATUS_DERIVED", { ...context, value: status, status: "READY" });
    return "READY";
  }
  const stage = typeof item.stage === "string" ? item.stage.trim() : "";
  let mapped = PACKAGE_STAGE_TO_STATUS[stage];
  if (!mapped) {
    if (stage !== "") report("warning", "STATUS_DERIVED", { ...context, value: stage, status: "READY" });
    mapped = "READY";
  }
  if (item.verification && item.verification.humanAccepted === true) mapped = "DONE";
  if (item.archived === true) mapped = mapped === "DONE" ? "DONE" : "CANCELLED";
  return mapped;
}

function mapLegacyTask(item, kind, report) {
  const id = item.id;
  const context = { entity: "task", id };
  checkRelativePath(item.scope, report, { ...context, field: "scope" });
  checkRelativePath(item.evidence, report, { ...context, field: "evidence" });
  const title = firstString(item.label, item.title, item.module, item.id);
  const description = firstString(item.description, item.scope, item.note, item.id);
  const roleRequired = roleFromOwner(item.owner, report, { ...context, field: "owner" });
  return {
    id,
    title,
    description,
    roleRequired,
    functionRequired: functionFromOwner(item.owner),
    priority: priorityFromLegacy(item.priority, report, { ...context, field: "priority" }),
    status: legacyStatusOf(item, kind, report, { ...context, field: "status" }),
    deps: legacyDeps(item, report, { ...context, field: "deps" }).filter((dep) => dep !== id),
    acceptance: firstString(item.acceptance, item.exit),
    /** @type {"package"|"subitem"|"slice"} */
    kind,
  };
}

function defaultFunctionsForRole(role) {
  if (role === "LEAD") return ["ORCHESTRATOR"];
  if (role === "QA") return ["REVIEWER"];
  return ["WORKER"];
}

function mapLegacyAgent(raw, index, report) {
  if (!isPlainObject(raw)) {
    report("error", "INVALID_RECORD", { collection: "runtime.agents", index, reason: "must be an object" });
    return null;
  }
  const rawRole = typeof raw.role === "string" ? raw.role.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_") : "";
  const role = /^[A-Z][A-Z0-9_]*$/.test(rawRole) ? rawRole : "DEV";
  if (role !== rawRole) {
    report("warning", "ROLE_DERIVED", {
      collection: "runtime.agents",
      index,
      value: raw.role ?? null,
      role,
    });
  }
  let id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    id = safeId(`agent-${role.toLowerCase()}-${String(index + 1).padStart(2, "0")}`);
    report("warning", "AGENT_ID_DERIVED", { collection: "runtime.agents", index, value: raw.id ?? null, id });
  }
  let capabilities = [];
  if (Array.isArray(raw.capabilities)) {
    capabilities = [...new Set(raw.capabilities.filter((capability) => FUNCTIONS.includes(capability)))];
    const invalid = raw.capabilities.filter((capability) => !FUNCTIONS.includes(capability));
    if (invalid.length > 0) report("warning", "INVALID_CAPABILITY", { agent: id, values: invalid });
  }
  if (capabilities.length === 0) {
    capabilities = defaultFunctionsForRole(role);
    report("warning", "CAPABILITIES_DERIVED", { agent: id, role, capabilities });
  }
  const rawStatus = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  let status = RUNTIME_STATUS_TO_AGENT[rawStatus];
  if (!status) {
    status = "IDLE";
    if (rawStatus !== "") report("warning", "STATUS_DERIVED", { agent: id, value: raw.status, status });
  }
  const agent = { id, role, capabilities, status };
  if (typeof raw.task === "string") agent.task = raw.task;
  if (typeof raw.detail === "string") agent.detail = raw.detail;
  const since = isoOrNull(raw.since);
  if (since !== null) agent.since = since;
  return agent;
}

function batchMeta(batch) {
  if (!isPlainObject(batch)) return null;
  const meta = {};
  for (const key of ["id", "goal", "stopCondition", "devClosedByUser", "applyMode", "openQuestions", "manifestTag", "allowRootFiles", "legacyReceipts"]) {
    if (batch[key] !== undefined) meta[key] = batch[key];
  }
  return meta;
}

/**
 * Import legacy workflow JSON into a Store.
 *
 * @param {object} store
 * @param {{
 *   stateJson: object|string|null,
 *   ownership?: object|string|null,
 *   runtime?: object|string|null,
 *   now?: string,
 *   dryRun?: boolean,
 *   projectId?: string,
 *   projectName?: string,
 *   repoPath?: string,
 *   defaultBranch?: string,
 *   config?: object|string|null,
 * }} options
 */
export function importStateJson(store, options = {}) {
  ensureStore(store, "importStateJson");
  if (!isPlainObject(options)) {
    fail("VALIDATION_ERROR", "importStateJson options must be an object", { entity: "importStateJson" });
  }
  const {
    stateJson,
    ownership,
    runtime,
    now,
    dryRun = false,
    config,
    projectId: explicitProjectId,
    projectName,
    repoPath,
    defaultBranch,
  } = options;
  if (typeof dryRun !== "boolean") {
    fail("VALIDATION_ERROR", "importStateJson.dryRun must be a boolean", { dryRun });
  }
  const at = nowIso(now);
  const problems = [];
  const report = (level, code, detail) => {
    problems.push({ level, code, detail });
  };
  const hasErrors = () => problems.some((problem) => problem.level === "error");

  const state = readJsonInput(stateJson, "stateJson", report);
  const ownershipInput = readJsonInput(ownership, "ownership", report);
  const runtimeInput = readJsonInput(runtime, "runtime", report);
  const configInput = readJsonInput(config, "config", report);

  if (state === null) {
    report("error", "MISSING_INPUT", { input: "stateJson", reason: "state.json is required" });
  } else if (state.schemaVersion === undefined) {
    report("warning", "STATE_SCHEMA_VERSION_MISSING", { schemaVersion: null });
  } else if (state.schemaVersion !== LEGACY_STATE_SCHEMA_VERSION) {
    report("error", "UNSUPPORTED_SCHEMA_VERSION", {
      input: "stateJson",
      schemaVersion: state.schemaVersion,
      supported: [LEGACY_STATE_SCHEMA_VERSION],
    });
  }

  // --- Project identity ---------------------------------------------------
  const configProject = isPlainObject(configInput) ? configInput.project : undefined;
  const projectId = explicitProjectId ?? configProject ?? state?.project?.id ?? "default";
  if (typeof projectId !== "string" || !ID_RE.test(projectId)) {
    report("error", "INVALID_PROJECT_ID", { projectId: projectId ?? null });
  }
  const projectNameValue = projectName ?? configProject ?? state?.project?.name ?? projectId;
  const repoPathValue = repoPath ?? state?.project?.repoPath ?? state?.repoPath ?? ".";
  const defaultBranchValue = defaultBranch ?? state?.project?.defaultBranch ?? "main";
  const derived = {
    id: explicitProjectId === undefined && configProject === undefined && state?.project?.id === undefined,
    repoPath: repoPath === undefined && state?.project?.repoPath === undefined && state?.repoPath === undefined,
    defaultBranch: defaultBranch === undefined && state?.project?.defaultBranch === undefined,
    name: projectName === undefined && configProject === undefined && state?.project?.name === undefined,
  };
  if (derived.id) report("info", "PROJECT_ID_DERIVED", { projectId, from: "fallback:default" });
  if (derived.repoPath) report("info", "PROJECT_FIELD_DERIVED", { field: "repoPath", value: repoPathValue });
  if (derived.defaultBranch) {
    report("info", "PROJECT_FIELD_DERIVED", { field: "defaultBranch", value: defaultBranchValue });
  }
  if (typeof projectNameValue !== "string" || projectNameValue.trim() === "") {
    report("error", "INVALID_PROJECT_FIELD", { field: "name", value: projectNameValue ?? null });
  }
  if (typeof repoPathValue !== "string" || repoPathValue.trim() === "") {
    report("error", "INVALID_PROJECT_FIELD", { field: "repoPath", value: repoPathValue ?? null });
  }
  if (typeof defaultBranchValue !== "string" || defaultBranchValue.trim() === "") {
    report("error", "INVALID_PROJECT_FIELD", { field: "defaultBranch", value: defaultBranchValue ?? null });
  }
  if (typeof repoPathValue === "string") noteNonAsciiPath(repoPathValue, report, { entity: "project", field: "repoPath" });

  // --- Collect tasks from packages / subitems / batch.slices ---------------
  const records = [];
  const idSources = new Map();
  const collectList = (list, collection, kind) => {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) {
      report("error", "INVALID_RECORD", { collection, reason: "must be an array" });
      return;
    }
    list.forEach((item, index) => {
      if (!isPlainObject(item)) {
        report("error", "INVALID_RECORD", { collection, index, reason: "must be an object" });
        return;
      }
      if (typeof item.id !== "string" || !ID_RE.test(item.id)) {
        report("error", "INVALID_ID", { collection, index, field: "id", value: item.id ?? null });
        return;
      }
      const source = `${collection}[${index}]`;
      if (idSources.has(item.id)) {
        report("error", "DUPLICATE_ID", {
          id: item.id,
          first: idSources.get(item.id),
          second: source,
        });
        return;
      }
      idSources.set(item.id, source);
      records.push({ kind, source, raw: item, mapped: mapLegacyTask(item, kind, report) });
    });
  };

  const batch = isPlainObject(state?.batch) ? state.batch : null;
  if (state?.batch !== undefined && state.batch !== null && !isPlainObject(state.batch)) {
    report("error", "INVALID_RECORD", { collection: "batch", reason: "must be an object" });
  }
  collectList(state?.packages, "packages", "package");
  collectList(state?.subitems, "subitems", "subitem");
  collectList(batch?.slices, "batch.slices", "slice");

  // --- Requirement from the batch ------------------------------------------
  const requirementPlans = [];
  if (batch) {
    const batchId = typeof batch.id === "string" && batch.id.trim() !== "" ? batch.id.trim() : undefined;
    if (!batchId) {
      report("warning", "MISSING_FIELD", { collection: "batch", field: "id" });
    } else {
      requirementPlans.push({
        id: safeId(`REQ-${batchId}`),
        projectId,
        description: firstString(batch.goal, batch.id) ?? batchId,
        acceptance: firstString(batch.stopCondition),
      });
    }
    if (batch.openQuestions !== undefined && !Array.isArray(batch.openQuestions)) {
      report("warning", "INVALID_RECORD", { collection: "batch", field: "openQuestions" });
    }
  }

  // --- Agents from runtime.json --------------------------------------------
  const agentPlans = [];
  const agentIds = new Map();
  if (runtimeInput) {
    if (runtimeInput.schemaVersion !== undefined && runtimeInput.schemaVersion !== 2 && runtimeInput.schemaVersion !== 3) {
      report("warning", "RUNTIME_SCHEMA_VERSION_UNKNOWN", { schemaVersion: runtimeInput.schemaVersion });
    }
    if (runtimeInput.agents !== undefined && runtimeInput.agents !== null) {
      if (!Array.isArray(runtimeInput.agents)) {
        report("error", "INVALID_RECORD", { collection: "runtime.agents", reason: "must be an array" });
      } else {
        runtimeInput.agents.forEach((raw, index) => {
          const agent = mapLegacyAgent(raw, index, report);
          if (!agent) return;
          if (agentIds.has(agent.id)) {
            report("error", "DUPLICATE_ID", { id: agent.id, first: agentIds.get(agent.id), second: `runtime.agents[${index}]` });
            return;
          }
          agentIds.set(agent.id, `runtime.agents[${index}]`);
          agentPlans.push(agent);
        });
      }
    }
  }

  // --- Ownership diagnostics (schema v1 has no ownership table) ------------
  let ownershipInfo = null;
  if (ownershipInput) {
    const roles = stringArray(ownershipInput.roles);
    const ignoredPrefixes = stringArray(ownershipInput.ignoredPrefixes);
    for (const [index, prefix] of ignoredPrefixes.entries()) {
      checkRelativePath(prefix, report, { entity: "ownership", field: "ignoredPrefixes", index });
    }
    if (ownershipInput.rules !== undefined && !Array.isArray(ownershipInput.rules)) {
      report("warning", "INVALID_RECORD", { collection: "ownership", field: "rules" });
    }
    const rules = Array.isArray(ownershipInput.rules) ? ownershipInput.rules : [];
    rules.forEach((rule, index) => {
      if (!isPlainObject(rule) || typeof rule.prefix !== "string") {
        report("warning", "INVALID_RECORD", { collection: "ownership.rules", index });
        return;
      }
      checkRelativePath(rule.prefix, report, { entity: "ownership", field: "prefix", index });
    });
    ownershipInfo = { roles, rules: rules.length, ignoredPrefixes: ignoredPrefixes.length };
  }

  // --- Resolve dependencies against the input plus what already exists -----
  const inputTaskIds = new Set(records.map((record) => record.mapped.id));
  const depPlans = new Map();
  let dependencyCount = 0;
  for (const record of records) {
    const resolved = [];
    for (const dep of record.mapped.deps) {
      if (!ID_RE.test(dep)) {
        report("warning", "INVALID_DEP", { taskId: record.mapped.id, dep });
        continue;
      }
      if (inputTaskIds.has(dep) || readOrNull(store.getTask, dep) !== null) {
        if (!resolved.includes(dep)) resolved.push(dep);
        continue;
      }
      report("warning", "DEP_MISSING", { taskId: record.mapped.id, dep });
    }
    depPlans.set(record.mapped.id, resolved);
    dependencyCount += resolved.length;
  }

  // --- Existence checks (read-only, also used by dryRun) --------------------
  const queryableProject = typeof projectId === "string" && ID_RE.test(projectId);
  const projectExists = queryableProject && readOrNull(store.getProject, projectId) !== null;
  const existingRequirements = new Set(
    projectExists ? store.listRequirements({ projectId }).map((requirement) => requirement.id) : [],
  );
  const existingTaskIds = new Set();
  for (const record of records) {
    if (readOrNull(store.getTask, record.mapped.id) !== null) existingTaskIds.add(record.mapped.id);
  }
  const existingAgentIds = new Set(store.listAgents().map((agent) => agent.id));

  const skipped = {
    projects: projectExists ? 1 : 0,
    requirements: requirementPlans.filter((plan) => existingRequirements.has(plan.id)).length,
    tasks: existingTaskIds.size,
    agents: agentPlans.filter((plan) => existingAgentIds.has(plan.id)).length,
  };
  const totals = {
    projects: 1,
    requirements: requirementPlans.length,
    tasks: records.length,
    taskDependencies: dependencyCount,
    agents: agentPlans.length,
    runs: 0,
    events: 0,
  };
  const newRecords = records.filter((record) => !existingTaskIds.has(record.mapped.id));
  const counts = {
    projects: totals.projects - skipped.projects,
    requirements: totals.requirements - skipped.requirements,
    tasks: newRecords.length,
    // A dependency between two already-imported tasks is not re-written; only
    // links owned by newly created tasks count as inserted in this run.
    taskDependencies: newRecords.reduce((sum, record) => sum + depPlans.get(record.mapped.id).length, 0),
    agents: totals.agents - skipped.agents,
    runs: 0,
    events: 0,
  };

  // --- Write phase ---------------------------------------------------------
  let writeFailed = false;
  if (!hasErrors() && !dryRun) {
    try {
      if (!projectExists) {
        store.createProject({
          id: projectId,
          name: projectNameValue,
          repoPath: repoPathValue,
          defaultBranch: defaultBranchValue,
          policyVersion: Number.isInteger(configInput?.policyVersion) ? configInput.policyVersion : 0,
          legacy: {
            source: state?.source ?? null,
            stateUpdatedAt: state?.updatedAt ?? null,
            project: state?.project ?? null,
            batch: batchMeta(batch),
          },
          settings: {
            ownership: ownershipInput ?? null,
            configProject: configProject ?? null,
          },
        });
      }
      for (const plan of requirementPlans) {
        if (existingRequirements.has(plan.id)) continue;
        const dto = { id: plan.id, projectId: plan.projectId, description: plan.description };
        if (plan.acceptance !== undefined) dto.acceptance = plan.acceptance;
        store.createRequirement(dto);
      }
      const createdRecords = [];
      for (const record of records) {
        if (existingTaskIds.has(record.mapped.id)) continue;
        const dto = {
          id: record.mapped.id,
          projectId,
          title: record.mapped.title,
          description: record.mapped.description,
          functionRequired: record.mapped.functionRequired,
          roleRequired: record.mapped.roleRequired,
          priority: record.mapped.priority,
          deps: [],
          legacy: { kind: record.kind, item: record.raw },
        };
        if (record.mapped.acceptance !== undefined) dto.acceptance = record.mapped.acceptance;
        store.createTask(dto);
        createdRecords.push(record);
      }
      for (const record of createdRecords) {
        const changes = {};
        const deps = depPlans.get(record.mapped.id) ?? [];
        if (deps.length > 0) changes.deps = deps;
        if (record.mapped.status !== "READY") changes.status = record.mapped.status;
        if (Object.keys(changes).length === 0) continue;
        const task = store.getTask(record.mapped.id);
        store.patchTask(record.mapped.id, { expectedVersion: task.version, changes });
      }
      for (const agent of agentPlans) {
        if (existingAgentIds.has(agent.id)) continue;
        store.upsertAgent(agent);
      }
    } catch (error) {
      writeFailed = true;
      report("error", "IMPORT_WRITE_FAILED", {
        code: error?.code ?? null,
        message: String(error?.message ?? error),
      });
    }
  }

  const status = hasErrors() || writeFailed ? "SKIPPED" : "PASS";
  const contentHash = sha256({ state, ownership: ownershipInput, runtime: runtimeInput, config: configInput });
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    generatedAt: at,
    dryRun,
    source: state
      ? {
          schemaVersion: state.schemaVersion ?? null,
          updatedAt: state.updatedAt ?? null,
          source: typeof state.source === "string" ? state.source : null,
        }
      : null,
    project: {
      id: projectId,
      name: projectNameValue,
      repoPath: repoPathValue,
      defaultBranch: defaultBranchValue,
      derived,
    },
    ownership: ownershipInfo,
    runtime: runtimeInput
      ? {
          schemaVersion: runtimeInput.schemaVersion ?? null,
          agents: agentPlans.length,
          events: Array.isArray(runtimeInput.events) ? runtimeInput.events.length : 0,
        }
      : null,
    runs: {
      imported: 0,
      reason:
        "legacy state.json/runtime.json contain no Run records; the runs table is truthfully empty (not a migration failure)",
    },
    counts,
    skipped,
    totals,
    contentHash,
  };

  return { status, dryRun, counts, problems, manifest, skipped, totals };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function expectedStatusOf(item, kind) {
  if (kind === "slice") return SLICE_STATUS_TO_STATUS[item.status] ?? "READY";
  let status = PACKAGE_STAGE_TO_STATUS[item.stage] ?? "READY";
  if (item.verification && item.verification.humanAccepted === true) status = "DONE";
  if (item.archived === true) status = status === "DONE" ? "DONE" : "CANCELLED";
  return status;
}

/**
 * Keep the original legacy object as the export template (so `atk export` is
 * structure-compatible with the pre-migration file) but reflect the fields the
 * store owns: deps, priority and status/stage when the task has since moved.
 */
function syncLegacyItem(template, task, kind) {
  const item = structuredClone(template);
  const expected = expectedStatusOf(template, kind);
  if (item.deps !== undefined || task.deps.length > 0) item.deps = [...task.deps];
  if (typeof item.priority === "string" && item.priority !== `P${task.priority}`) {
    item.priority = `P${task.priority}`;
  }
  if (expected !== task.status) {
    if (kind === "slice") item.status = STATUS_TO_SLICE[task.status] ?? item.status;
    else item.stage = STATUS_TO_STAGE[task.status] ?? item.stage;
  }
  return item;
}

/** Synthesize a legacy-shaped package for a task created after migration. */
function synthesizeLegacyItem(task) {
  const item = {
    id: task.id,
    type: "task",
    typeRaw: "",
    owner: task.roleRequired,
    module: "",
    scope: task.description,
    stage: STATUS_TO_STAGE[task.status] ?? "todo",
    statusRaw: task.status,
    priority: `P${task.priority}`,
    evidence: "",
    note: "",
    depsRaw: task.deps.join(","),
    deps: [...task.deps],
    archived: task.status === "CANCELLED",
    migrated: true,
    verification: {},
    updatedAt: task.updatedAt,
    archivedAt: null,
    archivedBy: null,
    archiveReason: null,
    archiveEvidence: null,
    firstSeenAt: task.createdAt,
  };
  if (task.acceptance !== undefined) item.exit = task.acceptance;
  return item;
}

/**
 * Export the store back to a legacy `state.json` structure.
 *
 * @param {object} store
 * @param {{projectId?: string, now?: string}} [options]
 * @returns {{state: object, manifest: object}}
 */
export function exportStateJson(store, options = {}) {
  ensureStore(store, "exportStateJson");
  if (!isPlainObject(options)) {
    fail("VALIDATION_ERROR", "exportStateJson options must be an object", { entity: "exportStateJson" });
  }
  const { projectId, now } = options;
  const at = nowIso(now);
  const projects = store.listProjects();
  let project;
  if (projectId !== undefined && projectId !== null) {
    project = store.getProject(projectId);
  } else if (projects.length === 1) {
    project = projects[0];
  } else if (projects.length === 0) {
    notFound("project", "<none>");
  } else {
    fail("VALIDATION_ERROR", "projectId is required when the store contains multiple projects", {
      projectIds: projects.map((entry) => entry.id),
    });
  }

  const internal = store[INTERNAL];
  const projectLegacy = internal?.getProjectLegacy?.(project.id) ?? null;
  const tasks = store.listTasks({ projectId: project.id, limit: MAX_LIST_LIMIT });
  const requirements = store.listRequirements({ projectId: project.id });
  const taskIds = new Set(tasks.map((task) => task.id));
  const runs = store
    .listRuns({ limit: MAX_LIST_LIMIT })
    .filter((run) => taskIds.has(run.taskId));

  const packages = [];
  const subitems = [];
  const slices = [];
  const stageCounts = {};
  for (const task of tasks) {
    const meta = internal?.getTaskLegacy?.(task.id) ?? null;
    const kind = meta && (meta.kind === "package" || meta.kind === "subitem" || meta.kind === "slice") ? meta.kind : "package";
    const item = meta && isPlainObject(meta.item) ? syncLegacyItem(meta.item, task, kind) : synthesizeLegacyItem(task);
    if (kind === "slice") slices.push(item);
    else if (kind === "subitem") subitems.push(item);
    else packages.push(item);
    const stage = typeof item.stage === "string" ? item.stage : STATUS_TO_STAGE[task.status] ?? "todo";
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
  }

  const legacyBatch = isPlainObject(projectLegacy?.batch) ? projectLegacy.batch : null;
  const requirement = requirements[0] ?? null;
  const batch = {
    id: legacyBatch?.id ?? safeId(project.id),
    goal: legacyBatch?.goal ?? requirement?.description ?? project.name,
    stopCondition: legacyBatch?.stopCondition ?? requirement?.acceptance ?? "",
    devClosedByUser: Boolean(legacyBatch?.devClosedByUser ?? false),
    applyMode: typeof legacyBatch?.applyMode === "string" ? legacyBatch.applyMode : "local-tree",
    openQuestions: Array.isArray(legacyBatch?.openQuestions) ? [...legacyBatch.openQuestions] : [],
    slices,
  };

  const state = {
    schemaVersion: LEGACY_STATE_SCHEMA_VERSION,
    updatedAt: at,
    source: typeof projectLegacy?.source === "string" ? projectLegacy.source : `exported from ${TOOL} (${project.id})`,
    // Additive block: lets a re-import recover the project identity without the
    // original agent-flow.config.json. Old tools ignore unknown fields.
    project: {
      id: project.id,
      name: project.name,
      repoPath: project.repoPath,
      defaultBranch: project.defaultBranch,
    },
    batch,
    counts: { total: tasks.length, byStage: stageCounts },
    packages,
    subitems,
  };

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    exportedAt: at,
    projectId: project.id,
    databaseSchemaVersion: store.health().schemaVersion,
    counts: {
      projects: 1,
      requirements: requirements.length,
      tasks: tasks.length,
      packages: packages.length,
      subitems: subitems.length,
      slices: slices.length,
      runs: runs.length,
    },
    contentHash: sha256(state),
  };

  return { state, manifest };
}
