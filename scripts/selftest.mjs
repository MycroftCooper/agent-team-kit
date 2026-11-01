// Run the full local suite: the node --test suite plus the standalone plugin
// selftests while the DSH plugin package still exists. Used by `atk gate quick`
// and `atk gate local`, and by the self-host verification script.
//
// No dependencies: node:child_process + node:fs only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const steps = [{ name: "unit tests", args: [path.join(ROOT, "scripts", "test.mjs")] }];
const pluginDir = path.join(ROOT, "plugins", "dsh-agent-board");
if (existsSync(path.join(pluginDir, "selftest.mjs"))) {
  steps.push({ name: "board plugin host selftest", args: [path.join(pluginDir, "selftest.mjs")] });
}
if (existsSync(path.join(pluginDir, "selftest-client.mjs"))) {
  steps.push({ name: "board plugin client selftest", args: [path.join(pluginDir, "selftest-client.mjs")] });
}

let failed = 0;
for (const step of steps) {
  process.stdout.write(`\n=== ${step.name} ===\n`);
  const result = spawnSync(NODE, step.args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) {
    failed += 1;
    process.stderr.write(`FAIL ${step.name}: ${result.error.message}\n`);
  } else if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`FAIL ${step.name} (exit ${result.status ?? "signal"})\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`\nselftest: ${failed} step(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nselftest: ${steps.length} step(s) passed\n`);
}
