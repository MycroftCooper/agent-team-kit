import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { runCli } from "../lib/dispatch.mjs";
import { run } from "../lib/init.mjs";
import { PLUGIN_SOURCE } from "../lib/plugin.mjs";
import { memoryLogger } from "./helpers.mjs";

const CONFIG_FILE = "agent-flow.config.json";

async function makeProject({ dirs = ["src", "docs", "tests"], files = { "package.json": "{}\n" } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-init-test-"));
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

async function runInit(root, argv = []) {
  const log = memoryLogger();
  const code = await run([...argv, "--no-plugin"], { cwd: root, log, configPath: undefined });
  return { code, log };
}

async function readJsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("scaffolds the complete generic workflow", async () => {
  const root = await makeProject();
  const { code, log } = await runInit(root, ["--project", "demo"]);

  assert.equal(code, 0, log.errorText());
  assert.match(log.text(), /Initialised demo/);

  const config = await readJsonFile(path.join(root, CONFIG_FILE));
  assert.equal(config.project, "demo");
  assert.equal(config.language, "en");
  assert.deepEqual(config.roles, ["LEAD", "DEV", "QA"]);
  assert.equal(config.layout.flowDir, ".agent-flow");
  assert.equal(config.plugin.id, "demo-board", "generic plugin identity is derived from the project");
  assert.equal(config.plugin.route, "/demo-board");

  const flow = path.join(root, ".agent-flow");
  for (const name of [
    "state.json",
    "ownership.json",
    "human-todos.json",
    "runtime.json",
    "task-template.md",
    "commands.md",
    "current-batch.md",
    "board.md",
    "README.md",
  ]) {
    assert.ok(existsSync(path.join(flow, name)), `expected ${name} in the flow directory`);
  }

  const state = await readJsonFile(path.join(flow, "state.json"));
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.batch.id, "DEMO-R01");
  assert.deepEqual(state.batch.slices, []);
  assert.deepEqual(state.packages, []);

  const ownership = await readJsonFile(path.join(flow, "ownership.json"));
  assert.deepEqual(ownership.roles, config.roles);
  const ruleFor = (prefix) => ownership.rules.find((rule) => rule.prefix === prefix);
  assert.equal(ruleFor("src/").role, "DEV");
  assert.equal(ruleFor("docs/").role, "LEAD");
  assert.equal(ruleFor("tests/").role, "QA");
  assert.equal(ownership.rootFiles.role, "LEAD");
  assert.ok(ownership.rootFiles.names.includes("package.json"));

  const roleFiles = ["LEAD.md", "DEV.md", "QA.md"];
  for (const name of roleFiles) {
    const text = await readFile(path.join(flow, "roles", name), "utf8");
    assert.match(text, /Receipt format \(6 lines/);
    assert.match(text, /Proof ladder/);
    assert.match(text, /Do not/);
    assert.match(text, /Round budget/);
  }

  for (const name of ["human-todos.json", "runtime.json"]) {
    const parsed = await readJsonFile(path.join(flow, name));
    assert.equal(parsed.schemaVersion, name === "runtime.json" ? 2 : 1);
  }
});

test("--dry-run prints the file list and writes nothing", async () => {
  const root = await makeProject();
  const { code, log } = await runInit(root, ["--dry-run", "--project", "demo"]);

  assert.equal(code, 0);
  assert.match(log.text(), /Dry run/);
  assert.match(log.text(), /agent-flow\.config\.json/);
  assert.match(log.text(), /\.agent-flow\/roles\/DEV\.md/);
  assert.ok(!existsSync(path.join(root, CONFIG_FILE)), "config must not be written in a dry run");
  assert.ok(!existsSync(path.join(root, ".agent-flow")), "flow directory must not be created in a dry run");
});

test("--json prints a machine report and nothing else", async () => {
  const root = await makeProject();
  const log = memoryLogger();
  const code = await run(["--json", "--dry-run", "--project", "demo", "--no-plugin"], { cwd: root, log });

  assert.equal(code, 0);
  assert.equal(log.lines.out.length, 0, "human output must be suppressed with --json");
  assert.equal(log.lines.json.length, 1);
  const report = log.lines.json[0];
  assert.equal(report.ok, true);
  assert.equal(report.command, "init");
  assert.equal(report.dryRun, true);
  assert.equal(report.project, "demo");
  assert.deepEqual(report.roles, ["LEAD", "DEV", "QA"]);
  assert.ok(report.files.includes(CONFIG_FILE));
  assert.ok(report.files.includes(".agent-flow/state.json"));
  assert.deepEqual(report.plugin, { requested: false, synced: false, reason: "--no-plugin" });
});

test("re-running without --force refuses; --force re-scaffolds the config and flow state", async () => {
  const root = await makeProject();
  assert.equal((await runInit(root, ["--project", "demo"])).code, 0);

  // Simulate a live project: edited state and a custom ownership rule.
  const flow = path.join(root, ".agent-flow");
  const statePath = path.join(flow, "state.json");
  const state = await readJsonFile(statePath);
  state.batch.goal = "KEEP-ME";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const ownershipPath = path.join(flow, "ownership.json");
  const ownership = await readJsonFile(ownershipPath);
  ownership.rules = ownership.rules.map((rule) => (rule.prefix === "src/" ? { ...rule, role: "LEAD" } : rule));
  await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`, "utf8");
  const todosPath = path.join(flow, "human-todos.json");
  const todos = await readJsonFile(todosPath);
  todos.items = [
    { id: "T01", text: "KEEP-ME-TODO", done: false, createdAt: "2026-01-01T00:00:00+00:00", doneAt: null, note: "" },
  ];
  await writeFile(todosPath, `${JSON.stringify(todos, null, 2)}\n`, "utf8");
  const boardHtmlPath = path.join(flow, "board.html");
  await writeFile(boardHtmlPath, "OLD-BOARD", "utf8");

  const refused = await runInit(root, ["--project", "renamed"]);
  assert.equal(refused.code, 1);
  assert.match(refused.log.errorText(), /refusing to overwrite/);
  assert.equal((await readJsonFile(path.join(root, CONFIG_FILE))).project, "demo");
  assert.equal((await readJsonFile(statePath)).batch.goal, "KEEP-ME", "a refused init must not touch state");

  const forced = await runInit(root, ["--project", "renamed", "--force", "--roles", "LEAD,DEV"]);
  assert.equal(forced.code, 0, forced.log.errorText());
  assert.equal((await readJsonFile(path.join(root, CONFIG_FILE))).project, "renamed");
  assert.deepEqual((await readJsonFile(path.join(root, CONFIG_FILE))).roles, ["LEAD", "DEV"]);
  // --force rewrites every generated flow document, not only the config. This is
  // why docs/ROLES.md and the agent-team-roles skill say never to use it to
  // change roles on a live project.
  assert.notEqual((await readJsonFile(statePath)).batch.goal, "KEEP-ME", "--force resets state.json");
  assert.equal(
    (await readJsonFile(ownershipPath)).rules.find((rule) => rule.prefix === "src/").role,
    "DEV",
    "--force resets ownership.json",
  );
  assert.deepEqual((await readJsonFile(todosPath)).items, [], "--force resets human-todos.json (user data)");
  assert.equal(await readFile(boardHtmlPath, "utf8"), "OLD-BOARD", "init never rewrites board.html");
  assert.ok(existsSync(path.join(flow, "roles", "QA.md")), "cards of roles dropped from --roles are left behind");
});

test("--no-plugin skips the board plugin copy", async () => {
  const root = await makeProject();
  const { code } = await runInit(root, ["--project", "demo"]);
  assert.equal(code, 0);
  assert.ok(!existsSync(path.join(root, "tools", "agent-board")));
});

test("default init attempts the plugin copy when the bundled plugin exists", async () => {
  if (!existsSync(PLUGIN_SOURCE)) {
    // The plugin package is written by a sibling task; --no-plugin covers the
    // scaffold path until it lands.
    return;
  }
  const root = await makeProject();
  const log = memoryLogger();
  const code = await run(["--project", "demo"], { cwd: root, log });
  assert.equal(code, 0, log.errorText());
  const target = path.join(root, "tools", "agent-board", "package.json");
  assert.ok(existsSync(target), "plugin package.json should be copied");
  const manifest = await readJsonFile(target);
  assert.equal(manifest.name, "dsh-demo-board");
});

test("honours --preset, --language, --roles and --flow-dir", async () => {
  const root = await makeProject({ dirs: [], files: {} });
  const { code, log } = await runInit(root, [
    "--preset",
    "p4deck",
    "--project",
    "Migration Demo",
    "--language",
    "zh-CN",
    "--roles",
    "LEAD,QA",
    "--flow-dir",
    "workflow",
  ]);

  assert.equal(code, 0, log.errorText());
  const config = await readJsonFile(path.join(root, CONFIG_FILE));
  assert.equal(config.language, "zh-CN");
  assert.deepEqual(config.roles, ["LEAD", "QA"]);
  assert.equal(config.layout.flowDir, "workflow");
  assert.equal(config.paths.state, "workflow/state.json", "explicit preset paths follow --flow-dir");
  assert.equal(config.plugin.id, "p4deck-board", "preset plugin identity is preserved");

  const flow = path.join(root, "workflow");
  assert.ok(existsSync(path.join(flow, "state.json")));
  const lead = await readFile(path.join(flow, "角色", "LEAD.md"), "utf8");
  assert.match(lead, /角色：LEAD/);
  assert.match(lead, /回执格式/);
  assert.match(lead, /证据阶梯/);
  const readme = await readFile(path.join(flow, "README.md"), "utf8");
  assert.match(readme, /唯一入口/);

  const ownership = await readJsonFile(path.join(flow, "ownership.json"));
  assert.equal(ownership.roles.includes("DEV"), false);
});

test("generated project loads through loadConfig with resolved paths", async () => {
  const root = await makeProject();
  assert.equal((await runInit(root, ["--project", "loadable"])).code, 0);

  const config = await loadConfig({ cwd: root });
  assert.equal(config.root, root);
  assert.equal(config.project, "loadable");
  assert.deepEqual(config.roles, ["LEAD", "DEV", "QA"]);
  assert.equal(config.rel.state, ".agent-flow/state.json");
  assert.equal(config.paths.state, path.join(root, ".agent-flow", "state.json"));
  assert.equal(config.paths.rolesDir, path.join(root, ".agent-flow", "roles"));
  assert.ok(existsSync(config.paths.state));
  assert.ok(existsSync(config.paths.board));
  assert.ok(existsSync(config.paths.ownership));
});

test("the CLI entry point runs init without a pre-existing config", async () => {
  const root = await makeProject();
  const log = memoryLogger();
  const code = await runCli(["init", "--cwd", root, "--project", "cli-demo", "--no-plugin"], { logger: log });
  assert.equal(code, 0, log.errorText());
  assert.ok(existsSync(path.join(root, CONFIG_FILE)));
});

test("custom roles fall back to the generic role card", async () => {
  const root = await makeProject({ dirs: ["src", "design"], files: {} });
  const { code, log } = await runInit(root, ["--project", "studio", "--roles", "LEAD,DESIGN,QA"]);
  assert.equal(code, 0, log.errorText());

  const card = await readFile(path.join(root, ".agent-flow", "roles", "DESIGN.md"), "utf8");
  assert.match(card, /^# Role: DESIGN/);
  assert.match(card, /atk queue --for DESIGN/);

  const ownership = await readJsonFile(path.join(root, ".agent-flow", "ownership.json"));
  assert.equal(ownership.rules.find((rule) => rule.prefix === "design/").role, "DESIGN");
  assert.equal(ownership.rules.find((rule) => rule.prefix === "src/").role, "DESIGN");
});

test("p4deck preset generates a zh-CN card for every role", async () => {
  const root = await makeProject({ dirs: [], files: {} });
  const { code, log } = await runInit(root, [
    "--preset",
    "p4deck",
    "--project",
    "migrated",
    "--flow-dir",
    "workflow",
  ]);
  assert.equal(code, 0, log.errorText());

  const config = await readJsonFile(path.join(root, CONFIG_FILE));
  assert.equal(config.language, "zh-CN");
  assert.deepEqual(config.roles, ["LEAD", "FE", "BE", "QA"]);
  assert.equal(config.paths.state, "workflow/state.json");

  for (const role of ["LEAD", "FE", "BE", "QA"]) {
    const text = await readFile(path.join(root, "workflow", "角色", `${role}.md`), "utf8");
    assert.match(text, new RegExp(`角色：${role}`), `${role} should use its zh-CN card`);
    assert.match(text, /回执格式/);
    assert.match(text, /证据阶梯/);
  }
});

test("usage errors exit 2 and write nothing", async () => {
  const root = await makeProject();
  const unknownPreset = await runInit(root, ["--preset", "nope"]);
  assert.equal(unknownPreset.code, 2);
  assert.match(unknownPreset.log.errorText(), /unknown preset/i);

  const badLanguage = await runInit(root, ["--language", "fr"]);
  assert.equal(badLanguage.code, 2);
  assert.match(badLanguage.log.errorText(), /unsupported language/i);

  const badFlowDir = await runInit(root, ["--flow-dir", "../escape"]);
  assert.equal(badFlowDir.code, 2);
  assert.match(badFlowDir.log.errorText(), /inside the project root|project-relative/i);

  const unknownOption = await runInit(root, ["--nope"]);
  assert.equal(unknownOption.code, 2);
  assert.match(unknownOption.log.errorText(), /unknown option/i);

  assert.ok(!existsSync(path.join(root, CONFIG_FILE)));
});

test("help prints the option surface and exits 0", async () => {
  const log = memoryLogger();
  const code = await run(["--help"], { cwd: os.tmpdir(), log });
  assert.equal(code, 0);
  assert.match(log.text(), /Usage: atk init/);
  assert.match(log.text(), /--preset/);
  assert.match(log.text(), /--no-plugin/);
});
