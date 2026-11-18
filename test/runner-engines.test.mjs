import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEngine, createDshResult } from "../apps/agent-cli/runner-engines.mjs";

const session = { type: "session", sessionId: "session-1" };
const final = { type: "final", sessionId: "session-1", reason: { kind: "completed" }, text: '{"outcome":"IMPLEMENTED","summary":"修复完成"}' };
const project = events => {
  const result = createDshResult();
  for (const event of events) result.line(typeof event === "string" ? event : JSON.stringify(event));
  return result.finish();
};

test("DSH result comes only from its own completed final event", () => {
  assert.deepEqual(project([session, { type: "tool_result", result: final.text }, final]), { outcome: "IMPLEMENTED", summary: "修复完成" });
  assert.throws(() => project([session, { type: "tool_result", result: final.text }]));
  assert.deepEqual(project([session, { ...final, text: '```json\n' + final.text + '\n```' }]), { outcome: "IMPLEMENTED", summary: "修复完成" });
});

for (const [name, events] of [
  ["mismatched session", [session, { ...final, sessionId: "other-session" }]],
  ["failed terminal", [session, { ...final, reason: { kind: "error" } }]],
  ["missing terminal", [session]],
  ["duplicate terminal", [session, final, final]],
  ["terminal before session", [final, session]],
  ["events after terminal", [session, final, { type: "status", phase: "step_start" }]],
  ["truncated final", [session, { ...final, truncated: true }]],
  ["malformed JSON", [session, "not JSON", final]],
  ["explicit error", [session, { type: "error", message: "failed" }, final]],
  ["invalid answer", [session, { ...final, text: '{"outcome":"COMPLETED","summary":"unverified"}' }]],
]) test(`DSH rejects ${name}`, () => assert.throws(() => project(events)));

test("official Windows desktop shim resolves to native Electron argv without a shell", t => {
  const base = path.resolve(process.env.ATK_TEST_ROOT ?? os.tmpdir());
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "dsh-engine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "resources", "runtime", "cli", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const file of [path.join(root, "DeepSeek Harness.exe"), path.join(root, "resources", "app.asar"), path.join(bin, "dsh.cmd")]) fs.writeFileSync(file, "");
  const resolved = resolveEngine("dsh", path.join(bin, "dsh.cmd"));
  assert.equal(resolved.executable, path.join(root, "DeepSeek Harness.exe"));
  assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(resolved.args[0], "--expose-internals");
  assert.ok(resolved.args[1].endsWith(path.join("dsh-desktop-host", "lib", "cli.js")));
  assert.throws(() => resolveEngine("codex", path.join(bin, "dsh.cmd")));
});

test("engine selection rejects unknown engines and keeps native argv resolution", () => {
  assert.throws(() => resolveEngine("unknown", process.execPath), /engine must be/);
  assert.deepEqual(resolveEngine("dsh", process.execPath), { executable: process.execPath });
});
