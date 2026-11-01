// Phase C read adapter (old CLI → SQLite).
//
// ADR-006 Phase C: SQLite is the single source of truth; the old CLI only
// PROJECTS it into the read shapes its commands already understand. It never
// copies SQLite back into state.json/runtime.json (that is `atk export`).
import { access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { resolveDatabaseFile, resolveDataDir } from "./migration-lock.mjs";

const STATUS_TO_STAGE = Object.freeze({
  DRAFT: "todo",
  READY: "todo",
  CLAIMED: "in-progress",
  RUNNING: "in-progress",
  REVIEWING: "implemented",
  INTEGRATING: "implemented",
  AWAITING_ACCEPTANCE: "implemented",
  DONE: "done",
  REJECTED: "partial",
  BLOCKED: "blocked",
  CANCELLED: "blocked",
});

export class SqliteReadError extends Error {
  constructor(message, { code = "SQLITE_READ_UNAVAILABLE", details = null } = {}) {
    super(message);
    this.name = "SqliteReadError";
    this.code = code;
    this.exitCode = 1;
    this.details = details;
  }
}

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  try {
    return JSON.parse(value.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function mapAgent(row) {
  return {
    id: row.id,
    role: row.role,
    capabilities: parseJson(row.capabilities_json, []),
    status: String(row.status ?? "OFFLINE").toLowerCase(),
    task: row.task ?? "",
    detail: row.detail ?? "",
    since: row.since ?? row.created_at,
    version: Number(row.version ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReview(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id ?? null,
    status: row.status,
    verdict: row.verdict ?? null,
    manifestHash: row.manifest_hash ?? null,
    commitSha: row.commit_sha ?? null,
    findings: parseJson(row.findings_json, []),
    evidence: parseJson(row.evidence_json, null),
    attempt: Number(row.attempt ?? 1),
    version: Number(row.version ?? 0),
    reviewer: row.reviewer ?? null,
    submittedAt: row.submitted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id ?? null,
    scope: row.scope,
    targetHash: row.target_hash,
    actor: row.actor,
    status: row.status,
    decision: row.decision ?? null,
    at: row.at ?? null,
    decidedAt: row.decided_at ?? null,
    version: Number(row.version ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function mapRun(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    function: row.function,
    role: row.role ?? null,
    status: row.status,
    attempt: Number(row.attempt ?? 1),
    exitCode: row.exit_code ?? null,
    version: Number(row.version ?? 0),
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    defaultBranch: row.default_branch,
    policyVersion: Number(row.policy_version ?? 0),
    version: Number(row.version ?? 0),
    legacy: parseJson(row.legacy_json, null),
    settings: parseJson(row.settings_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskToLegacyItem(task, legacyMeta) {
  const raw = legacyMeta && typeof legacyMeta === "object" && legacyMeta.item && typeof legacyMeta.item === "object" ? legacyMeta.item : {};
  const stage = STATUS_TO_STAGE[task.status] ?? "todo";
  return {
    ...raw,
    id: task.id,
    type: raw.type ?? "feature",
    typeRaw: raw.typeRaw ?? raw.type ?? "feature",
    owner: raw.owner ?? task.roleRequired,
    module: raw.module ?? "",
    scope: raw.scope ?? "",
    stage,
    statusRaw: raw.statusRaw ?? task.status,
    priority: raw.priority ?? `P${task.priority}`,
    evidence: raw.evidence ?? "",
    note: raw.note ?? task.description,
    depsRaw: (task.deps ?? []).join(","),
    deps: [...(task.deps ?? [])],
    archived: raw.archived === true,
    migrated: true,
    verification: raw.verification ?? {},
    updatedAt: task.updatedAt,
    firstSeenAt: raw.firstSeenAt ?? task.createdAt,
  };
}

/** Open the SQLite snapshot strictly read-only (never creates/updates files). */
export async function openReadDatabase({ dataDir = resolveDataDir(), dbFile, env = process.env } = {}) {
  const file = dbFile ? dbFile : resolveDatabaseFile({ dataDir, env });
  try {
    await access(file);
  } catch {
    throw new SqliteReadError(`SQLite database not found: ${file}`, { details: { dbFile: file } });
  }
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new SqliteReadError(`cannot open SQLite database ${file} read-only: ${error.message}`, {
      details: { dbFile: file },
    });
  }
}

/** Project every entity the old read commands need. */
export function readModel(db, { projectId = null } = {}) {
  const projects = db.prepare("SELECT * FROM projects ORDER BY id ASC").all().map(mapProject);
  // The old CLI is single-project: prefer the configured id, then the only/first
  // stored project (config.project is often the human project name, not the id).
  const configured = projectId === null ? null : projects.find((project) => project.id === projectId) ?? null;
  const selected = configured ?? projects[0] ?? null;
  const taskRows =
    selected === null
      ? db.prepare("SELECT * FROM tasks ORDER BY id ASC").all()
      : db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY id ASC").all(selected.id);
  const dependencies = new Map();
  for (const row of db.prepare("SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id ASC, position ASC").all()) {
    if (!dependencies.has(row.task_id)) dependencies.set(row.task_id, []);
    dependencies.get(row.task_id).push(row.depends_on_id);
  }
  const tasks = taskRows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    functionRequired: row.function_required,
    roleRequired: row.role_required,
    priority: Number(row.priority ?? 2),
    status: row.status,
    acceptance: row.acceptance ?? null,
    planId: row.plan_id ?? null,
    parentId: row.parent_id ?? null,
    targetHash: row.target_hash ?? null,
    files: parseJson(row.files_json, []),
    deps: [...(dependencies.get(row.id) ?? [])],
    version: Number(row.version ?? 0),
    legacy: parseJson(row.legacy_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const runs = db.prepare("SELECT * FROM runs ORDER BY created_at ASC, id ASC").all().map(mapRun);
  const reviews = db.prepare("SELECT * FROM reviews ORDER BY created_at ASC, id ASC").all().map(mapReview);
  const approvals = db.prepare("SELECT * FROM approvals ORDER BY created_at ASC, id ASC").all().map(mapApproval);
  const agents = db.prepare("SELECT * FROM agent_instances ORDER BY id ASC").all().map(mapAgent);
  return { projects, project: selected, tasks, runs, reviews, approvals, agents };
}

/** Rebuild the legacy state shape the old commands consume (read-only). */
export function legacyStateFromModel(model) {
  if (!model.project) throw new SqliteReadError("SQLite contains no project to project for the old CLI", { code: "SQLITE_EMPTY" });
  const project = model.project;
  const projectLegacy = project.legacy && typeof project.legacy === "object" ? project.legacy : {};
  const packages = [];
  const subitems = [];
  const slices = [];
  for (const task of model.tasks) {
    const meta = task.legacy && typeof task.legacy === "object" ? task.legacy : null;
    const kind = meta?.kind === "subitem" || meta?.kind === "slice" ? meta.kind : "package";
    const item = taskToLegacyItem(task, meta);
    if (kind === "slice") slices.push(item);
    else if (kind === "subitem") subitems.push(item);
    else packages.push(item);
  }
  const legacyBatch = projectLegacy.batch && typeof projectLegacy.batch === "object" ? projectLegacy.batch : null;
  const batch = {
    id: legacyBatch?.id ?? project.id,
    goal: legacyBatch?.goal ?? project.name,
    stopCondition: legacyBatch?.stopCondition ?? `all tasks in ${project.id} reach DONE`,
    devClosedByUser: Boolean(legacyBatch?.devClosedByUser ?? false),
    applyMode: typeof legacyBatch?.applyMode === "string" ? legacyBatch.applyMode : "local-tree",
    openQuestions: Array.isArray(legacyBatch?.openQuestions) ? [...legacyBatch.openQuestions] : [],
    slices,
  };
  const stageCounts = {};
  for (const item of [...packages, ...subitems, ...slices]) stageCounts[item.stage] = (stageCounts[item.stage] ?? 0) + 1;
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: typeof projectLegacy.source === "string" ? projectLegacy.source : `projected from SQLite (${project.id})`,
    project: {
      id: project.id,
      name: project.name,
      repoPath: project.repoPath,
      defaultBranch: project.defaultBranch,
    },
    batch,
    counts: { total: model.tasks.length, byStage: stageCounts },
    packages,
    subitems,
  };
}

/** Open + project in one call for the read commands and tests. */
export async function loadSqliteReadModel({ ctx = null, dataDir, dbFile, env = process.env, projectId = null } = {}) {
  const db = await openReadDatabase({ dataDir, dbFile, env });
  try {
    const model = readModel(db, { projectId: projectId ?? ctx?.config?.projectId ?? ctx?.config?.project ?? null });
    return { ...model, legacyState: legacyStateFromModel(model) };
  } finally {
    db.close();
  }
}

/** Non-throwing readiness probe used by `atk doctor`/`atk status`. */
export async function probeDatabase(options = {}) {
  try {
    const model = await loadSqliteReadModel(options);
    return { ok: true, counts: { projects: model.projects.length, tasks: model.tasks.length, runs: model.runs.length, reviews: model.reviews.length } };
  } catch (error) {
    return { ok: false, code: error.code ?? "SQLITE_READ_FAILED", message: error.message };
  }
}
