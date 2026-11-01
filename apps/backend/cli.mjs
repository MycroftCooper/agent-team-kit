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
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createServer } from "./src/server.mjs";
import { runtimePaths } from "./src/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIST = path.resolve(HERE, "..", "web", "dist");

const USAGE = `Usage: atk-backend <command> [options]

Commands:
  serve    [--port 1421] [--data <file>] [--web-dist <dir>]
           Start the HTTP API on 127.0.0.1 only (ADR-008).
  migrate  [--from <state.json>] [--data <file>] [--dry-run] [--json] [--config <file>]
           Import a legacy agent-flow state.json into SQLite
           (default source: .agent-flow/state.json + sibling ownership/runtime;
            --config defaults to ./agent-flow.config.json when present).
  doctor   [--json]
           Read-only diagnostics: node, paths, database availability, web build,
           port availability and the security configuration summary.
  export   --out <file> [--data <file>] [--project <id>] [--json]
           Export the SQLite store back to a state JSON document.

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

function readOptionalJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`cannot parse ${file}: ${shortError(error)}`);
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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function serve(flags) {
  const port = flags.port !== undefined ? parsePort(flags.port) : 1421;
  const paths = runtimePaths();
  const dataFile = flags.data ? path.resolve(flags.data) : paths.dbFile;
  const webDist = flags["web-dist"] ? path.resolve(flags["web-dist"]) : undefined;

  ensureDirFor(dataFile);
  const database = await loadDatabase();
  const store = openStore(database, dataFile);
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
  process.stdout.write(
    server.tokenFile
      ? `session token file: ${server.tokenFile}${server.tokenPersisted ? "" : " (NOT persisted: in-memory fallback, see warning above)"}\n`
      : "session token: in-memory only\n",
  );
  process.stdout.write(`security: bind 127.0.0.1, Host allow-list, write Origin+CSRF, x-atk-token (health/session exempt)\n`);
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
      resolve(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}

async function migrate(flags) {
  const paths = runtimePaths();
  const dryRun = Boolean(flags["dry-run"]);
  const fromFile = flags.from ? path.resolve(flags.from) : path.resolve(".agent-flow", "state.json");
  if (!fs.existsSync(fromFile)) {
    throw new CliError(`state file not found: ${fromFile}`);
  }
  let stateJson;
  try {
    stateJson = JSON.parse(fs.readFileSync(fromFile, "utf8"));
  } catch (error) {
    throw new CliError(`cannot parse state JSON ${fromFile}: ${shortError(error)}`);
  }
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
  return 0;
}

async function exportCommand(flags) {
  if (!flags.out) throw new CliError("export requires --out <file>");
  const outFile = path.resolve(flags.out);
  const paths = runtimePaths();
  const dataFile = flags.data ? path.resolve(flags.data) : paths.dbFile;
  const database = await loadDatabase();
  if (typeof database.exportStateJson !== "function") {
    throw new CliError("@atk/database does not export exportStateJson(); cannot export");
  }
  const store = openStore(database, dataFile);
  try {
    const result = database.exportStateJson(store, flags.project ? { projectId: flags.project } : {});
    ensureDirFor(outFile);
    const state = result && typeof result === "object" && "state" in result ? result.state : result;
    fs.writeFileSync(outFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    if (flags.json) printJson({ ok: true, out: outFile, source: dataFile, projectId: flags.project ?? null, manifest: result?.manifest ?? null });
    else process.stdout.write(`exported ${dataFile} -> ${outFile}\n`);
  } finally {
    try {
      store.close?.();
    } catch {
      // ignore
    }
  }
  return 0;
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
