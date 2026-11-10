#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createAgentClient } from "../../packages/agent-client/src/index.mjs";
import { ATK_AGENT_HELP } from "../../packages/platform/src/cli-help.mjs";
import {
  runtimePaths,
  argumentsOf,
} from "../../packages/platform/src/index.mjs";
const argv = process.argv.slice(2),
  separator = argv.indexOf("--"),
  args = argumentsOf(separator === -1 ? argv : argv.slice(0, separator)),
  toolArgs = separator === -1 ? [] : argv.slice(separator + 1),
  [command, runId, action] = args._;

async function invokeResource(command, arguments_, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "ATK_AGENT_TOKEN"));
  const child = spawn(command === "node" ? process.execPath : command, arguments_, { cwd, env, stdio: "inherit", shell: false });
  const forward = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, forward);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, forward);
  }
}

async function main() {
  if (!command || command === "help" || args.help) {
    console.log(ATK_AGENT_HELP);
    return;
  }
  const client = createAgentClient({
    baseUrl: args.url ?? process.env.ATK_URL,
    credential: process.env.ATK_AGENT_TOKEN,
    stateDir:
      args["state-dir"] ??
      path.join(
        runtimePaths().root,
        "clients",
        crypto
          .createHash("sha256")
          .update(process.env.ATK_AGENT_TOKEN ?? "")
          .digest("hex")
          .slice(0, 12),
      ),
  });
  let result;
  if (command === "resources") {
    if (runId === "list" && !action) {
      result = await client.request(`/resources${args.kind ? `?kind=${encodeURIComponent(args.kind)}` : ""}`);
    } else {
      const [kind, name, extra] = (action ?? "").split("/");
      if (!kind || !name || extra !== undefined || args._.length !== 3 ||
        !(runId === "show" || (runId === "run" && kind === "cli") || (runId === "serve-mcp" && kind === "mcp")))
        throw new Error("Use resources show <kind/name>, resources run cli/<name> or resources serve-mcp mcp/<name>");
      const resource = await client.request(`/resources/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
      if (runId === "run") {
        if (resource.builtIn) throw new Error(`Run ${resource.name} directly; use ${resource.command} for usage.`);
        return invokeResource(process.execPath, [resource.path, ...toolArgs]);
      }
      if (runId === "serve-mcp") {
        if (resource.config.transport !== "stdio") throw new Error("Configure the MCP client with the HTTP URL from resources show");
        return invokeResource(resource.config.command, resource.config.args, path.dirname(resource.path));
      }
      result = resource;
    }
  } else if (command === "doctor") result = await client.doctor();
  else if (command === "connect") result = await client.connect();
  else if (command === "claim")
    result = await client.claim({
      projectId: args.project,
      taskId: args.task,
      kind: args.kind === undefined ? undefined : String(args.kind).toUpperCase(),
      waitMs: Number(args.wait ?? 30000),
    });
  else if (command === "get")
    result = await client.request(`/runs/${encodeURIComponent(runId)}`);
  else if (command === "heartbeat")
    result = await client.heartbeat(runId, Number(args.generation));
  else if (command === "events") {
    const events = JSON.parse(fs.readFileSync(args.file, "utf8"));
    result = await client.events(runId, Number(args.generation), events);
  } else if (command === "submit") {
    if (!["plan", "result", "review"].includes(action))
      throw new Error("submit requires plan|result|review");
    result = await client.submit(
      runId,
      action,
      JSON.parse(fs.readFileSync(args.file, "utf8")),
    );
  } else if (command === "stopped")
    result = await client.request(
      `/runs/${encodeURIComponent(runId)}/stopped`,
      { generation: Number(args.generation), stopped: true },
    );
  else if (command === "replay") result = await client.replay();
  else if (command === "watch") {
    client.watch(runId, Number(args.generation), {
      onStop: (r) => {
        console.error("STOP REQUIRED", r.status);
        process.exitCode = 3;
      },
      onError: (e) => {
        console.error("STOP REQUIRED", e.message);
        process.exitCode = 3;
      },
    });
    console.log(
      "Lease watcher started. Stop file writes if this process exits with code 3.",
    );
    return;
  } else throw new Error("Unknown command");
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      error: {
        code: e.code ?? "CLIENT_ERROR",
        message: e.message,
        details: e.details,
      },
    }),
  );
  process.exitCode = 1;
});
