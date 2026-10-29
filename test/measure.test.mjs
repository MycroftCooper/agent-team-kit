import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { run as runMeasure } from "../lib/measure.mjs";
import { readJsonl } from "../lib/util.mjs";
import { createProject, memoryLogger } from "./helpers.mjs";

async function setup(t) {
  const project = await createProject({});
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  t.after(() => rm(project.root, { recursive: true, force: true }));
  const metricsFile = path.join(project.root, "artifacts", "agent-flow", "metrics.jsonl");
  return { ...project, ctx, logger, metricsFile, run: (argv) => runMeasure(argv, ctx) };
}

test("measure record appends one typed JSONL row", async (t) => {
  const { run, metricsFile } = await setup(t);
  const code = await run([
    "record",
    "--batch",
    "BATCH-01",
    "--role",
    "dev",
    "--event",
    "entry",
    "--files",
    "3",
    "--tokens",
    "12000",
    "--rounds",
    "2",
    "--gateMs",
    "450",
    "--note",
    "first slice",
  ]);
  assert.equal(code, 0);
  const rows = await readJsonl(metricsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].batch, "BATCH-01");
  assert.equal(rows[0].role, "DEV", "roles are upper-cased");
  assert.equal(rows[0].event, "entry");
  assert.equal(rows[0].files, 3);
  assert.equal(rows[0].tokens, 12000);
  assert.equal(rows[0].rounds, 2);
  assert.equal(rows[0].gateMs, 450);
  assert.equal(rows[0].note, "first slice");
  assert.match(rows[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test("measure summary aggregates rows per batch, sorted and filterable", async (t) => {
  const { run, logger } = await setup(t);
  await run(["record", "--batch", "BATCH-02", "--role", "QA", "--event", "verify", "--tokens", "100"]);
  await run(["record", "--batch", "BATCH-01", "--role", "DEV", "--event", "entry", "--tokens", "200", "--rounds", "1"]);
  await run(["record", "--batch", "BATCH-01", "--role", "DEV", "--event", "freeze", "--gateMs", "90"]);

  assert.equal(await run(["summary"]), 0);
  const summary = logger.lines.json.at(-1);
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.samples, 3);
  assert.deepEqual(
    summary.batches.map((batch) => batch.batch),
    ["BATCH-01", "BATCH-02"],
    "batches are sorted for deterministic output",
  );
  const first = summary.batches.find((batch) => batch.batch === "BATCH-01");
  assert.equal(first.events, 2);
  assert.equal(first.tokens, 200);
  assert.equal(first.rounds, 1);
  assert.equal(first.gateMs, 90);

  await run(["summary", "--batch", "BATCH-02"]);
  const filtered = logger.lines.json.at(-1);
  assert.equal(filtered.samples, 1);
  assert.equal(filtered.batches.length, 1);
});

test("measure summary without data is a clean empty report", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["summary"]), 0);
  const summary = logger.lines.json.at(-1);
  assert.deepEqual(summary.batches, []);
  assert.equal(summary.samples, 0);
});

test("measure record rejects missing required flags and non-numeric values", async (t) => {
  const { run, logger } = await setup(t);
  assert.equal(await run(["record", "--batch", "BATCH-01"]), 2);
  assert.match(logger.errorText(), /--batch, --role and --event are required/);

  assert.equal(await run(["record", "--batch", "BATCH-01", "--role", "DEV", "--event", "entry", "--tokens", "lots"]), 2);
  assert.match(logger.errorText(), /must be a number/);

  assert.equal(await run([]), 2);
  assert.match(logger.text(), /Usage: atk measure/);
});

test("measure keeps an append-only log across calls", async (t) => {
  const { run, metricsFile } = await setup(t);
  await run(["record", "--batch", "BATCH-01", "--role", "DEV", "--event", "entry"]);
  await run(["record", "--batch", "BATCH-01", "--role", "QA", "--event", "verify"]);
  const text = await readFile(metricsFile, "utf8");
  assert.equal(text.split(/\r?\n/).filter(Boolean).length, 2);
});
