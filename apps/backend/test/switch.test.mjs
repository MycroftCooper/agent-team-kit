// M6 export/import CLI: readable JSON round-trip, merge/replace semantics and
// the transactional failure path (a bad record must never corrupt the target).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

let database = null;
try {
  database = await import("@atk/database");
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "atk-switch-probe-"));
  const probe = database.openStore({ file: path.join(probeDir, "probe.db"), migrate: true });
  probe.close();
  fs.rmSync(probeDir, { recursive: true, force: true });
} catch {
  database = null;
}
const DB_SKIP = database === null ? "@atk/database is not available/healthy in this checkout" : false;

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000, windowsHide: true });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atk-switch-"));
}

function seedDatabase(dir, name, taskIds) {
  const file = path.join(dir, name);
  const store = database.openStore({ file, migrate: true });
  try {
    store.createProject({ id: "P-1", name: "Demo", repoPath: "C:\\repo", defaultBranch: "main" });
    for (const id of taskIds) {
      store.createTask({
        id,
        projectId: "P-1",
        title: `Task ${id}`,
        description: "d",
        functionRequired: "WORKER",
        roleRequired: "BE",
        priority: 2,
        deps: [],
      });
    }
  } finally {
    store.close();
  }
  return file;
}

function taskIds(file) {
  const store = database.openStore({ file, migrate: false });
  try {
    return store.listTasks({}).map((task) => task.id).sort();
  } finally {
    store.close();
  }
}

function contentHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("export writes the readable { stateJson, runtime, manifest } document", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, "source.db", ["T-1", "T-2"]);
  const out = path.join(dir, "state.json");
  const result = runCli(["export", "--data", source, "--to", out, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "export");
  assert.equal(output.to, out);

  const document = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(document).sort(), ["exportedAt", "manifest", "runtime", "stateJson"]);
  assert.equal(document.stateJson.schemaVersion, 1);
  assert.equal(document.stateJson.project.id, "P-1");
  assert.equal(document.stateJson.packages.length, 2);
  assert.equal(document.stateJson.counts.total, 2);
  assert.equal(document.runtime.schemaVersion, 3);
  assert.ok(Array.isArray(document.runtime.agents));
  assert.equal(document.manifest.projectId, "P-1");
  assert.equal(document.manifest.counts.tasks, 2);
  assert.equal(typeof document.manifest.contentHash, "string");
  assert.equal(output.manifest.contentHash, document.manifest.contentHash);
});

test("export -> import(merge) round-trips task identity; a second export is stable", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, "source.db", ["T-1", "T-2"]);
  const first = path.join(dir, "first.json");
  assert.equal(runCli(["export", "--data", source, "--to", first]).status, 0);

  const merged = path.join(dir, "merged.db");
  const imported = runCli(["import", "--from", first, "--data", merged, "--mode", "merge", "--json"]);
  assert.equal(imported.status, 0, imported.stderr);
  const report = JSON.parse(imported.stdout);
  assert.equal(report.command, "import");
  assert.equal(report.mode, "merge");
  assert.equal(report.report.status, "PASS");
  assert.deepEqual(taskIds(merged), ["T-1", "T-2"]);

  const second = path.join(dir, "second.json");
  assert.equal(runCli(["export", "--data", merged, "--to", second]).status, 0);
  const firstDoc = JSON.parse(fs.readFileSync(first, "utf8"));
  const secondDoc = JSON.parse(fs.readFileSync(second, "utf8"));
  assert.deepEqual(secondDoc.stateJson.packages.map((item) => item.id), firstDoc.stateJson.packages.map((item) => item.id));
  assert.equal(secondDoc.manifest.counts.tasks, firstDoc.manifest.counts.tasks);
});

test("replace refuses a non-empty database without --force and replaces it with --force", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, "source.db", ["T-1", "T-2"]);
  const out = path.join(dir, "state.json");
  assert.equal(runCli(["export", "--data", source, "--to", out]).status, 0);

  const target = seedDatabase(dir, "target.db", ["OLD-1"]);
  const before = contentHash(target);
  const refused = runCli(["import", "--from", out, "--data", target, "--mode", "replace"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /requires --force/);
  assert.equal(contentHash(target), before, "a refused replace must not touch the target");
  assert.deepEqual(taskIds(target), ["OLD-1"]);

  const replaced = runCli(["import", "--from", out, "--data", target, "--mode", "replace", "--force", "--json"]);
  assert.equal(replaced.status, 0, replaced.stderr);
  const report = JSON.parse(replaced.stdout);
  assert.equal(report.mode, "replace");
  assert.equal(report.forced, true);
  assert.equal(report.report.status, "PASS");
  assert.deepEqual(taskIds(target), ["T-1", "T-2"], "replace removes stale rows and imports the file exactly");
});

test("a bad record rolls the whole replace back and leaves the target untouched", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, "source.db", ["T-1", "T-2"]);
  const out = path.join(dir, "state.json");
  assert.equal(runCli(["export", "--data", source, "--to", out]).status, 0);

  const broken = JSON.parse(fs.readFileSync(out, "utf8"));
  broken.stateJson.packages[0].id = "not a valid id!";
  const brokenFile = path.join(dir, "broken.json");
  fs.writeFileSync(brokenFile, `${JSON.stringify(broken, null, 2)}\n`, "utf8");

  const target = seedDatabase(dir, "target.db", ["OLD-1", "OLD-2"]);
  const before = contentHash(target);
  const result = runCli(["import", "--from", brokenFile, "--data", target, "--mode", "replace", "--force", "--json"]);
  // CI only reads the exit code: a non-PASS report (SKIPPED/FAIL) must never
  // look like success.
  assert.equal(result.status, 1, `bad record must exit 1: ${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.notEqual(parsed.report.status, "PASS");
  assert.ok(Array.isArray(parsed.report.problems) && parsed.report.problems.length > 0);
  assert.equal(contentHash(target), before, "a failed replace must roll back every write");
  assert.deepEqual(taskIds(target), ["OLD-1", "OLD-2"]);
});

test("a rejected write-phase import exits non-zero with SKIPPED + IMPORT_WRITE_FAILED (no fake success)", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const target = seedDatabase(dir, "target.db", ["OLD-1", "OLD-2"]);
  const before = contentHash(target);
  const beforeTasks = taskIds(target);

  // A non-empty legacy task collection that the old importer used to ignore:
  // it must be refused BEFORE the clear phase, not silently "succeed" with an
  // empty import (that was the M6 gate's data-loss bug).
  const brokenFile = path.join(dir, "broken-write.json");
  fs.writeFileSync(
    brokenFile,
    `${JSON.stringify({
      stateJson: {
        schemaVersion: 1,
        project: { id: "BROKEN", name: "broken" },
        batch: { id: "B", tasks: [{ id: "DUP", status: "READY" }, { id: "DUP", status: "READY" }] },
        packages: [],
        subitems: [],
        slices: [],
        counts: {},
      },
      runtime: { schemaVersion: 3, agents: [] },
    })}\n`,
    "utf8",
  );

  const result = runCli(["import", "--from", brokenFile, "--data", target, "--mode", "replace", "--force", "--json"]);
  // Scripts/CI only see the exit code: SKIPPED must never look like success.
  assert.equal(result.status, 1, `a write-phase failure must exit 1: ${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.report.status, "SKIPPED");
  assert.ok(
    parsed.report.problems.some((problem) => problem.code === "IMPORT_WRITE_FAILED"),
    `expected IMPORT_WRITE_FAILED, got ${JSON.stringify(parsed.report.problems)}`,
  );
  assert.equal(contentHash(target), before, "the failed replace must not clear or rewrite the database");
  assert.deepEqual(taskIds(target), beforeTasks);
});

test("import usage errors exit 2; human output names mode/status", { skip: DB_SKIP }, () => {
  const dir = tempDir();
  const source = seedDatabase(dir, "source.db", ["T-1"]);
  const out = path.join(dir, "state.json");
  assert.equal(runCli(["export", "--data", source, "--to", out]).status, 0);

  assert.equal(runCli(["import", "--data", path.join(dir, "x.db")]).status, 2, "missing --from");
  assert.equal(runCli(["import", "--from", out, "--data", path.join(dir, "x.db"), "--mode", "nope"]).status, 2, "bad mode");
  assert.equal(runCli(["export", "--data", source]).status, 2, "missing --to");

  const merged = path.join(dir, "merged.db");
  const human = runCli(["import", "--from", out, "--data", merged]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /import PASS \(mode: merge\)/);
  assert.match(human.stdout, /counts:/);
});
