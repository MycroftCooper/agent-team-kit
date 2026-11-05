#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runtimePaths,
  argumentsOf,
  readBrowserAccess,
  browserUrl,
} from "../../packages/platform/src/index.mjs";
import { VERSION } from "../../packages/contracts/src/index.mjs";
const args = argumentsOf(process.argv.slice(2)),
  command = args._[0] ?? "help",
  dataDir = path.resolve(args.data ?? runtimePaths().root),
  stateFile = path.join(dataDir, "runtime", "service.json");
function state() {
  for (const file of [stateFile, path.join(dataDir, "runtime", "backend.lock")])
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof data.url === "string" && typeof data.instanceId === "string")
        return data;
    } catch {}
  return null;
}
async function health() {
  const s = state();
  if (!s) return { running: false };
  try {
    const r = await fetch(s.url + "/api/v1/system/health", {
        signal: AbortSignal.timeout(1500),
      }),
      h = await r.json();
    return { ...s, running: r.ok && h.instanceId === s.instanceId };
  } catch {
    return { ...s, running: false };
  }
}
async function humanCall(url, body) {
  const s = state();
  const authResponse = await fetch(s.url + "/api/v1/session", {
    headers: { "x-atk-access": readBrowserAccess(dataDir) },
  });
  if (!authResponse.ok) throw new Error("Browser authorization failed");
  const auth = await authResponse.json();
  const response = await fetch(s.url + url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atk-token": auth.token,
      "x-atk-csrf": auth.csrf,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? response.statusText);
  return result;
}
async function main() {
  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (command === "help" || args.help) {
    console.log(
      "Agent Team Kit\n  atk start [--port 1421] [--data <directory>]\n  atk stop|status|logs [--data <directory>]\n  atk backup [--to <new directory>]\n  atk restore --from <backup directory>\n\nExternal agents use atk-agent. No target-project installation is needed.",
    );
    return;
  }
  if (command === "start") {
    const current = await health();
    if (current.running) {
      console.log(JSON.stringify({ ...current, browserUrl: browserUrl(current.url, readBrowserAccess(dataDir)) }));
      return;
    }
    const runtime = path.join(dataDir, "runtime"),
      logs = path.join(dataDir, "logs");
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    const logfile = path.join(logs, "backend.log");
    if (fs.existsSync(logfile) && fs.statSync(logfile).size > 5 * 1024 * 1024)
      fs.renameSync(logfile, logfile + `.${Date.now()}`);
    const out = fs.openSync(logfile, "a");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../backend/cli.mjs", import.meta.url)),
        "serve",
        "--data",
        dataDir,
        "--port",
        String(args.port ?? 1421),
      ],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
        cwd: dataDir,
      },
    );
    child.unref();
    fs.closeSync(out);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const next = await health();
      if (next.running) {
        console.log(JSON.stringify({ ...next, browserUrl: browserUrl(next.url, readBrowserAccess(dataDir)) }));
        return;
      }
    }
    throw new Error(`Service failed to start; inspect ${logfile}`);
  }
  if (command === "status") {
    const h = await health();
    console.log(JSON.stringify(h));
    if (state() && !h.running) process.exitCode = 1;
    return;
  }
  if (command === "stop") {
    const h = await health();
    if (!h.running) {
      console.log(JSON.stringify({ stopped: true, wasRunning: false }));
      return;
    }
    await humanCall("/api/v1/operations/shutdown", {});
    console.log(JSON.stringify({ stopping: true }));
    return;
  }
  if (command === "logs") {
    const f = path.join(dataDir, "logs", "backend.log");
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, "utf8");
      process.stdout.write(text.slice(-65536));
    }
    return;
  }
  if (command === "backup") {
    console.log(
      JSON.stringify(
        await humanCall("/api/v1/operations/backup", { destination: args.to }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "restore") {
    if (typeof args.from !== "string")
      throw new Error("restore requires --from <backup directory>");
    console.log(
      JSON.stringify(
        await humanCall("/api/v1/operations/restore", {
          source: path.resolve(args.from),
        }),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error("Unknown command. Run atk help.");
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
