// docs rotate: dry run, apply (sections + narrative), pointer line, archive
// creation, and the stat-based concurrency guard.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext } from "../lib/context.mjs";
import { isUnchanged, run, splitSections } from "../lib/docs.mjs";

function memoryLogger() {
  const out = [];
  const err = [];
  const logger = {
    out: (text = "") => out.push(String(text)),
    err: (text = "") => err.push(String(text)),
    json: (value) => out.push(JSON.stringify(value, null, 2)),
    fail: (text) => err.push(String(text)),
  };
  logger.text = () => out.join("\n");
  logger.errors = () => err.join("\n");
  return logger;
}

const HANDOFF = [
  "# Handoff",
  "",
  "Intro text.",
  "",
  "## Newest",
  "A content.",
  "",
  "## Older",
  "B content.",
  "",
  "## Oldest",
  "C content.",
  "",
].join("\n");

const TODO = [
  "# Todo",
  "",
  "## Narrative A",
  "alpha",
  "",
  "## Narrative B",
  "beta",
  "",
  "## Ledger",
  "| id | status |",
  "| --- | --- |",
  "| T1 | open |",
  "",
].join("\n");

function config(rotation) {
  return {
    schemaVersion: 1,
    project: "docs-fixture",
    language: "en",
    layout: { artifactDir: "artifacts/workflow" },
    roles: ["LEAD", "DEV", "QA"],
    gates: { fast: { groups: {}, steps: [] }, quick: null, local: null },
    rotation,
  };
}

const DEFAULT_ROTATION = [
  {
    path: "docs/handoff.md",
    archiveDir: "docs/archive",
    archivePrefix: "handoff",
    keep: 1,
    mode: "sections",
    headingLevel: 2,
  },
  {
    path: "docs/todo.md",
    archiveDir: "docs/archive",
    archivePrefix: "todo-narrative",
    mode: "narrative",
    startMarker: "Ledger",
    flavor: "todo",
  },
];

async function makeProject(t, rotation = DEFAULT_ROTATION) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-docs-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "agent-flow.config.json"), `${JSON.stringify(config(rotation), null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "docs", "handoff.md"), HANDOFF, "utf8");
  await writeFile(path.join(root, "docs", "todo.md"), TODO, "utf8");
  return root;
}

async function contextFor(root) {
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: root, logger });
  return { ctx, logger };
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

test("dry run reports the rotation and writes nothing", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  const code = await run(["rotate"], ctx);
  assert.equal(code, 0);

  const report = JSON.parse(logger.text());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.dryRun, true);
  assert.equal(report.entries.length, 2);

  const handoff = report.entries.find((entry) => entry.path === "docs/handoff.md");
  assert.equal(handoff.mode, "sections");
  assert.equal(handoff.keep, 1);
  assert.equal(handoff.movedSections, 2);
  assert.equal(handoff.status, "would-rotate");
  assert.equal(handoff.archiveFile, `docs/archive/handoff-${monthKey()}.md`);

  const todo = report.entries.find((entry) => entry.path === "docs/todo.md");
  assert.equal(todo.mode, "narrative");
  assert.equal(todo.movedSections, 2);
  assert.equal(todo.status, "would-rotate");

  // Nothing written: live files untouched, archive dir does not exist.
  assert.equal(await readFile(path.join(root, "docs", "handoff.md"), "utf8"), HANDOFF);
  assert.equal(await readFile(path.join(root, "docs", "todo.md"), "utf8"), TODO);
  await assert.rejects(stat(path.join(root, "docs", "archive")));
});

test("apply rotates sections, leaves a pointer and appends to the archive", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  const code = await run(["rotate", "--apply", "--entry", "docs/handoff.md", "--keep", "1"], ctx);
  assert.equal(code, 0, logger.errors());

  const report = JSON.parse(logger.text());
  assert.equal(report.dryRun, false);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].status, "rotated");

  const live = await readFile(path.join(root, "docs", "handoff.md"), "utf8");
  assert.match(live, /^# Handoff/);
  assert.match(live, /## Newest/);
  assert.doesNotMatch(live, /## Older/);
  assert.doesNotMatch(live, /## Oldest/);
  // Pointer line references the archive file.
  assert.match(live, new RegExp(`Rotated .*handoff-${monthKey()}\\.md`));

  const archive = await readFile(path.join(root, "docs", "archive", `handoff-${monthKey()}.md`), "utf8");
  assert.match(archive, /## Older/);
  assert.match(archive, /## Oldest/);
  assert.match(archive, /B content\./);
  // The untouched entry is left alone in this run.
  assert.equal(await readFile(path.join(root, "docs", "todo.md"), "utf8"), TODO);
});

test("apply rotates the narrative zone selected by --flavor", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  const code = await run(["rotate", "--apply", "--flavor", "todo"], ctx);
  assert.equal(code, 0, logger.errors());

  const report = JSON.parse(logger.text());
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].mode, "narrative");
  assert.equal(report.entries[0].status, "rotated");

  const live = await readFile(path.join(root, "docs", "todo.md"), "utf8");
  assert.match(live, /^# Todo/);
  assert.match(live, /## Ledger/);
  assert.doesNotMatch(live, /## Narrative A/);
  assert.doesNotMatch(live, /## Narrative B/);
  assert.match(live, /Rotated .*todo-narrative-/);

  const archive = await readFile(path.join(root, "docs", "archive", `todo-narrative-${monthKey()}.md`), "utf8");
  assert.match(archive, /## Narrative A/);
  assert.match(archive, /## Narrative B/);
  assert.match(archive, /alpha/);

  // The sections entry was not selected.
  assert.equal(await readFile(path.join(root, "docs", "handoff.md"), "utf8"), HANDOFF);
});

test("--keep overriding the section count can make rotation a no-op", async (t) => {
  const root = await makeProject(t);
  const dry = await contextFor(root);
  assert.equal(await run(["rotate", "--entry", "docs/handoff.md", "--keep", "5"], dry.ctx), 0);
  const dryReport = JSON.parse(dry.logger.text());
  assert.equal(dryReport.entries[0].movedSections, 0);
  assert.equal(dryReport.entries[0].status, "no-op");

  const applied = await contextFor(root);
  assert.equal(await run(["rotate", "--apply", "--entry", "docs/handoff.md", "--keep", "5"], applied.ctx), 0);
  assert.equal(await readFile(path.join(root, "docs", "handoff.md"), "utf8"), HANDOFF);
  await assert.rejects(stat(path.join(root, "docs", "archive")));
});

test("reports a clear error when a narrative marker is missing", async (t) => {
  const rotation = [
    {
      path: "docs/todo.md",
      archiveDir: "docs/archive",
      archivePrefix: "todo-narrative",
      mode: "narrative",
      startMarker: "NotThere",
    },
  ];
  const root = await makeProject(t, rotation);
  const { ctx, logger } = await contextFor(root);
  const code = await run(["rotate", "--apply"], ctx);
  assert.equal(code, 1);
  const report = JSON.parse(logger.text());
  assert.equal(report.entries[0].status, "error");
  assert.match(report.entries[0].error, /startMarker/i);
  assert.equal(await readFile(path.join(root, "docs", "todo.md"), "utf8"), TODO);
});

test("reports a clear error when a configured file is missing", async (t) => {
  const rotation = [
    { path: "docs/missing.md", archiveDir: "docs/archive", archivePrefix: "missing", mode: "sections" },
  ];
  const root = await makeProject(t, rotation);
  const { ctx, logger } = await contextFor(root);
  assert.equal(await run(["rotate"], ctx), 1);
  const report = JSON.parse(logger.text());
  assert.equal(report.entries[0].status, "error");
  assert.match(report.entries[0].error, /cannot read/i);
});

test("isEmpty rotation config prints a note instead of failing", async (t) => {
  const root = await makeProject(t, []);
  const { ctx, logger } = await contextFor(root);
  assert.equal(await run(["rotate"], ctx), 0);
  assert.match(logger.text(), /no rotation entries configured/i);
});

test("usage and unknown sub-commands", async (t) => {
  const root = await makeProject(t);
  const help = await contextFor(root);
  assert.equal(await run(["help"], help.ctx), 2);
  assert.match(help.logger.text(), /usage: atk docs rotate/i);

  const missing = await contextFor(root);
  assert.equal(await run([], missing.ctx), 2);

  const unknown = await contextFor(root);
  assert.equal(await run(["nope"], unknown.ctx), 2);

  const badKeep = await contextFor(root);
  assert.equal(await run(["rotate", "--keep", "nope"], badKeep.ctx), 2);

  const noMatch = await contextFor(root);
  assert.equal(await run(["rotate", "--flavor", "absent"], noMatch.ctx), 2);
});

test("stat guard detects a file changed after it was read", async (t) => {
  const root = await makeProject(t);
  const live = path.join(root, "docs", "handoff.md");
  const before = await stat(live);
  assert.equal(await isUnchanged(live, before), true);

  // Simulate another writer: different size (and mtime) after the read.
  await writeFile(live, `${HANDOFF}\nextra line\n`, "utf8");
  assert.equal(await isUnchanged(live, before), false);

  // Missing file is treated as changed (refuse to write).
  await rm(live);
  assert.equal(await isUnchanged(live, before), false);
});

test("splitSections keeps the header and splits on the configured heading level", () => {
  const lines = ["# Top", "", "## One", "a", "### Nested", "b", "## Two", "c"];
  const { header, sections } = splitSections(lines, 2);
  assert.deepEqual(header, ["# Top", ""]);
  assert.deepEqual(
    sections.map((section) => section.title),
    ["One", "Two"],
  );
  assert.deepEqual(sections[0].lines, ["## One", "a", "### Nested", "b"]);

  const level3 = splitSections(lines, 3);
  assert.deepEqual(
    level3.sections.map((section) => section.title),
    ["Nested"],
  );
  assert.deepEqual(level3.header, ["# Top", "", "## One", "a"]);
});
