// M6.3 stage A / P0-1: prove the real `atk start` chain never records a Host
// heartbeat, so the Scheduler's F10 gate can never dispatch a READY task.
//
// This test intentionally drives the actual launcher (backend + Scheduler + Host
// child processes), not a hand-injected heartbeat or an in-process fake.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LAUNCHER_CLI = path.join(ROOT, "apps", "launcher", "cli.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function databaseModule() {
  return import(pathToFileURL(path.join(ROOT, "packages", "database", "src", "index.mjs")).href);
}

async function seedData(dataDir) {
  const { openStore } = await databaseModule();
  const dbFile = path.join(dataDir, "data", "atk.db");
  const store = openStore({ file: dbFile, migrate: true });
  try {
    const project = store.createProject({ id: "M63-P", name: "m63", repoPath: ROOT, defaultBranch: "main" });
    const task = store.createTask({
      id: "M63-T",
      projectId: project.id,
      title: "Heartbeat dispatch task",
      description: "A READY task that can only dispatch after a real Host heartbeat.",
      functionRequired: "WORKER",
      roleRequired: "DEV",
      priority: 2,
      deps: [],
      files: [],
      acceptance: "green",
    });
    store.upsertAgent({ id: "agent-dev-01", role: "DEV", capabilities: ["WORKER"], status: "IDLE" });
    return { project, task };
  } finally {
    store.close();
  }
}

async function snapshot(dataDir) {
  const { openStore } = await databaseModule();
  const dbFile = path.join(dataDir, "data", "atk.db");
  const store = openStore({ file: dbFile, migrate: false });
  try {
    const agent = (store.listAgents ? store.listAgents() : []).find((candidate) => candidate.id === "agent-dev-01");
    const task = store.getTask("M63-T");
    const runs = store.listRuns({});
    const availability = store.agentAvailability({ agentId: "agent-dev-01" });
    return {
      agent,
      availability,
      taskStatus: task?.status ?? null,
      runs: runs.length,
      runStatuses: runs.map((run) => run.status),
    };
  } finally {
    store.close();
  }
}

function stopLauncher(dataDir) {
  try {
    spawnSync(process.execPath, [LAUNCHER_CLI, "stop", "--data", dataDir, "--force"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
  } catch {
    /* best effort */
  }
  const stateFile = path.join(dataDir, "launcher.json");
  if (!existsSync(stateFile)) return;
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    for (const child of state.children ?? []) {
      if (Number.isInteger(child.pid)) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
      }
    }
  } catch {
    /* best effort */
  }
}

test("P0-1: real atk start -> Host heartbeat must persist and let the Scheduler dispatch", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "atk-m63-p01-"));
  const port = await pickPort();
  try {
    await seedData(dataDir);
    const started = spawnSync(process.execPath, [LAUNCHER_CLI, "start", "--data", dataDir, "--port", String(port), "--hosts", "1"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 90000,
      // The Host needs the agent identities it is allowed to heartbeat for. The
      // launcher currently inherits env; WP1 may later pass this explicitly.
      env: {
        ...process.env,
        ATK_HOST_ID: "host-1",
        ATK_HOST_AGENTS: JSON.stringify([{ agentId: "agent-dev-01", role: "DEV", function: "WORKER" }]),
        ATK_ALLOW_NONE_WORKSPACE: "1",
      },
    });
    assert.equal(started.status, 0, `atk start failed (exit ${started.status}):\n${started.stdout}\n${started.stderr}`);

    // The Host heartbeats every 10s; give the Scheduler at least two polls after
    // the first heartbeat. No manual heartbeat injection anywhere in this test.
    let current = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      current = await snapshot(dataDir);
      if (current.runs > 0) break;
      await sleep(500);
    }
    assert.ok(current, "the launcher must expose a database snapshot");
    assert.deepEqual(
      { available: current.availability.available, reason: current.availability.reason },
      { available: true, reason: "ok" },
      `Host heartbeat did not reach agentAvailability; task=${current.taskStatus}, runs=${current.runs}, agent.lastHeartbeatAt=${current.agent.lastHeartbeatAt ?? "null"}`,
    );
    assert.ok(current.runs >= 1, `Scheduler did not dispatch after the Host heartbeat; task=${current.taskStatus}, runs=${current.runs}`);
    assert.notEqual(current.taskStatus, "READY", "the heartbeat gate must let the READY task be claimed");
  } finally {
    stopLauncher(dataDir);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        break;
      } catch {
        /* backend/supervisor may still be closing */
      }
    }
  }
});
