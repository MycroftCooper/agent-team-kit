import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli, usageText, VERSION } from "../lib/dispatch.mjs";
import { memoryLogger } from "./helpers.mjs";

async function configuredProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "agent-flow.config.json"),
    `${JSON.stringify({ schemaVersion: 1, language: "en" }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

test("usage lists every documented command", () => {
  const text = usageText();
  for (const command of ["init", "state", "board", "serve", "evidence", "ownership", "batch", "gate", "select-tests", "todo", "measure", "sync", "docs", "plugin"]) {
    assert.ok(text.includes(command), `usage should mention ${command}`);
  }
  assert.ok(text.includes("atk task"), "aliases are documented");
});

test("--version prints the version", async () => {
  const log = memoryLogger();
  const code = await runCli(["--version"], { logger: log });
  assert.equal(code, 0);
  assert.equal(log.text().trim(), VERSION);
});

test("-v before any positional argument is the global CLI version", async () => {
  const log = memoryLogger();
  const code = await runCli(["-v"], { logger: log });
  assert.equal(code, 0);
  assert.equal(log.text().trim(), VERSION);
});

test("a leading --help prints the CLI usage and exits 0", async () => {
  const log = memoryLogger();
  assert.equal(await runCli(["--help"], { logger: log }), 0);
  assert.match(log.text(), /atk init/);
});

test("--version after the sub-command is forwarded to the command module", async (t) => {
  const root = await configuredProject(t);
  const log = memoryLogger();
  // `release --version 0.2.0` in a non-git directory reaches release's own
  // --version parsing and then fails the git check (exit 1). Before the fix the
  // global handler swallowed --version, printed the CLI version and exited 0.
  const code = await runCli(["release", "--version", "0.2.0", "--cwd", root], { logger: log });
  assert.equal(code, 1);
  assert.match(log.errorText(), /not a git repository/i);
  assert.notEqual(log.text().trim(), VERSION, "must not print the CLI version");
});

test("--help after the sub-command still belongs to the command module", async (t) => {
  const root = await configuredProject(t);
  const log = memoryLogger();
  assert.equal(await runCli(["gate", "--help", "--cwd", root], { logger: log }), 2);
  assert.match(log.text(), /Usage: atk gate/i);
  assert.doesNotMatch(log.text(), /atk init/);
});

test("no arguments prints usage and exits 2", async () => {
  const log = memoryLogger();
  const code = await runCli([], { logger: log });
  assert.equal(code, 2);
  assert.match(log.text(), /Usage:/);
});

test("help exits 0", async () => {
  const log = memoryLogger();
  assert.equal(await runCli(["help"], { logger: log }), 0);
  assert.match(log.text(), /atk init/);
});

test("unknown command exits 2 and explains", async () => {
  const log = memoryLogger();
  const code = await runCli(["nope"], { logger: log });
  assert.equal(code, 2);
  assert.match(log.errorText(), /Unknown command "nope"/);
});

test("a command without a config reports a ConfigError instead of crashing", async () => {
  const log = memoryLogger();
  // A fresh temp directory, so the assertion does not depend on whether the
  // checkout itself has been scaffolded with `atk init`.
  const dir = await mkdtemp(path.join(os.tmpdir(), "atk-noconfig-"));
  const code = await runCli(["board", "--cwd", dir], { logger: log });
  assert.equal(code, 2);
  assert.match(log.errorText(), /No agent-flow config found/);
});
