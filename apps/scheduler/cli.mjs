#!/usr/bin/env node
// CLI for the Scheduler. Configuration comes from the environment (the launcher
// hands it the internal token, ADR-010).
//
//   ATK_BACKEND_URL              default http://127.0.0.1:1421
//   ATK_INTERNAL_TOKEN           required
//   SCHEDULER_OWNER              default scheduler-<pid>
//   SCHEDULER_POLL_MS            default 1000
//   MAX_CONCURRENT_PER_PROJECT   default 4
//   MAX_PER_AGENT                default 1
//   ATK_REPO_PATH                project repository for workspace policy (default cwd)
//   ATK_WORKTREE_ROOT            worktree root (default %LOCALAPPDATA%/AgentTeamKit/worktrees)
//   ATK_WORKSPACE_MODE           auto | worktree | none (default auto)
import process from "node:process";
import { planDispatch } from "@atk/scheduler-core";
import { createSchedulerClient } from "./src/client.mjs";
import { createScheduler } from "./src/index.mjs";
import { deriveWorkspacePolicy, summarizeWorkspacePolicy } from "./src/workspace-policy.mjs";

const USAGE = [
  "Usage: atk-scheduler [--once] [--owner <id>]",
  "",
  "Environment:",
  "  ATK_BACKEND_URL              backend base URL (default http://127.0.0.1:1421)",
  "  ATK_INTERNAL_TOKEN           internal credential from `atk-backend serve` (required)",
  "  SCHEDULER_OWNER              scheduler id (default scheduler-<pid>)",
  "  SCHEDULER_POLL_MS            poll interval (default 1000)",
  "  MAX_CONCURRENT_PER_PROJECT   concurrent runs per project (default 4)",
  "  MAX_PER_AGENT                concurrent runs per agent (default 1)",
  "  ATK_REPO_PATH                project repository for workspace policy (default: cwd)",
  "  ATK_WORKTREE_ROOT            root for Run worktrees (default: %LOCALAPPDATA%/AgentTeamKit/worktrees)",
  "  ATK_WORKSPACE_MODE           auto (git -> worktree, else none) | worktree | none (default auto)",
  "",
  "Exit codes: 0 ok, 2 usage/config error.",
].join("\n");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--once") args.once = true;
    else if (argv[index] === "--owner") args.owner = argv[++index];
    else if (argv[index] === "--help" || argv[index] === "-h") args.help = true;
    else args._.push(argv[index]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const baseUrl = process.env.ATK_BACKEND_URL ?? "http://127.0.0.1:1421";
const token = process.env.ATK_INTERNAL_TOKEN ?? "";
if (!token) {
  process.stderr.write("atk-scheduler: ATK_INTERNAL_TOKEN is required (the backend prints it once on `serve`)\n");
  process.exit(2);
}

const ownerId = args.owner ?? process.env.SCHEDULER_OWNER ?? `scheduler-${process.pid}`;
// m6.3: derive the workspace policy once at startup. A real git repository gets
// worktrees with a pinned HEAD; everything else degrades to `none` so a
// mock/demo setup is never refused by the backend for an incomplete policy.
let workspace;
try {
  workspace = deriveWorkspacePolicy({
    repoPath: process.env.ATK_REPO_PATH,
    worktreeRoot: process.env.ATK_WORKTREE_ROOT,
    mode: process.env.ATK_WORKSPACE_MODE,
  });
} catch (error) {
  process.stderr.write(`atk-scheduler: ${error.message}\n`);
  process.exit(2);
}
const policies = {
  maxConcurrentPerProject: Number(process.env.MAX_CONCURRENT_PER_PROJECT ?? 4),
  maxPerAgent: Number(process.env.MAX_PER_AGENT ?? 1),
  workspacePolicy: workspace.policy,
};

const logger = console;
const client = createSchedulerClient({ baseUrl, token });
const scheduler = createScheduler({
  client,
  core: { planDispatch },
  policies,
  ownerId,
  pollMs: Number(process.env.SCHEDULER_POLL_MS ?? 1000),
  logger,
});

if (args.once) {
  const result = await scheduler.runOnce();
  process.stdout.write(
    `${JSON.stringify({
      result,
      stats: scheduler.stats,
      workspace: {
        kind: workspace.policy.kind,
        root: workspace.policy.root ?? null,
        baseCommit: workspace.policy.baseCommit ?? null,
        reason: workspace.reason,
        repoPath: workspace.repoPath,
      },
    })}\n`,
  );
  await scheduler.stop();
} else {
  scheduler.start({ keepAlive: true });
  process.stdout.write(
    `[scheduler] ${ownerId} attached to ${baseUrl} (policies ${JSON.stringify({
      maxConcurrentPerProject: policies.maxConcurrentPerProject,
      maxPerAgent: policies.maxPerAgent,
    })}; workspace=${summarizeWorkspacePolicy(workspace)})\n`,
  );
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    process.stdout.write(`[scheduler] received ${signal}; stopping\n`);
    await scheduler.stop();
    process.exit(0);
  });
}
