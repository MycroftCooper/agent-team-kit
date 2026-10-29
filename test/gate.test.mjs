// Gate runner tests. Throwaway projects with harmless node commands only, so
// the suite stays fast and cross-platform.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { createContext } from "../lib/context.mjs";
import { run } from "../lib/gate.mjs";

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

function baseConfig(gates) {
  return {
    schemaVersion: 1,
    project: "gate-fixture",
    language: "en",
    layout: { artifactDir: "artifacts/gates" },
    roles: ["LEAD", "DEV", "QA"],
    gates,
  };
}

/** A tiny argument recorder: node scripts/args.mjs <out> <args...> appends a line. */
const ARGS_SCRIPT = [
  'import { appendFileSync } from "node:fs";',
  "appendFileSync(process.argv[2], `${process.argv.slice(3).join(',')}\\n`);",
  "",
].join("\n");

async function makeProject(t, config, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-gate-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "agent-flow.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const all = { "scripts/args.mjs": ARGS_SCRIPT, ...files };
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

async function contextFor(root) {
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: root, logger });
  return { ctx, logger };
}

const reportPath = (root) => path.join(root, "artifacts", "gates", "ci-fast-latest.json");

async function readReport(root) {
  return JSON.parse(await readFile(reportPath(root), "utf8"));
}

async function readLines(root, rel) {
  const text = await readFile(path.join(root, rel), "utf8");
  return text.split(/\r?\n/).filter(Boolean);
}

test("gate fast runs applicable steps and writes the report", async (t) => {
  const root = await makeProject(
    t,
    baseConfig({
      fast: {
        parallel: true,
        groups: { code: ["src/**/*.js"], docs: ["docs/**"] },
        steps: [
          { name: "preflight-state", phase: "preflight", command: ["node", "-e", "process.exit(0)"], when: { changed: true } },
          { name: "lint", phase: "main", command: ["node", "-e", "process.exit(0)"], when: { group: "code" } },
          { name: "docs", phase: "main", command: "node --version", when: { group: "docs" } },
        ],
      },
      quick: null,
      local: null,
    }),
  );
  const { ctx, logger } = await contextFor(root);

  const code = await run(["fast", "--files", "src/a.js"], ctx);
  assert.equal(code, 0);

  const report = await readReport(root);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, true);
  assert.equal(report.role, null);
  assert.equal(report.scope.total, 1);
  assert.deepEqual(
    report.steps.map((step) => step.name),
    ["preflight-state", "lint"],
  );
  assert.ok(report.steps.every((step) => step.status === "passed" && step.exitCode === 0));
  assert.equal(typeof report.durationMs, "number");
  assert.equal(typeof report.note, "string");

  const printed = JSON.parse(logger.text());
  assert.equal(printed.ok, true);
});

test("gate fast fails when a main step exits non-zero", async (t) => {
  const root = await makeProject(
    t,
    baseConfig({
      fast: {
        parallel: true,
        groups: { code: ["src/**/*.js"] },
        steps: [{ name: "boom", phase: "main", command: ["node", "-e", "process.exit(1)"], when: { group: "code" } }],
      },
    }),
    { "src/a.js": "export const a = 1;\n" },
  );
  const { ctx } = await contextFor(root);
  const code = await run(["fast", "--files", "src/a.js"], ctx);
  assert.equal(code, 1);
  const report = await readReport(root);
  assert.equal(report.ok, false);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].status, "failed");
  assert.equal(report.steps[0].exitCode, 1);
});

test("gate fast aborts main steps when a preflight step fails", async (t) => {
  const root = await makeProject(
    t,
    baseConfig({
      fast: {
        parallel: true,
        groups: {},
        steps: [
          { name: "preflight-bad", phase: "preflight", command: ["node", "-e", "process.exit(1)"], when: { changed: true } },
          {
            name: "main-writes-marker",
            phase: "main",
            command: ["node", "-e", "require('fs').writeFileSync('main-ran.txt','yes')"],
          },
        ],
      },
    }),
  );
  const { ctx } = await contextFor(root);
  const code = await run(["fast", "--files", "src/a.js"], ctx);
  assert.equal(code, 1);
  const report = await readReport(root);
  assert.equal(report.ok, false);
  assert.equal(report.stoppedAt, "preflight");
  assert.deepEqual(
    report.steps.map((step) => step.name),
    ["preflight-bad"],
  );
  await assert.rejects(stat(path.join(root, "main-ran.txt")));
});

test("gate fast appends --role and --files for roleFlag/filesFlag steps", async (t) => {
  const root = await makeProject(
    t,
    baseConfig({
      fast: {
        parallel: true,
        groups: { code: ["src/**/*.js"] },
        steps: [
          {
            name: "role-step",
            phase: "preflight",
            command: ["node", "scripts/args.mjs", "role.txt"],
            roleFlag: true,
            when: { changed: true },
          },
          {
            name: "files-step",
            phase: "preflight",
            command: ["node", "scripts/args.mjs", "files.txt"],
            filesFlag: true,
            when: { changed: true },
          },
        ],
      },
    }),
  );
  const { ctx } = await contextFor(root);
  const code = await run(["fast", "--files", "src/a.js,src/b.js", "--role", "dev"], ctx);
  assert.equal(code, 0);
  assert.deepEqual(await readLines(root, "role.txt"), ["--role,DEV"]);
  assert.deepEqual(await readLines(root, "files.txt"), ["--files,src/a.js,src/b.js"]);
});

test("gate fast appends classified files, uses fallback globs, and runs each-mode per file", async (t) => {
  const root = await makeProject(
    t,
    baseConfig({
      fast: {
        parallel: true,
        groups: { code: ["src/**/*.js"], scripts: ["scripts/**/*.mjs"] },
        steps: [
          {
            name: "append-files",
            phase: "main",
            command: ["node", "scripts/args.mjs", "append.txt"],
            when: { group: "code" },
            files: { group: "code", mode: "append" },
          },
          {
            name: "append-fallback",
            phase: "main",
            command: ["node", "scripts/args.mjs", "fallback.txt"],
            files: { group: "docs", mode: "append", fallback: ["src/**/*.js"] },
          },
          {
            name: "check-each",
            phase: "main",
            command: ["node", "scripts/args.mjs", "each.txt"],
            when: { group: "scripts" },
            files: { group: "scripts", mode: "each" },
          },
        ],
      },
    }),
    { "src/a.js": "", "src/b.js": "", "scripts/a.mjs": "", "scripts/b.mjs": "" },
  );
  const { ctx } = await contextFor(root);
  const code = await run(
    ["fast", "--files", "src/a.js,src/b.js,scripts/a.mjs,scripts/b.mjs"],
    ctx,
  );
  assert.equal(code, 0, await readFile(path.join(root, "artifacts", "gates", "ci-fast-latest.json"), "utf8"));
  assert.deepEqual(await readLines(root, "append.txt"), ["src/a.js,src/b.js"]);
  // No docs files changed, so the fallback globs are appended instead.
  assert.deepEqual(await readLines(root, "fallback.txt"), ["src/**/*.js"]);
  // each-mode runs the command once per file.
  assert.deepEqual(await readLines(root, "each.txt"), ["scripts/a.mjs", "scripts/b.mjs"]);
});

test("gate fast --plan prints planned steps and runs nothing", async (t) => {
  const root = await makeProject(
    t,
    baseConfig({
      fast: {
        parallel: true,
        groups: { code: ["src/**/*.js"] },
        steps: [
          { name: "preflight", phase: "preflight", command: ["node", "-e", "process.exit(0)"], when: { changed: true } },
          { name: "lint", phase: "main", command: ["node", "-e", "process.exit(0)"], when: { group: "code" } },
        ],
      },
    }),
  );
  const { ctx, logger } = await contextFor(root);
  const code = await run(["fast", "--files", "src/a.js", "--plan"], ctx);
  assert.equal(code, 0);
  const plan = JSON.parse(logger.text());
  assert.equal(plan.planOnly, true);
  assert.equal(plan.role, null);
  assert.deepEqual(
    plan.steps.map((step) => step.name),
    ["preflight", "lint"],
  );
  assert.ok(plan.steps.every((step) => typeof step.command === "string"));
  await assert.rejects(stat(reportPath(root)));
});

test("gate fast without steps prints a note and succeeds", async (t) => {
  const root = await makeProject(
    t,
    baseConfig({ fast: { parallel: true, groups: {}, steps: [] }, quick: null, local: null }),
  );
  const { ctx, logger } = await contextFor(root);
  const code = await run(["fast"], ctx);
  assert.equal(code, 0);
  assert.match(logger.text(), /no fast gate steps configured/i);
  await assert.rejects(stat(reportPath(root)));
});

test("quick gate prints a note when no command is configured", async (t) => {
  const root = await makeProject(t, baseConfig({ fast: { groups: {}, steps: [] }, quick: null, local: null }));
  const { ctx, logger } = await contextFor(root);
  const code = await run(["quick"], ctx);
  assert.equal(code, 0);
  assert.match(logger.text(), /no quick command configured/i);
});

test("local gate prints a note when no command is configured", async (t) => {
  const root = await makeProject(t, baseConfig({ fast: { groups: {}, steps: [] }, quick: null, local: null }));
  const { ctx, logger } = await contextFor(root);
  const code = await run(["local"], ctx);
  assert.equal(code, 0);
  assert.match(logger.text(), /no local command configured/i);
});

test("quick gate runs the configured command and reports its exit code", async (t) => {
  const passingRoot = await makeProject(
    t,
    baseConfig({ fast: { groups: {}, steps: [] }, quick: { command: ["node", "-e", "process.exit(0)"] }, local: null }),
  );
  const passing = await contextFor(passingRoot);
  assert.equal(await run(["quick"], passing.ctx), 0);

  const failingRoot = await makeProject(
    t,
    baseConfig({ fast: { groups: {}, steps: [] }, quick: { command: ["node", "-e", "process.exit(1)"] }, local: null }),
  );
  const failing = await contextFor(failingRoot);
  assert.equal(await run(["quick"], failing.ctx), 1);

  const jsonRoot = await makeProject(
    t,
    baseConfig({ fast: { groups: {}, steps: [] }, quick: { command: ["node", "-e", "process.exit(0)"] }, local: null }),
  );
  const jsonRun = await contextFor(jsonRoot);
  assert.equal(await run(["quick", "--json"], jsonRun.ctx), 0);
  const report = JSON.parse(jsonRun.logger.text());
  assert.equal(report.gate, "quick");
  assert.equal(report.ok, true);
});

test("gate command validates the sub-command", async (t) => {
  const root = await makeProject(t, baseConfig({ fast: { groups: {}, steps: [] }, quick: null, local: null }));
  const { ctx, logger } = await contextFor(root);
  assert.equal(await run([], ctx), 2);
  assert.match(logger.text(), /usage: atk gate/i);

  const unknown = await contextFor(root);
  assert.equal(await run(["nope"], unknown.ctx), 2);

  const help = await contextFor(root);
  assert.equal(await run(["help"], help.ctx), 2);
  assert.match(help.logger.text(), /usage: atk gate/i);
});

test("gate fast records a ci-fast measurement row (batch from --batch or state)", async (t) => {
  const state = { schemaVersion: 1, updatedAt: "2026-01-01T00:00:00+08:00", batch: { id: "TEST-R01" } };
  const root = await makeProject(
    t,
    baseConfig({
      fast: {
        parallel: true,
        groups: { code: ["src/**/*.js"] },
        steps: [{ name: "lint", phase: "main", command: ["node", "-e", "process.exit(0)"], when: { group: "code" } }],
      },
    }),
    { "src/a.js": "", ".agent-flow/state.json": `${JSON.stringify(state)}\n` },
  );
  const metricsFile = path.join(root, "artifacts", "gates", "metrics.jsonl");
  const { ctx } = await contextFor(root);
  assert.equal(await run(["fast", "--files", "src/a.js", "--role", "QA"], ctx), 0);
  const first = (await readFile(metricsFile, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(first.length, 1);
  assert.equal(first[0].event, "ci-fast");
  assert.equal(first[0].batch, "TEST-R01");
  assert.equal(first[0].role, "QA");
  assert.equal(first[0].files, 1);
  assert.equal(typeof first[0].gateMs, "number");

  const second = await contextFor(root);
  assert.equal(await run(["fast", "--files", "src/a.js", "--role", "QA", "--batch", "OTHER-R02"], second.ctx), 0);
  const rows = (await readFile(metricsFile, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].batch, "OTHER-R02");
});

test("roleFlag falls back to AGENT_ROLE", async (t) => {
  const root = await makeProject(t, baseConfig({
    fast: {
      parallel: true,
      groups: {},
      steps: [
        {
          name: "role-step",
          phase: "preflight",
          command: ["node", "scripts/args.mjs", "env-role.txt"],
          roleFlag: true,
          when: { changed: true },
        },
      ],
    },
  }));
  const previous = process.env.AGENT_ROLE;
  process.env.AGENT_ROLE = "qa";
  try {
    const { ctx } = await contextFor(root);
    assert.equal(await run(["fast", "--files", "src/a.js"], ctx), 0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_ROLE;
    else process.env.AGENT_ROLE = previous;
  }
  assert.deepEqual(await readLines(root, "env-role.txt"), ["--role,QA"]);
});

test("string commands run through the shell", async (t) => {
  const root = await makeProject(
    t,
    baseConfig({
      fast: {
        parallel: true,
        groups: { docs: ["docs/**"] },
        steps: [{ name: "docs-string", phase: "main", command: "node --version", when: { group: "docs" } }],
      },
    }),
    { "docs/a.md": "# doc\n" },
  );
  const { ctx } = await contextFor(root);
  assert.equal(await run(["fast", "--files", "docs/a.md"], ctx), 0);
  const report = await readReport(root);
  assert.equal(report.ok, true);
  assert.equal(report.steps[0].name, "docs-string");
});
