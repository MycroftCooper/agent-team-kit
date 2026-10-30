import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { run as runEvidence } from "../lib/evidence.mjs";
import { writeJson } from "../lib/util.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

const SHA = "A".repeat(64);

function stateWithSlices() {
  return {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00+00:00",
    batch: {
      id: "BATCH-01",
      goal: "derive facts from receipts",
      stopCondition: "all slices accepted",
      slices: [
        { id: "S1", label: "one", status: "in_progress", qaPassed: null, applied: null, owner: "DEV" },
        { id: "S2", label: "two", status: "blocked", qaPassed: null, applied: null, owner: "DEV" },
        { id: "S3", label: "three", status: "paused", qaPassed: null, applied: null, owner: "DEV" },
      ],
    },
    packages: [
      { id: "PKG-01", type: "feature", evidence: ["src/app.ts"], verification: {}, stage: "implemented" },
      { id: "PKG-02", type: "bug", evidence: [], verification: {}, stage: "todo" },
    ],
    subitems: [],
  };
}

async function setup(t, options = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const prefix = options.tempPrefix ?? `atk-evidence-test-${suffix}`;
  const project = await createProject({
    config: { layout: { flowDir: "flow", tempPrefix: prefix } },
    files: {
      "flow/state.json": options.state ?? stateWithSlices(),
      ...(options.receipts ?? {}),
    },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  return {
    ...project,
    ctx,
    logger,
    prefix,
    statePath: path.join(project.root, "flow", "state.json"),
    evidenceDir: path.join(project.root, "artifacts", "evidence"),
    run: (argv) => runEvidence(argv, ctx),
  };
}

async function loadState(env) {
  return JSON.parse(await readFile(env.statePath, "utf8"));
}

async function receipt(env, name, payload) {
  await writeJson(path.join(env.evidenceDir, "BATCH-01", name), payload);
}

test("evidence derives qaPassed from receipts and is idempotent", async (t) => {
  const env = await setup(t);
  await receipt(env, "manifest-aaaaaaaa.json", {
    schemaVersion: 1,
    batchId: "BATCH-01",
    manifestSha256: SHA,
    files: [{ path: "src/app.ts" }],
  });
  await receipt(env, "qa-s1.json", {
    noninteractiveQA: "passed",
    manifestSha256: SHA,
    batchId: "S1",
    packages: ["PKG-01"],
  });

  assert.equal(await env.run([]), 0);
  assert.match(env.logger.text(), /evidence: 2 receipt\(s\), qa=1, applied=0/);

  let state = await loadState(env);
  const s1 = state.batch.slices.find((slice) => slice.id === "S1");
  assert.equal(s1.qaPassed, true);
  assert.equal(s1.status, "awaiting_apply");
  assert.equal(state.packages.find((pkg) => pkg.id === "PKG-01").verification.qaPassed, true);
  assert.equal(state.packages.find((pkg) => pkg.id === "PKG-02").verification.qaPassed, undefined);
  assert.notEqual(state.updatedAt, "2026-01-01T00:00:00+00:00", "updatedAt is refreshed on write");
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

  const snapshot = await readFile(env.statePath, "utf8");
  env.logger.lines.json.length = 0;
  assert.equal(await env.run(["--json"]), 0);
  assert.deepEqual(env.logger.lines.json.at(-1).changes, [], "second run derives nothing new");
  assert.equal(await readFile(env.statePath, "utf8"), snapshot, "idempotent evidence does not rewrite state.json");
});

test("evidence advances a qa-passed slice to awaiting_accept once applied", async (t) => {
  const env = await setup(t);
  await receipt(env, "manifest-aaaaaaaa.json", {
    batchId: "BATCH-01",
    manifestSha256: SHA,
    files: [{ path: "src/app.ts" }],
  });
  await receipt(env, "qa.json", { noninteractiveQA: "passed", manifestSha256: SHA, batchId: "S1" });
  await receipt(env, "apply.json", { originalApplied: true, manifestSha256: SHA, batchId: "S1" });

  assert.equal(await env.run([]), 0);
  const state = await loadState(env);
  const s1 = state.batch.slices.find((slice) => slice.id === "S1");
  assert.equal(s1.qaPassed, true);
  assert.equal(s1.applied, true);
  assert.equal(s1.status, "awaiting_accept");
  const pkg = state.packages.find((entry) => entry.id === "PKG-01");
  assert.equal(pkg.verification.qaPassed, true);
  assert.equal(pkg.verification.applied, true);
});

test("evidence never advances blocked/paused slices and keeps humanAccepted", async (t) => {
  const env = await setup(t, {
    state: (() => {
      const state = stateWithSlices();
      state.packages[0].verification = { humanAccepted: true };
      return state;
    })(),
    receipts: {
      "artifacts/evidence/BATCH-01/qa-s2.json": { noninteractiveQA: "passed", manifestSha256: "B".repeat(64), batchId: "S2" },
      "artifacts/evidence/BATCH-01/apply-s3.json": { originalApplied: true, manifestSha256: "C".repeat(64), batchId: "S3" },
      "artifacts/evidence/BATCH-01/qa-s1.json": { noninteractiveQA: "passed", manifestSha256: "D".repeat(64), batchId: "S1" },
      "artifacts/evidence/BATCH-01/apply-s1.json": { originalApplied: true, manifestSha256: "D".repeat(64), batchId: "S1" },
    },
  });
  assert.equal(await env.run([]), 0);
  const state = await loadState(env);
  const byId = Object.fromEntries(state.batch.slices.map((slice) => [slice.id, slice]));
  assert.equal(byId.S2.qaPassed, true);
  assert.equal(byId.S2.status, "blocked", "blocked slices are never auto-advanced");
  assert.equal(byId.S3.applied, true);
  assert.equal(byId.S3.status, "paused", "paused slices are never auto-advanced");
  assert.equal(byId.S1.status, "awaiting_accept");
  assert.equal(state.packages.find((pkg) => pkg.id === "PKG-01").verification.humanAccepted, true);
});

test("evidence --dry reports changes without writing state.json", async (t) => {
  const env = await setup(t, {
    receipts: {
      "artifacts/evidence/BATCH-01/qa-s1.json": { noninteractiveQA: "passed", manifestSha256: "D".repeat(64), batchId: "S1" },
    },
  });
  const before = await readFile(env.statePath, "utf8");
  assert.equal(await env.run(["--dry", "--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.dryRun, true);
  assert.equal(report.changes.length, 1);
  assert.equal(await readFile(env.statePath, "utf8"), before, "dry-run must not write");
});

test("evidence --collect-temp copies recognisable receipts from tempPrefix dirs", async (t) => {
  const env = await setup(t);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `${env.prefix}-collect-`));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  await writeJson(path.join(tempDir, "qa-approval.json"), {
    noninteractiveQA: "passed",
    batchId: "S1",
    manifestSha256: "E".repeat(64),
  });
  await writeJson(path.join(tempDir, "unrelated.json"), { hello: "world" });

  assert.equal(await env.run(["--collect-temp", "--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.collected.copied, 1, "only recognisable receipts are copied");
  const copied = path.join(env.evidenceDir, path.basename(tempDir), "qa-qa-approval.json");
  assert.equal((await stat(copied)).isFile(), true);
  assert.equal(JSON.parse(await readFile(copied, "utf8")).batchId, "S1");
});

test("evidence --collect-temp skips build dirs and reads BOM receipts", async (t) => {
  const env = await setup(t);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `${env.prefix}-bom-`));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const receiptText = JSON.stringify({ noninteractiveQA: "passed", batchId: "S1", manifestSha256: "F".repeat(64) });
  await writeFile(path.join(tempDir, "qa-bom.json"), `\uFEFF${receiptText}`, "utf8");
  await writeJson(path.join(tempDir, "target", "manifest-hidden.json"), {
    files: [{ path: "src/app.ts" }],
    manifestSha256: "F".repeat(64),
  });

  assert.equal(await env.run(["--collect-temp", "--json"]), 0);
  const report = env.logger.lines.json.at(-1);
  assert.equal(report.collected.copied, 1, "BOM receipt is copied, build-dir JSON is skipped");
  const copied = path.join(env.evidenceDir, path.basename(tempDir), "qa-qa-bom.json");
  assert.equal((await stat(copied)).isFile(), true);
  assert.equal(JSON.parse((await readFile(copied, "utf8")).replace(/^\uFEFF/, "")).batchId, "S1");
});

test("evidence fails cleanly when state.json is missing", async (t) => {
  const project = await createProject({
    config: { layout: { flowDir: "flow", tempPrefix: "atk-evidence-missing" } },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  assert.equal(await runEvidence([], ctx), 2);
  assert.match(logger.errorText(), /evidence:/);
});
