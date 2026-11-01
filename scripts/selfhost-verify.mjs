// Heavy self-host gate used by `atk gate local`: full suite, then the workflow
// integrity checks that must stay true while the toolkit develops itself.
//
// Deliberately independent of lib/: it only shells out to `node bin/atk.mjs` and
// `node scripts/selftest.mjs`, so it can still report when a lib change is broken
// (the recovery path is `node scripts/selfhost.mjs restore latest --apply`).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const ATK = path.join(ROOT, "bin", "atk.mjs");

function run(argv, { capture = false } = {}) {
  const result = spawnSync(NODE, argv, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  return { code: result.status ?? (result.error ? -1 : 0), stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}\n`);
}

process.stdout.write("=== full suite ===\n");
const suite = run([path.join(ROOT, "scripts", "selftest.mjs")]);
record("selftest suite", suite.code === 0, `exit ${suite.code}`);

const version = run([ATK, "--version"], { capture: true });
record("bin/atk.mjs runs", version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), version.stdout.trim());

const state = run([ATK, "state", "check", "--json"], { capture: true });
let stateOk = false;
try {
  stateOk = JSON.parse(state.stdout).ok === true;
} catch {
  stateOk = false;
}
record("state check", state.code === 0 && stateOk);

const ownership = run([ATK, "ownership", "verify-config"], { capture: true });
let ownershipOk = false;
try {
  ownershipOk = JSON.parse(ownership.stdout).ok === true;
} catch {
  ownershipOk = false;
}
record("ownership verify-config", ownership.code === 0 && ownershipOk);

const matrix = run([ATK, "permit", "matrix", "--json"], { capture: true });
let matrixOk = false;
try {
  const payload = JSON.parse(matrix.stdout);
  matrixOk = Array.isArray(payload.groups) && payload.stats?.operations === 75;
} catch {
  matrixOk = false;
}
record("permission registry", matrix.code === 0 && matrixOk);

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
  process.stderr.write(`\nselfhost gate local: ${failed.length} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nselfhost gate local: ${checks.length} check(s) passed\n`);
}
