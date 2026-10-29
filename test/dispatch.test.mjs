import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, usageText, VERSION } from "../lib/dispatch.mjs";
import { memoryLogger } from "./helpers.mjs";

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
  const code = await runCli(["board", "--cwd", process.cwd()], { logger: log });
  assert.equal(code, 2);
  assert.match(log.errorText(), /No agent-flow config found/);
});
