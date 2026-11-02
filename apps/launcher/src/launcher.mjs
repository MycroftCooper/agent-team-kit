// Process supervisor for the local Agent Team Kit system.
//
// The launcher owns exactly three kinds of children (m5-contracts §1):
//   backend   -> apps/backend/cli.mjs serve --port <port> --data <dataDir>/data/atk.db
//   scheduler -> apps/scheduler/cli.mjs        (env ATK_BACKEND_URL, ATK_INTERNAL_TOKEN)
//   host-<i>  -> apps/runtime-host/cli.mjs     (env ++ AGENT_RUNTIME, ATK_HOST_STATE_FILE)
//
// ADR-010 / ADR-008 hard rule: the internal credential is printed once by the
// backend on stdout, captured here in memory, and passed to the Scheduler and
// Hosts *only* through their environment. It is never written to `launcher.json`,
// never written to a log line, and never returned by `status()`.
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { checkHealth, isProcessAlive, loopbackUrl, waitForHealth } from "./health.mjs";
import { readState, removeState, statePathFor, writeState } from "./state.mjs";

export const HOST_ROLE = "host";
export const SCHEDULER_ROLE = "scheduler";
export const BACKEND_ROLE = "backend";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN_LINE = /^internal tokens:\s*scheduler=(\S+)\s+runtime-host=(\S+)\s*$/;
const LEGACY_TOKEN_LINE = /^internal token:\s*(\S+)\s*$/;

export class LauncherError extends Error {
  constructor(message, { code = 1, details = {} } = {}) {
    super(message);
    this.name = "LauncherError";
    this.code = code;
    this.details = details;
  }
}

function parsePort(value, label = "port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new LauncherError(`${label} must be an integer in 1..65535, got ${JSON.stringify(value)}`, { code: 2 });
  }
  return port;
}

function parseHosts(value) {
  const hosts = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(hosts) || hosts < 1 || hosts > 16) {
    throw new LauncherError(`hosts must be an integer in 1..16, got ${JSON.stringify(value)}`, { code: 2 });
  }
  return hosts;
}

function createLineReader(onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      onLine(line);
    }
  };
}

/**
 * @param {object} options
 * @param {string} options.dataDir        data directory (contains data/, runtime/, logs/, launcher.json)
 * @param {number} [options.port]         backend port (default 1421)
 * @param {number} [options.hosts]        number of Runtime Hosts (default 1)
 * @param {string} [options.runtime]      AGENT_RUNTIME for Hosts: "mock" (default) | "dsh"
 * @param {Function} [options.spawnImpl]  child_process.spawn-compatible (tests inject fakes)
 * @param {Function} [options.fetchImpl]  fetch-compatible (tests inject fakes)
 * @param {object} [options.logger]       {info,warn,error}; never receives the token
 * @param {Function} [options.now]        clock (ms)
 * @param {Function} [options.sleep]      sleep(ms) (tests inject an instant version)
 * @param {Function} [options.isAliveImpl] process.kill(pid,0)-like
 * @param {Function} [options.killImpl]   process.kill(pid,signal)-like
 */
export function createLauncher(options = {}) {
  if (!options.dataDir) throw new TypeError("createLauncher: dataDir is required");
  const dataDir = path.resolve(options.dataDir);
  const port = parsePort(options.port ?? 1421);
  const hosts = parseHosts(options.hosts);
  const runtime = String(options.runtime ?? "mock").toLowerCase();
  if (runtime !== "mock" && runtime !== "dsh") {
    throw new LauncherError(`runtime must be "mock" or "dsh", got ${JSON.stringify(runtime)}`, { code: 2 });
  }

  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const isAliveImpl = options.isAliveImpl ?? isProcessAlive;
  const killImpl = options.killImpl ?? ((pid, signal) => process.kill(pid, signal));
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const nodeBin = options.nodeBin ?? process.execPath;
  const healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
  const healthIntervalMs = options.healthIntervalMs ?? 250;
  const settleMs = options.settleMs ?? 750;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const stopPollMs = options.stopPollMs ?? 100;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? 15_000;

  const dataFile = path.join(dataDir, "data", "atk.db");
  const runtimeDir = path.join(dataDir, "runtime");
  const logsDir = path.join(dataDir, "logs");
  const stateFile = statePathFor(dataDir);
  const supervisorPidFile = path.join(runtimeDir, "launcher.pid");
  const baseUrl = loopbackUrl(port);
  const webDist = options.webDist === undefined ? path.join(repoRoot, "apps", "web", "dist") : options.webDist;

  /** name -> {name, role, pid, child, exited, exitCode, signalCode} */
  const children = new Map();
  const tokenState = { scheduler: null, runtimeHost: null, waiters: [] };

  function tokensReady() {
    return typeof tokenState.scheduler === "string" && typeof tokenState.runtimeHost === "string";
  }

  function ensureDirs() {
    for (const directory of [dataDir, path.join(dataDir, "data"), runtimeDir, logsDir]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  function isoNow() {
    return new Date(now()).toISOString();
  }

  function redact(text) {
    let value = String(text ?? "");
    for (const token of [tokenState.scheduler, tokenState.runtimeHost]) {
      if (typeof token === "string" && token !== "") value = value.split(token).join("[REDACTED]");
    }
    return value;
  }

  function appendLog(name, line) {
    ensureDirs();
    const message = redact(line);
    try {
      fs.appendFileSync(path.join(logsDir, `${name}.log`), `${isoNow()} [${name}] ${message}\n`);
    } catch (error) {
      logger.warn?.(`launcher: could not append to ${name}.log: ${error?.message ?? error}`);
    }
  }

  function logTail(name) {
    try {
      return fs.readFileSync(path.join(logsDir, `${name}.log`), "utf8").split("\n").slice(-12).join("\n");
    } catch {
      return "";
    }
  }

  function resolveTokenWaiters(error) {
    for (const waiter of tokenState.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve({ scheduler: tokenState.scheduler, runtimeHost: tokenState.runtimeHost });
    }
  }

  function waitForTokens(timeoutMs = tokenTimeoutMs) {
    if (tokensReady()) return Promise.resolve({ scheduler: tokenState.scheduler, runtimeHost: tokenState.runtimeHost });
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = tokenState.waiters.indexOf(waiter);
        if (index !== -1) tokenState.waiters.splice(index, 1);
        reject(new LauncherError(`backend did not print both internal tokens within ${timeoutMs}ms`, { code: 1 }));
      }, timeoutMs);
      waiter.timer.unref?.();
      tokenState.waiters.push(waiter);
    });
  }

  function handleLine(name, line) {
    if (name === BACKEND_ROLE) {
      const match = TOKEN_LINE.exec(line.trim());
      if (match) {
        // Never persist the values: the log only records that they arrived.
        tokenState.scheduler = match[1];
        tokenState.runtimeHost = match[2];
        appendLog(name, "internal credentials received (values held in memory; injected per role)");
        resolveTokenWaiters();
        return;
      }
      const legacy = LEGACY_TOKEN_LINE.exec(line.trim());
      if (legacy) {
        // Compatibility with older backends: one credential for both roles, but
        // only during migration; the M6.3 backend prints two.
        tokenState.scheduler = legacy[1];
        tokenState.runtimeHost = legacy[1];
        appendLog(name, "legacy single internal credential received (value held in memory)");
        resolveTokenWaiters();
        return;
      }
    }
    // Any line that names the credential channel (raw token banner or the
    // `x-atk-internal` security banner) is never written verbatim: handing the
    // backend's stdout to a file must not turn a printed secret into a stored one.
    if (/internal tokens?:|x-atk-internal/i.test(line)) {
      appendLog(name, "[redacted] internal credential line filtered");
      return;
    }
    appendLog(name, line);
  }

  function trackExit(entry, code, signal) {
    entry.exited = true;
    entry.exitCode = code;
    entry.signalCode = signal;
    appendLog(entry.name, `exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    if (entry.name === BACKEND_ROLE && !tokensReady()) {
      resolveTokenWaiters(new LauncherError(`backend exited before printing an internal token (scheduler/runtime-host; code ${code ?? "null"})`, { code: 1 }));
    }
  }

  function spawnChild(name, role, args, envExtra = {}) {
    // The backend never receives ATK_INTERNAL_TOKEN: it creates the credential.
    const env = { ...process.env, ...envExtra };
    let child;
    try {
      child = spawnImpl(nodeBin, args, {
        cwd: repoRoot,
        env,
        windowsHide: true, // Windows: never flash a console window for a child.
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
    } catch (error) {
      throw new LauncherError(`could not spawn ${name}: ${error?.message ?? error}`, { code: 1 });
    }
    const entry = { name, role, pid: child.pid, child, exited: false, exitCode: null, signalCode: null };
    children.set(name, entry);
    const onStdout = createLineReader((line) => handleLine(name, line));
    const onStderr = createLineReader((line) => handleLine(name, `${line}`));
    child.stdout?.on?.("data", onStdout);
    child.stderr?.on?.("data", onStderr);
    if (typeof child.once === "function") child.once("exit", (code, signal) => trackExit(entry, code, signal));
    if (typeof child.on === "function") child.on("error", (error) => appendLog(name, `spawn error: ${error?.message ?? error}`));
    return entry;
  }

  async function waitForExit(pid, timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (!isAliveImpl(pid)) return true;
      if (now() >= deadline) return false;
      await sleep(stopPollMs);
    }
  }

  /** Best-effort supervisor pid (written by the CLI; token-free). */
  function readSupervisorInfo() {
    try {
      const parsed = JSON.parse(fs.readFileSync(supervisorPidFile, "utf8"));
      if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
      return { pid: parsed.pid, alive: isAliveImpl(parsed.pid) };
    } catch {
      return null;
    }
  }

  function stopOrder(state) {
    const hostsFirst = state.children.filter((child) => child.role === HOST_ROLE).reverse();
    const scheduler = state.children.filter((child) => child.role === SCHEDULER_ROLE);
    const backend = state.children.filter((child) => child.role === BACKEND_ROLE);
    return [...hostsFirst, ...scheduler, ...backend];
  }

  /** Send SIGTERM (or SIGKILL when forced), wait, escalate, and report per child. */
  async function stopEntries(entries, force) {
    const stopped = [];
    for (const child of entries) {
      if (!isAliveImpl(child.pid)) {
        stopped.push({ name: child.name, pid: child.pid, action: "already-exited" });
        continue;
      }
      const signal = force ? "SIGKILL" : "SIGTERM";
      let signalled = false;
      try {
        killImpl(child.pid, signal);
        signalled = true;
      } catch (error) {
        if (error?.code !== "ESRCH") appendLog("launcher", `could not signal ${child.name} (${child.pid}): ${error?.message ?? error}`);
      }
      let exited = await waitForExit(child.pid, force ? 1_000 : stopTimeoutMs);
      let forced = false;
      if (!exited) {
        forced = true;
        try {
          killImpl(child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") appendLog("launcher", `could not force-kill ${child.name} (${child.pid}): ${error?.message ?? error}`);
        }
        exited = await waitForExit(child.pid, 1_000);
      }
      stopped.push({ name: child.name, pid: child.pid, action: signalled ? signal.toLowerCase() : "already-exited", forced, exited });
    }
    removeState(stateFile);
    return stopped;
  }

  async function stop(options = {}) {
    const force = options.force === true;
    const state = options.state ?? readState(stateFile);
    if (!state) {
      // QA6-01: a corrupt/missing launcher.json must not make a live process tree
      // unmanageable. A supervisor still has its children in memory; stop them
      // here so `atk stop` can recover instead of silently reporting success.
      const tracked = [...children.values()].map((entry) => ({ name: entry.name, pid: entry.pid, role: entry.role }));
      if (tracked.length === 0) {
        return { code: 0, stopped: [], message: "not running" };
      }
      const stopped = await stopEntries(stopOrder({ children: tracked }), force);
      return {
        code: 0,
        stopped,
        recovered: true,
        message: "stopped in-memory child processes (launcher.json was corrupt or missing)",
      };
    }
    const stopped = await stopEntries(stopOrder(state), force);
    return { code: 0, stopped, message: `stopped ${stopped.length} recorded child process(es)` };
  }

  async function killSpawnedChildren() {
    for (const entry of [...children.values()].reverse()) {
      if (!isAliveImpl(entry.pid)) continue;
      try {
        killImpl(entry.pid, "SIGKILL");
      } catch {
        // best effort during abort
      }
      await waitForExit(entry.pid, 1_000);
    }
    removeState(stateFile);
  }

  async function inspect() {
    const state = readState(stateFile);
    const statePresent = fs.existsSync(stateFile);
    const supervisor = readSupervisorInfo();
    if (!state) {
      return { running: false, state: null, health: null, aliveChildren: [], statePresent, corrupt: statePresent, supervisor };
    }
    const aliveChildren = state.children.filter((child) => isAliveImpl(child.pid));
    let health = null;
    try {
      health = await checkHealth({ baseUrl: loopbackUrl(state.port), fetchImpl, timeoutMs: 1_500, now });
    } catch (error) {
      health = { ok: false, error: String(error?.message ?? error) };
    }
    return {
      running: aliveChildren.length > 0 && health?.ok === true,
      state,
      health,
      aliveChildren,
      statePresent: true,
      corrupt: false,
      supervisor,
    };
  }

  async function start() {
    const existing = await inspect();
    if (existing.running) {
      const pids = existing.aliveChildren.map((child) => `${child.name}=${child.pid}`).join(", ");
      throw new LauncherError(
        `an Agent Team Kit instance is already running on port ${existing.state.port} (${pids}); ` +
          `run \`atk status --json\` or \`atk stop\` first`,
        { code: 2, details: { port: existing.state.port, children: existing.state.children } },
      );
    }
    if (!existing.state && existing.statePresent) {
      // QA6-01: fail closed. Without a readable state file we cannot enumerate
      // the old children, so blindly starting could double-run the port while the
      // previous tree is still alive.
      throw new LauncherError(
        `launcher.json at ${stateFile} is corrupt or unreadable; refusing to start because the running child tree cannot be verified. ` +
          `Run \`atk stop\` (a live supervisor can recover its children), or remove the file after ensuring no Agent Team Kit processes are running.`,
        { code: 1, details: { stateFile, supervisor: existing.supervisor } },
      );
    }
    if (existing.state) {
      // Stale state: PIDs are dead or the backend is not answering. Clean up the
      // remaining children (if any are alive but unhealthy) and remove the file
      // before starting fresh — never kill a healthy instance and call it "start".
      await stop({ state: existing.state });
      const survivors = existing.state.children.filter((child) => isAliveImpl(child.pid));
      if (survivors.length > 0) {
        throw new LauncherError(
          `could not stop the stale instance (still alive: ${survivors.map((child) => `${child.name}=${child.pid}`).join(", ")}); refusing to start a second tree`,
          { code: 1 },
        );
      }
    }

    ensureDirs();
    const args = [path.join(repoRoot, "apps", "backend", "cli.mjs"), "serve", "--port", String(port), "--data", dataFile];
    if (webDist && fs.existsSync(path.join(webDist, "index.html"))) args.push("--web-dist", webDist);

    try {
      spawnChild(BACKEND_ROLE, BACKEND_ROLE, args);
      const tokens = await waitForTokens();
      await waitForHealth({
        baseUrl,
        timeoutMs: healthTimeoutMs,
        intervalMs: healthIntervalMs,
        fetchImpl,
        now,
        sleep,
      });

      spawnChild(SCHEDULER_ROLE, SCHEDULER_ROLE, [path.join(repoRoot, "apps", "scheduler", "cli.mjs")], {
        ATK_BACKEND_URL: baseUrl,
        ATK_INTERNAL_TOKEN: tokens.scheduler,
        SCHEDULER_OWNER: "launcher-scheduler",
      });

      for (let index = 1; index <= hosts; index += 1) {
        const name = `host-${index}`;
        const hostAgents = process.env.ATK_HOST_AGENTS
          ?? JSON.stringify([{ agentId: `${name}-agent`, role: "DEV", function: "WORKER" }]);
        const hostCapacity = process.env.ATK_HOST_CAPACITY ?? "1";
        spawnChild(name, HOST_ROLE, [path.join(repoRoot, "apps", "runtime-host", "cli.mjs"), "--owner", name], {
          ATK_BACKEND_URL: baseUrl,
          ATK_INTERNAL_TOKEN: tokens.runtimeHost,
          ATK_HOST_AGENTS: hostAgents,
          ATK_HOST_CAPACITY: hostCapacity,
          AGENT_RUNTIME: runtime,
          ATK_HOST_OWNER: name,
          // ADR-010 decision 7: the Host records its in-flight runs here, so a
          // replacement Host can reconcile them with recover() after a crash.
          ATK_HOST_STATE_FILE: path.join(runtimeDir, `host-${index}.json`),
        });
      }

      if (settleMs > 0) await sleep(settleMs);
      const dead = [...children.values()].find((entry) => entry.exited || (typeof entry.child?.exitCode === "number" && entry.child.exitCode !== null));
      if (dead) {
        const tail = logTail(dead.name);
        throw new LauncherError(
          `${dead.name} exited during startup (code ${dead.exitCode ?? dead.child?.exitCode ?? "null"}). Last log:\n${tail}`,
          { code: 1 },
        );
      }

      const state = {
        version: 1,
        port,
        startedAt: isoNow(),
        children: [...children.values()].map((entry) => ({ name: entry.name, pid: entry.pid, role: entry.role })),
      };
      writeState(stateFile, state);
      return { port, state, dataDir, logsDir };
    } catch (error) {
      await killSpawnedChildren();
      if (error instanceof LauncherError) throw error;
      throw new LauncherError(`start failed: ${error?.message ?? error}`, { code: 1 });
    }
  }

  function status() {
    return (async () => {
      const state = readState(stateFile);
      const statePresent = fs.existsSync(stateFile);
      const supervisor = readSupervisorInfo();
      if (!state) {
        // QA6-01/QA6-02: a corrupt state file is not "not running". Report it as a
        // degraded/unmanaged state and exit non-zero; never claim success.
        const managed = statePresent || Boolean(supervisor?.alive);
        return {
          code: managed ? 1 : 0,
          running: false,
          statePresent,
          supervisor: supervisor ? { pid: supervisor.pid, alive: supervisor.alive } : null,
          version: null,
          port: null,
          startedAt: null,
          health: {
            ok: false,
            error: statePresent
              ? "launcher.json is corrupt or unreadable; child processes may still be running"
              : supervisor?.alive
                ? "a supervisor is running but launcher.json is missing"
                : "not running",
          },
          children: [],
        };
      }
      const childrenStatus = state.children.map((child) => ({
        name: child.name,
        role: child.role,
        pid: child.pid,
        alive: isAliveImpl(child.pid),
      }));
      const health = await checkHealth({ baseUrl: loopbackUrl(state.port), fetchImpl, timeoutMs: 3_000, now });
      const allAlive = childrenStatus.length > 0 && childrenStatus.every((child) => child.alive);
      // QA6-02: `running` means the system is actually usable: every child alive
      // AND the backend healthy. A dead backend must not look "running: true".
      const running = allAlive && health.ok === true;
      return {
        code: running ? 0 : 1,
        running,
        statePresent: true,
        supervisor: supervisor ? { pid: supervisor.pid, alive: supervisor.alive } : null,
        version: state.version,
        port: state.port,
        startedAt: state.startedAt,
        health,
        children: childrenStatus,
      };
    })();
  }

  return {
    dataDir,
    port,
    hosts,
    runtime,
    stateFile,
    dataFile,
    runtimeDir,
    logsDir,
    baseUrl,
    repoRoot,
    nodeBin,
    start,
    stop,
    status,
    inspect,
    readState: () => readState(stateFile),
  };
}
