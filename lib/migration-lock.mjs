// Phase C migration lock: the single published fact about who owns the data.
//
// ADR-006 stages B/C publish `<dataDir>/runtime/migration.lock` so every entry
// point (old CLI, Launcher, operators) reads the same answer. This module is the
// old CLI's guard: when the lock says SQLite, the old CLI is READ-ONLY. It must
// never silently ignore a lock, and a stale lock must be diagnosed, not bypassed.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const MIGRATION_LOCK_FILE = "migration.lock";
export const LOCK_OWNERS = Object.freeze(["json", "sqlite"]);
export const LOCK_PHASES = Object.freeze(["B", "C"]);

/** Base data directory, matching apps/backend/src/paths.mjs + the Launcher. */
export function resolveDataDir(env = process.env) {
  const override = env.ATK_DATA_DIR;
  if (typeof override === "string" && override.trim() !== "") return path.resolve(override);
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base = localAppData && localAppData.trim() !== "" ? localAppData : path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "AgentTeamKit");
  }
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "agent-team-kit");
}

export function migrationLockPath({ dataDir = resolveDataDir() } = {}) {
  return path.join(dataDir, "runtime", MIGRATION_LOCK_FILE);
}

/** Database file the read adapter projects (env override wins for tests/ops). */
export function resolveDatabaseFile({ dataDir = resolveDataDir(), env = process.env } = {}) {
  if (typeof env.ATK_DB_FILE === "string" && env.ATK_DB_FILE.trim() !== "") return path.resolve(env.ATK_DB_FILE);
  return path.join(dataDir, "data", "atk.db");
}

export class MigrationLockError extends Error {
  constructor(code, message, { details = null, guidance = [] } = {}) {
    super(message);
    this.name = "MigrationLockError";
    this.code = code;
    this.exitCode = 1;
    this.details = details;
    this.guidance = Array.isArray(guidance) ? guidance : [];
  }

  /** Machine-readable form for `--json` callers. */
  toJSON() {
    return { ok: false, code: this.code, message: this.message, details: this.details, guidance: this.guidance };
  }
}

function readOnlyGuidance(lockPath) {
  return [
    "The old CLI is read-only once SQLite is the owner (ADR-006 Phase C).",
    "Read/export: atk export, atk board, atk status, atk doctor.",
    "Write: use the Backend API (atk start), not the old CLI.",
    `If this lock is wrong, stop all ATK processes, verify a backup, then remove ${lockPath} and re-run atk migrate.`,
  ];
}

function staleGuidance(lockPath, pid) {
  return [
    `Verify no migrate/backend process is running (lock references pid ${pid}).`,
    "Take a fresh backup before touching anything: atk-backend backup --data <db> --to <dir>.",
    `Only after confirming the process is gone: delete ${lockPath}.`,
    "Or resume the interrupted migration with `atk migrate --resume` (never hand-edit state.json).",
  ];
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we may not signal it.
    return error?.code === "EPERM";
  }
}

function validateLock(lock, lockPath) {
  const problems = [];
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) problems.push("lock must be a JSON object");
  else {
    if (!LOCK_OWNERS.includes(lock.owner)) problems.push('owner must be "json" or "sqlite"');
    if (!LOCK_PHASES.includes(lock.phase)) problems.push('phase must be "B" or "C"');
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) problems.push("pid must be a positive integer");
    if (typeof lock.startedAt !== "string" || lock.startedAt.trim() === "") problems.push("startedAt must be a non-empty string");
    if (typeof lock.toolVersion !== "string" || lock.toolVersion.trim() === "") problems.push("toolVersion must be a non-empty string");
  }
  if (problems.length > 0) {
    throw new MigrationLockError(
      "MIGRATION_LOCK_INVALID",
      `migration lock ${lockPath} is invalid: ${problems.join("; ")}`,
      {
        details: { path: lockPath, problems },
        guidance: [
          "The lock is the single source of truth for the data owner; an invalid lock is never ignored.",
          `Restore the lock from the migration manifest/backup, or after confirming all processes are stopped delete ${lockPath} and re-run the migration.`,
        ],
      },
    );
  }
}

/**
 * Read and validate the published lock. A missing file means "before Phase B"
 * (legacy JSON behaviour). A stale or invalid lock is an error, never a bypass.
 */
export async function readMigrationLock({ dataDir = resolveDataDir(), env = process.env } = {}) {
  const lockPath = migrationLockPath({ dataDir });
  let text;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, path: lockPath, dataDir };
    throw new MigrationLockError("MIGRATION_LOCK_UNREADABLE", `cannot read migration lock ${lockPath}: ${error.message}`, {
      details: { path: lockPath },
      guidance: [`Fix the file permissions or restore ${lockPath} from the backup.`],
    });
  }
  let lock;
  try {
    lock = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new MigrationLockError("MIGRATION_LOCK_INVALID", `migration lock ${lockPath} is not valid JSON: ${error.message}`, {
      details: { path: lockPath },
      guidance: [
        "The lock is the single source of truth for the data owner; an invalid lock is never ignored.",
        `Restore it from the migration manifest/backup, or after confirming all processes are stopped delete ${lockPath} and re-run the migration.`,
      ],
    });
  }
  validateLock(lock, lockPath);
  const alive = pidIsAlive(lock.pid);
  if (!alive) {
    throw new MigrationLockError(
      "MIGRATION_LOCK_STALE",
      `migration lock ${lockPath} references pid ${lock.pid}, which is not running; refusing to continue instead of silently bypassing it`,
      {
        details: {
          path: lockPath,
          owner: lock.owner,
          phase: lock.phase,
          pid: lock.pid,
          startedAt: lock.startedAt,
          toolVersion: lock.toolVersion,
        },
        guidance: staleGuidance(lockPath, lock.pid),
      },
    );
  }
  return { present: true, path: lockPath, dataDir, lock, pidAlive: true };
}

/** Is the old CLI allowed to run at all? (stale/invalid locks throw from read). */
export async function readCompatibilityMode(options = {}) {
  const state = await readMigrationLock(options);
  if (!state.present) return { mode: "legacy", state };
  const { lock } = state;
  if (lock.owner === "sqlite" || lock.phase === "C") return { mode: "read-only", state, lock };
  return { mode: "migration-in-progress", state, lock };
}

/** Central write guard for fact files (state/ownership/runtime). */
export async function assertWritesAllowed(operation, options = {}) {
  const mode = await readCompatibilityMode(options);
  if (mode.mode === "legacy") return mode;
  const { path: lockPath, lock } = mode.state;
  if (mode.mode === "read-only") {
    throw new MigrationLockError(
      "READ_ONLY_MODE",
      `read-only compatibility mode; use atk export or the Backend API (operation: ${operation})`,
      {
        details: {
          operation,
          lockPath,
          owner: lock.owner,
          phase: lock.phase,
          pid: lock.pid,
          startedAt: lock.startedAt,
          toolVersion: lock.toolVersion,
        },
        guidance: readOnlyGuidance(lockPath),
      },
    );
  }
  throw new MigrationLockError(
    "MIGRATION_IN_PROGRESS",
    `migration is in progress (phase ${lock.phase}, owner ${lock.owner}); the old CLI must not write ${operation}`,
    {
      details: { operation, lockPath, owner: lock.owner, phase: lock.phase, pid: lock.pid },
      guidance: [
        "Finish or roll back the migration first (atk migrate).",
        "The old CLI stays read-only during phase B so the migration snapshot is not corrupted.",
      ],
    },
  );
}
