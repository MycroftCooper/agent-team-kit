// Phase C read-only commands (ADR-006): status / doctor / verify / export.
//
// These are the ONLY new writers-of-nothing the old CLI keeps during Phase C:
// they report the published lock + SQLite projection and never mutate the
// legacy fact files. `export` materialises the readable JSON, by design.
import path from "node:path";
import process from "node:process";

import {
  MigrationLockError,
  migrationLockPath,
  readMigrationLock,
  resolveDataDir,
  resolveDatabaseFile,
} from "./migration-lock.mjs";
import { loadSqliteReadModel, openReadDatabase, probeDatabase } from "./sqlite-read.mjs";
import { ensureDir, localIso, parseArgs, readJson, writeJson } from "./util.mjs";

const USAGE = `Usage: atk <status|doctor|verify|export> [options]

  status [--json]        Published migration lock + SQLite projection counts
  doctor [--json]        Diagnose lock/database state (exit 1 on a real problem)
  verify [--json]        PRAGMA integrity_check + row counts (read-only)
  export [--out <file>]  Write the readable {stateJson,runtime,manifest} document

These commands never write state.json / runtime.json / ownership.json. In Phase C
(lock owner=sqlite) the rest of the old CLI is read-only as well.
`;

async function lockReport(dataDir) {
  try {
    const state = await readMigrationLock({ dataDir });
    if (!state.present) return { present: false, path: state.path, owner: null, phase: null, stale: false };
    return {
      present: true,
      path: state.path,
      owner: state.lock.owner,
      phase: state.lock.phase,
      pid: state.lock.pid,
      startedAt: state.lock.startedAt,
      toolVersion: state.lock.toolVersion,
      pidAlive: state.pidAlive,
      stale: false,
    };
  } catch (error) {
    if (!(error instanceof MigrationLockError)) throw error;
    return {
      present: true,
      ok: false,
      code: error.code,
      message: error.message,
      details: error.details ?? null,
      guidance: error.guidance ?? [],
      stale: error.code === "MIGRATION_LOCK_STALE",
    };
  }
}

async function databaseReport(dataDir, env) {
  const file = resolveDatabaseFile({ dataDir, env });
  const probe = await probeDatabase({ dataDir, env });
  return { file, ...probe };
}

function print(logger, json, payload, humanLines) {
  if (json) logger.json(payload);
  else for (const line of humanLines) logger.out(line);
}

async function cmdStatus(args, ctx, logger, dataDir, env) {
  const lock = await lockReport(dataDir);
  const database = await databaseReport(dataDir, env);
  const mode = lock.ok === false ? "error" : !lock.present ? "legacy" : lock.owner === "sqlite" || lock.phase === "C" ? "read-only" : "migration-in-progress";
  const payload = { ok: lock.ok !== false && database.ok, mode, lock, database, command: "status" };
  print(logger, args.json === true, payload, [
    `mode: ${mode}`,
    `lock: ${lock.path}${lock.present ? ` (owner=${lock.owner}, phase=${lock.phase}, pid=${lock.pid}${lock.stale ? ", STALE" : ""})` : " (absent)"}`,
    `database: ${database.file} ${database.ok ? `tasks=${database.counts.tasks}, runs=${database.counts.runs}, reviews=${database.counts.reviews}` : `UNAVAILABLE (${database.code})`}`,
  ]);
  return payload.ok ? 0 : 1;
}

async function cmdDoctor(args, ctx, logger, dataDir, env) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });

  const lock = await lockReport(dataDir);
  if (lock.ok === false) add("migration-lock", "FAIL", `${lock.code}: ${lock.message}`);
  else if (!lock.present) add("migration-lock", "SKIPPED", `${lock.path} (absent: Phase B has not started)`);
  else add("migration-lock", "PASS", `owner=${lock.owner}, phase=${lock.phase}, pid=${lock.pid}, alive=${lock.pidAlive}`);

  const database = await databaseReport(dataDir, env);
  add("database", database.ok ? "PASS" : "FAIL", database.ok ? `${database.file} tasks=${database.counts.tasks}` : `${database.file}: ${database.message ?? database.code}`);

  const stateFile = ctx?.paths?.state;
  if (stateFile) {
    const state = await readJson(stateFile, undefined);
    add("state-json", state ? "PASS" : "SKIPPED", `${stateFile}${state ? "" : " (missing/unreadable; Phase C does not need it)"}`);
  }

  const failed = checks.filter((check) => check.status === "FAIL").length;
  const payload = { ok: failed === 0, command: "doctor", checks, lock, database, dataDir };
  if (args.json === true) logger.json(payload);
  else {
    logger.out(`atk doctor (legacy CLI, Phase C surface) — dataDir ${dataDir}`);
    for (const check of checks) logger.out(`  ${check.status.padEnd(7)} ${check.id.padEnd(15)} ${check.detail}`);
    logger.out(`result: ${payload.ok ? "OK" : "ATTENTION"}`);
  }
  return failed === 0 ? 0 : 1;
}

async function cmdVerify(args, ctx, logger, dataDir, env) {
  const file = resolveDatabaseFile({ dataDir, env });
  let db;
  try {
    db = await openReadDatabase({ dataDir, env });
  } catch (error) {
    const payload = { ok: false, command: "verify", database: file, code: error.code ?? "SQLITE_READ_FAILED", message: error.message };
    if (args.json === true) logger.json(payload);
    else logger.err(`verify: ${error.message}`);
    return 1;
  }
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    const ok = integrity.length === 1 && String(integrity[0]).toLowerCase() === "ok";
    const model = await loadSqliteReadModel({ ctx, dataDir, env });
    const payload = {
      ok,
      command: "verify",
      database: file,
      integrity,
      counts: { projects: model.projects.length, tasks: model.tasks.length, runs: model.runs.length, reviews: model.reviews.length, approvals: model.approvals.length, agents: model.agents.length },
    };
    if (args.json === true) logger.json(payload);
    else {
      logger.out(`verify: ${file}`);
      logger.out(`  integrity_check: ${integrity.join("; ")}`);
      logger.out(`  counts: ${JSON.stringify(payload.counts)}`);
    }
    return ok ? 0 : 1;
  } finally {
    db.close();
  }
}

async function cmdExport(args, ctx, logger, dataDir, env) {
  const model = await loadSqliteReadModel({ ctx, dataDir, env });
  const exportedAt = localIso();
  const document = {
    exportedAt,
    stateJson: model.legacyState,
    runtime: { schemaVersion: 3, exportedAt, agents: model.agents },
    manifest: {
      schemaVersion: 1,
      tool: "agent-team-kit-legacy",
      toolVersion: "0.2.0",
      exportedAt,
      projectId: model.project?.id ?? null,
      source: "sqlite-projection",
      counts: {
        projects: model.projects.length,
        tasks: model.tasks.length,
        runs: model.runs.length,
        reviews: model.reviews.length,
        approvals: model.approvals.length,
        agents: model.agents.length,
      },
    },
  };
  if (args.out) {
    const outFile = path.resolve(String(args.out));
    await ensureDir(path.dirname(outFile));
    await writeJson(outFile, document);
    if (args.json === true) logger.json({ ok: true, command: "export", out: outFile, manifest: document.manifest });
    else logger.out(`exported SQLite projection -> ${outFile}`);
  } else if (args.json === true) {
    logger.json(document);
  } else {
    logger.out(JSON.stringify(document, null, 2));
  }
  return 0;
}

export async function run(argv = [], ctx = {}) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const logger = ctx.log ?? { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`), json: (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) };
  if (!command || command === "help" || command === "--help" || args.help === true) {
    logger.out(USAGE);
    return command ? 0 : 2;
  }
  const env = process.env;
  const dataDir = resolveDataDir(env);
  if (command === "status") return cmdStatus(args, ctx, logger, dataDir, env);
  if (command === "doctor") return cmdDoctor(args, ctx, logger, dataDir, env);
  if (command === "verify") return cmdVerify(args, ctx, logger, dataDir, env);
  if (command === "export") return cmdExport(args, ctx, logger, dataDir, env);
  logger.err(`unknown read-only command "${command}"`);
  logger.out(USAGE);
  return 2;
}
