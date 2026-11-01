#!/usr/bin/env node
// M0 gate harness: reproduces the four P0 risks from the 2.0 implementation spec
// (§1.2) against the *current* CLI and asserts the fixed behaviour.
//
// Every scenario runs in its own throwaway project under the OS temp dir, so the
// repository and the user's real projects are never touched. The pre-fix
// behaviour is recorded in docs/architecture/current-state.md §6; this script is
// the machine-checkable "after" side and the regression harness QA re-runs.
//
// Usage: node scripts/m0-repro.mjs [--verbose]
// Exit: 0 = every P0 check passes, 1 = at least one regression.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATK = path.resolve(HERE, "..", "bin", "atk.mjs");
const verbose = process.argv.includes("--verbose");

function run(cwd, args) {
  const result = spawnSync(process.execPath, [ATK, "--cwd", cwd, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (verbose) {
    process.stdout.write(`\n$ atk ${args.join(" ")}\n${combined.trimEnd()}\n(exit ${result.status ?? -1})\n`);
  }
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", combined };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, "utf8");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

/** Find the first JSON object a command printed (commands mix status lines and JSON). */
function lastJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through: the JSON is probably embedded after status lines */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

const root = mkdtempSync(path.join(os.tmpdir(), "atk-m0-repro-"));
const checks = [];

function check(name, fn) {
  checks.push(async () => {
    try {
      const detail = await fn();
      return { name, ok: true, detail: detail ?? "" };
    } catch (error) {
      return { name, ok: false, detail: String(error?.message ?? error) };
    }
  });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function rawProject(dir, config = {}, files = {}) {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeJson(path.join(dir, "agent-flow.config.json"), {
    schemaVersion: 1,
    project: path.basename(dir),
    layout: { flowDir: "flow", artifactDir: "artifacts/agent-flow", evidenceDir: "artifacts/evidence" },
    roles: ["LEAD", "DEV", "QA"],
    ...config,
  });
  for (const [relative, content] of Object.entries(files)) {
    if (typeof content === "string") writeText(path.join(dir, relative), content);
    else writeJson(path.join(dir, relative), content);
  }
  return dir;
}

function project(name, config = {}, files = {}) {
  return rawProject(path.join(root, name), config, files);
}

const OWNERSHIP = {
  schemaVersion: 1,
  roles: ["LEAD", "DEV", "QA"],
  ignoredPrefixes: ["artifacts/"],
  rules: [
    { prefix: "src/", role: "DEV" },
    { prefix: "tests/", role: "QA" },
  ],
};
const RUNTIME = {
  schemaVersion: 3,
  agents: [
    { id: "agent-dev-01", role: "DEV", capabilities: ["WORKER"], status: "idle", task: "", detail: "", since: "2026-01-01T00:00:00+00:00" },
    { id: "agent-qa-01", role: "QA", capabilities: ["REVIEWER"], status: "idle", task: "", detail: "", since: "2026-01-01T00:00:00+00:00" },
  ],
  events: [],
};

// ---------------------------------------------------------------------------
// P0-1: ownership must require a Role and must refuse unmapped paths in strict mode
// ---------------------------------------------------------------------------
check("P0-1a ownership --strict without --role exits 2 (config error)", () => {
  const dir = project("ownership", {}, {
    "flow/ownership.json": OWNERSHIP,
    "src/a.mjs": "export const a = 1;\n",
  });
  const result = run(dir, ["ownership", "check", "--strict", "--files", "src/a.mjs", "--json"]);
  expect(result.code === 2, `expected exit 2, got ${result.code}: ${result.combined.trim()}`);
  return "exit 2";
});

check("P0-1b ownership --strict unknown role exits 2", () => {
  const dir = project("ownership", {}, {
    "flow/ownership.json": OWNERSHIP,
    "src/a.mjs": "export const a = 1;\n",
  });
  const result = run(dir, ["ownership", "check", "--strict", "--role", "NOPE", "--files", "src/a.mjs", "--json"]);
  expect(result.code === 2, `expected exit 2, got ${result.code}: ${result.combined.trim()}`);
  return "exit 2";
});

check("P0-1c ownership --strict refuses an unmapped path (exit 1)", () => {
  const dir = project("ownership", {}, {
    "flow/ownership.json": OWNERSHIP,
    "src/a.mjs": "export const a = 1;\n",
  });
  const result = run(dir, ["ownership", "check", "--strict", "--role", "DEV", "--files", "misc/x.txt", "--json"]);
  expect(result.code === 1, `expected exit 1, got ${result.code}: ${result.combined.trim()}`);
  const report = lastJson(result.combined);
  expect(report, "expected a JSON report");
  expect(report.status === "FAIL", `expected status FAIL, got ${report.status}`);
  const files = (report.violations ?? []).map((entry) => (typeof entry === "string" ? entry : entry.file));
  expect(files.includes("misc/x.txt"), `unmapped file must be a violation, got ${JSON.stringify(report.violations)}`);
  return `status=${report.status}, violations=${files.length}`;
});

check("P0-1d ownership --strict passes an in-scope path (exit 0, status PASS)", () => {
  const dir = project("ownership", {}, {
    "flow/ownership.json": OWNERSHIP,
    "src/a.mjs": "export const a = 1;\n",
  });
  const result = run(dir, ["ownership", "check", "--strict", "--role", "DEV", "--files", "src/a.mjs", "--json"]);
  expect(result.code === 0, `expected exit 0, got ${result.code}: ${result.combined.trim()}`);
  const report = lastJson(result.combined);
  expect(report, "expected a JSON report");
  expect(report.status === "PASS", `expected status PASS, got ${report.status}`);
  return `status=${report.status}`;
});

check("P0-1e loose mode still ignores unmapped paths (back-compat exit 0)", () => {
  const dir = project("ownership", {}, {
    "flow/ownership.json": OWNERSHIP,
    "src/a.mjs": "export const a = 1;\n",
  });
  const result = run(dir, ["ownership", "check", "--files", "misc/x.txt", "--json"]);
  expect(result.code === 0, `expected exit 0, got ${result.code}: ${result.combined.trim()}`);
  const report = lastJson(result.combined);
  expect(report, "expected a JSON report");
  expect(report.ok === true, "loose mode keeps ok:true for an unmapped path");
  return "exit 0 (loose)";
});

// ---------------------------------------------------------------------------
// P0-2: an unconfigured gate must never exit 0
// ---------------------------------------------------------------------------
check("P0-2a gate fast with no steps is UNCONFIGURED (exit 2)", () => {
  const dir = project("gate-empty", {}, { "src/a.mjs": "export const a = 1;\n" });
  const result = run(dir, ["gate", "fast", "--files", "src/a.mjs", "--json"]);
  expect(result.code === 2, `expected exit 2, got ${result.code}: ${result.combined.trim()}`);
  expect(/UNCONFIGURED/i.test(result.combined), `expected UNCONFIGURED in output: ${result.combined.trim()}`);
  return "exit 2, UNCONFIGURED";
});

check("P0-2b gate quick with a null command is UNCONFIGURED (exit 2)", () => {
  const dir = project("gate-empty", {}, {});
  const result = run(dir, ["gate", "quick", "--json"]);
  expect(result.code === 2, `expected exit 2, got ${result.code}: ${result.combined.trim()}`);
  return "exit 2";
});

check("P0-2c gate fast with no applicable step is SKIPPED, not PASS", () => {
  const dir = project(
    "gate-skip",
    {
      gates: {
        fast: {
          parallel: true,
          groups: { code: ["src/**"] },
          steps: [{ name: "unit", command: ["node", "-e", "process.exit(0)"], when: { group: "code" } }],
        },
        quick: null,
        local: null,
      },
    },
    { "src/a.mjs": "export const a = 1;\n" },
  );
  const result = run(dir, ["gate", "fast", "--files", "docs/notes.md", "--json"]);
  expect(result.code === 0, `expected exit 0, got ${result.code}: ${result.combined.trim()}`);
  expect(/SKIPPED/i.test(result.combined), `expected SKIPPED in output: ${result.combined.trim()}`);
  const report = lastJson(result.combined);
  expect(report, "expected a JSON report");
  expect(report.status === "SKIPPED", `expected status SKIPPED, got ${report.status}`);
  expect(!/\bPASS\b/.test(result.combined), `a skipped gate must never print PASS: ${result.combined.trim()}`);
  return "status=SKIPPED, no PASS";
});

check("P0-2d gate fast with an applicable passing step is PASS (exit 0)", () => {
  const dir = project(
    "gate-pass",
    {
      gates: {
        fast: {
          parallel: true,
          groups: { code: ["src/**"] },
          steps: [{ name: "unit", command: ["node", "-e", "process.exit(0)"], when: { group: "code" } }],
        },
        quick: null,
        local: null,
      },
    },
    { "src/a.mjs": "export const a = 1;\n" },
  );
  const result = run(dir, ["gate", "fast", "--files", "src/a.mjs", "--json"]);
  expect(result.code === 0, `expected exit 0, got ${result.code}: ${result.combined.trim()}`);
  const report = lastJson(result.combined);
  expect(report, "expected a JSON report");
  expect(report.status === "PASS", `expected status PASS, got ${report.status}`);
  return "status=PASS";
});

// ---------------------------------------------------------------------------
// P0-3 + P0-4: QA must be mandatory for controlled integration, and evidence
// must not trust a self-reported boolean
// ---------------------------------------------------------------------------
function batchProject() {
  // The candidate tree must live OUTSIDE the project root: freezing a candidate
  // that sits inside the original tree is refused (WORKSPACE_NOT_ISOLATED).
  const base = path.join(root, "batch");
  const dir = rawProject(
    path.join(base, "proj"),
    { batch: { allowedPrefixes: ["src/"], allowRootFiles: false, manifestTag: "agent-flow-manifest-v1" } },
    {
      "flow/ownership.json": OWNERSHIP,
      "flow/runtime.json": RUNTIME,
      "flow/state.json": {
        schemaVersion: 1,
        updatedAt: "2026-01-01T00:00:00+00:00",
        batch: {
          id: "BATCH-01",
          goal: "gate the P0 fix",
          stopCondition: "accepted",
          slices: [{ id: "S1", label: "First", status: "in_progress", qaPassed: null, applied: null, owner: "DEV", exit: "gates pass", evidence: "artifacts/evidence", note: "" }],
        },
        counts: { total: 1 },
        packages: [
          {
            id: "S1-PKG",
            type: "feature",
            typeRaw: "feature",
            owner: "DEV",
            module: "m",
            scope: "s",
            stage: "implemented",
            statusRaw: "implemented",
            priority: "P1",
            evidence: "",
            note: "",
            depsRaw: "",
            deps: [],
            archived: false,
            migrated: true,
            verification: {},
            updatedAt: "2026-01-01T00:00:00+00:00",
            firstSeenAt: "2026-01-01T00:00:00+00:00",
          },
        ],
        subitems: [],
      },
      "src/a.mjs": "export const a = 1;\n",
    },
  );
  const candidate = path.join(base, "cand");
  writeText(path.join(candidate, "src", "a.mjs"), "export const a = 2;\n");
  const manifest = run(dir, [
    "batch",
    "manifest",
    "--candidate",
    candidate,
    "--paths",
    "src/a.mjs",
    "--batch",
    "BATCH-01",
    "--agent",
    "agent-dev-01",
    "--json",
  ]);
  expect(manifest.code === 0, `manifest failed: ${manifest.combined.trim()}`);
  const manifestFile = path.join(dir, "artifacts", "agent-flow", "BATCH-01-manifest.json");
  return { dir, manifestFile, manifest: readJson(manifestFile) };
}

check("P0-3a batch verify without --qa is diagnostic only (no PASS)", () => {
  const { dir, manifestFile } = batchProject();
  const result = run(dir, ["batch", "verify", "--manifest", manifestFile, "--json"]);
  expect(!/\bPASS\b/.test(result.combined), `verify without QA must not print PASS: ${result.combined.trim()}`);
  const report = lastJson(result.combined);
  expect(report, "expected a JSON report");
  expect(report.status === "SKIPPED", `expected status SKIPPED, got ${report.status}`);
  expect(report.diagnosticOnly === true || report.kind === "verify", "diagnostic mode must be recognisable");
  return `status=${report.status}`;
});

check("P0-3b batch apply without a QA approval is refused (exit 1)", () => {
  const { dir, manifestFile } = batchProject();
  const result = run(dir, ["batch", "apply", "--manifest", manifestFile, "--json"]);
  expect(result.code === 1, `expected exit 1, got ${result.code}: ${result.combined.trim()}`);
  return "exit 1";
});

check("P0-4a evidence refuses a receipt that only says passed:true", () => {
  const { dir, manifest } = batchProject();
  // Forged receipt: self-reported boolean, no schemaVersion/kind/verdict/reviewer/gates.
  writeJson(path.join(dir, "artifacts", "evidence", "BATCH-01", "qa-approval.json"), {
    manifestSha256: manifest.manifestSha256,
    passed: true,
    batchId: "S1",
    originalApplied: false,
  });
  const result = run(dir, ["evidence", "--json"]);
  expect(result.code === 0, `evidence should not crash, got ${result.code}: ${result.combined.trim()}`);
  const report = lastJson(result.combined);
  expect(report, "expected a JSON report");
  expect(report.qaApprovals === 0, `a forged receipt must not count as QA, got ${report.qaApprovals}`);
  expect(Array.isArray(report.rejected) && report.rejected.length > 0, "the forged receipt must be reported as rejected");
  const state = readJson(path.join(dir, "flow", "state.json"));
  expect(state.batch.slices[0].qaPassed !== true, "state must not record qaPassed from a forged receipt");
  expect(state.batch.slices[0].status !== "awaiting_apply", `slice must not advance, got ${state.batch.slices[0].status}`);
  return `qaApprovals=0, rejected=${report.rejected.length}, slice=${state.batch.slices[0].status}`;
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const results = [];
for (const runCheck of checks) results.push(await runCheck());

let failed = 0;
process.stdout.write("M0 gate harness (P0 regression checks)\n");
process.stdout.write(`root: ${root}\n\n`);
for (const result of results) {
  if (!result.ok) failed += 1;
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n`);
  if (!result.ok) process.stdout.write(`      ${result.detail.split("\n").join("\n      ")}\n`);
  else if (result.detail) process.stdout.write(`      ${result.detail}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);

if (process.argv.includes("--keep")) process.stdout.write(`kept: ${root}\n`);
else rmSync(root, { recursive: true, force: true });

process.exit(failed === 0 ? 0 : 1);
