// Versioned Task Execution Spec (M6.2 F05).
//
// A Runtime Host must never be told "execute task T-42" and left to guess. The
// dispatched spec is the whole instruction: what to build, how it is accepted,
// where to work, and which task version it was frozen from. Anything the host
// needs at execution time is here, and nothing else may be read from the live
// task row - otherwise editing a task mid-run would silently change the goal of
// a Run that is already executing.

export const EXECUTION_SPEC_VERSION = 1;

const WORKSPACE_KINDS = Object.freeze(["worktree", "none"]);

function requireString(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${field} must be a non-empty string`);
}

function requireStringArray(value, field, errors) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${field} must be an array of non-empty strings`);
  }
}

/**
 * Build the frozen spec for one dispatch.
 *
 * `task` and `project` are snapshots (plain objects), `workspace` describes the
 * checked-out candidate area, and `frozenAt` records when the snapshot was taken.
 * The caller is responsible for passing the task version it froze.
 */
export function createTaskExecutionSpec({ task, project, workspace, constraints = {}, frozenAt = new Date().toISOString() }) {
  if (!task || typeof task !== "object") throw new TypeError("createTaskExecutionSpec: task is required");
  if (!project || typeof project !== "object") throw new TypeError("createTaskExecutionSpec: project is required");
  return {
    schemaVersion: EXECUTION_SPEC_VERSION,
    taskId: task.id,
    taskVersion: task.version,
    title: task.title,
    description: task.description,
    acceptance: task.acceptance ?? null,
    files: Array.isArray(task.files) ? [...task.files] : [],
    deps: Array.isArray(task.deps) ? [...task.deps] : [],
    functionRequired: task.functionRequired,
    roleRequired: task.roleRequired,
    project: {
      id: project.id,
      name: project.name,
      repoPath: project.repoPath,
      defaultBranch: project.defaultBranch,
    },
    workspace: {
      kind: workspace?.kind ?? "none",
      path: workspace?.path ?? null,
      baseCommit: workspace?.baseCommit ?? null,
      targetBranch: workspace?.targetBranch ?? null,
    },
    constraints: { ...constraints },
    frozenAt,
  };
}

/**
 * Validate a spec received over the internal API. A host that cannot understand
 * the spec (missing description, unknown schema version, workspace-less spec for
 * a real task) must refuse to start rather than run a partial instruction.
 */
export function validateTaskExecutionSpec(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["spec must be an object"] };
  }
  if (value.schemaVersion !== EXECUTION_SPEC_VERSION) {
    errors.push(`spec.schemaVersion must be ${EXECUTION_SPEC_VERSION}`);
  }
  requireString(value.taskId, "spec.taskId", errors);
  if (!Number.isInteger(value.taskVersion) || value.taskVersion < 0) errors.push("spec.taskVersion must be a non-negative integer");
  requireString(value.title, "spec.title", errors);
  requireString(value.description, "spec.description", errors);
  if (value.acceptance != null) requireString(value.acceptance, "spec.acceptance", errors);
  requireStringArray(value.files, "spec.files", errors);
  requireStringArray(value.deps, "spec.deps", errors);
  requireString(value.functionRequired, "spec.functionRequired", errors);
  requireString(value.roleRequired, "spec.roleRequired", errors);
  if (!value.project || typeof value.project !== "object") {
    errors.push("spec.project must be an object");
  } else {
    requireString(value.project.id, "spec.project.id", errors);
    requireString(value.project.repoPath, "spec.project.repoPath", errors);
  }
  if (!value.workspace || typeof value.workspace !== "object") {
    errors.push("spec.workspace must be an object");
  } else {
    if (!WORKSPACE_KINDS.includes(value.workspace.kind)) {
      errors.push(`spec.workspace.kind must be one of ${WORKSPACE_KINDS.join("|")}`);
    }
    if (value.workspace.kind === "worktree") {
      requireString(value.workspace.path, "spec.workspace.path", errors);
      requireString(value.workspace.baseCommit, "spec.workspace.baseCommit", errors);
    }
  }
  requireString(value.frozenAt, "spec.frozenAt", errors);
  return { ok: errors.length === 0, errors };
}
