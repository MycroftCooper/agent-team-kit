#!/usr/bin/env node
// ATK Backend CLI (M1 / ATK-102).
//
//   node apps/backend/cli.mjs serve [--port 1421] [--data <file>] [--web-dist <dir>]
//   node apps/backend/cli.mjs migrate [--from <state.json>] [--dry-run] [--json]
//   node apps/backend/cli.mjs doctor [--json]
//   node apps/backend/cli.mjs export --out <file>
//
// `@atk/database` is imported dynamically: the database package is built in
// parallel with this one, so a missing package must produce a clear message and
// exit code 2, not a stack trace. `doctor` works without it.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createServer } from "./src/server.mjs";
import { runtimePaths } from "./src/paths.mjs";
import { readJsonFile } from "./src/json.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIST = path.resolve(HERE, "..", "web", "dist");

const USAGE = `Usage: atk-backend <command> [options]

Commands:
  serve    [--port 1421] [--data <file>] [--web-dist <dir>] [--pidfile <file>]
           Start the HTTP API on 127.0.0.1 only (ADR-008).
  migrate  [--from <state.json>] [--data <file>] [--dry-run] [--json] [--config <file>]
           Import a legacy agent-flow state.json into SQLite
           (default source: .agent-flow/state.json + sibling ownership/runtime;
            --config defaults to ./agent-flow.config.json when present).
           JSON files may carry a UTF-8 BOM (Windows editors add one).
  doctor   [--json]
           Read-only diagnostics: node, paths, database availability, web build,
           port availability and the security configuration summary.
           Exit 1 when at least one check FAILs (usable as a health gate).
  export   --data <db> --to <file> [--project <id>] [--json]
           Export the SQLite store to readable JSON ({ stateJson, runtime, manifest }).
           --out is kept as an alias for --to.
  import   --from <file> --data <db> [--mode merge|replace] [--force] [--json]
           Import that JSON into SQLite (merge default; replace needs an empty
           database or --force; the whole import is transactional).
  backup   --data <db> --to <dir> [--force] [--json]
           Write a consistent SQLite snapshot (read-only source + backup API)
           plus manifest.json ({createdAt, schemaVersion, bytes, sha256, source}).
  restore  --from <dir> --data <db> [--force] [--json]
           Verify the manifest sha256/schemaVersion, then atomically install the
           snapshot at --data (temp file + rename; target must not exist unless --force).

Environment:
  LOCALAPPDATA (Windows) or XDG_DATA_HOME selects the per-user data directory.
`;

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--dry-run") {
      flags["dry-run"] = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      const name = equals >= 0 ? body.slice(0, equals) : body;
      let value;
      if (equals >= 0) {
        value = body.slice(equals + 1);
      } else {
        value = argv[index + 1];
        index += 1;
      }
      if (name === "") throw new CliError(`invalid flag "${arg}"`);
      if (value === undefined || (equals < 0 && String(value).startsWith("--"))) {
        throw new CliError(`missing value for --${name}`);
      }
      flags[name] = value;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], flags };
}

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`invalid --port "${raw}" (expected an integer between 0 and 65535)`);
  }
  return port;
}

function shortError(error) {
  const message = error?.message ?? String(error);
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

/** Load @atk/database with a clear, stack-free failure when it is not built yet. */
async function loadDatabase() {
  try {
    return await import("@atk/database");
  } catch (error) {
    const missing = error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND";
    const detail = missing
      ? "the package entry point is missing (packages/database/src/index.mjs)"
      : shortError(error);
    throw new CliError(
      `cannot load @atk/database: ${detail}\n` +
        "The database package is not available in this checkout yet. `serve`, `migrate` and `export` need it; " +
        "`doctor` works without it. No state was written.",
    );
  }
}

function openStore(database, file) {
  if (typeof database.openStore !== "function") {
    throw new CliError("@atk/database does not export openStore(); cannot open the store");
  }
  return database.openStore({ file, migrate: true });
}

/**
 * Read an optional JSON sidecar (ownership/runtime/config). `readJsonFile`
 * tolerates a UTF-8 BOM (QA2-04) and names the file in every failure.
 */
function readOptionalJson(file) {
  if (!file) return null;
  try {
    return readJsonFile(file, { optional: true });
  } catch (error) {
    throw new CliError(error.message);
  }
}

/** Read required JSON; parsing/read failures keep the exit-2 usage-error semantics. */
function readRequiredJson(file) {
  try {
    return readJsonFile(file);
  } catch (error) {
    throw new CliError(error.message);
  }
}

/**
 * Locate the legacy project config (project id, roles): explicit --config wins,
 * then the current directory, then the parent of the flow directory.
 */
function resolveConfigFile(flags, sourceDir) {
  if (flags.config) return path.resolve(flags.config);
  const candidates = [
    path.resolve(process.cwd(), "agent-flow.config.json"),
    path.join(path.dirname(sourceDir), "agent-flow.config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writePidfile(file) {
  const resolved = path.resolve(file);
  ensureDirFor(resolved);
  fs.writeFileSync(resolved, `${process.pid}\n`, "utf8");
  return resolved;
}

/** Remove only a pidfile that still belongs to this process. */
function removePidfile(file) {
  if (!file) return;
  try {
    if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.rmSync(file, { force: true });
  } catch {
    // missing or already replaced: nothing to clean up
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// --- M5 backup / restore ----------------------------------------------------

const BACKUP_DB_NAME = "atk.db";
const BACKUP_MANIFEST_NAME = "manifest.json";
const DATA_SIDECARS = ["-wal", "-shm", "-journal"];

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Fingerprint the main DB + WAL/journal (proves backup did not touch source data).
 *  `-shm` is a transient lock table touched by any reader, not database content. */
function fileFingerprint(file) {
  const fingerprint = {};
  for (const suffix of ["", "-wal", "-journal"]) {
    const candidate = `${file}${suffix}`;
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    fingerprint[suffix === "" ? "main" : suffix.slice(1)] = {
      bytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      sha256: sha256File(candidate),
    };
  }
  return fingerprint;
}

function removeDataSidecars(file) {
  for (const suffix of DATA_SIDECARS) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true });
    } catch {
      // best effort
    }
  }
}

function directoryNonEmpty(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new CliError(
      `node:sqlite is unavailable (${shortError(error)}); Node >= 22.5 is required for backup/restore`,
      1,
    );
  }
}

/** Read the schema version out of the snapshot itself (migrate:false = read-only). */
function readSnapshotSchemaVersion(database, file) {
  const store = database.openStore({ file, migrate: false });
  try {
    const health = typeof store.health === "function" ? store.health() : null;
    const version = Number(health?.schemaVersion);
    if (!Number.isInteger(version) || version < 0) {
      throw new CliError(`snapshot ${file} has no readable schemaVersion`, 1);
    }
    return version;
  } finally {
    try {
      store.close?.();
    } catch {
      // ignore
    }
  }
}

function parseManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new CliError(`cannot read manifest ${file}: ${shortError(error)}`, 1);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`manifest is not valid JSON (${file}): ${shortError(error)}`, 1);
  }
  const problems = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) problems.push("manifest must be a JSON object");
  else {
    if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) problems.push("createdAt must be an ISO timestamp");
    if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 0) problems.push("schemaVersion must be a non-negative integer");
    if (!Number.isInteger(manifest.bytes) || manifest.bytes < 0) problems.push("bytes must be a non-negative integer");
    if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.sha256)) problems.push("sha256 must be a 64-char hex digest");
    if (manifest.source !== undefined && typeof manifest.source !== "string") problems.push("source must be a string when present");
  }
  if (problems.length > 0) throw new CliError(`invalid manifest ${file}: ${problems.join("; ")}`, 1);
  return manifest;
}

async function backup(flags) {
  if (!flags.to) throw new CliError("backup requires --to <dir>");
  const paths = runtimePaths();
  const sourceFile = flags.data ? path.resolve(flags.data) : paths.dbFile;
  if (!fs.existsSync(sourceFile)) throw new CliError(`source database not found: ${sourceFile}`, 1);
  if (fs.statSync(sourceFile).isDirectory()) throw new CliError(`--data must be a database file, not a directory: ${sourceFile}`, 1);

  const toDir = path.resolve(flags.to);
  const force = Boolean(flags.force);
  if (fs.existsSync(toDir) && !fs.statSync(toDir).isDirectory()) {
    throw new CliError(`--to must be a directory: ${toDir}`, 1);
  }
  if (directoryNonEmpty(toDir) && !force) {
    throw new CliError(`destination directory is not empty: ${toDir} (pass --force to overwrite)`, 1);
  }
  fs.mkdirSync(toDir, { recursive: true });

  const database = await loadDatabase();
  const sqlite = await loadSqlite();
  const targetDb = path.join(toDir, BACKUP_DB_NAME);
  const targetManifest = path.join(toDir, BACKUP_MANIFEST_NAME);
  const tempSnapshot = path.join(toDir, `.atk-snapshot-${process.pid}-${Date.now()}.db`);
  const tempManifest = path.join(toDir, `.atk-manifest-${process.pid}-${Date.now()}.json`);
  const before = fileFingerprint(sourceFile);
  try {
    // Consistency: a read-only connection + SQLite's backup API copy a
    // transactionally consistent database, including committed WAL pages.
    // Never `fs.copyFile` the .db: in WAL mode that can miss the WAL entirely.
    const sourceDb = new sqlite.DatabaseSync(sourceFile, { readOnly: true });
    try {
      await sqlite.backup(sourceDb, tempSnapshot);
    } finally {
      try {
        sourceDb.close();
      } catch {
        // ignore
      }
    }
    const schemaVersion = readSnapshotSchemaVersion(database, tempSnapshot);
    const bytes = fs.statSync(tempSnapshot).size;
    const sha256 = sha256File(tempSnapshot);
    const manifest = {
      createdAt: new Date().toISOString(),
      schemaVersion,
      bytes,
      sha256,
      source: sourceFile,
    };
    const after = fileFingerprint(sourceFile);
    // A read-only WAL open may create a transient -shm file; that is not a
    // modification of the source database. Stability means every file that
    // existed before the snapshot (main DB + committed WAL) is byte-identical.
    const sourceUnchanged = Object.keys(before).every(
      (key) => JSON.stringify(before[key]) === JSON.stringify(after[key]),
    );
    fs.writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // Install: overwrite only our two artifacts (--force), then rename into place.
    for (const file of [targetDb, targetManifest]) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    removeDataSidecars(targetDb);
    fs.renameSync(tempSnapshot, targetDb);
    fs.renameSync(tempManifest, targetManifest);
    const installedSha = sha256File(targetDb);
    if (installedSha !== sha256) {
      throw new CliError(`snapshot verification failed after install: expected ${sha256}, got ${installedSha}`, 1);
    }

    if (flags.json) {
      printJson({
        ok: true,
        command: "backup",
        source: sourceFile,
        to: toDir,
        database: targetDb,
        manifest,
        sourceUnchanged,
      });
    } else {
      process.stdout.write(`backup ok: ${sourceFile} -> ${targetDb}\n`);
      process.stdout.write(`manifest: schema v${schemaVersion}, ${bytes} bytes, sha256 ${sha256}\n`);
      process.stdout.write(`source unchanged: ${sourceUnchanged ? "yes" : "NO (a concurrent writer touched it)"}\n`);
    }
    return 0;
  } finally {
    for (const file of [tempSnapshot, tempManifest]) {
      try {
        fs.rmSync(file, { force: true });
        removeDataSidecars(file);
      } catch {
        // best effort
      }
    }
  }
}

async function restore(flags) {
  if (!flags.from) throw new CliError("restore requires --from <dir>");
  const fromDir = path.resolve(flags.from);
  const snapshotFile = path.join(fromDir, BACKUP_DB_NAME);
  const manifestFile = path.join(fromDir, BACKUP_MANIFEST_NAME);
  if (!fs.existsSync(manifestFile)) throw new CliError(`manifest not found: ${manifestFile}`, 1);
  if (!fs.existsSync(snapshotFile)) throw new CliError(`snapshot not found: ${snapshotFile}`, 1);
  const manifest = parseManifest(manifestFile);

  // Integrity first: a tampered snapshot is refused before any target write.
  const actualBytes = fs.statSync(snapshotFile).size;
  const actualSha = sha256File(snapshotFile);
  if (actualBytes !== manifest.bytes || actualSha !== manifest.sha256.toLowerCase()) {
    throw new CliError(
      `snapshot integrity check failed: manifest sha256 ${manifest.sha256} / ${manifest.bytes} bytes, ` +
        `but ${snapshotFile} is ${actualSha} / ${actualBytes} bytes`,
      1,
    );
  }

  const database = await loadDatabase();
  const supported = Number(database.SCHEMA_VERSION);
  if (Number.isInteger(supported) && manifest.schemaVersion > supported) {
    throw new CliError(
      `backup schemaVersion ${manifest.schemaVersion} is newer than this build (v${supported}); upgrade the code first`,
      1,
    );
  }

  const paths = runtimePaths();
  const dataFile = flags.data ? path.resolve(flags.data) : paths.dbFile;
  const force = Boolean(flags.force);
  if (dataFile === snapshotFile) throw new CliError("restore target must differ from the snapshot file", 1);
  if (fs.existsSync(dataFile) && fs.statSync(dataFile).isDirectory()) {
    throw new CliError(`restore target is a directory, not a database file: ${dataFile}`, 1);
  }
  if (fs.existsSync(dataFile) && !force) {
    throw new CliError(`target database already exists: ${dataFile} (pass --force to overwrite)`, 1);
  }

  ensureDirFor(dataFile);
  const tempFile = `${dataFile}.restore.tmp`;
  let oldFile = null;
  try {
    // Copy the verified snapshot beside the target, re-verify, then rename.
    fs.copyFileSync(snapshotFile, tempFile);
    const tempSha = sha256File(tempFile);
    if (tempSha !== actualSha) {
      throw new CliError(`restore temp copy failed integrity check: expected ${actualSha}, got ${tempSha}`, 1);
    }
    if (fs.existsSync(dataFile)) {
      oldFile = `${dataFile}.restore.old-${process.pid}-${Date.now()}`;
      fs.rmSync(oldFile, { force: true });
      fs.renameSync(dataFile, oldFile); // keep the old DB until the swap succeeds
    }
    try {
      fs.renameSync(tempFile, dataFile);
    } catch (error) {
      if (oldFile !== null) {
        fs.renameSync(oldFile, dataFile);
        oldFile = null;
      }
      throw error;
    }
    // Sidecars belong to the replaced database; never let a stale WAL attach.
    removeDataSidecars(dataFile);
    if (oldFile !== null) {
      fs.rmSync(oldFile, { force: true });
      removeDataSidecars(oldFile);
      oldFile = null;
    }
    const installedSha = sha256File(dataFile);
    if (installedSha !== actualSha) {
      throw new CliError(`restored database failed integrity check: expected ${actualSha}, got ${installedSha}`, 1);
    }
    const migrationPending = manifest.schemaVersion < supported;
    if (flags.json) {
      printJson({
        ok: true,
        command: "restore",
        from: fromDir,
        data: dataFile,
        manifest,
        forced: force,
        migrationPending,
      });
    } else {
      process.stdout.write(`restore ok: ${fromDir} -> ${dataFile}\n`);
      process.stdout.write(`manifest: schema v${manifest.schemaVersion}, ${manifest.bytes} bytes, sha256 ${manifest.sha256}\n`);
      if (migrationPending) process.stdout.write(`note: schema v${manifest.schemaVersion} < v${supported}; the next start migrates it\n`);
    }
    return 0;
  } finally {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // best effort
    }
    if (oldFile !== null) {
      try {
        if (!fs.existsSync(dataFile)) fs.renameSync(oldFile, dataFile);
        else {
          fs.rmSync(oldFile, { force: true });
          removeDataSidecars(oldFile);
        }
      } catch {
        // best effort
      }
    }
  }
}

async function serve(flags) {
  const port = flags.port !== undefined ? parsePort(flags.port) : 1421;
  const paths = runtimePaths();
  const dataFile = flags.data ? path.resolve(flags.data) : paths.dbFile;
  const webDist = flags["web-dist"] ? path.resolve(flags["web-dist"]) : undefined;

  ensureDirFor(dataFile);
  const database = await loadDatabase();
  const store = openStore(database, dataFile);
  // M6: @atk/database exports verifySwitchReadiness(store); older stores expose
  // it as a method. Bridge the function onto the injected store so the server
  // keeps its "store is the only dependency" boundary.
  if (typeof store.verifySwitchReadiness !== "function" && typeof database.verifySwitchReadiness === "function") {
    Object.defineProperty(store, "verifySwitchReadiness", {
      value: () => database.verifySwitchReadiness(store),
      enumerable: false,
      configurable: true,
    });
  }
  const server = createServer({ store, webDist, logger: console });

  let info;
  try {
    info = await server.listen({ port });
  } catch (error) {
    try {
      store.close?.();
    } catch {
      // ignore
    }
    if (error?.code === "EADDRINUSE") {
      throw new CliError(`port ${port} is already in use; pass --port <n> to choose another one`);
    }
    throw new CliError(`cannot start the HTTP server: ${shortError(error)}`);
  }

  process.stdout.write(`atk backend listening on ${info.url}\n`);
  process.stdout.write(`data: ${dataFile}\n`);
  let pidfile = null;
  if (flags.pidfile !== undefined) {
    if (typeof flags.pidfile !== "string" || flags.pidfile.trim() === "") {
      await server.close();
      store.close?.();
      throw new CliError("--pidfile requires a non-empty path");
    }
    try {
      pidfile = writePidfile(flags.pidfile);
      process.stdout.write(`pidfile: ${pidfile}\n`);
    } catch (error) {
      await server.close();
      store.close?.();
      throw new CliError(`cannot write --pidfile: ${shortError(error)}`, 1);
    }
  }
  process.stdout.write(
    server.tokenFile
      ? `session token file: ${server.tokenFile}${server.tokenPersisted ? "" : " (NOT persisted: in-memory fallback, see warning above)"}\n`
      : "session token: in-memory only\n",
  );
  process.stdout.write(`security: bind 127.0.0.1, Host allow-list, write Origin+CSRF, x-atk-token (health/session exempt)\n`);
  // M2: the internal credential is printed exactly once, is NOT persisted and is
  // NOT logged. Child processes (future runtime-host) receive it via the env.
  process.stdout.write(`internal token: ${server.internalToken}\n`);
  process.env.ATK_INTERNAL_TOKEN = server.internalToken;
  process.stdout.write("internal API: /internal/v1/* requires x-atk-internal (browser token is not accepted there)\n");
  process.stdout.write("press Ctrl+C to stop\n");

  return new Promise((resolve) => {
    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(`\n[atk] received ${signal}; shutting down\n`);
      try {
        await server.close();
      } catch (error) {
        process.stderr.write(`[atk] close failed: ${shortError(error)}\n`);
      }
      try {
        store.close?.();
      } catch (error) {
        process.stderr.write(`[atk] store close failed: ${shortError(error)}\n`);
      }
      removePidfile(pidfile);
      resolve(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    // Last-resort cleanup if the process exits through another path.
    process.once("exit", () => removePidfile(pidfile));
  });
}

async function migrate(flags) {
  const paths = runtimePaths();
  const dryRun = Boolean(flags["dry-run"]);
  const fromFile = flags.from ? path.resolve(flags.from) : path.resolve(".agent-flow", "state.json");
  const stateJson = readRequiredJson(fromFile);
  const sourceDir = path.dirname(fromFile);
  const ownership = readOptionalJson(path.join(sourceDir, "ownership.json"));
  const runtime = readOptionalJson(path.join(sourceDir, "runtime.json"));
  const configFile = resolveConfigFile(flags, sourceDir);
  const config = readOptionalJson(configFile);

  const database = await loadDatabase();
  if (typeof database.importStateJson !== "function") {
    throw new CliError("@atk/database does not export importStateJson(); cannot migrate");
  }

  // A dry run must not touch the real database: use a throwaway file unless the
  // caller explicitly names one with --data.
  let tempFile = null;
  let store;
  try {
    let dbFile;
    if (flags.data) {
      dbFile = path.resolve(flags.data);
    } else if (dryRun) {
      tempFile = path.join(os.tmpdir(), `atk-migrate-dry-run-${process.pid}-${Date.now()}.db`);
      dbFile = tempFile;
    } else {
      dbFile = paths.dbFile;
    }
    ensureDirFor(dbFile);
    store = openStore(database, dbFile);
    const report = await database.importStateJson(store, {
      stateJson,
      ownership,
      runtime,
      config,
      now: new Date().toISOString(),
      dryRun,
    });
    if (flags.json) {
      printJson({ source: fromFile, databaseFile: dbFile, config: configFile, dryRun, ...report });
    } else {
      process.stdout.write(`migrate ${report?.status ?? "UNKNOWN"} (dryRun: ${dryRun}) source: ${fromFile}\n`);
      if (configFile) process.stdout.write(`config: ${configFile}\n`);
      if (report?.counts) process.stdout.write(`counts: ${JSON.stringify(report.counts)}\n`);
      const problems = Array.isArray(report?.problems) ? report.problems : [];
      for (const problem of problems) {
        process.stdout.write(`  [${problem?.level ?? "info"}] ${problem?.code ?? ""}: ${problem?.detail ?? ""}\n`);
      }
    }
    return report?.status === "PASS" ? 0 : 1;
  } finally {
    try {
      store?.close?.();
    } catch (error) {
      process.stderr.write(`[atk] store close failed: ${shortError(error)}\n`);
    }
    if (tempFile) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          fs.rmSync(`${tempFile}${suffix}`, { force: true });
        } catch {
          // best effort
        }
      }
    }
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

async function doctor(flags) {
  const paths = runtimePaths();
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  add("node", nodeOk ? "PASS" : "FAIL", `Node ${process.versions.node} (need >= 22.5.0 for node:sqlite)`);
  add("platform", "PASS", `${process.platform} ${process.arch}`);

  for (const [id, dir] of [
    ["data-dir", paths.dataDir],
    ["runtime-dir", paths.runtimeDir],
  ]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      add(id, "PASS", dir);
    } catch (error) {
      add(id, "FAIL", `${dir}: ${shortError(error)}`);
    }
  }

  let database = null;
  try {
    database = await import("@atk/database");
    add("database", "PASS", "@atk/database loads");
  } catch (error) {
    const missing = error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND";
    add(
      "database",
      "FAIL",
      missing ? "@atk/database is not implemented in this checkout yet" : `@atk/database: ${shortError(error)}`,
    );
  }
  add("database-file", fs.existsSync(paths.dbFile) ? "PASS" : "SKIPPED", `${paths.dbFile}${fs.existsSync(paths.dbFile) ? "" : " (not created yet)"}`);
  add("token-file", fs.existsSync(paths.tokenFile) ? "PASS" : "SKIPPED", `${paths.tokenFile}${fs.existsSync(paths.tokenFile) ? "" : " (created by `serve`)"}`);
  add("web-dist", fs.existsSync(DEFAULT_WEB_DIST) ? "PASS" : "SKIPPED", `${DEFAULT_WEB_DIST}${fs.existsSync(DEFAULT_WEB_DIST) ? "" : " (run: pnpm --filter @atk/web build)"}`);

  const portFree = await portIsFree(1421);
  add("port-1421", portFree ? "PASS" : "FAIL", portFree ? "127.0.0.1:1421 is free" : "127.0.0.1:1421 is in use");

  const report = {
    ok: checks.every((check) => check.status !== "FAIL"),
    node: process.versions.node,
    runtime: paths,
    security: {
      bind: "127.0.0.1",
      hostCheck: true,
      writeOriginCheck: true,
      csrf: "x-atk-csrf on writes",
      sessionToken: "x-atk-token on all but /api/v1/system/health and /api/v1/session",
      tokenFile: paths.tokenFile,
    },
    checks,
  };

  if (flags.json) {
    printJson(report);
  } else {
    process.stdout.write(`atk backend doctor — Node ${report.node}\n`);
    for (const check of report.checks) process.stdout.write(`  ${check.status.padEnd(7)} ${check.id.padEnd(13)} ${check.detail}\n`);
    process.stdout.write("security: bind 127.0.0.1; Host allow-list; write Origin+CSRF; session token (health/session exempt)\n");
    process.stdout.write(`result: ${report.ok ? "OK" : "ATTENTION"}\n`);
  }
  // A diagnostic command used by operators/CI must fail when something is
  // actually wrong: exit 1 couples the exit code to `report.ok` (Lead decision
  // on QA2-04). `--json` follows the same rule.
  return report.ok ? 0 : 1;
}

/** Minimal runtime.json-compatible snapshot derived from the store's agents. */
function deriveRuntime(store, exportedAt) {
  const agents = typeof store.listAgents === "function" ? store.listAgents() : [];
  return {
    schemaVersion: 3,
    exportedAt,
    agents: agents.map((agent) => ({
      id: agent.id,
      role: agent.role,
      capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
      status: typeof agent.status === "string" ? agent.status.toLowerCase() : "idle",
    })),
  };
}

async function exportCommand(flags) {
  const target = flags.to ?? flags.out;
  if (!target) throw new CliError("export requires --to <file>");
  const outFile = path.resolve(target);
  const paths = runtimePaths();
  const dataFile = flags.data ? path.resolve(flags.data) : paths.dbFile;
  const database = await loadDatabase();
  if (typeof database.exportStateJson !== "function") {
    throw new CliError("@atk/database does not export exportStateJson(); cannot export", 1);
  }
  const store = openStore(database, dataFile);
  try {
    const result = database.exportStateJson(store, flags.project ? { projectId: flags.project } : {});
    const exportedAt = new Date().toISOString();
    const stateJson = result && typeof result === "object" && "state" in result ? result.state : result;
    const runtime = (result && typeof result === "object" && result.runtime) || deriveRuntime(store, exportedAt);
    // Readable, cross-version/audit format. backup/restore remain the binary
    // rollback path; this JSON is NOT a byte-for-byte database snapshot.
    const document = { exportedAt, stateJson, runtime, manifest: result?.manifest ?? null };
    ensureDirFor(outFile);
    fs.writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    if (flags.json) {
      printJson({
        ok: true,
        command: "export",
        data: dataFile,
        to: outFile,
        projectId: flags.project ?? null,
        manifest: document.manifest,
      });
    } else {
      process.stdout.write(`exported ${dataFile} -> ${outFile}\n`);
      if (document.manifest?.counts) process.stdout.write(`counts: ${JSON.stringify(document.manifest.counts)}\n`);
    }
  } finally {
    try {
      store.close?.();
    } catch {
      // ignore
    }
  }
  return 0;
}

async function importCommand(flags) {
  if (!flags.from) throw new CliError("import requires --from <file>");
  const fromFile = path.resolve(flags.from);
  const mode = flags.mode ?? "merge";
  if (mode !== "merge" && mode !== "replace") {
    throw new CliError('--mode must be "merge" or "replace"');
  }
  const force = Boolean(flags.force);
  const document = readRequiredJson(fromFile);
  // Accept both the export wrapper ({stateJson,runtime}) and a raw legacy state.
  let stateJson = document;
  let runtime = null;
  let ownership = null;
  let config = null;
  if (document && typeof document === "object" && !Array.isArray(document) && document.stateJson !== undefined) {
    stateJson = document.stateJson;
    runtime = document.runtime ?? null;
    ownership = document.ownership ?? null;
    config = document.config ?? null;
  }
  const paths = runtimePaths();
  const dataFile = flags.data ? path.resolve(flags.data) : paths.dbFile;
  const database = await loadDatabase();
  if (typeof database.importStateJson !== "function") {
    throw new CliError("@atk/database does not export importStateJson(); cannot import", 1);
  }
  ensureDirFor(dataFile);
  const store = openStore(database, dataFile);
  try {
    const projects = typeof store.listProjects === "function" ? store.listProjects() : [];
    const tasks = typeof store.listTasks === "function" ? store.listTasks({}) : [];
    const nonEmpty = projects.length > 0 || tasks.length > 0;
    if (mode === "replace" && nonEmpty && !force) {
      throw new CliError(
        `target database is not empty (${projects.length} project(s), ${tasks.length} task(s)); import --mode replace requires --force`,
        1,
      );
    }
    const report = await database.importStateJson(store, { stateJson, runtime, ownership, config, mode, force });
    const status = report?.status ?? "UNKNOWN";
    if (flags.json) {
      printJson({
        ok: status === "PASS",
        command: "import",
        from: fromFile,
        data: dataFile,
        mode,
        forced: force,
        report,
      });
    } else {
      process.stdout.write(`import ${status} (mode: ${mode}${force ? ", force" : ""}) from: ${fromFile}\n`);
      if (report?.counts) process.stdout.write(`counts: ${JSON.stringify(report.counts)}\n`);
      const problems = Array.isArray(report?.problems) ? report.problems : [];
      for (const problem of problems) {
        process.stdout.write(`  [${problem?.level ?? "info"}] ${problem?.code ?? ""}: ${JSON.stringify(problem?.detail ?? null)}\n`);
      }
    }
    return status === "PASS" ? 0 : 1;
  } finally {
    try {
      store.close?.();
    } catch {
      // ignore
    }
  }
}

/** Command dispatcher (exported so tests can drive it without spawning). */
export async function run(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  if (flags.help || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    process.stderr.write(USAGE);
    return 2;
  }
  switch (command) {
    case "serve":
      return serve(flags);
    case "migrate":
      return migrate(flags);
    case "doctor":
      return doctor(flags);
    case "export":
      return exportCommand(flags);
    case "import":
      return importCommand(flags);
    case "backup":
      return backup(flags);
    case "restore":
      return restore(flags);
    default:
      throw new CliError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error) => {
      if (error instanceof CliError) {
        process.stderr.write(`atk-backend: ${error.message}\n`);
        process.exitCode = error.exitCode;
      } else {
        process.stderr.write(`atk-backend: unexpected error: ${shortError(error)}\n`);
        process.exitCode = 1;
      }
    },
  );
}
