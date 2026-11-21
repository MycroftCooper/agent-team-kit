import { utilityProcess } from "electron";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Invalid ${name}.`);
  return value;
}

export function startProdRuntime({ onReady, onError, onUpdateReady }) {
  const backendPort = port("ATK_PORT", 1421);
  const webDist = fileURLToPath(new URL("../web/dist", import.meta.url));
  if (!fs.existsSync(webDist)) {
    throw new Error(`Packaged web UI not found at ${webDist}`);
  }

  let closing, started = false;
  const child = utilityProcess.fork(fileURLToPath(new URL("./runtime.mjs", import.meta.url)), [], {
    serviceName: "ATK Backend",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  const exited = new Promise((resolve) => child.once("exit", resolve));

  child.on("message", (message) => {
    if (closing) return;
    if (message.type === "error") {
      onError(message.error);
    } else if (message.type === "ready") {
      started = true;
      onReady(message.browserUrl);
      console.log(`ATK desktop ready. Agent API: ${message.url}`);
    } else if (message.type === "update-ready") {
      onUpdateReady?.({
        installerPath: message.installerPath,
        version: message.version,
        sha256: message.sha256,
      });
    }
  });

  void exited.then((code) => {
    if (!closing && !started) {
      onError(`ATK backend exited unexpectedly (${code}).`);
    }
  });

  child.postMessage({ type: "start", port: backendPort, webDist, installMode: "desktop" });

  return {
    close() {
      closing ??= Promise.resolve().then(async () => {
        child.postMessage({ type: "stop" });
        const timeout = setTimeout(() => child.kill(), 6000);
        timeout.unref();
        try { await exited; } finally { clearTimeout(timeout); }
      });
      return closing;
    },
  };
}
