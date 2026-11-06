#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createAgentClient } from "../../packages/agent-client/src/index.mjs";
import {
  runtimePaths,
  argumentsOf,
} from "../../packages/platform/src/index.mjs";
const args = argumentsOf(process.argv.slice(2)),
  [command, runId, action] = args._;
async function main() {
  if (!command || command === "help" || args.help) {
    console.log(
      "atk-agent doctor\natk-agent connect\natk-agent claim [--project <id>] [--task <id>] [--wait 30000]\natk-agent watch <runId> --generation <n>\natk-agent heartbeat <runId> --generation <n>\natk-agent events <runId> --file <JSON> --generation <n>\natk-agent submit <runId> plan|result|review --file <JSON>\natk-agent stopped <runId> --generation <n>\natk-agent get <runId>\natk-agent replay\nEnvironment: ATK_URL, ATK_AGENT_TOKEN; no model credentials.",
    );
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
  if (command === "doctor") result = await client.doctor();
  else if (command === "connect") result = await client.connect();
  else if (command === "claim")
    result = await client.claim({
      projectId: args.project,
      taskId: args.task,
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
