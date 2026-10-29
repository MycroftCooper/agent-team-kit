import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { runCli } from "../lib/dispatch.mjs";
import { computeManifestSha, run as runBatch } from "../lib/batch.mjs";
import { writeJson, writeText } from "../lib/util.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

const ORIGINAL_APP = "export const app = 1;\n";
const CANDIDATE_APP = "export const app = 2;\n";

async function setup(t) {
  const project = await createProject({
    config: {
      batch: { allowedPrefixes: ["src", "docs"], manifestTag: "demo-manifest-v1" },
    },
    files: {
      "src/app.ts": ORIGINAL_APP,
      "src/keep.ts": "export const keep = 1;\n",
    },
  });
  const candidateRoot = await mkdtemp(path.join(os.tmpdir(), "atk-candidate-"));
  await writeText(path.join(candidateRoot, "src", "app.ts"), CANDIDATE_APP);
  await writeText(path.join(candidateRoot, "src", "new.ts"), "export const created = true;\n");
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  t.after(() => rm(candidateRoot, { recursive: true, force: true }));
  const manifestPath = path.join(project.root, "artifacts", "agent-flow", "BATCH-01-manifest.json");
  return {
    ...project,
    ctx,
    logger,
    candidateRoot,
    manifestPath,
    evidenceDir: path.join(project.root, "artifacts", "evidence"),
    run: (argv) => runBatch(argv, ctx),
  };
}

async function freeze(env) {
  const code = await env.run([
    "manifest",
    "--candidate",
    env.candidateRoot,
    "--paths",
    "src/app.ts,src/new.ts",
    "--packages",
    "PKG-01",
    "--batch",
    "BATCH-01",
  ]);
  return code;
}

async function readManifest(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function receiptNames(dir) {
  return readdir(dir).catch(() => []);
}

test("batch manifest freezes hashes in the legacy-compatible format and copies to evidence", async (t) => {
  const env = await setup(t);
  assert.equal(await freeze(env), 0);
  assert.match(env.logger.text(), /manifest: .*batch=BATCH-01.*files 2/);

  const manifest = await readManifest(env.manifestPath);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.batchId, "BATCH-01");
  assert.equal(manifest.manifestTag, "demo-manifest-v1");
  assert.deepEqual(manifest.packages, ["PKG-01"]);
  assert.equal(manifest.originalRoot, env.root);
  assert.equal(manifest.candidateRoot, env.candidateRoot);
  assert.match(manifest.manifestSha256, /^[0-9A-F]{64}$/);
  assert.equal(manifest.manifestSha256, computeManifestSha(manifest, "demo-manifest-v1"));

  const app = manifest.files.find((file) => file.path === "src/app.ts");
  const created = manifest.files.find((file) => file.path === "src/new.ts");
  assert.equal(app.kind, "modify");
  assert.match(app.sourceSha256, /^[0-9A-F]{64}$/);
  assert.equal(app.sha256, app.sourceSha256, "brief-compatible sha256 alias is kept");
  assert.ok(app.size > 0);
  assert.match(app.expectedOriginalSha256, /^[0-9A-F]{64}$/);
  assert.equal(created.kind, "create");
  assert.equal(created.expectedOriginalSha256, undefined);

  const copies = await receiptNames(path.join(env.evidenceDir, "BATCH-01"));
  assert.ok(copies.some((name) => name.startsWith("manifest-")), "manifest is copied into the evidence dir");
});

test("batch verify passes on a clean freeze and fails after candidate tampering", async (t) => {
  const env = await setup(t);
  await freeze(env);
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 0);
  assert.match(env.logger.text(), /PASS BATCH-01/);

  const names = await receiptNames(path.join(env.evidenceDir, "BATCH-01"));
  assert.ok(names.some((name) => name.startsWith("verify-")), "verify writes a receipt");

  await writeText(path.join(env.candidateRoot, "src", "app.ts"), "export const app = 999;\n");
  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 1);
  assert.match(env.logger.text(), /FAIL BATCH-01/);
  assert.match(env.logger.text(), /candidate:src\/app\.ts/);

  await writeText(path.join(env.candidateRoot, "src", "app.ts"), CANDIDATE_APP);
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 0);
});

test("batch verify reports original-tree drift", async (t) => {
  const env = await setup(t);
  await freeze(env);
  await writeText(path.join(env.root, "src", "app.ts"), "export const app = 42;\n");
  env.logger.lines.out.length = 0;
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath]), 1);
  assert.match(env.logger.text(), /drift:src\/app\.ts/);
  await writeText(path.join(env.root, "src", "app.ts"), ORIGINAL_APP);
});

test("batch verify binds qa-approval.json to the manifest sha", async (t) => {
  const env = await setup(t);
  await freeze(env);
  const manifest = await readManifest(env.manifestPath);
  const qaPath = path.join(env.root, "qa-approval.json");

  await writeJson(qaPath, { passed: true, manifestSha256: manifest.manifestSha256, originalApplied: false });
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 0);

  await writeJson(qaPath, { passed: true, manifestSha256: "0".repeat(64), originalApplied: false });
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1);

  await writeJson(qaPath, { noninteractiveQA: "passed", manifestSha256: manifest.manifestSha256, originalApplied: true });
  assert.equal(await env.run(["verify", "--manifest", env.manifestPath, "--qa", qaPath]), 1, "a used approval cannot be replayed");
});

test("batch verify accepts a legacy manifest without the extra convenience fields", async (t) => {
  const env = await setup(t);
  await freeze(env);
  const manifest = await readManifest(env.manifestPath);
  const legacy = {
    schemaVersion: 1,
    batchId: manifest.batchId,
    packages: manifest.packages,
    createdAt: manifest.createdAt,
    candidateRoot: manifest.candidateRoot,
    originalRoot: manifest.originalRoot,
    files: manifest.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      sourceSha256: file.sourceSha256,
      expectedOriginalSha256: file.expectedOriginalSha256,
    })),
    manifestSha256: undefined,
  };
  legacy.manifestSha256 = computeManifestSha(legacy, "demo-manifest-v1");
  assert.equal(legacy.manifestSha256, manifest.manifestSha256);
  const legacyPath = path.join(env.root, "legacy-manifest.json");
  await writeJson(legacyPath, legacy);
  assert.equal(await env.run(["verify", "--manifest", legacyPath]), 0);
});

test("batch apply defaults to dry-run and never writes the original tree", async (t) => {
  const env = await setup(t);
  await freeze(env);
  assert.equal(await env.run(["apply", "--manifest", env.manifestPath]), 0);
  const plan = env.logger.lines.json.at(-1);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.verify, true);
  assert.deepEqual(plan.modifies, ["src/app.ts"]);
  assert.deepEqual(plan.creates, ["src/new.ts"]);
  assert.match(env.logger.errorText(), /dry-run/);

  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), ORIGINAL_APP);
  const newFile = path.join(env.root, "src", "new.ts");
  await assert.rejects(stat(newFile), /ENOENT/, "dry-run must not create candidate files");
  const names = await receiptNames(path.join(env.evidenceDir, "BATCH-01"));
  assert.ok(names.some((name) => name.startsWith("apply-plan-")));
});

test("batch apply refuses without confirmation, and exit 3 on original-tree drift", async (t) => {
  const env = await setup(t);
  await freeze(env);
  assert.equal(await env.run(["apply", "--manifest", env.manifestPath, "--apply"]), 2);

  await writeText(path.join(env.root, "src", "app.ts"), "export const app = 123;\n");
  assert.equal(
    await env.run(["apply", "--manifest", env.manifestPath, "--apply", "--confirm-dev-closed"]),
    3,
    "drift is a concurrency refusal (exit 3)",
  );
  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), "export const app = 123;\n");
});

test("batch apply with confirmation writes the tree, backs up, and records receipts", async (t) => {
  const env = await setup(t);
  await freeze(env);
  const backupDir = path.join(env.root, "artifacts", "test-backup");
  assert.equal(
    await env.run(["apply", "--manifest", env.manifestPath, "--apply", "--confirm-dev-closed", "--backup", backupDir]),
    0,
  );
  const payload = env.logger.lines.json.at(-1);
  assert.equal(payload.originalApplied, true);
  assert.match(payload.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.mismatches.length, 0);

  assert.equal(await readFile(path.join(env.root, "src", "app.ts"), "utf8"), CANDIDATE_APP);
  assert.equal(await readFile(path.join(env.root, "src", "new.ts"), "utf8"), "export const created = true;\n");
  assert.equal(await readFile(path.join(backupDir, "src", "app.ts"), "utf8"), ORIGINAL_APP);

  const names = await receiptNames(path.join(env.evidenceDir, "BATCH-01"));
  assert.ok(names.some((name) => name.startsWith("apply-2")), "apply receipt is durable");
  assert.ok(names.some((name) => name.startsWith("post-apply-verify-")));
});

test("batch manifest enforces allowed prefixes, traversal and absolute paths", async (t) => {
  const env = await setup(t);
  assert.equal(await env.run(["manifest", "--candidate", env.candidateRoot, "--paths", "secret/x.ts"]), 2);
  assert.match(env.logger.errorText(), /outside batch.allowedPrefixes/);
  assert.equal(await env.run(["manifest", "--candidate", env.candidateRoot, "--paths", "../escape.ts"]), 2);
  assert.match(env.logger.errorText(), /outside the project/);
  assert.equal(
    await env.run(["manifest", "--candidate", env.candidateRoot, "--paths", "D:/absolute/file.ts"]),
    2,
  );
  assert.match(env.logger.errorText(), /absolute path/);
});

test("batch manifest runs through the CLI dispatcher", async (t) => {
  const env = await setup(t);
  const logger = memoryLogger();
  const code = await runCli(
    ["batch", "manifest", "--candidate", env.candidateRoot, "--paths", "src/app.ts", "--batch", "CLI-01", "--cwd", env.root],
    { logger },
  );
  assert.equal(code, 0);
  assert.match(logger.text(), /batch=CLI-01/);
  const manifest = await readManifest(path.join(env.root, "artifacts", "agent-flow", "CLI-01-manifest.json"));
  assert.equal(manifest.files.length, 1);
});

test("batch without a sub-command prints usage and exits 2", async (t) => {
  const env = await setup(t);
  assert.equal(await env.run([]), 2);
  assert.match(env.logger.text(), /Usage: atk batch/);
  assert.equal(await env.run(["nope"]), 2);
});
