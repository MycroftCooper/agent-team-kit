import { spawnSync } from "node:child_process";
import path from "node:path";
const cwd = path.resolve("apps/web");
for (const [script, args] of [
  ["typescript/bin/tsc", ["--noEmit"]],
  ["vite/bin/vite.js", ["build"]],
]) {
  const r = spawnSync(
    process.execPath,
    [path.join(cwd, "node_modules", script), ...args],
    { cwd, stdio: "inherit", windowsHide: true },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}
