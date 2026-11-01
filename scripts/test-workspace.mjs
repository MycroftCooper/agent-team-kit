#!/usr/bin/env node
// Test runner for the M1 workspace (apps/* and packages/*).
//
// The legacy suite (test/*.test.mjs via scripts/test.mjs) must keep working on
// Node >= 20.11. The workspace packages use node:sqlite, which only exists from
// Node 22.5, so this runner reports SKIPPED (not PASS) when the runtime is too
// old: a skip is never evidence that the tests passed.
//
// Usage: node scripts/test-workspace.mjs [--grep <pattern>]
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function minorVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return { major, minor };
}

const { major, minor } = minorVersion();
if (major < 22 || (major === 22 && minor < 5)) {
  process.stdout.write(
    `SKIPPED workspace tests: node:sqlite requires Node >= 22.5.0 (running ${process.versions.node}). ` +
      "This is a skip, not a pass.\n",
  );
  process.exit(0);
}

function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vite") continue;
      collect(full, out);
    } else if (entry.isFile() && /\.test\.(mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const group of ["apps", "packages"]) {
  const base = path.join(ROOT, group);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    collect(path.join(base, entry.name, "test"), files);
  }
}

if (files.length === 0) {
  process.stdout.write("SKIPPED workspace tests: no apps/*/test or packages/*/test files yet. This is a skip, not a pass.\n");
  process.exit(0);
}

files.sort((a, b) => a.localeCompare(b, "en"));
process.stdout.write(`workspace tests: ${files.length} file(s)\n`);
const child = spawn(process.execPath, ["--test", ...files], { cwd: ROOT, stdio: "inherit" });
child.on("error", (error) => {
  process.stderr.write(`test-workspace: cannot start node --test: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
