// Shared fakes for the launcher tests: a spawn-compatible factory returning real
// EventEmitters (so stdout/stderr/exit behave like child_process) and a fake clock
// whose sleep() advances time, keeping the state machine tests instant.
import { EventEmitter } from "node:events";

export const FAKE_TOKEN = "fake-internal-token-9f3c2b7a1d4e";

export function createFakeChild({ pid, name }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.name = name;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
  };
  child.emitExit = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  return child;
}

export function createClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
    sleep: async (ms) => {
      value += ms;
    },
  };
}

export function createAliveMap() {
  const alive = new Set();
  const kills = [];
  return {
    alive,
    kills,
    isAlive: (pid) => alive.has(pid),
    kill: (pid, signal) => {
      kills.push({ pid, signal });
      if (signal === "SIGKILL") alive.delete(pid);
    },
  };
}

/**
 * A spawn impl that records every call and emits a backend token line (unless
 * `token: null`). `behavior` may tweak individual children by name.
 */
export function createFakeSpawn({ token = FAKE_TOKEN, pidStart = 4_000 } = {}) {
  const calls = [];
  const children = new Map();
  let nextPid = pidStart;
  const spawnImpl = (command, args, options) => {
    const script = String(args?.[0] ?? "");
    const name = script.includes("backend")
      ? "backend"
      : script.includes("scheduler")
        ? "scheduler"
        : `host-${calls.filter((call) => call.name.startsWith("host-")).length + 1}`;
    const child = createFakeChild({ pid: nextPid, name });
    nextPid += 1;
    calls.push({ name, command, args, options, child });
    children.set(name, child);
    if (name === "backend" && token !== null) {
      queueMicrotask(() => {
        child.stdout.emit("data", "atk backend listening on http://127.0.0.1:1421\n");
        child.stdout.emit("data", `internal token: ${token}\n`);
        // This banner names the credential channel and must be filtered too.
        child.stdout.emit("data", "internal API: /internal/v1/* requires x-atk-internal (browser token is not accepted there)\n");
        child.stdout.emit("data", "press Ctrl+C to stop\n");
      });
    }
    return child;
  };
  return { spawnImpl, calls, children };
}

export function createHealthyFetch({ ok = true, status = 200, body = { ok: true, db: { schemaVersion: 4 } } } = {}) {
  const calls = [];
  const state = { ok, status, body };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: state.ok,
      status: state.status,
      async json() {
        return state.body;
      },
    };
  };
  fetchImpl.calls = calls;
  fetchImpl.state = state;
  return fetchImpl;
}

/** Health fake whose successive probes answer `results` (then repeat the last). */
export function createSequenceFetch(results = [false, true]) {
  let index = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const ok = results[Math.min(index, results.length - 1)];
    index += 1;
    return {
      ok,
      status: ok ? 200 : 503,
      async json() {
        return { ok };
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
