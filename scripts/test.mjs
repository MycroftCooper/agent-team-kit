// Cross-platform test entry point for `npm test`.
//
// Node 20's test runner does not expand globs, Node 22+ only expands them when
// they reach `--test` as a literal, and Windows `cmd` (what npm uses by default)
// expands no globs at all. And Node 24 rejects a bare directory argument on
// Windows ("Cannot find module .../test"). So expand the file list here and pass
// explicit paths: one invocation that works on Node >= 20.11 on every platform.
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const dir = "test";
const files = (await readdir(dir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => path.join(dir, entry.name))
  .sort((a, b) => a.localeCompare(b, "en"));

if (files.length === 0) {
  console.error(`test: no *.test.mjs files found in ${dir}/`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`test: cannot start node --test: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
