import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInterface } from "node:readline";
import crypto from "node:crypto";

// A separate supervisor outlives a backend crash long enough to stop its tree.
// On Windows a kill-on-close Job Object owns descendants, including detached ones.
export function launchProcess(spec, onData) {
  const windows = process.platform === "win32";
  const executable = windows
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
    : process.execPath;
  const args = windows
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./automation-job.ps1", import.meta.url))]
    : [fileURLToPath(import.meta.url), "--supervise"];
  const child = spawn(executable, args, { env: spec.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8").on("data", text => onData("stdout", text));
  const nonce = crypto.randomUUID(), marker = "::atk-supervisor::" + nonce + "::";
  let partial = "", completion;
  child.stderr.setEncoding("utf8").on("data", text => {
    partial += text;
    let boundary;
    while ((boundary = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, boundary + 1); partial = partial.slice(boundary + 1);
      if (line.startsWith(marker) && /^-?\d+\s*$/.test(line.slice(marker.length))) completion = Number(line.slice(marker.length));
      else onData("stderr", line);
    }
    if (partial.length > 16384) { onData("stderr", partial.slice(0, 8192)); partial = partial.slice(8192); }
  });
  const done = new Promise(resolve => {
    let error;
    child.on("error", e => { error = e; });
    child.once("close", (code, signal) => { if (partial) onData("stderr", partial); resolve({ code: completion ?? code, signal, error, confirmed: completion !== undefined }); });
  });
  child.stdin.write(JSON.stringify({ executable: spec.executable, args: spec.args, cwd: spec.cwd, nonce }) + "\n");
  return { child, done, stop: () => child.stdin.end() };
}

async function supervise() {
  const input = createInterface({ input: process.stdin });
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next();
  const spec = JSON.parse(first.value);
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, detached: true, stdio: ["ignore", "inherit", "inherit"] });
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") process.exitCode = 125; } };
  input.on("close", kill);
  child.once("error", e => {
    console.error(e.message);
    process.stderr.write("\n::atk-supervisor::" + spec.nonce + "::127\n", () => process.exit(0));
  });
  child.once("exit", async (code, signal) => {
    kill();
    for (let i = 0; i < 100; i++) {
      try { process.kill(-child.pid, 0); }
      catch (e) {
        if (e.code === "ESRCH") {
          process.stderr.write("\n::atk-supervisor::" + spec.nonce + "::" + (signal ? 128 : code ?? 127) + "\n", () => process.exit(0));
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    process.exit(125);
  });
}
if (process.argv[2] === "--supervise") supervise().catch(e => { console.error(e.message); process.exit(125); });
