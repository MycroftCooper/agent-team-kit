import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { runCli } from "../lib/dispatch.mjs";
import { run as runSync } from "../lib/sync.mjs";
import { readJsonl } from "../lib/util.mjs";
import { createProject, memoryLogger, minimalOwnership } from "./helpers.mjs";

const BACKLOG = [
  "# Backlog",
  "",
  "## Unique task table",
  "",
  "| ID | Type | Owner | Module | Status | Priority | Evidence | Accept | Deps |",
  "|---|---|---|---|---|---|---|---|---|",
  "| PKG-01 | Feature | DEV | core: cli | Implemented | P1 | | ship the cli | |",
  "| PKG-02 | Feature | DEV | board: render | Implemented | P2 | | render it | |",
  "",
].join("\n");

const INITIAL_STATE = {
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00+00:00",
  batch: {
    id: "BATCH-01",
    goal: "ship the toolkit",
    stopCondition: "all gates green",
    slices: [{ id: "S1", label: "one", status: "in_progress", owner: "DEV", exit: "gates pass", qaPassed: null, applied: null }],
  },
  packages: [],
  subitems: [],
};

async function setup(t, options = {}) {
  const project = await createProject({
    config: {
      language: "en",
      paths: { todoSource: "backlog.md", ...(options.paths ?? {}) },
      import: { stagePatterns: [["Implemented", "implemented"]], typePatterns: [["Feature", "feature"]] },
      ...(options.config ?? {}),
    },
    files: {
      "backlog.md": BACKLOG,
      "flow/ownership.json": minimalOwnership(),
      "flow/state.json": INITIAL_STATE,
      "src/app.ts": "export const app = 1;\n",
      ...(options.files ?? {}),
    },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  return { ...project, ctx, logger, run: (argv) => runSync(argv, ctx) };
}

test("sync runs import -> evidence -> boards -> measure -> check in one command", async (t) => {
  const env = await setup(t);
  assert.equal(await env.run([]), 0);
  assert.equal(env.logger.lines.out.length, 1, "sync prints exactly one summary line");
  assert.match(env.logger.text(), /^sync ok \d+ms \| packages 2 \| slices 1 \| warnings \d+ \| board refreshed$/);

  const state = JSON.parse(await readFile(path.join(env.root, "flow", "state.json"), "utf8"));
  assert.equal(state.packages.length, 2, "import rebuilt packages from the backlog");
  assert.equal(state.batch.id, "BATCH-01", "import preserved the active batch");
  assert.equal((await stat(path.join(env.root, "flow", "board.md"))).isFile(), true, "state board rendered");
  assert.equal((await stat(path.join(env.root, "flow", "board.html"))).isFile(), true, "html board rendered");

  const metrics = await readJsonl(path.join(env.root, "artifacts", "agent-flow", "metrics.jsonl"));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].event, "sync");
  assert.equal(metrics[0].batch, "BATCH-01");
  assert.ok(metrics[0].gateMs >= 0, "sync records its own wall-clock time");
});

test("sync --quiet still prints exactly the summary line", async (t) => {
  const env = await setup(t);
  assert.equal(await env.run(["--quiet"]), 0);
  assert.equal(env.logger.lines.out.length, 1);
  assert.match(env.logger.text(), /^sync ok /);
});

test("sync exits 1 when a middle pipeline step fails", async (t) => {
  const env = await setup(t, { paths: { boardHtml: "board-dir" } });
  await mkdir(path.join(env.root, "board-dir"));
  assert.equal(await env.run(["--quiet"]), 1);
  assert.match(env.logger.text(), /^sync failed at board-html/);
});

test("sync exits 1 when the final state check is not green", async (t) => {
  const badState = {
    ...INITIAL_STATE,
    batch: { ...INITIAL_STATE.batch, slices: [{ id: "S1", status: "nonsense" }] },
  };
  const env = await setup(t, { files: { "flow/state.json": badState } });
  // Import keeps the previous batch, so the last `state check` sees the broken slice.
  assert.equal(await env.run([]), 1);
  assert.match(env.logger.text(), /^sync failed at check/);
});

test("sync skips the import step when no backlog is configured", async (t) => {
  const project = await createProject({
    config: { language: "en" },
    files: { "flow/state.json": INITIAL_STATE },
  });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  assert.equal(await runSync([], ctx), 0);
  assert.match(logger.text(), /^sync ok /);
  assert.match(logger.errorText(), /skipped import/);
});

test("sync runs end-to-end through the CLI dispatcher", async (t) => {
  const env = await setup(t);
  const logger = memoryLogger();
  const code = await runCli(["sync", "--quiet", "--cwd", env.root], { logger });
  assert.equal(code, 0);
  assert.match(logger.text(), /^sync ok /);
});

test("sync help exits 2 with usage", async (t) => {
  const env = await setup(t);
  assert.equal(await env.run(["help"]), 2);
  assert.match(env.logger.text(), /Usage: atk sync/);
});
