import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "smoke";
const SUITES = {
  smoke: [
    { name: "module-boundaries", script: "scripts/check-boundaries.mjs" },
    { name: "unit-and-protocol-tests", script: "scripts/test.mjs" },
    { name: "web-build", script: "scripts/build-web.mjs" },
  ],
  release: [
    { name: "module-boundaries", script: "scripts/check-boundaries.mjs" },
    { name: "unit-and-protocol-tests", script: "scripts/test.mjs" },
    { name: "web-build", script: "scripts/build-web.mjs" },
    { name: "web-e2e", script: "scripts/e2e.mjs" },
    { name: "package-smoke", script: "scripts/smoke.mjs" },
    { name: "desktop-installer-build", script: "scripts/build-desktop.mjs" },
    { name: "release-artifacts", script: "scripts/prepare-release.mjs" },
  ],
};

if (!SUITES[mode]) {
  console.error(`Unknown local CI mode: ${mode}. Use "smoke" or "release".`);
  process.exit(2);
}

const steps = SUITES[mode];
const startedAt = new Date().toISOString();
const totalStart = performance.now();
const results = [];
let failed = false;

console.log(`\n=== ATK Local CI (${mode}) — ${steps.length} steps ===\n`);

for (const step of steps) {
  const stepStart = performance.now();
  console.log(`>>> [${step.name}] node ${step.script}`);
  const run = spawnSync(process.execPath, [step.script], {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  const durationMs = Math.round(performance.now() - stepStart);
  const ok = run.status === 0;
  results.push({
    name: step.name,
    script: step.script,
    passed: ok,
    exitCode: run.status ?? 1,
    durationMs,
  });
  console.log(
    `<<< [${step.name}] ${ok ? "PASS" : "FAIL"} (${(durationMs / 1000).toFixed(1)}s)\n`,
  );
  if (!ok) {
    failed = true;
    break;
  }
}

const totalMs = Math.round(performance.now() - totalStart);
const outDir = path.resolve("artifacts/local-ci");
fs.mkdirSync(outDir, { recursive: true });
const report = {
  mode,
  startedAt,
  finishedAt: new Date().toISOString(),
  passed: !failed,
  totalMs,
  results,
};
fs.writeFileSync(
  path.join(outDir, `${mode}-report.json`),
  JSON.stringify(report, null, 2) + "\n",
  "utf8",
);

console.log(
  `=== ATK Local CI (${mode}): ${failed ? "FAILED" : "PASSED"} in ${(totalMs / 1000).toFixed(1)}s ===`,
);
if (failed) process.exit(1);
