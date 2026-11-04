#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "./src/server.mjs";
import {
  runtimePaths,
  argumentsOf,
} from "../../packages/platform/src/index.mjs";
import { VERSION } from "../../packages/contracts/src/index.mjs";
import { atomicJson } from "../../packages/project-files/src/index.mjs";
export async function serve(args = {}) {
  const dataDir = path.resolve(args.data ?? runtimePaths().root),
    port = Number(args.port ?? 1421);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  const app = createServer({
    dataDir,
    webDist: args["web-dist"] ? path.resolve(args["web-dist"]) : undefined,
  });
  const info = await app.listen({ port });
  fs.mkdirSync(path.join(dataDir, "runtime"), { recursive: true });
  atomicJson(path.join(dataDir, "runtime", "service.json"), {
    version: VERSION,
    pid: process.pid,
    url: info.url,
    instanceId: app.instanceId,
    startedAt: new Date().toISOString(),
  });
  console.log(`Agent Team Kit ${VERSION} ${info.url}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  app.onShutdown = close;
  return app;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = argumentsOf(process.argv.slice(2));
  if (args.help || args._[0] === "help")
    console.log(
      "atk-backend serve [--port 1421] [--data <new data directory>] [--web-dist <directory>]",
    );
  else if (args._[0] === undefined || args._[0] === "serve")
    serve(args).catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
  else {
    console.error("Unknown command");
    process.exitCode = 2;
  }
}
