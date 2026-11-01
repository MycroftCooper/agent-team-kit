// Launcher state machine against fake children: ordering, env-only token, no
// double start, stale cleanup, ordered/idempotent stop and DB-free status.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLauncher, LauncherError } from "../src/launcher.mjs";
import { readState, statePathFor, writeState } from "../src/state.mjs";
import { createAliveMap, createClock, createFakeSpawn, createHealthyFetch, createSequenceFetch, FAKE_TOKEN } from "./fake.mjs";

const TEMP_DIRS = [];
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atk-launcher-"));
  TEMP_DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function makeHarness(options = {}) {
  const dataDir = tempDir();
  const clock = createClock();
  const alive = createAliveMap();
  const spawn = createFakeSpawn({ token: options.token === undefined ? FAKE_TOKEN : options.token });
  const fetchImpl = options.fetchImpl ?? createHealthyFetch({ ok: options.healthy !== false });
  const graceful = options.graceful !== false;
  const spawnImpl = (command, args, spawnOptions) => {
    const child = spawn.spawnImpl(command, args, spawnOptions);
    alive.alive.add(child.pid);
    if (options.backendExit !== undefined && child.name === "backend") {
      queueMicrotask(() => child.emitExit(options.backendExit, null));
    }
    return child;
  };
  const killImpl = (pid, signal) => {
    if (graceful) {
      alive.kills.push({ pid, signal });
      alive.alive.delete(pid);
      return;
    }
    alive.kills.push({ pid, signal });
    if (signal === "SIGKILL") alive.alive.delete(pid);
  };
  const launcher = createLauncher({
    dataDir,
    port: 1421,
    hosts: options.hosts ?? 2,
    runtime: "mock",
    spawnImpl,
    fetchImpl,
    logger: { info() {}, warn() {}, error() {} },
    now: clock.now,
    sleep: clock.sleep,
    isAliveImpl: alive.isAlive,
    killImpl,
    settleMs: 0,
    healthTimeoutMs: options.healthTimeoutMs ?? 5_000,
    healthIntervalMs: 100,
    tokenTimeoutMs: options.tokenTimeoutMs ?? 2_000,
    stopTimeoutMs: options.stopTimeoutMs ?? 200,
    stopPollMs: 50,
    repoRoot: "C:\\repo",
    nodeBin: "node",
    webDist: null,
  });
  return { launcher, dataDir, clock, alive, spawn, fetchImpl };
}

test("start spawns backend -> scheduler -> hosts and records the contract state", async () => {
  const { launcher, dataDir, spawn } = makeHarness();
  const result = await launcher.start();
  assert.deepEqual(
    spawn.calls.map((call) => call.name),
    ["backend", "scheduler", "host-1", "host-2"],
    "start order must be backend, scheduler, then hosts",
  );
  const state = readState(statePathFor(dataDir));
  assert.deepEqual(state, result.state);
  assert.deepEqual(state.children.map((child) => [child.name, child.role]), [
    ["backend", "backend"],
    ["scheduler", "scheduler"],
    ["host-1", "host"],
    ["host-2", "host"],
  ]);
  assert.match(state.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.port, 1421);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(FAKE_TOKEN));
});

test("the internal token travels only in Scheduler/Host env (never backend env, never disk)", async () => {
  const { launcher, dataDir, spawn } = makeHarness();
  await launcher.start();
  const byName = new Map(spawn.calls.map((call) => [call.name, call]));
  assert.equal(byName.get("backend").options.env.ATK_INTERNAL_TOKEN, undefined, "backend creates the token; it must not receive one");
  for (const name of ["scheduler", "host-1", "host-2"]) {
    const call = byName.get(name);
    assert.equal(call.options.env.ATK_INTERNAL_TOKEN, FAKE_TOKEN, `${name} must receive the token via env`);
    assert.equal(call.options.env.ATK_BACKEND_URL, "http://127.0.0.1:1421");
  }
  assert.equal(byName.get("host-1").options.env.AGENT_RUNTIME, "mock");
  assert.equal(byName.get("host-1").options.env.ATK_HOST_STATE_FILE, path.join(dataDir, "runtime", "host-1.json"));
  assert.equal(byName.get("host-2").options.env.ATK_HOST_STATE_FILE, path.join(dataDir, "runtime", "host-2.json"));

  const stateText = readFileSync(statePathFor(dataDir), "utf8");
  assert.doesNotMatch(stateText, new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(stateText, /internal token:|x-atk-internal/i);
  const backendLog = readFileSync(path.join(dataDir, "logs", "backend.log"), "utf8");
  assert.doesNotMatch(backendLog, new RegExp(FAKE_TOKEN), "the token must not be written to a log");
  assert.doesNotMatch(backendLog, /internal token:|x-atk-internal/i, "credential-channel lines must be filtered, not copied");
  assert.match(backendLog, /internal credential received \(value held in memory/);
  for (const name of ["scheduler", "host-1", "host-2"]) {
    const file = path.join(dataDir, "logs", `${name}.log`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(FAKE_TOKEN));
  }
  const status = await launcher.status();
  assert.doesNotMatch(JSON.stringify(status), new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(JSON.stringify(status), /internal token:|x-atk-internal/i);
});

test("start refuses a second instance while the recorded PIDs are alive and healthy (exit 2)", async () => {
  const { launcher, spawn } = makeHarness();
  await launcher.start();
  const before = spawn.calls.length;
  await assert.rejects(
    () => launcher.start(),
    (error) => error instanceof LauncherError && error.code === 2 && /already running on port 1421/.test(error.message) && /backend=/.test(error.message),
  );
  assert.equal(spawn.calls.length, before, "a refused double-start must not spawn anything");
});

test("start cleans a stale state file (dead PIDs) before starting", async () => {
  const { launcher, dataDir, alive, spawn } = makeHarness();
  const stale = {
    version: 1,
    port: 1421,
    startedAt: "2026-01-01T00:00:00.000Z",
    children: [
      { name: "backend", pid: 900_001, role: "backend" },
      { name: "scheduler", pid: 900_002, role: "scheduler" },
      { name: "host-1", pid: 900_003, role: "host" },
    ],
  };
  writeState(statePathFor(dataDir), stale);
  await launcher.start();
  const state = readState(statePathFor(dataDir));
  assert.equal(state.children[0].pid, spawn.calls[0].child.pid);
  assert.equal(alive.kills.length, 0, "dead PIDs need no signalling");
});

test("status marks a dead child and returns non-zero; it never leaks the token", async () => {
  const { launcher, alive } = makeHarness();
  const started = await launcher.start();
  alive.alive.delete(started.state.children[0].pid); // kill the backend on paper
  const status = await launcher.status();
  // QA6-02: a dead backend must not keep `running: true`.
  assert.equal(status.running, false);
  assert.equal(status.code, 1);
  assert.equal(status.statePresent, true);
  assert.equal(status.children.find((child) => child.role === "backend").alive, false);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(FAKE_TOKEN));
});

test("stop recovers tracked children when launcher.json is corrupt (QA6-01)", async () => {
  const { launcher, dataDir, alive, spawn } = makeHarness();
  await launcher.start();
  const pidOf = (name) => spawn.calls.find((call) => call.name === name).child.pid;
  writeFileSync(statePathFor(dataDir), "{ this is not valid json");
  const result = await launcher.stop();
  assert.equal(result.code, 0);
  assert.equal(result.recovered, true);
  assert.deepEqual(
    alive.kills.map((kill) => kill.pid),
    [pidOf("host-2"), pidOf("host-1"), pidOf("scheduler"), pidOf("backend")],
    "in-memory children must still stop in hosts -> scheduler -> backend order",
  );
  assert.equal(launcher.readState(), null);
});

test("status refuses to claim 'not running' while a corrupt state file / pidfile points at children", async () => {
  const { launcher, dataDir, alive } = makeHarness();
  writeFileSync(statePathFor(dataDir), '{"version":1,"children":"broken"}');
  const runtimeDir = path.join(dataDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const pidFile = path.join(runtimeDir, "launcher.pid");
  writeFileSync(pidFile, JSON.stringify({ pid: 606_060, startedAt: "2026-01-01T00:00:00.000Z" }));
  alive.alive.add(606_060);
  const status = await launcher.status();
  assert.equal(status.running, false);
  assert.equal(status.code, 1);
  assert.equal(status.statePresent, true);
  assert.equal(status.supervisor?.alive, true);
  assert.match(status.health.error, /corrupt/i);
  assert.ok(existsSync(statePathFor(dataDir)), "status must not delete the corrupt state file");
  assert.ok(existsSync(pidFile), "status must not delete launcher.pid");
});

test("stop is ordered hosts -> scheduler -> backend and idempotent", async () => {
  const { launcher, alive, spawn } = makeHarness();
  await launcher.start();
  const pidOf = (name) => spawn.calls.find((call) => call.name === name).child.pid;
  const first = await launcher.stop();
  assert.equal(first.code, 0);
  assert.deepEqual(
    alive.kills.map((kill) => kill.pid),
    [pidOf("host-2"), pidOf("host-1"), pidOf("scheduler"), pidOf("backend")],
    "hosts must stop first (newest host first), then the scheduler, then the backend",
  );
  assert.deepEqual(
    alive.kills.map((kill) => kill.signal),
    ["SIGTERM", "SIGTERM", "SIGTERM", "SIGTERM"],
  );
  const second = await launcher.stop();
  assert.equal(second.code, 0);
  assert.equal(alive.kills.length, 4, "a second stop must not signal anything again");
});

test("stop escalates to SIGKILL when SIGTERM is ignored (bounded wait, then force)", async () => {
  const { launcher, alive } = makeHarness({ graceful: false, stopTimeoutMs: 100 });
  await launcher.start();
  const result = await launcher.stop();
  assert.equal(result.code, 0);
  assert.equal(alive.kills.length, 8, "each child must get SIGTERM then SIGKILL");
  assert.deepEqual(
    alive.kills.map((kill) => kill.signal),
    ["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"],
  );
  for (const entry of result.stopped) assert.equal(entry.forced, true);
});

test("a backend that exits before printing the token fails start and cleans up", async () => {
  const { launcher, alive, spawn } = makeHarness({ token: null, backendExit: 1 });
  await assert.rejects(() => launcher.start(), /backend exited before printing an internal token/);
  assert.equal(launcher.readState(), null);
  const backendPid = spawn.calls[0].child.pid;
  assert.ok(
    alive.kills.some((kill) => kill.pid === backendPid && kill.signal === "SIGKILL"),
    "a failed start must kill the backend it spawned",
  );
});

test("an unhealthy backend times out start (never a silent success)", async () => {
  const { launcher, alive, spawn } = makeHarness({ healthy: false, healthTimeoutMs: 500 });
  await assert.rejects(() => launcher.start(), /did not become healthy within 500ms/);
  assert.equal(launcher.readState(), null);
  const backendPid = spawn.calls[0].child.pid;
  assert.ok(
    alive.kills.some((kill) => kill.pid === backendPid && kill.signal === "SIGKILL"),
    "a failed start must not leave the backend running",
  );
});

test("start cleans a stale-but-alive instance whose backend is unhealthy before starting fresh", async () => {
  const { launcher, dataDir, alive, spawn } = makeHarness({ fetchImpl: createSequenceFetch([false, true]) });
  const stalePids = [910_001, 910_002, 910_003];
  for (const pid of stalePids) alive.alive.add(pid);
  writeState(statePathFor(dataDir), {
    version: 1,
    port: 1421,
    startedAt: "2026-01-01T00:00:00.000Z",
    children: [
      { name: "backend", pid: stalePids[0], role: "backend" },
      { name: "scheduler", pid: stalePids[1], role: "scheduler" },
      { name: "host-1", pid: stalePids[2], role: "host" },
    ],
  });
  await launcher.start();
  assert.deepEqual(
    alive.kills.map((kill) => kill.pid),
    [stalePids[2], stalePids[1], stalePids[0]],
    "stale children stop in hosts -> scheduler -> backend order",
  );
  const state = launcher.readState();
  assert.equal(state.children[0].pid, spawn.calls[0].child.pid);
});
