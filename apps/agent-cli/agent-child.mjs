// Runs inside a managed process tree; stdin carries the prompt without shell quoting.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createDshResult } from "./runner-engines.mjs";

const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let executable, args, env = process.env;
const dshResult = request.engine === "dsh" ? createDshResult() : null;
if (!request.command) {
  const agent = request.agent ?? request.codex;
  executable = agent.executable;
  env = { ...process.env, ...agent.env };
  if (request.engine === "dsh") {
    const patches = [...(request.dshPatches ?? [])];
    env.DSH_PERMISSION_MODE = "workspace-write";
    if (agent.desktopAsar && !patches.length) {
      const { stdout } = await promisify(execFile)(agent.executable, ["--expose-internals",
        fileURLToPath(new URL("./dsh-desktop-model.cjs", import.meta.url)), agent.desktopAsar,
        process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh")], { env, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      const selection = JSON.parse(stdout);
      if (selection.length) {
        const patch = path.join(path.dirname(request.output), "dsh-desktop-model.patch.json");
        fs.writeFileSync(patch, JSON.stringify(selection), { mode: 0o600 });
        patches.push(patch);
      }
    }
    args = [...(agent.args ?? []), "--profile", "headless", ...patches.flatMap(file => ["--patch", file]),
      "--json", "--permission-mode", "workspace-write", "--approval-policy", "never", "-"];
  } else args = [...(agent.args ?? []), "exec", "--sandbox", "workspace-write", "--json", "--color", "never",
    "--output-schema", request.schema, "--output-last-message", request.output, "-"];
}
const child = request.command ? spawn(request.command, {
  cwd: request.root, env: process.env, windowsHide: true, shell: true, stdio: "inherit",
}) : spawn(executable, args, { cwd: request.root, env, windowsHide: true, stdio: ["pipe", dshResult ? "pipe" : "inherit", "inherit"] });
if (dshResult) {
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", value => process.stdout.write(value));
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => dshResult.line(line));
}
child.stdin?.on("error", () => {});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("close", code => {
  process.exitCode = code ?? 1;
  if (code === 0 && dshResult) {
    try { fs.writeFileSync(request.output, JSON.stringify(dshResult.finish()), { mode: 0o600 }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
});
child.stdin?.end(request.prompt);
