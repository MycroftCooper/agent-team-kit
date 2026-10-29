import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ConfigError,
  DEFAULT_CONFIG,
  findConfig,
  loadConfig,
  mergeDeep,
  resolveLayout,
  toProjectRelative,
  validateConfig,
} from "../lib/config.mjs";
import { createProject } from "./helpers.mjs";

test("loadConfig resolves every default path under the flow dir", async () => {
  const { root, configPath } = await createProject({ files: { "flow/state.json": { schemaVersion: 1 } } });
  const config = await loadConfig({ cwd: root });
  assert.equal(config.root, root);
  assert.equal(config.configPath, configPath);
  assert.equal(config.rel.flowDir, "flow");
  assert.equal(config.rel.state, "flow/state.json");
  assert.equal(config.rel.board, "flow/board.md");
  assert.equal(config.rel.humanTodos, "flow/human-todos.json");
  assert.equal(config.paths.state, path.join(root, "flow", "state.json"));
  assert.equal(config.project, path.basename(root));
  assert.deepEqual(config.roles, ["LEAD", "DEV", "QA"]);
});

test("findConfig walks up from a nested directory", async () => {
  const { root, configPath } = await createProject({ files: { "src/app/deep/file.ts": "x" } });
  const found = await findConfig(path.join(root, "src", "app", "deep"));
  assert.equal(found.root, root);
  assert.equal(found.configPath, configPath);
});

test("loadConfig accepts an explicit config path and strips a BOM", async () => {
  const { root, configPath } = await createProject({});
  const { writeText } = await import("../lib/util.mjs");
  await writeText(configPath, `\uFEFF{"schemaVersion":1,"layout":{"flowDir":"flow"},"roles":["LEAD"]}`);
  const config = await loadConfig({ cwd: root, configPath });
  assert.deepEqual(config.roles, ["LEAD"]);
});

test("missing config is a friendly ConfigError", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "atk-noconfig-"));
  await assert.rejects(loadConfig({ cwd: outside }), ConfigError);
});

test("invalid configs are rejected with actionable messages", () => {
  assert.throws(() => validateConfig({ roles: [] }), /non-empty array/);
  assert.throws(() => validateConfig({ roles: ["lead"] }), /upper-case/);
  assert.throws(() => validateConfig({ roles: ["LEAD", "LEAD"] }), /duplicate/);
  assert.throws(() => validateConfig({ schemaVersion: 99 }), /unsupported schemaVersion/);
  assert.throws(() => validateConfig({ board: { port: 99999 } }), /valid TCP port/);
  assert.throws(
    () => resolveLayout("/root", validateConfig({ layout: { flowDir: "D:/absolute" } })),
    /project-relative/,
  );
  assert.throws(() => resolveLayout("/root", validateConfig({ layout: { flowDir: "../escape" } })), /inside the project root/);
  assert.throws(() => validateConfig({ plugin: { id: "Bad_ID" } }), /kebab-case/);
  assert.throws(() => validateConfig({ plugin: { route: "no-slash" } }), /must start with/);
});

test("explicit paths override the flow-dir defaults", async () => {
  const { root } = await createProject({
    config: {
      layout: { flowDir: "flow" },
      paths: { state: "docs/state.json", board: "docs/board.md", todoSource: "docs/TODO.md" },
    },
  });
  const config = await loadConfig({ cwd: root });
  assert.equal(config.rel.state, "docs/state.json");
  assert.equal(config.rel.board, "docs/board.md");
  assert.equal(config.rel.todoSource, "docs/TODO.md");
  assert.equal(config.rel.ownership, "flow/ownership.json");
});

test("mergeDeep keeps nested defaults and replaces arrays", () => {
  const config = validateConfig({ roles: ["LEAD"], gates: { fast: { steps: [] } } });
  assert.equal(config.gates.fast.parallel, true);
  assert.deepEqual(config.gates.fast.groups, {});
  assert.equal(config.batch.budgetRounds, DEFAULT_CONFIG.batch.budgetRounds);
});

test("toProjectRelative normalises absolute and relative input", async () => {
  const { root } = await createProject({});
  const config = await loadConfig({ cwd: root });
  assert.equal(toProjectRelative(config, path.join(root, "src", "a.ts")), "src/a.ts");
  assert.equal(toProjectRelative(config, "./src/b.ts"), "src/b.ts");
});

test("bundled presets validate and resolve to their documented layout", async () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const presetsDir = path.resolve(here, "..", "presets");
  for (const name of ["generic.json", "p4deck.json"]) {
    const raw = JSON.parse(await readFile(path.join(presetsDir, name), "utf8"));
    const config = validateConfig(raw);
    const { rel } = resolveLayout("/project", config);
    assert.equal(config.schemaVersion, 1, name);
    if (name === "p4deck.json") {
      assert.equal(rel.state, "ForAIDoc/PM/工作流/state.json");
      assert.equal(rel.board, "ForAIDoc/PM/工作流/看板.md");
      assert.equal(rel.todoSource, "ForAIDoc/PM/Windows本机私用TODO.md");
      assert.deepEqual(config.roles, ["LEAD", "FE", "BE", "QA"]);
      assert.equal(config.plugin.id, "p4deck-board");
      assert.equal(config.plugin.dir, "tools/dsh-p4deck-board");
      const rustStep = config.gates.fast.steps.find((step) => step.name === "rust:offline-check");
      assert.ok(rustStep, "p4deck preset keeps the rust gate");
    } else {
      assert.equal(rel.state, ".agent-flow/state.json");
      assert.equal(config.language, "en");
    }
  }
});
