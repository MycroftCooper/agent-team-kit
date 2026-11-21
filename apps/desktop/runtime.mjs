import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../backend/src/server.mjs";
import { runtimePaths } from "../../packages/platform/src/index.mjs";

const parent = process.parentPort;
let backend, started, stopping = false;

function dataDirectory() {
  const config = new URL("../../atk.local.json", import.meta.url);
  if (process.env.ATK_DATA_DIR || !fs.existsSync(config)) return runtimePaths().root;
  const { dataDir } = JSON.parse(fs.readFileSync(config, "utf8"));
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("atk.local.json requires a non-empty dataDir.");
  return path.resolve(fileURLToPath(new URL("../../", import.meta.url)), dataDir);
}

async function main(backendPort) {
  backend = createServer({ dataDir: dataDirectory(), webDist: null });
  const info = await backend.listen({ port: backendPort }).catch((error) => {
    backend = undefined; // listen() already closes its database and instance lock.
    throw error;
  });
  parent.postMessage({ type: "ready", ...info });
}

function exitAfter(result) {
  void result.then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
}

parent.on("message", ({ data }) => {
  if (data.type === "start" && !started) {
    started = main(data.port);
    void started.catch(async (error) => {
      const busy = error.code === "EADDRINUSE" || error.code === "INSTANCE_ACTIVE";
      parent.postMessage({ type: "error", error: error.message + (busy ? "\nStop the other ATK service, or choose a free port and a separate ATK_DATA_DIR." : "") });
      await backend?.close().catch(console.error);
      process.exit(1);
    });
  } else if (data.type === "reload" && backend && !stopping) {
    const shutdown = backend.closeWhenIdle();
    if (!shutdown) return parent.postMessage({ type: "busy" });
    stopping = true;
    parent.postMessage({ type: "reloading" });
    exitAfter(shutdown);
  } else if (data.type === "stop" && !stopping) {
    stopping = true;
    exitAfter(Promise.resolve(started).catch(() => {}).then(() => backend?.close()));
  }
});
