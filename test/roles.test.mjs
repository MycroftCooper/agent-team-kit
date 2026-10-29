// End-to-end guard for the role-change recipe documented in
// skills/agent-team-roles and docs/ROLES.md: add a role, verify it, catch a
// duplicate prefix, remove a role. These are the edits an agent makes by hand,
// so this test keeps the recipe executable as the CLI evolves.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../lib/dispatch.mjs";
import { run as runInit } from "../lib/init.mjs";
import { createProject, memoryLogger, minimalState } from "./helpers.mjs";

async function makeProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-roles-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  for (const dir of ["src", "tests", "design", "docs"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(path.join(root, "package.json"), '{ "name": "demo", "private": true }\n', "utf8");

  const log = memoryLogger();
  assert.equal(await runInit(["--project", "demo", "--no-plugin"], { cwd: root, log }), 0, log.errorText());
  const config = await readJson(path.join(root, "agent-flow.config.json"));
  const flow = path.join(root, config.layout.flowDir);
  return { root, flow, config };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function cli(root, argv) {
  const log = memoryLogger();
  const code = await runCli([...argv, "--cwd", root], { logger: log });
  return { code, log };
}

function report(log) {
  const last = log.lines.json.at(-1);
  assert.ok(last, `expected JSON output, got: ${log.text()} ${log.errorText()}`);
  return last;
}

/** Add a role exactly as the skill documents: five records, then re-render. */
async function addDesignRole(project) {
  const { flow } = project;
  const config = await readJson(path.join(project.root, "agent-flow.config.json"));
  config.roles = ["LEAD", "DESIGN", "DEV", "QA"];
  await writeJson(path.join(project.root, "agent-flow.config.json"), config);

  const ownershipPath = path.join(flow, "ownership.json");
  const ownership = await readJson(ownershipPath);
  ownership.roles = [...config.roles];
  // init already assigned design/ to a fallback role: reassign, do not append.
  const existing = ownership.rules.find((rule) => rule.prefix === "design/");
  assert.ok(existing, "init should derive a rule for the design/ directory");
  existing.role = "DESIGN";
  existing.note = "design tokens, specs and prototypes";
  await writeJson(ownershipPath, ownership);

  await writeFile(
    path.join(flow, "roles", "DESIGN.md"),
    "# Role: DESIGN\n\n## Write scope\n\ndesign/\n\n## Do not\n\n- Do not write src/.\n",
    "utf8",
  );

  const runtimePath = path.join(flow, "runtime.json");
  const runtime = await readJson(runtimePath);
  runtime.agents = [
    runtime.agents[0],
    { role: "DESIGN", status: "idle", task: "", detail: "", since: "2026-01-01T00:00:00+00:00" },
    ...runtime.agents.slice(1),
  ];
  await writeJson(runtimePath, runtime);

  const readmePath = path.join(flow, "README.md");
  const readme = await readFile(readmePath, "utf8");
  const updated = readme
    // init's fallback rule gave design/ to DEV; the new role takes it over.
    .replace(/^\| DEV \| design\/, src\/ \|/m, "| DEV | src/ |")
    .replace(/^\| DEV \|/m, "| DESIGN | design/ | Owns design tokens, specs and prototypes. |\n| DEV |");
  assert.notEqual(updated, readme, "the role table should contain init's fallback rule for design/");
  assert.equal(updated.match(/design\//g).length, 1, "design/ must be listed exactly once");
  await writeFile(readmePath, updated, "utf8");

  assert.equal((await cli(project.root, ["state", "board"])).code, 0);
  assert.equal((await cli(project.root, ["board"])).code, 0);
}

test("adding a role leaves a consistent config, board and queue", async (t) => {
  const project = await makeProject(t);
  await addDesignRole(project);

  const verify = await cli(project.root, ["ownership", "verify-config"]);
  assert.equal(verify.code, 0, verify.log.text());
  assert.equal(report(verify.log).ok, true);

  assert.equal((await cli(project.root, ["state", "check"])).code, 0);

  const board = await cli(project.root, ["board", "--json"]);
  assert.equal(board.code, 0);
  const agents = report(board.log).agents.map((agent) => agent.role);
  assert.deepEqual(agents, ["DESIGN", "DEV", "LEAD", "QA"]);
  for (const role of ["LEAD", "DESIGN", "DEV", "QA"]) {
    assert.equal(agents.filter((agent) => agent === role).length, 1, `${role} must appear exactly once`);
  }

  const queue = await cli(project.root, ["queue", "--for", "DESIGN", "--json"]);
  assert.equal(queue.code, 0);
  assert.equal(report(queue.log).count, 0);

  const map = await cli(project.root, ["ownership", "map", "design/tokens.json"]);
  assert.equal(map.code, 0);
  assert.match(map.log.text(), /design\/tokens\.json -> DESIGN \[design\/\]/);

  const check = await cli(project.root, ["ownership", "check", "--role", "DESIGN", "--files", "design/tokens.json"]);
  assert.equal(check.code, 0, check.log.errorText());
  assert.match(check.log.text(), /PASS ownership check \(DESIGN\)/);
});

test("a duplicate prefix is a config error the skill tells the agent to avoid", async (t) => {
  const project = await makeProject(t);
  await addDesignRole(project);

  const ownershipPath = path.join(project.flow, "ownership.json");
  const ownership = await readJson(ownershipPath);
  ownership.rules.push({ prefix: "design/", role: "DEV", note: "second owner for the same path" });
  await writeJson(ownershipPath, ownership);

  const verify = await cli(project.root, ["ownership", "verify-config"]);
  assert.equal(verify.code, 1);
  const output = report(verify.log);
  assert.equal(output.ok, false);
  assert.ok(
    output.problems.some((problem) => /claimed by both DESIGN and DEV/.test(problem)),
    JSON.stringify(output.problems),
  );
});

test("removing a role updates every machine-enforced record", async (t) => {
  const project = await makeProject(t);

  // Preconditions from the skill: queue is empty for the role.
  const before = await cli(project.root, ["queue", "--for", "QA", "--json"]);
  assert.equal(before.code, 0);
  assert.equal(report(before.log).count, 0);

  const configPath = path.join(project.root, "agent-flow.config.json");
  const config = await readJson(configPath);
  config.roles = ["LEAD", "DEV"];
  await writeJson(configPath, config);

  const ownershipPath = path.join(project.flow, "ownership.json");
  const ownership = await readJson(ownershipPath);
  ownership.roles = [...config.roles];
  for (const rule of ownership.rules) {
    if (rule.role === "QA") rule.role = "DEV";
  }
  await writeJson(ownershipPath, ownership);

  await rm(path.join(project.flow, "roles", "QA.md"));
  const runtimePath = path.join(project.flow, "runtime.json");
  const runtime = await readJson(runtimePath);
  runtime.agents = runtime.agents.filter((agent) => agent.role !== "QA");
  await writeJson(runtimePath, runtime);

  const readmePath = path.join(project.flow, "README.md");
  const readme = await readFile(readmePath, "utf8");
  await writeFile(
    readmePath,
    readme
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("| QA |"))
      .join("\n"),
    "utf8",
  );
  assert.equal((await cli(project.root, ["state", "board"])).code, 0);
  assert.equal((await cli(project.root, ["board"])).code, 0);

  const verify = await cli(project.root, ["ownership", "verify-config"]);
  assert.equal(verify.code, 0, verify.log.text());
  assert.equal(report(verify.log).ok, true);

  assert.equal((await cli(project.root, ["state", "check"])).code, 0);

  const board = await cli(project.root, ["board", "--json"]);
  assert.equal(board.code, 0);
  assert.deepEqual(report(board.log).agents.map((agent) => agent.role), ["DEV", "LEAD"]);

  // The removed id is now rejected everywhere it was a key.
  const queue = await cli(project.root, ["queue", "--for", "QA"]);
  assert.equal(queue.code, 2);
  assert.match(queue.log.errorText(), /unknown role "QA" \(configured: LEAD, DEV\)/);

  assert.equal(existsSync(path.join(project.flow, "roles", "QA.md")), false, "the card is deleted");
  assert.equal((await readFile(path.join(project.flow, "README.md"), "utf8")).match(/^\| QA \|/m), null);
  assert.deepEqual((await readJson(path.join(project.flow, "ownership.json"))).roles, ["LEAD", "DEV"]);
});

test("state check accepts owners that are no longer roles, so removal must audit slices and subitems", async (t) => {
  const state = minimalState();
  state.packages = state.packages.map((pkg) => ({ ...pkg, owner: "LEAD" }));
  state.batch.slices = state.batch.slices.map((slice) => ({ ...slice, owner: "LEAD" }));
  state.subitems = [{ id: "PKG-01-F01", parent: "PKG-01", type: "feature", owner: "DEV; QA" }];
  const { root } = await createProject({
    config: { roles: ["LEAD", "DEV", "QA"] },
    files: { "flow/state.json": state },
  });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The queue only reads packages, so QA looks idle...
  const queue = await cli(root, ["queue", "--for", "QA", "--json"]);
  assert.equal(queue.code, 0);
  assert.equal(report(queue.log).count, 0);
  // ...and state check does not reject the stale subitem owner.
  assert.equal((await cli(root, ["state", "check"])).code, 0);
  // That is why the skill requires the manual slices/subitems audit.
  assert.match(await readFile(path.join(root, "flow", "state.json"), "utf8"), /"owner": "DEV; QA"/);
});

test("generated flow docs hard-code the init-time role set", async (t) => {
  const project = await makeProject(t);
  const read = (name) => readFile(path.join(project.flow, name), "utf8");
  assert.match(await read("commands.md"), /atk queue --for DEV/);
  assert.match(await read("task-template.md"), /--role DEV/);
  assert.match(await read("README.md"), /^5 QA/m);
});
