import { utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendSources = ["apps/backend/src", "apps/backend/resources", ...[
  "contracts", "database", "domain", "platform", "project-files", "scheduler-core",
].map((name) => `packages/${name}/src`)];

function port(name, fallback, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > 65535) throw new Error(`Invalid ${name}.`);
  return value;
}

function worker(file, label) {
  const child = utilityProcess.fork(fileURLToPath(new URL(file, import.meta.url)), [], {
    serviceName: label,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { child, exited };
}

async function stopWorker(worker) {
  if (!worker) return;
  worker.child.postMessage({ type: "stop" });
  const timeout = setTimeout(() => worker.child.kill(), 6000);
  timeout.unref();
  try { await worker.exited; } finally { clearTimeout(timeout); }
}

export function startDesktopRuntime({ onReady, onError }) {
  let backendPort = port("ATK_PORT", 1421);
  const webPort = port("ATK_DEV_PORT", 5173, 1);
  const watchers = [];
  let backend, web, closing, timer, dirty = false, started = false, deferred = false;

  function schedule(delay = 250) {
    if (closing) return;
    clearTimeout(timer);
    timer = setTimeout(applyChanges, delay);
    timer.unref();
  }

  function applyChanges() {
    if (closing || !dirty) return;
    if (!backend) {
      dirty = false;
      startBackend();
    } else if (backend.ready && !backend.requested) {
      dirty = false;
      backend.requested = true;
      web.child.postMessage({ type: "pause-backend" });
    }
  }

  function watchBackend() {
    const directories = backendSources.map((source) => fileURLToPath(new URL(`../../${source}`, import.meta.url)));
    if (process.env.ATK_DESKTOP_TEST)
      directories.push(path.join(process.env.ATK_DESKTOP_TEST, "backend-reload-probe"));
    for (const directory of directories) {
      try {
        const watcher = fs.watch(directory, { recursive: true, persistent: false }, (_, filename) => {
          if (filename && !/\.(?:mjs|cjs|js|json|md)$/i.test(filename)) return;
          dirty = true;
          schedule();
        });
        watcher.on("error", (error) => console.error(`ATK cannot watch ${directory}: ${error.message}`));
        watchers.push(watcher);
      } catch (error) {
        console.error(`ATK cannot watch ${directory}: ${error.message}`);
      }
    }
  }

  function startWeb(info) {
    const running = web = worker("./web-runtime.mjs", "ATK Development Web");
    running.child.on("message", (message) => {
      if (closing) return;
      if (message.type === "error") return onError(message.error);
      if (message.type === "backend-paused") {
        if (backend?.ready && backend.requested) backend.child.postMessage({ type: "reload" });
        return;
      }
      if (message.type !== "ready") return;
      const url = new URL(`http://127.0.0.1:${message.port}`);
      url.hash = new URL(info.browserUrl).hash;
      started = true;
      watchBackend();
      onReady(url.href);
      console.log(`ATK desktop ready. Agent API: ${info.url}`);
    });
    void running.exited.then((code) => {
      web = null;
      if (!closing) onError(`Development web process exited (${code}). See the dev.bat console.`);
    });
    running.child.postMessage({ type: "start", backendUrl: info.url, port: webPort });
  }

  function startBackend() {
    const running = backend = worker("./runtime.mjs", "ATK Development Backend");
    running.child.on("message", (message) => {
      if (closing) return;
      if (message.type === "error") {
        if (!started) onError(message.error);
        else console.error(`ATK backend reload failed: ${message.error}`);
      } else if (message.type === "ready") {
        running.ready = true;
        backendPort = message.port; // Preserve the actual port when ATK_PORT=0.
        if (!web) startWeb(message);
        else {
          web.child.postMessage({ type: "resume-backend" });
          console.log(`ATK backend reloaded. Agent API: ${message.url}`);
        }
        if (dirty) schedule();
      } else if (message.type === "busy") {
        running.requested = false;
        web.child.postMessage({ type: "resume-backend" });
        dirty = true;
        if (!deferred) console.log("ATK backend reload deferred until tasks and automations are idle.");
        deferred = true;
        schedule(1000);
      } else if (message.type === "reloading") {
        deferred = false;
        running.replacing = true;
      }
    });
    void running.exited.then((code) => {
      backend = null;
      if (closing) return;
      if (running.replacing) {
        dirty = false;
        startBackend();
      } else if (!started) {
        onError(`Development backend exited (${code}). See the dev.bat console.`);
      } else {
        console.error(`ATK development backend exited (${code}); save a backend file to retry.`);
        if (dirty) schedule();
      }
    });
    running.child.postMessage({ type: "start", port: backendPort });
  }

  startBackend();
  return {
    close() {
      closing ??= Promise.resolve().then(async () => {
        clearTimeout(timer);
        for (const watcher of watchers) watcher.close();
        await stopWorker(backend);
        await stopWorker(web);
      });
      return closing;
    },
  };
}
