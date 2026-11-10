import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../backend/src/server.mjs";
import { startDevWeb } from "../web/dev-server.mjs";
import { runtimePaths } from "../../packages/platform/src/index.mjs";

const parent = process.parentPort;
let backend, web, stopping = false;

function dataDirectory() {
  const config = new URL("../../atk.local.json", import.meta.url);
  if (process.env.ATK_DATA_DIR || !fs.existsSync(config)) return runtimePaths().root;
  const { dataDir } = JSON.parse(fs.readFileSync(config, "utf8"));
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("atk.local.json requires a non-empty dataDir.");
  return path.resolve(fileURLToPath(new URL("../../", import.meta.url)), dataDir);
}

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Invalid ${name}.`);
  return value;
}

async function stop() {
  if (stopping) return;
  stopping = true;
  // Closing the backend first releases open SSE streams proxied through Vite.
  try {
    await backend?.close();
  } finally {
    await web?.close();
  }
}

async function main() {
  const backendPort = port("ATK_PORT", 1421);
  const webPort = port("ATK_DEV_PORT", 5173);
  if (!webPort) throw new Error("ATK_DEV_PORT must be a non-zero port.");
  backend = createServer({ dataDir: dataDirectory(), webDist: null });
  const info = await backend.listen({ port: backendPort }).catch((error) => {
    backend = undefined; // listen() already closes its database and instance lock.
    throw error;
  });
  web = await startDevWeb({ backendUrl: info.url, port: webPort });
  const address = web.httpServer.address();
  const url = new URL(`http://127.0.0.1:${address.port}`);
  url.hash = new URL(info.browserUrl).hash;
  parent.postMessage({ type: "ready", url: url.href });
  console.log(`ATK desktop ready. Agent API: ${info.url}`);
}

const started = main();
parent.on("message", ({ data }) => {
  if (data.type === "stop") void started.catch(() => {}).then(stop).then(
    () => process.exit(0),
    (error) => { console.error(error); process.exit(1); },
  );
});
started.catch(async (error) => {
  const busy = error.code === "EADDRINUSE" || error.code === "INSTANCE_ACTIVE";
  parent.postMessage({
    type: "error",
    error: error.message + (busy ? "\nStop the other ATK service, or choose a free port and a separate ATK_DATA_DIR." : ""),
  });
  await stop().catch(console.error);
  process.exit(1);
});
