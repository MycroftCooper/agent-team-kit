// select-tests: plan classification, step expansion and output modes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext } from "../lib/context.mjs";
import { run, stepApplies } from "../lib/select-tests.mjs";

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

const GROUPS = {
  code: ["src/**/*.js", "src/**/*.ts"],
  docs: ["docs/**", "*.md"],
  scripts: ["scripts/**/*.mjs"],
  tests: ["tests/**"],
};

const STEPS = [
  {
    name: "ownership",
    phase: "preflight",
    command: ["node", "bin/ownership.mjs", "check"],
    roleFlag: true,
    filesFlag: true,
    when: { changed: true },
  },
  { name: "typecheck", phase: "main", command: ["node", "bin/typecheck.mjs"], when: { group: "code" } },
  {
    name: "script-syntax",
    phase: "main",
    command: ["node", "--check"],
    when: { group: "scripts" },
    files: { group: "scripts", mode: "each" },
  },
  { name: "docs-lint", phase: "main", command: "node --version", when: { group: "docs" } },
  { name: "unconditional", command: ["node", "-e", "process.exit(0)"] },
];

function config() {
  return {
    schemaVersion: 1,
    project: "select-fixture",
    language: "en",
    layout: { artifactDir: "artifacts/workflow" },
    roles: ["LEAD", "DEV", "QA"],
    gates: { fast: { parallel: true, groups: GROUPS, steps: STEPS }, quick: null, local: null },
    rotation: [],
  };
}

async function makeProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-select-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "agent-flow.config.json"), `${JSON.stringify(config(), null, 2)}\n`, "utf8");
  return root;
}

async function contextFor(root) {
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: root, logger });
  return { ctx, logger };
}

const FILES = ["src/a.js", "docs/b.md", "scripts/c.mjs", "src/d.test.js", "README.md", "misc/note.txt"];

test("classifies changed files by the configured group patterns", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  const code = await run(["--files", FILES.join(","), "--json"], ctx);
  assert.equal(code, 0);
  const plan = JSON.parse(logger.text());

  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.source, "explicit");
  assert.equal(typeof plan.generatedAt, "string");
  assert.equal(plan.changed.total, 6);
  assert.deepEqual(plan.changed.code, ["src/a.js", "src/d.test.js"]);
  assert.deepEqual(plan.changed.docs, ["README.md", "docs/b.md"]);
  assert.deepEqual(plan.changed.scripts, ["scripts/c.mjs"]);
  assert.deepEqual(plan.changed.tests, ["src/d.test.js"]);
  assert.equal(plan.changed.misc, undefined);
  assert.equal(plan.broad, false);
  assert.ok(plan.notes.some((note) => /match no configured group/i.test(note)), plan.notes.join("\n"));
});

test("builds commands from applicable main steps only", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  assert.equal(await run(["--files", FILES.join(","), "--json"], ctx), 0);
  const plan = JSON.parse(logger.text());

  assert.deepEqual(Object.keys(plan.commands), ["typecheck", "script-syntax", "docs-lint", "unconditional"]);
  assert.deepEqual(plan.commands.typecheck, ["node", "bin/typecheck.mjs"]);
  // each-mode: one expanded command line, run once per file by `atk gate fast`
  assert.deepEqual(plan.commands["script-syntax"], ["node", "--check", "scripts/c.mjs"]);
  // string command stays a string
  assert.equal(plan.commands["docs-lint"], "node --version");
  assert.deepEqual(plan.commands.unconditional, ["node", "-e", "process.exit(0)"]);
});

test("--plan prints the plan JSON and never executes a step", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  const code = await run(["--files", "src/a.js", "--plan"], ctx);
  assert.equal(code, 0);
  const plan = JSON.parse(logger.text());
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.source, "explicit");
  assert.deepEqual(plan.changed.code, ["src/a.js"]);
  assert.deepEqual(Object.keys(plan.commands), ["typecheck", "unconditional"]);
});

test("--quiet prints name: command lines only", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  const code = await run(["--files", FILES.join(","), "--quiet"], ctx);
  assert.equal(code, 0);
  const lines = logger.text().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(lines, [
    "typecheck: node bin/typecheck.mjs",
    "script-syntax: node --check scripts/c.mjs",
    "docs-lint: node --version",
    "unconditional: node -e process.exit(0)",
  ]);
});

test("marks a large change set as broad", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  const many = Array.from({ length: 25 }, (_, index) => `src/file-${index}.js`);
  assert.equal(await run(["--files", many.join(",")], ctx), 0);
  const plan = JSON.parse(logger.text());
  assert.equal(plan.broad, true);
  assert.ok(plan.notes.some((note) => /large change set/i.test(note)));
});

test("falls back to git collection when no files are given", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  // A bare temp directory is not a git work tree: the plan is empty, not an error.
  assert.equal(await run([], ctx), 0);
  const plan = JSON.parse(logger.text());
  assert.equal(plan.changed.total, 0);
  assert.equal(plan.source, undefined);
  assert.deepEqual(plan.changed.tests, []);
});

test("stepApplies honours group, changed and includingTests conditions", () => {
  const plan = { changed: { total: 1, code: [], tests: ["src/a.test.ts"] } };
  const base = { name: "step", command: ["node", "-e", "process.exit(0)"] };
  assert.equal(stepApplies(base, plan), true);
  assert.equal(stepApplies({ ...base, when: { changed: true } }, plan), true);
  assert.equal(stepApplies({ ...base, when: { group: "code" } }, plan), false);
  assert.equal(stepApplies({ ...base, when: { group: "code", includingTests: true } }, plan), true);
  assert.equal(stepApplies({ ...base, when: { changed: true } }, { changed: { total: 0, tests: [] } }), false);
});

test("prints usage for help flags", async (t) => {
  const root = await makeProject(t);
  const { ctx, logger } = await contextFor(root);
  assert.equal(await run(["help"], ctx), 2);
  assert.match(logger.text(), /usage: atk select-tests/i);

  const second = await contextFor(root);
  assert.equal(await run(["--help"], second.ctx), 2);
  assert.match(second.logger.text(), /usage: atk select-tests/i);
});
