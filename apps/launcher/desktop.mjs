#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
try {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Node.js 24 or newer is required.");
  const [action = "start", ...options] = process.argv.slice(2);
  if (!["start", "stop"].includes(action))
    throw new Error("Use start or stop.");
  const configFile = path.join(root, "atk.local.json");
  const defaults = [];
  if (fs.existsSync(configFile) && !process.env.ATK_DATA_DIR) {
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (typeof config.dataDir !== "string" || !config.dataDir.trim())
      throw new Error("atk.local.json requires a non-empty dataDir.");
    defaults.push("--data", path.resolve(root, config.dataDir));
  }
  if (action === "start" && !fs.existsSync(path.join(root, "apps/web/dist/index.html")))
    throw new Error("Web build missing. Run node scripts/build-web.mjs once, then start again.");
  const output = execFileSync(
    process.execPath,
    [path.join(root, "apps/launcher/cli.mjs"), action, ...defaults, ...options.filter((v) => v !== "--no-open")],
    { encoding: "utf8", windowsHide: true, timeout: 25000 },
  );
  const info = JSON.parse(output);
  if (action === "stop") {
    console.log("Agent Team Kit: stopped or stopping.");
  } else {
    const url = new URL(info.browserUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Refusing to open an unexpected service address.");
    console.log(`Agent Team Kit is running: ${info.url}`);
    if (!options.includes("--no-open")) {
      if (process.platform === "win32") {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "Start-Process -FilePath $env:ATK_LAUNCH_URL"], {
          windowsHide: true, timeout: 10000,
          env: { ...process.env, ATK_LAUNCH_URL: url.href },
        });
      } else {
        execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [url.href], { timeout: 10000 });
      }
    }
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}
