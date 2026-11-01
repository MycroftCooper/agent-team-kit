#!/usr/bin/env node
// CLI for the Runtime Host.
//
// Configuration comes from the environment because the backend launches this
// process and hands it the internal token (ADR-010):
//   ATK_BACKEND_URL      default http://127.0.0.1:1421
//   ATK_INTERNAL_TOKEN   required (printed once by `atk-backend serve`)
//   ATK_HOST_OWNER       default host-<pid>
//   AGENT_RUNTIME        mock | dsh (default mock)
import process from "node:process";
import path from "node:path";
import { createMockRuntime } from "@atk/runtime-sdk/mock";
import { createDshRuntimeStub } from "@atk/runtime-sdk/dsh";
import { createInternalClient } from "./client.mjs";
import { createHost } from "./host.mjs";

const USAGE = [
  "Usage: atk-runtime-host [--once] [--owner <id>]",
  "",
  "Environment:",
  "  ATK_BACKEND_URL      backend base URL (default http://127.0.0.1:1421)",
  "  ATK_INTERNAL_TOKEN   internal credential from `atk-backend serve` (required)",
  "  ATK_HOST_OWNER       lease owner id (default host-<pid>)",
  "  AGENT_RUNTIME        mock (default) | dsh (experimental, capabilities all false)",
  "",
  "Exit codes: 0 ok, 2 usage/config error.",
].join("\n");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--once") args.once = true;
    else if (token === "--owner") args.owner = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else args._.push(token);
  }
  return args;
}

function buildRuntime(kind, logger) {
  if (kind === "dsh") {
    logger.warn?.("[host] AGENT_RUNTIME=dsh is experimental: capabilities are all false until RT-P07/P08 are verified");
    return createDshRuntimeStub();
  }
  return createMockRuntime({ scenario: "complete" });
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const baseUrl = process.env.ATK_BACKEND_URL ?? "http://127.0.0.1:1421";
const token = process.env.ATK_INTERNAL_TOKEN ?? "";
const ownerId = args.owner ?? process.env.ATK_HOST_OWNER ?? `host-${process.pid}`;
const runtimeKind = (process.env.AGENT_RUNTIME ?? "mock").toLowerCase();

if (!token) {
  process.stderr.write("atk-runtime-host: ATK_INTERNAL_TOKEN is required (the backend prints it once on `serve`)\n");
  process.exit(2);
}

const logger = console;
const runtime = buildRuntime(runtimeKind, logger);
const client = createInternalClient({ baseUrl, token });
const stateFile = process.env.ATK_HOST_STATE_FILE ?? path.join(process.env.LOCALAPPDATA ?? process.cwd(), "AgentTeamKit", "runtime", `host-${ownerId}.json`);
const host = createHost({ client, runtime, ownerId, logger, stateFile });

async function main() {
  const health = await runtime.probe();
  if (!health?.ok) {
    // The DSH stub lands here on purpose: we report it, but nothing pretends a
    // real session exists.
    logger.warn?.(`[host] runtime ${runtime.kind} is not usable: ${health?.detail ?? "unknown reason"}`);
  }
  // Reconcile before taking any new work: after a crash this host cannot know
  // whether its previous incarnation started a session (ADR-010 decision 7).
  const recovered = await host.recover();
  if (recovered.total > 0) {
    logger.warn?.(`[host] reconciled ${recovered.total} in-flight run(s) from ${stateFile}`);
  }
  if (args.once) {
    await host.tick();
    process.stdout.write(`${JSON.stringify({ recovered, stats: host.stats })}\n`);
    await host.stop();
    return;
  }
  host.start();
  process.stdout.write(`[host] ${ownerId} attached to ${baseUrl} (runtime ${runtime.kind})\n`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    process.stdout.write(`[host] received ${signal}; stopping\n`);
    await host.stop();
    process.exit(0);
  });
}

await main().catch((error) => {
  process.stderr.write(`atk-runtime-host: ${error?.message ?? error}\n`);
  process.exit(1);
});
