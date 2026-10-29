import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { run as runBaseline } from "../lib/baseline.mjs";
import { writeText } from "../lib/util.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

const BASELINE_CONFIG = { baseline: { roots: ["src"] } };

async function setup(t, options = {}) {
  const project = await createProject({
    config: { ...BASELINE_CONFIG, ...(options.config ?? {}) },
    files: options.files ?? {
      "src/a.ts": "export const a = 1;\n",
      "src/sub/b.ts": "export const b = 2;\n",
    },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  const baselinePath = path.join(project.root, "artifacts", "agent-flow", "baseline.json");
  return { ...project, ctx, logger, baselinePath, run: (argv) => runBaseline(argv, ctx) };
}

test("baseline start records content hashes and changed detects new/modified/deleted files", async (t) => {
  const { run, logger, baselinePath, root, ctx } = await setup(t);
  assert.equal(await run(["start"]), 0);
  assert.match(logger.text(), /baseline recorded: 2 file/);

  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  assert.equal(baseline.schemaVersion, 1);
  assert.match(baseline.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(baseline.files).sort(), ["src/a.ts", "src/sub/b.ts"]);
  assert.equal(ctx.relOf(baselinePath), "artifacts/agent-flow/baseline.json");

  assert.equal(await run(["changed", "--json"]), 0);
  assert.deepEqual(logger.lines.json.at(-1), {
    startedAt: baseline.startedAt,
    count: 0,
    files: [],
  });

  await writeText(path.join(root, "src", "new.ts"), "export const c = 3;\n");
  await writeText(path.join(root, "src", "a.ts"), "export const a = 99;\n");
  await rm(path.join(root, "src", "sub", "b.ts"));
  assert.equal(await run(["changed", "--json"]), 0);
  const changed = logger.lines.json.at(-1);
  assert.equal(changed.count, 3);
  assert.deepEqual(changed.files, ["src/a.ts", "src/new.ts", "src/sub/b.ts"]);
});

test("baseline changed tells the operator to start a baseline first", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["changed"]), 2);
  assert.match(logger.errorText(), /no baseline yet/);
});

test("baseline status reports existence without requiring a baseline", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["status"]), 0);
  assert.deepEqual(logger.lines.json.at(-1), { exists: false, startedAt: null, files: 0 });
  await run(["start"]);
  assert.equal(await run(["status"]), 0);
  const status = logger.lines.json.at(-1);
  assert.equal(status.exists, true);
  assert.equal(status.files, 2);
});

test("baseline roots fall back to batch.allowedPrefixes", async (t) => {
  const project = await createProject({
    config: { batch: { allowedPrefixes: ["src", "docs"] } },
    files: {
      "src/a.ts": "a\n",
      "docs/guide.md": "# guide\n",
      "tests/ignored.ts": "ignored\n",
    },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  assert.equal(await runBaseline(["start"], ctx), 0);
  const baseline = JSON.parse(
    await readFile(path.join(project.root, "artifacts", "agent-flow", "baseline.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(baseline.files).sort(), ["docs/guide.md", "src/a.ts"]);
});

test("baseline start is deterministic for unchanged content", async (t) => {
  const { run, baselinePath, root } = await setup(t);
  await run(["start"]);
  const first = JSON.parse(await readFile(baselinePath, "utf8"));
  await run(["start"]);
  const second = JSON.parse(await readFile(baselinePath, "utf8"));
  assert.deepEqual(first.files, second.files);
  await writeFile(path.join(root, "src", "a.ts"), "changed\n");
  await run(["start"]);
  const third = JSON.parse(await readFile(baselinePath, "utf8"));
  assert.notEqual(third.files["src/a.ts"], first.files["src/a.ts"]);
});
