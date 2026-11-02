// Child process used by restart-recovery.test.mjs. It is a real Host that claims
// a worktree Run, starts a hanging MockRuntime session and then stays alive until
// the parent kills it. The parent inspects the persisted state/outbox and the
// worktree afterwards.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMockRuntime } from "@atk/runtime-sdk/mock";
import { createTaskExecutionSpec } from "../../../../packages/contracts/src/execution-spec.mjs";
import { createHost } from "../../src/host.mjs";

const [dir, repoPath, baseCommit, worktreePath] = process.argv.slice(2);
if (!dir || !repoPath || !baseCommit || !worktreePath) {
  throw new Error("restart-worker: expected dir repoPath baseCommit worktreePath");
}

const spec = createTaskExecutionSpec({
  task: {
    id: "TASK-RESTART",
    version: 4,
    title: "Restart me",
    description: "A worktree Run that must survive a host crash.",
    acceptance: "green",
    files: ["src/restart.js"],
    deps: [],
    functionRequired: "DEV",
    roleRequired: "DEVELOPER",
  },
  project: { id: "proj-restart", name: "Restart", repoPath, defaultBranch: "main" },
  workspace: { kind: "worktree", path: worktreePath, baseCommit, targetBranch: "atk/run/run-restart" },
  frozenAt: "2026-01-01T00:00:00.000Z",
});

const lease = {
  ownerId: "host-crashed",
  generation: 9,
  // Deliberately already expired: the new Host must not silently resume it.
  claimedUntil: new Date(Date.now() - 1000).toISOString(),
};
const claim = {
  command: { id: "CMD-RESTART", runId: "run-restart", commandType: "RUN_TASK", attempts: 1, payload: { spec } },
  run: { id: "run-restart", taskId: "TASK-RESTART", status: "STARTING", workspace: { kind: "worktree", path: worktreePath, baseCommit, targetBranch: "atk/run/run-restart" } },
  lease,
};

let starts = 0;
const base = createMockRuntime({ scenario: "hang", sessionIdFactory: () => "session-crashed" });
const runtime = {
  ...base,
  start: async (input) => {
    starts += 1;
    writeFileSync(path.join(dir, "child-starts.txt"), String(starts), "utf8");
    writeFileSync(path.join(input.cwd, "uncommitted.txt"), "survives the crash\n", "utf8");
    return base.start(input);
  },
  stop: base.stop.bind(base),
  subscribe: base.subscribe.bind(base),
  probe: base.probe.bind(base),
  capabilities: base.capabilities.bind(base),
};

const client = {
  claim: async () => claim,
  events: async (runId, body) => ({ appended: body.events, skipped: 0 }),
  renew: async (runId, body) => ({ lease: { ...body, generation: body.generation + 1 } }),
  heartbeat: async () => ({ ok: true }),
  result: async () => ({ persisted: true }),
  reconcile: async (runId) => ({ run: { id: runId, status: "RUNNING" }, lease, command: { status: "CLAIMED" } }),
};

const host = createHost({
  client,
  runtime,
  ownerId: lease.ownerId,
  leaseMs: 30000,
  pollMs: 10000,
  flushMs: 10000,
  heartbeatMs: 10000,
  stateFile: path.join(dir, "host.json"),
  outboxFile: path.join(dir, "host.outbox.json"),
  logger: { info() {}, warn() {}, error() {} },
});
await host.tick();
// Keep the process alive so the parent has time to inspect and kill it (the
// host's own timers are unref'd in library mode).
setInterval(() => {}, 1000);
