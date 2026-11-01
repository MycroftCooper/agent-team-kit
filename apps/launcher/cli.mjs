#!/usr/bin/env node
// `atk` — one command to run the local Agent Team Kit system (m5-contracts §1).
//
//   atk start  [--port 1421] [--data <dir>] [--hosts 1] [--runtime mock] [--detach]
//   atk stop   [--data <dir>] [--force]
//   atk status [--data <dir>] [--json]
//   atk logs   [--data <dir>] [--follow]
//
// `start` hands the process tree to a small detached supervisor process. The
// supervisor owns the children's stdout pipes, so it is the only process that
// ever sees the backend's one-time "internal token" line; it redacts that line
// before touching a log and passes the value to Scheduler/Hosts via env only.
// The state file (`launcher.json`) is written by the supervisor and never
// contains the credential. Exit codes: 0 ok, 1 runtime failure, 2 usage or an
// already-running instance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkHealth, isProcessAlive, loopbackUrl } from "./src/health.mjs";
import { createLauncher, LauncherError } from "./src/launcher.mjs";
import { readState, removeState, statePathFor } from "./src/state.mjs";

const CLI_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(CLI_FILE), "..", "..");
const DEFAULT_PORT = 1421;
const DEFAULT_HOSTS = 1;
const START_READY_TIMEOUT_MS = 45_000;
const START_READY_POLL_MS = 200;
const STOP_WAIT_TIMEOUT_MS = 15_000;
const STOP_WAIT_POLL_MS = 150;

const USAGE = `Usage: atk <command> [options]

Commands:
  start   start Backend + Scheduler + Runtime Hosts as one local system
  stop    stop the recorded process tree (idempotent)
  status  show per-child PID / alive / health (--json for machines)
  logs    print the child logs (--follow to stream new lines)

Options for start:
  --port <n>       backend port (default ${DEFAULT_PORT})
  --data <dir>     data directory (default %LOCALAPPDATA%\\AgentTeamKit or ATK_DATA_DIR)
  --hosts <n>      number of Runtime Hosts (default ${DEFAULT_HOSTS}, 1..16)
  --runtime <kind> Host runtime: mock (default) or dsh
  --detach         accepted for symmetry; start always returns after readiness

Options for stop:
  --force          skip SIGTERM grace, kill immediately

Options for status:
  --json           machine-readable output

Options for logs:
  --follow         keep streaming appended lines (Ctrl+C to stop)

Environment: ATK_DATA_DIR overrides the default data directory.
Exit codes: 0 ok, 1 runtime failure, 2 usage error or already running.`;

function usageError(message) {
  return new LauncherError(`${message}\n\n${USAGE}`, { code: 2 });
}

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw usageError(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const flags = {};
  let command = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      switch (name) {
        case "port":
        case "data":
        case "hosts":
        case "runtime": {
          flags[name] = inline ?? takeValue(argv, (index += 1), `--${name}`);
          break;
        }
        case "detach":
        case "force":
        case "json":
        case "follow": {
          if (inline !== undefined) throw usageError(`--${name} does not take a value`);
          flags[name] = true;
          break;
        }
        default:
          throw usageError(`unknown option --${name}`);
      }
      continue;
    }
    if (command !== null) throw usageError(`unexpected argument ${JSON.stringify(arg)}`);
    command = arg;
  }
  return { command, flags };
}

function resolveDataDir(flags) {
  if (flags.data !== undefined) return path.resolve(flags.data);
  if (process.env.ATK_DATA_DIR) return path.resolve(process.env.ATK_DATA_DIR);
  const base = process.env.LOCALAPPDATA || os.homedir();
  return path.join(base, "AgentTeamKit");
}

function resolvePort(flags) {
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw usageError(`--port must be an integer in 1..65535, got ${JSON.stringify(flags.port)}`);
  return port;
}

function resolveHosts(flags) {
  const hosts = flags.hosts === undefined ? DEFAULT_HOSTS : Number(flags.hosts);
  if (!Number.isInteger(hosts) || hosts < 1 || hosts > 16) throw usageError(`--hosts must be an integer in 1..16, got ${JSON.stringify(flags.hosts)}`);
  return hosts;
}

function resolveRuntime(flags) {
  const runtime = String(flags.runtime ?? "mock").toLowerCase();
  if (runtime !== "mock" && runtime !== "dsh") throw usageError(`--runtime must be "mock" or "dsh", got ${JSON.stringify(flags.runtime)}`);
  return runtime;
}

function supervisorPaths(dataDir) {
  const runtimeDir = path.join(dataDir, "runtime");
  return {
    runtimeDir,
    logsDir: path.join(dataDir, "logs"),
    stateFile: statePathFor(dataDir),
    pidFile: path.join(runtimeDir, "launcher.pid"),
    stopRequest: path.join(runtimeDir, "stop.request"),
    supervisorLog: path.join(dataDir, "logs", "launcher.log"),
  };
}

function readPidFile(pidFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writePidFile(pidFile, pid) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${JSON.stringify({ pid, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function tailFile(file, lines = 30) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask a live supervisor to stop its (in-memory) children through the token-free
 * request file; true when the supervisor process is gone afterwards. This is the
 * fallback for QA6-01: even with a corrupt `launcher.json`, a running supervisor
 * still knows its children and can stop them in order.
 */
async function requestSupervisorStop(paths, pid, timeoutMs) {
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.writeFileSync(paths.stopRequest, `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(STOP_WAIT_POLL_MS);
  removeFile(paths.stopRequest);
  return !isProcessAlive(pid);
}

function childPids(state) {
  return state ? state.children.map((child) => `${child.name}=${child.pid}`).join(", ") : "";
}

async function waitForReadiness({ dataDir, supervisorPid, timeoutMs = START_READY_TIMEOUT_MS }) {
  const paths = supervisorPaths(dataDir);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProcessAlive(supervisorPid)) {
      return { ok: false, reason: `supervisor (pid ${supervisorPid}) exited during startup`, log: tailFile(paths.supervisorLog) };
    }
    const state = readState(paths.stateFile);
    if (state && state.children.every((child) => isProcessAlive(child.pid))) {
      const health = await checkHealth({ baseUrl: loopbackUrl(state.port), timeoutMs: 1_500 });
      if (health.ok) return { ok: true, state };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: `system did not become ready within ${timeoutMs}ms`, log: tailFile(paths.supervisorLog) };
    }
    await sleep(START_READY_POLL_MS);
  }
}

async function commandStart(flags) {
  const dataDir = resolveDataDir(flags);
  const port = resolvePort(flags);
  const hosts = resolveHosts(flags);
  const runtime = resolveRuntime(flags);
  const paths = supervisorPaths(dataDir);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true });

  const probe = createLauncher({ dataDir, port, hosts, runtime, repoRoot: ROOT });
  const existing = await probe.inspect();
  if (existing.running) {
    process.stderr.write(
      `atk: an instance is already running on port ${existing.state.port} (${childPids(existing.state)}); ` +
        `use \`atk status --json\` or \`atk stop\`\n`,
    );
    return 2;
  }
  if (existing.state) {
    process.stdout.write(`atk: cleaning stale launcher state from a previous run\n`);
    await probe.stop({ state: existing.state });
    const survivors = existing.state.children.filter((child) => isProcessAlive(child.pid));
    if (survivors.length > 0) {
      process.stderr.write(
        `atk: could not stop the stale instance (still alive: ${survivors.map((child) => `${child.name}=${child.pid}`).join(", ")}); refusing to start\n`,
      );
      return 1;
    }
  }
  const corruptState = fs.existsSync(paths.stateFile) && !existing.state;
  if (corruptState) {
    // QA6-01: a corrupt launcher.json must not lead to a blind second start.
    const pidEntry = readPidFile(paths.pidFile);
    if (pidEntry && isProcessAlive(pidEntry.pid)) {
      const stopped = await requestSupervisorStop(paths, pidEntry.pid, 5_000);
      if (!stopped || fs.existsSync(paths.stateFile)) {
        process.stderr.write(
          `atk: launcher.json is corrupt and the running supervisor did not finish stopping; refusing to start a second tree (launcher.pid preserved)\n`,
        );
        return 1;
      }
      process.stdout.write(`atk: recovered a corrupt launcher.json via the running supervisor\n`);
    } else {
      process.stderr.write(
        `atk: launcher.json at ${paths.stateFile} is corrupt/unreadable and no live supervisor is recording children; ` +
          `refusing to start because the running tree cannot be verified. Ensure no Agent Team Kit processes are running, then remove the file.\n`,
      );
      return 1;
    }
  }
  // A supervisor without a state file is a crashed/aborted start; make it exit
  // before spawning another one, so two supervisors can never race on the port.
  const stalePid = readPidFile(paths.pidFile);
  if (stalePid && isProcessAlive(stalePid.pid)) {
    const stopped = await requestSupervisorStop(paths, stalePid.pid, 5_000);
    if (!stopped) {
      process.stderr.write(`atk: a supervisor (pid ${stalePid.pid}) is still running and did not stop; refusing to start a second one\n`);
      return 1;
    }
  }
  if (!stalePid || !isProcessAlive(stalePid.pid)) removeFile(paths.pidFile);

  const logFd = fs.openSync(paths.supervisorLog, "a");
  const supervisorArgs = [CLI_FILE, "__supervise", "--port", String(port), "--data", dataDir, "--hosts", String(hosts), "--runtime", runtime];
  let supervisor;
  try {
    supervisor = spawn(process.execPath, supervisorArgs, {
      cwd: ROOT,
      env: { ...process.env, ATK_LAUNCHER_SUPERVISOR: "1" },
      windowsHide: true,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    supervisor.unref();
  } finally {
    fs.closeSync(logFd);
  }
  if (!supervisor.pid) {
    process.stderr.write(`atk: could not start the launcher supervisor\n`);
    return 1;
  }
  writePidFile(paths.pidFile, supervisor.pid);

  const ready = await waitForReadiness({ dataDir, supervisorPid: supervisor.pid });
  if (!ready.ok) {
    process.stderr.write(`atk: ${ready.reason}\n`);
    if (ready.log) process.stderr.write(`--- ${paths.supervisorLog} (tail) ---\n${ready.log}\n`);
    fs.writeFileSync(paths.stopRequest, `${JSON.stringify({ requestedAt: new Date().toISOString(), reason: "start-failed" })}\n`);
    try {
      await probe.stop({ force: true });
    } catch {
      // best effort cleanup
    }
    try {
      process.kill(supervisor.pid, "SIGTERM");
    } catch {
      // already gone
    }
    removeFile(paths.stopRequest);
    removeFile(paths.pidFile);
    return 1;
  }

  process.stdout.write(`atk: started on port ${ready.state.port} (data ${dataDir})\n`);
  for (const child of ready.state.children) process.stdout.write(`  ${child.role.padEnd(9)} ${child.name} (pid ${child.pid})\n`);
  process.stdout.write(`  logs      ${paths.logsDir}\n`);
  process.stdout.write(`  supervisor pid ${supervisor.pid} (logs/launcher.log)\n`);
  return 0;
}

async function commandStop(flags) {
  const dataDir = resolveDataDir(flags);
  const paths = supervisorPaths(dataDir);
  const launcher = createLauncher({ dataDir, repoRoot: ROOT });
  const state = readState(paths.stateFile);
  const stateFileExists = fs.existsSync(paths.stateFile);
  const pidEntry = readPidFile(paths.pidFile);
  const supervisorAlive = Boolean(pidEntry && isProcessAlive(pidEntry.pid));

  if (!state) {
    if (!stateFileExists && !supervisorAlive) {
      removeFile(paths.stopRequest);
      if (pidEntry) removeFile(paths.pidFile); // dead supervisor pid, nothing to manage
      process.stdout.write("atk: not running\n");
      return 0;
    }
    if (supervisorAlive) {
      // QA6-01 fallback: the supervisor holds the child PIDs in memory and can
      // stop them in order even when launcher.json is corrupt.
      const stopped = await requestSupervisorStop(paths, pidEntry.pid, STOP_WAIT_TIMEOUT_MS);
      if (stopped && !fs.existsSync(paths.stateFile)) {
        removeFile(paths.pidFile);
        process.stdout.write("atk: stopped (recovered a corrupt launcher.json via the running supervisor)\n");
        return 0;
      }
      process.stderr.write(
        `atk: launcher.json is corrupt and the supervisor (pid ${pidEntry.pid}) did not finish stopping; ` +
          `refusing to report success (launcher.pid and launcher.json preserved)\n`,
      );
      return 1;
    }
    // QA6-01: corrupt state with no live supervisor — never silently succeed and
    // never delete the pidfile: children may still be running with unknown PIDs.
    process.stderr.write(
      `atk: launcher.json at ${paths.stateFile} is corrupt/unreadable and no supervisor is alive to enumerate the children; ` +
        `refusing to report success. Inspect/stop any remaining Agent Team Kit processes manually, then remove the state file.\n`,
    );
    return 1;
  }

  if (flags.force) {
    const result = await launcher.stop({ force: true, state });
    removeFile(paths.stopRequest);
    removeFile(paths.pidFile);
    process.stdout.write(`atk: force-stopped ${result.stopped.length} child process(es)\n`);
    return 0;
  }

  // Ask the supervisor to perform the ordered stop (hosts -> scheduler ->
  // backend). The request is a token-free file so it works on Windows too, where
  // programmatic SIGTERM delivery is not a real signal (it would kill the
  // supervisor before it could stop the children in order).
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.writeFileSync(paths.stopRequest, `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`);

  const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = readState(paths.stateFile);
    if (!current || current.children.every((child) => !isProcessAlive(child.pid))) break;
    await sleep(STOP_WAIT_POLL_MS);
  }

  // Fallback: if the supervisor is gone or wedged, stop the recorded PIDs in the
  // same order. This makes `atk stop` idempotent and crash-safe.
  if (readState(paths.stateFile)) await launcher.stop();
  const survivors = state.children.filter((child) => isProcessAlive(child.pid));
  removeFile(paths.stopRequest);
  if (survivors.length > 0) {
    process.stderr.write(
      `atk: stop did not finish (still alive: ${survivors.map((child) => `${child.name}=${child.pid}`).join(", ")}); launcher.pid preserved\n`,
    );
    return 1;
  }
  removeFile(paths.pidFile);
  process.stdout.write("atk: stopped\n");
  return 0;
}

function formatStatusText(status) {
  if (!status.running) {
    const reason = status.health?.error ? ` (${status.health.error})` : "";
    const children = (status.children ?? []).map(
      (child) => `  ${child.role.padEnd(9)} ${child.name.padEnd(10)} pid ${String(child.pid).padEnd(8)} ${child.alive ? "alive" : "DOWN"}`,
    );
    return `atk: not running${reason}\n${children.length > 0 ? `${children.join("\n")}\n` : ""}`;
  }
  const lines = [`atk: running on port ${status.port} since ${status.startedAt}`, `health: ${status.health?.ok ? "ok" : "down"}${status.health?.error ? ` (${status.health.error})` : ""}`];
  for (const child of status.children) {
    lines.push(`  ${child.role.padEnd(9)} ${child.name.padEnd(10)} pid ${String(child.pid).padEnd(8)} ${child.alive ? "alive" : "DOWN"}`);
  }
  return `${lines.join("\n")}\n`;
}

async function commandStatus(flags) {
  const dataDir = resolveDataDir(flags);
  const launcher = createLauncher({ dataDir, repoRoot: ROOT });
  const status = await launcher.status();
  if (flags.json) process.stdout.write(`${JSON.stringify(status)}\n`);
  else process.stdout.write(formatStatusText(status));
  return status.code;
}

function readLogFiles(logsDir) {
  try {
    return fs
      .readdirSync(logsDir)
      .filter((file) => file.endsWith(".log"))
      .sort()
      .map((file) => path.join(logsDir, file));
  } catch {
    return [];
  }
}

async function commandLogs(flags) {
  const dataDir = resolveDataDir(flags);
  const logsDir = path.join(dataDir, "logs");
  const files = readLogFiles(logsDir);
  if (files.length === 0) {
    process.stdout.write(`atk: no logs yet under ${logsDir}\n`);
    return 0;
  }
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    process.stdout.write(`=== ${path.basename(file)} ===\n${lines.slice(-200).join("\n")}\n`);
  }
  if (!flags.follow) return 0;

  const offsets = new Map(files.map((file) => [file, fs.statSync(file).size]));
  process.stdout.write("atk: following logs (Ctrl+C to stop)\n");
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      for (const file of readLogFiles(logsDir)) {
        const size = fs.statSync(file).size;
        const offset = offsets.get(file) ?? 0;
        if (size <= offset) continue;
        const fd = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(size - offset);
          fs.readSync(fd, buffer, 0, buffer.length, offset);
          process.stdout.write(buffer.toString("utf8"));
        } finally {
          fs.closeSync(fd);
        }
        offsets.set(file, size);
      }
    }, 250);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Hidden supervisor command: keeps the children's pipes alive and performs the
// ordered stop when `atk stop` leaves a request file.
// ---------------------------------------------------------------------------
async function commandSupervise(flags) {
  const dataDir = resolveDataDir(flags);
  const port = resolvePort(flags);
  const hosts = resolveHosts(flags);
  const runtime = resolveRuntime(flags);
  const paths = supervisorPaths(dataDir);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true });

  const log = (level, message) => {
    try {
      fs.appendFileSync(paths.supervisorLog, `${new Date().toISOString()} [supervisor:${level}] ${message}\n`);
    } catch {
      // logging is best effort
    }
  };
  const logger = {
    info: (message) => log("info", String(message ?? "")),
    warn: (message) => log("warn", String(message ?? "")),
    error: (message) => log("error", String(message ?? "")),
  };
  const launcher = createLauncher({ dataDir, port, hosts, runtime, repoRoot: ROOT, logger });

  try {
    const result = await launcher.start();
    log("info", `started on port ${result.port} (${result.state.children.map((child) => `${child.name}=${child.pid}`).join(", ")})`);
  } catch (error) {
    log("error", `start failed: ${error?.message ?? error}`);
    if (error?.details) log("error", `details: ${JSON.stringify(error.details)}`);
    removeFile(paths.pidFile);
    return error instanceof LauncherError ? error.code : 1;
  }

  let stopping = false;
  const requestStop = async (reason) => {
    if (stopping) return;
    stopping = true;
    log("info", `stop requested (${reason})`);
    try {
      const result = await launcher.stop();
      log("info", `stopped in order: ${result.stopped.map((entry) => entry.name).join(" -> ")}`);
    } catch (error) {
      log("error", `stop failed: ${error?.message ?? error}`);
    } finally {
      removeFile(paths.stopRequest);
      const pidFile = readPidFile(paths.pidFile);
      if (!pidFile || pidFile.pid === process.pid) removeFile(paths.pidFile);
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void requestStop("SIGTERM"));
  process.on("SIGINT", () => void requestStop("SIGINT"));
  setInterval(() => {
    try {
      if (fs.existsSync(paths.stopRequest)) return void requestStop("stop-request");
      if (!fs.existsSync(paths.stateFile)) return void requestStop("state-removed");
    } catch {
      // transient filesystem error; retry next tick
    }
  }, 200);
  await new Promise(() => {});
  return 0;
}

async function main(argv) {
  let command;
  let flags;
  try {
    ({ command, flags } = parseArgs(argv));
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    return 2;
  }
  if (flags.help || command === null) {
    process.stdout.write(`${USAGE}\n`);
    return flags.help ? 0 : 2;
  }
  try {
    switch (command) {
      case "start":
        return await commandStart(flags);
      case "stop":
        return await commandStop(flags);
      case "status":
        return await commandStatus(flags);
      case "logs":
        return await commandLogs(flags);
      case "__supervise":
        return await commandSupervise(flags);
      default:
        throw usageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (error) {
    process.stderr.write(`atk: ${error?.message ?? error}\n`);
    return error instanceof LauncherError ? error.code : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(CLI_FILE)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export { main, parseArgs };
